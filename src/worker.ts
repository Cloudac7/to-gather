import { handle } from '@astrojs/cloudflare/handler';
import { DurableObject } from 'cloudflare:workers';
import { ZodError } from 'zod';
import type {
  AnswerDraft,
  AnswerFieldKey,
  CreateShareResponse,
  RevealedAnswer,
  RoomTemplate,
  ShareSnapshot,
  ShareSummary,
  ServerEvent,
} from './lib/types';
import { ANSWER_FIELD_KEYS, createEmptyDraft } from './lib/types';
import {
  createParticipantCookie,
  deriveJoinCode,
  hashSecret,
  isSecureRequest,
  randomRoomId,
  randomString,
  randomToken,
  sha256Hex,
  timingSafeEqual,
} from './lib/security';
import {
  answerSchema,
  createRoomSchema,
  draftSchema,
  hasMinimumAnswer,
  joinRoomSchema,
  recoverRoomSchema,
  shareCreateSchema,
} from './lib/validation';
import {
  buildRoomState,
  expiryIso,
  getParticipantFromRequest,
  getRoom,
  nowIso,
  parseAnswer,
  parseRoomTemplate,
  touchRoom,
  type ParticipantRow,
} from './server/db';
import { assertSameOrigin, errorResponse, HttpError, json, readJson } from './server/http';
import {
  effectiveShareStatus,
  getPublicShareState,
  getShareRow,
  SHARE_ID_PATTERN,
  type ShareRow,
} from './server/shares';
import { forkAnswerMedia } from './server/room-fork';
import { musicArtworkApi, musicSearchApi } from './server/music';

const ROOM_PATH = /^\/api\/rooms\/([a-z2-9]{12})(?:\/(.*))?$/;
const SHARE_PATH = /^\/api\/shares\/([a-z2-9]{24})(?:\/(.*))?$/;
const MAX_GUESTS = 20;
const SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PENDING_SHARE_TTL_MS = 60 * 60 * 1000;

function coordinator(env: Env, roomId: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(roomId));
}

function secureHeaders(response: Response) {
  // Reconstructing an upgrade response drops Cloudflare's non-standard
  // `webSocket` handle, so the 101 response must pass through untouched.
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

interface HostRoomSeed {
  nickname: string;
  template: RoomTemplate;
  answer: AnswerDraft;
  source?: { roomId: string; participantId: string };
}

async function createRoomWithHost(request: Request, env: Env, seed: HostRoomSeed) {
  const roomId = randomRoomId();
  const participantId = crypto.randomUUID();
  const joinCode = await deriveJoinCode(roomId, env.AUTH_PEPPER);
  const recoveryCode = randomString(12);
  const token = randomToken();
  const [joinHash, recoveryHash, tokenHash] = await Promise.all([
    hashSecret(joinCode, env.AUTH_PEPPER),
    hashSecret(recoveryCode, env.AUTH_PEPPER),
    hashSecret(token, env.AUTH_PEPPER),
  ]);
  const now = nowIso();
  const copiedMediaKeys: string[] = [];
  let answer = answerSchema.parse(seed.answer);
  try {
    if (seed.source) {
      answer = await forkAnswerMedia(
        answer,
        {
          sourceRoomId: seed.source.roomId,
          sourceParticipantId: seed.source.participantId,
          targetRoomId: roomId,
          targetParticipantId: participantId,
        },
        async (sourceKey, targetKey) => {
          const object = await env.AVATARS.get(sourceKey);
          if (!object) throw new HttpError(409, '原房间中的图片已经不存在，无法完整创建新房间', 'source_media_missing');
          await env.AVATARS.put(targetKey, object.body, {
            httpMetadata: object.httpMetadata,
            customMetadata: object.customMetadata,
          });
          copiedMediaKeys.push(targetKey);
        },
      );
    }

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO rooms (id, join_code_hash, status, current_round, version, created_at, last_active_at, expires_at, template_json)
         VALUES (?, ?, 'waiting_partner', 1, 1, ?, ?, ?, ?)`,
      ).bind(roomId, joinHash, now, now, expiryIso(new Date(now)), JSON.stringify(seed.template)),
      env.DB.prepare(
        `INSERT INTO participants (id, room_id, slot, nickname, token_hash, recovery_hash, created_at)
         VALUES (?, ?, 1, ?, ?, ?, ?)`,
      ).bind(participantId, roomId, seed.nickname, tokenHash, recoveryHash, now),
      env.DB.prepare('INSERT INTO rounds (room_id, round_number, created_at) VALUES (?, 1, ?)').bind(
        roomId,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO answers (room_id, round_number, participant_id, content_json, version, updated_at)
         VALUES (?, 1, ?, ?, 0, ?)`,
      ).bind(roomId, participantId, JSON.stringify(answer), now),
    ]);
  } catch (error) {
    if (copiedMediaKeys.length) await env.AVATARS.delete(copiedMediaKeys);
    throw error;
  }

  const origin = new URL(request.url).origin;
  return json(
    {
      roomId,
      inviteUrl: `${origin}/room/${roomId}`,
      joinCode,
      recoveryCode,
    },
    {
      status: 201,
      headers: { 'Set-Cookie': createParticipantCookie(roomId, token, isSecureRequest(request)) },
    },
  );
}

async function createRoom(request: Request, env: Env) {
  assertSameOrigin(request);
  const input = createRoomSchema.parse(await readJson(request));
  return createRoomWithHost(request, env, {
    nickname: input.nickname,
    template: input.template,
    answer: createEmptyDraft(),
  });
}

async function forkRoom(request: Request, env: Env, roomId: string, participant: ParticipantRow) {
  assertSameOrigin(request);
  if (participant.slot !== 2) {
    throw new HttpError(403, '只有二号可以用自己的内容创建新房间', 'host_cannot_fork');
  }
  const room = await getRoom(env.DB, roomId);
  if (!room || room.expires_at <= nowIso()) throw new HttpError(410, '原房间已经过期', 'expired');
  const source = await env.DB.prepare(
    `SELECT content_json, submitted_at FROM answers
     WHERE room_id = ? AND round_number = ? AND participant_id = ?`,
  )
    .bind(roomId, room.current_round, participant.id)
    .first<{ content_json: string; submitted_at: string | null }>();
  if (!source?.submitted_at) {
    throw new HttpError(409, '请先发布当前内容，再用它创建新房间', 'answer_not_published');
  }

  return createRoomWithHost(request, env, {
    nickname: participant.nickname,
    template: parseRoomTemplate(room.template_json),
    answer: answerSchema.parse(parseAnswer(source.content_json)),
    source: { roomId, participantId: participant.id },
  });
}

async function proxyMutation(
  request: Request,
  env: Env,
  roomId: string,
  action: string,
  participant: ParticipantRow | null,
) {
  if (!participant) throw new HttpError(401, '请先加入或恢复房间', 'unauthorized');
  assertSameOrigin(request);
  const headers = new Headers(request.headers);
  headers.set('X-Participant-Id', participant.id);
  headers.set('X-Room-Id', roomId);
  const body = request.method === 'POST' && action !== 'submit' && action !== 'reopen' ? request.body : request.body;
  return coordinator(env, roomId).fetch(
    new Request(`https://room.internal/${action}`, { method: request.method, headers, body }),
  );
}

async function joinRoom(request: Request, env: Env, roomId: string) {
  assertSameOrigin(request);
  const input = joinRoomSchema.parse(await readJson(request));
  const response = await coordinator(env, roomId).fetch(
    new Request('https://room.internal/join', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-IP': request.headers.get('CF-Connecting-IP') ?? 'local',
      },
      body: JSON.stringify(input),
    }),
  );
  if (!response.ok) return response;
  const result = (await response.json()) as { roomId: string; recoveryCode: string; token: string };
  return json(
    { roomId: result.roomId, recoveryCode: result.recoveryCode },
    {
      status: 201,
      headers: { 'Set-Cookie': createParticipantCookie(roomId, result.token, isSecureRequest(request)) },
    },
  );
}

async function recoverRoom(request: Request, env: Env, roomId: string) {
  assertSameOrigin(request);
  const input = recoverRoomSchema.parse(await readJson(request));
  const recoveryHash = await hashSecret(input.recoveryCode, env.AUTH_PEPPER);
  const participant = await env.DB.prepare(
    'SELECT * FROM participants WHERE room_id = ? AND slot = ? AND nickname = ? AND recovery_hash = ?',
  )
    .bind(roomId, input.slot, input.nickname, recoveryHash)
    .first<ParticipantRow>();
  if (!participant) throw new HttpError(401, '恢复信息不匹配', 'invalid_recovery');
  const token = randomToken();
  const tokenHash = await hashSecret(token, env.AUTH_PEPPER);
  await env.DB.prepare('UPDATE participants SET token_hash = ? WHERE id = ?')
    .bind(tokenHash, participant.id)
    .run();
  await touchRoom(env.DB, roomId);
  return json(
    { roomId },
    { headers: { 'Set-Cookie': createParticipantCookie(roomId, token, isSecureRequest(request)) } },
  );
}

function imageType(bytes: Uint8Array) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return 'image/png';
  if (
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  )
    return 'image/webp';
  return null;
}

async function uploadAvatar(request: Request, env: Env, roomId: string, participant: ParticipantRow) {
  assertSameOrigin(request);
  const declaredLength = Number(request.headers.get('Content-Length') ?? 0);
  if (declaredLength > 2_000_000) throw new HttpError(413, '头像不能超过 2MB', 'avatar_too_large');
  const buffer = await request.arrayBuffer();
  if (!buffer.byteLength || buffer.byteLength > 2_000_000) {
    throw new HttpError(413, '头像不能超过 2MB', 'avatar_too_large');
  }
  const type = imageType(new Uint8Array(buffer));
  if (!type) throw new HttpError(415, '仅支持 JPG、PNG 或 WebP 图片', 'invalid_avatar');
  const extension = type === 'image/jpeg' ? 'jpg' : type.split('/')[1];
  const key = `${roomId}/${participant.id}/${crypto.randomUUID()}.${extension}`;
  await env.AVATARS.put(key, buffer, { httpMetadata: { contentType: type } });
  const response = await coordinator(env, roomId).fetch(
    new Request('https://room.internal/avatar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Participant-Id': participant.id },
      body: JSON.stringify({ key }),
    }),
  );
  if (!response.ok) {
    await env.AVATARS.delete(key);
    return response;
  }
  const result = (await response.json()) as { version: number };
  return json({ avatarKey: key, version: result.version });
}

async function readAvatar(request: Request, env: Env, roomId: string, participant: ParticipantRow) {
  const key = new URL(request.url).searchParams.get('key');
  if (!key || !key.startsWith(`${roomId}/`)) throw new HttpError(404, '头像不存在', 'not_found');
  const row = await env.DB.prepare(
    `SELECT a.participant_id, a.submitted_at, p.slot AS target_slot
     FROM answers a JOIN participants p ON p.id = a.participant_id
     WHERE a.room_id = ? AND json_extract(a.content_json, '$.avatarKey') = ?`,
  )
    .bind(roomId, key)
    .first<{ participant_id: string; submitted_at: string | null; target_slot: 1 | 2 }>();
  const canReadPublishedCounterpart = Boolean(
    row?.submitted_at && (participant.slot === 1 || row.target_slot === 1),
  );
  if (!row || (row.participant_id !== participant.id && !canReadPublishedCounterpart)) {
    throw new HttpError(403, '当前无权查看该头像', 'forbidden');
  }
  const object = await env.AVATARS.get(key);
  if (!object) throw new HttpError(404, '头像不存在', 'not_found');
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'private, max-age=300');
  headers.set('ETag', object.httpEtag);
  return new Response(object.body, { headers });
}

function isAnswerFieldKey(value: string): value is AnswerFieldKey {
  return (ANSWER_FIELD_KEYS as readonly string[]).includes(value);
}

async function uploadAnswerImage(
  request: Request,
  env: Env,
  roomId: string,
  participant: ParticipantRow,
  field: AnswerFieldKey,
) {
  assertSameOrigin(request);
  const declaredLength = Number(request.headers.get('Content-Length') ?? 0);
  if (declaredLength > 1_000_000) {
    throw new HttpError(413, '处理后的答案图片不能超过 1MB', 'answer_image_too_large');
  }
  const buffer = await request.arrayBuffer();
  if (!buffer.byteLength || buffer.byteLength > 1_000_000) {
    throw new HttpError(413, '处理后的答案图片不能超过 1MB', 'answer_image_too_large');
  }
  const type = imageType(new Uint8Array(buffer));
  if (type !== 'image/webp') {
    throw new HttpError(415, '答案图片需要由页面压缩为 WebP 后上传', 'invalid_answer_image');
  }
  const key = `${roomId}/${participant.id}/answers/${field}/${crypto.randomUUID()}.webp`;
  await env.AVATARS.put(key, buffer, { httpMetadata: { contentType: type } });
  const response = await coordinator(env, roomId).fetch(
    new Request('https://room.internal/answer-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Participant-Id': participant.id },
      body: JSON.stringify({ field, key }),
    }),
  );
  if (!response.ok) {
    await env.AVATARS.delete(key);
    return response;
  }
  const result = (await response.json()) as { version: number; previousKey: string | null };
  if (result.previousKey && result.previousKey !== key) {
    await deleteRoomMediaIfUnreferenced(env, result.previousKey);
  }
  return json({ imageKey: key, version: result.version });
}

async function deleteAnswerImage(
  request: Request,
  env: Env,
  roomId: string,
  participant: ParticipantRow,
  field: AnswerFieldKey,
) {
  assertSameOrigin(request);
  const response = await coordinator(env, roomId).fetch(
    new Request('https://room.internal/answer-image', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'X-Participant-Id': participant.id },
      body: JSON.stringify({ field }),
    }),
  );
  if (!response.ok) return response;
  const result = (await response.json()) as { version: number; previousKey: string | null };
  if (result.previousKey) await deleteRoomMediaIfUnreferenced(env, result.previousKey);
  return json({ imageKey: null, version: result.version });
}

async function readRoomMedia(request: Request, env: Env, roomId: string, participant: ParticipantRow) {
  const key = new URL(request.url).searchParams.get('key');
  if (!key || !key.startsWith(`${roomId}/`)) throw new HttpError(404, '图片不存在', 'not_found');
  const rows = await env.DB.prepare(
    `SELECT a.participant_id, a.content_json, a.submitted_at, p.slot AS target_slot
     FROM answers a JOIN participants p ON p.id = a.participant_id
     WHERE a.room_id = ?`,
  )
    .bind(roomId)
    .all<{ participant_id: string; content_json: string; submitted_at: string | null; target_slot: 1 | 2 }>();
  const row = rows.results.find((candidate) => {
    const answer = parseAnswer(candidate.content_json);
    return answer.avatarKey === key || Object.values(answer.imageKeys).includes(key);
  });
  const canReadPublishedCounterpart = Boolean(
    row?.submitted_at && (participant.slot === 1 || row.target_slot === 1),
  );
  if (!row || (row.participant_id !== participant.id && !canReadPublishedCounterpart)) {
    throw new HttpError(403, '当前无权查看该图片', 'forbidden');
  }
  const object = await env.AVATARS.get(key);
  if (!object) throw new HttpError(404, '图片不存在', 'not_found');
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'private, max-age=300');
  headers.set('ETag', object.httpEtag);
  return new Response(object.body, { headers });
}

function collectSnapshotMedia(snapshot: ShareSnapshot) {
  const keys = new Set<string>();
  for (const person of [snapshot.host, snapshot.guest]) {
    if (person.answer.avatarKey) keys.add(person.answer.avatarKey);
    for (const key of Object.values(person.answer.imageKeys)) if (key) keys.add(key);
  }
  return [...keys];
}

async function deleteRoomMediaIfUnreferenced(env: Env, objectKey: string) {
  const reference = await env.DB.prepare(
    `SELECT 1 AS found
     FROM share_assets sa JOIN shares s ON s.id = sa.share_id
     WHERE sa.object_key = ? AND s.status IN ('pending', 'active') AND s.expires_at > ?
     LIMIT 1`,
  )
    .bind(objectKey, nowIso())
    .first<{ found: number }>();
  if (!reference) await env.AVATARS.delete(objectKey);
}

function shareSummary(request: Request, row: ShareRow, pairNickname: string): ShareSummary {
  const origin = new URL(request.url).origin;
  const status = effectiveShareStatus(row);
  return {
    id: row.id,
    pairParticipantId: row.pair_participant_id,
    pairNickname,
    status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    shareUrl: `${origin}/share/${row.id}`,
    posterUrl: status === 'active' && row.poster_key ? `${origin}/api/shares/${row.id}/poster` : null,
  };
}

async function createShare(
  request: Request,
  env: Env,
  roomId: string,
  participant: ParticipantRow,
): Promise<Response> {
  assertSameOrigin(request);
  const input = shareCreateSchema.parse(await readJson(request));
  const room = await getRoom(env.DB, roomId);
  if (!room || room.expires_at <= nowIso()) throw new HttpError(410, '房间已过期', 'expired');
  const pair = await env.DB.prepare('SELECT * FROM participants WHERE room_id = ? AND id = ?')
    .bind(roomId, input.pairParticipantId)
    .first<ParticipantRow>();
  if (!pair || pair.id === participant.id || pair.slot === participant.slot) {
    throw new HttpError(400, '请选择当前房间中与你配对的参与者', 'invalid_pair');
  }
  const answerRows = await env.DB.prepare(
    `SELECT a.participant_id, a.content_json, a.submitted_at, p.slot, p.nickname
     FROM answers a JOIN participants p ON p.id = a.participant_id
     WHERE a.room_id = ? AND a.round_number = ? AND a.participant_id IN (?, ?)`,
  )
    .bind(roomId, room.current_round, participant.id, pair.id)
    .all<{
      participant_id: string;
      content_json: string;
      submitted_at: string | null;
      slot: 1 | 2;
      nickname: string;
    }>();
  if (answerRows.results.length !== 2 || answerRows.results.some((answer) => !answer.submitted_at)) {
    throw new HttpError(409, '双方都发布结果后才能生成分享', 'pair_not_published');
  }
  const answers: RevealedAnswer[] = answerRows.results.map((answer) => ({
    participantId: answer.participant_id,
    slot: answer.slot,
    nickname: answer.nickname,
    answer: parseAnswer(answer.content_json),
  }));
  const host = answers.find((answer) => answer.slot === 1);
  const guest = answers.find((answer) => answer.slot === 2);
  if (!host || !guest) throw new HttpError(409, '配对结果不完整', 'pair_not_published');
  const now = nowIso();
  const snapshot: ShareSnapshot = {
    roomId,
    roundNumber: room.current_round,
    template: parseRoomTemplate(room.template_json),
    host,
    guest,
    createdAt: now,
  };
  const fingerprint = await sha256Hex(JSON.stringify({ ...snapshot, createdAt: '' }));
  if (!input.forceNew) {
    const existing = await env.DB.prepare(
      `SELECT * FROM shares
       WHERE room_id = ? AND owner_participant_id = ? AND pair_participant_id = ?
         AND round_number = ? AND fingerprint = ? AND status = 'active' AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(roomId, participant.id, pair.id, room.current_round, fingerprint, now)
      .first<ShareRow>();
    if (existing?.poster_key) {
      const response: CreateShareResponse = {
        share: shareSummary(request, existing, pair.nickname),
        reused: true,
        needsPoster: false,
      };
      await touchRoom(env.DB, roomId);
      return json(response);
    }
  }

  const shareId = randomString(24, 'abcdefghjkmnpqrstuvwxyz23456789');
  const expiresAt = new Date(new Date(now).getTime() + SHARE_TTL_MS).toISOString();
  const mediaKeys = collectSnapshotMedia(snapshot);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO shares
       (id, room_id, owner_participant_id, pair_participant_id, round_number, status,
        fingerprint, snapshot_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    ).bind(
      shareId,
      roomId,
      participant.id,
      pair.id,
      room.current_round,
      fingerprint,
      JSON.stringify(snapshot),
      now,
      expiresAt,
    ),
    ...mediaKeys.map((objectKey) =>
      env.DB.prepare('INSERT INTO share_assets (share_id, asset_id, object_key) VALUES (?, ?, ?)').bind(
        shareId,
        randomString(16, 'abcdefghjkmnpqrstuvwxyz23456789'),
        objectKey,
      ),
    ),
  ]);
  await touchRoom(env.DB, roomId);
  const row = await getShareRow(env.DB, shareId);
  if (!row) throw new HttpError(500, '分享创建失败');
  const response: CreateShareResponse = {
    share: shareSummary(request, row, pair.nickname),
    reused: false,
    needsPoster: true,
  };
  return json(response, { status: 201 });
}

async function uploadSharePoster(
  request: Request,
  env: Env,
  roomId: string,
  participant: ParticipantRow,
  shareId: string,
) {
  assertSameOrigin(request);
  const row = await getShareRow(env.DB, shareId);
  if (!row || row.room_id !== roomId || row.owner_participant_id !== participant.id) {
    throw new HttpError(404, '分享不存在', 'not_found');
  }
  if (row.status !== 'pending') throw new HttpError(409, '分享已经生成', 'share_already_generated');
  const declaredLength = Number(request.headers.get('Content-Length') ?? 0);
  if (declaredLength > 15_000_000) throw new HttpError(413, '导出图片不能超过 15MB', 'poster_too_large');
  const buffer = await request.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (!buffer.byteLength || buffer.byteLength > 15_000_000) {
    throw new HttpError(413, '导出图片不能超过 15MB', 'poster_too_large');
  }
  if (!(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) {
    throw new HttpError(415, '导出图片必须是 PNG', 'invalid_poster');
  }
  const view = new DataView(buffer);
  if (view.getUint32(16) !== 1600 || view.getUint32(20) !== 1600) {
    throw new HttpError(400, '导出图片必须是 1600 × 1600', 'invalid_poster_dimensions');
  }
  const posterKey = `shares/${shareId}/poster.png`;
  await env.AVATARS.put(posterKey, buffer, { httpMetadata: { contentType: 'image/png' } });
  await env.DB.prepare("UPDATE shares SET status = 'active', poster_key = ? WHERE id = ? AND status = 'pending'")
    .bind(posterKey, shareId)
    .run();
  const active = await getShareRow(env.DB, shareId);
  if (!active) throw new HttpError(500, '分享图片保存失败');
  const pair = await env.DB.prepare('SELECT nickname FROM participants WHERE id = ?')
    .bind(row.pair_participant_id)
    .first<{ nickname: string }>();
  return json({ share: shareSummary(request, active, pair?.nickname ?? '配对对象') });
}

async function releaseShareAssets(env: Env, row: ShareRow) {
  const assets = await env.DB.prepare('SELECT object_key FROM share_assets WHERE share_id = ?')
    .bind(row.id)
    .all<{ object_key: string }>();
  if (row.poster_key) await env.AVATARS.delete(row.poster_key);
  await env.DB.prepare('DELETE FROM share_assets WHERE share_id = ?').bind(row.id).run();
  const roomStillExists = Boolean(await getRoom(env.DB, row.room_id));
  const roomMedia = new Set<string>();
  if (roomStillExists) {
    const answers = await env.DB.prepare('SELECT content_json FROM answers WHERE room_id = ?')
      .bind(row.room_id)
      .all<{ content_json: string }>();
    for (const answerRow of answers.results) {
      const answer = parseAnswer(answerRow.content_json);
      if (answer.avatarKey) roomMedia.add(answer.avatarKey);
      for (const imageKey of Object.values(answer.imageKeys)) if (imageKey) roomMedia.add(imageKey);
    }
  }
  for (const { object_key: objectKey } of assets.results) {
    const reference = await env.DB.prepare('SELECT 1 AS found FROM share_assets WHERE object_key = ? LIMIT 1')
      .bind(objectKey)
      .first<{ found: number }>();
    if (!reference && !roomMedia.has(objectKey)) await env.AVATARS.delete(objectKey);
  }
}

async function retireShare(env: Env, row: ShareRow, status: 'revoked' | 'expired') {
  await releaseShareAssets(env, row);
  const now = nowIso();
  await env.DB.prepare(
    `UPDATE shares SET status = ?, snapshot_json = NULL, poster_key = NULL,
      revoked_at = CASE WHEN ? = 'revoked' THEN ? ELSE revoked_at END, cleaned_at = ?
     WHERE id = ?`,
  )
    .bind(status, status, now, now, row.id)
    .run();
}

async function revokeShare(
  request: Request,
  env: Env,
  roomId: string,
  participant: ParticipantRow,
  shareId: string,
) {
  assertSameOrigin(request);
  const row = await getShareRow(env.DB, shareId);
  if (!row || row.room_id !== roomId || row.owner_participant_id !== participant.id) {
    throw new HttpError(404, '分享不存在', 'not_found');
  }
  const status = effectiveShareStatus(row);
  if (status === 'active' || status === 'pending') await retireShare(env, row, 'revoked');
  return json({ status: status === 'expired' ? 'expired' : 'revoked' });
}

async function publicShareApi(request: Request, env: Env, shareId: string, tail = '') {
  if (!SHARE_ID_PATTERN.test(shareId)) throw new HttpError(404, '分享不存在', 'not_found');
  const row = await getShareRow(env.DB, shareId);
  if (!row) throw new HttpError(404, '分享不存在', 'not_found');
  const status = effectiveShareStatus(row);
  if (status !== 'active') {
    return json({ status }, { status: status === 'expired' || status === 'revoked' ? 410 : 404 });
  }
  if (!tail) return json(await getPublicShareState(env, shareId));
  if (tail === 'poster' && request.method === 'GET') {
    if (!row.poster_key) throw new HttpError(404, '分享图片不存在', 'not_found');
    const object = await env.AVATARS.get(row.poster_key);
    if (!object) throw new HttpError(404, '分享图片不存在', 'not_found');
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('Cache-Control', 'no-store');
    headers.set('ETag', object.httpEtag);
    return new Response(object.body, { headers });
  }
  const mediaMatch = tail.match(/^media\/([a-z2-9]{16})$/);
  if (mediaMatch && request.method === 'GET') {
    const asset = await env.DB.prepare('SELECT object_key FROM share_assets WHERE share_id = ? AND asset_id = ?')
      .bind(shareId, mediaMatch[1])
      .first<{ object_key: string }>();
    if (!asset) throw new HttpError(404, '分享图片不存在', 'not_found');
    const object = await env.AVATARS.get(asset.object_key);
    if (!object) throw new HttpError(404, '分享图片不存在', 'not_found');
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('Cache-Control', 'no-store');
    headers.set('ETag', object.httpEtag);
    return new Response(object.body, { headers });
  }
  throw new HttpError(404, '接口不存在', 'not_found');
}

async function roomApi(request: Request, env: Env, roomId: string, tail = ''): Promise<Response> {
  const participant = await getParticipantFromRequest(request, env, roomId);
  if (request.method === 'GET' && !tail) {
    if (participant) await touchRoom(env.DB, roomId);
    return json(await buildRoomState(env, roomId, participant));
  }
  if (request.method === 'POST' && tail === 'join') return joinRoom(request, env, roomId);
  if (request.method === 'POST' && tail === 'recover') return recoverRoom(request, env, roomId);
  if (request.method === 'POST' && tail === 'join-code') {
    return proxyMutation(request, env, roomId, 'join-code', participant);
  }
  if (request.method === 'GET' && tail === 'ws') {
    if (!participant) throw new HttpError(401, '请先加入房间', 'unauthorized');
    const headers = new Headers(request.headers);
    headers.set('X-Participant-Id', participant.id);
    return coordinator(env, roomId).fetch(
      new Request('https://room.internal/ws', { headers }),
    );
  }
  if (tail === 'avatar' && request.method === 'POST') {
    if (!participant) throw new HttpError(401, '请先加入房间', 'unauthorized');
    return uploadAvatar(request, env, roomId, participant);
  }
  if (tail === 'avatar' && request.method === 'GET') {
    if (!participant) throw new HttpError(401, '请先加入房间', 'unauthorized');
    return readAvatar(request, env, roomId, participant);
  }
  if (tail === 'media' && request.method === 'GET') {
    if (!participant) throw new HttpError(401, '请先加入房间', 'unauthorized');
    return readRoomMedia(request, env, roomId, participant);
  }
  const answerImageMatch = tail.match(/^answer-image\/([A-Za-z]+)$/);
  if (answerImageMatch && isAnswerFieldKey(answerImageMatch[1])) {
    if (!participant) throw new HttpError(401, '请先加入房间', 'unauthorized');
    if (request.method === 'POST') {
      return uploadAnswerImage(request, env, roomId, participant, answerImageMatch[1]);
    }
    if (request.method === 'DELETE') {
      return deleteAnswerImage(request, env, roomId, participant, answerImageMatch[1]);
    }
  }
  if (tail === 'shares' && request.method === 'POST') {
    if (!participant) throw new HttpError(401, '请先加入房间', 'unauthorized');
    return createShare(request, env, roomId, participant);
  }
  if (tail === 'fork' && request.method === 'POST') {
    if (!participant) throw new HttpError(401, '请先加入房间', 'unauthorized');
    return forkRoom(request, env, roomId, participant);
  }
  const sharePosterMatch = tail.match(/^shares\/([a-z2-9]{24})\/poster$/);
  if (sharePosterMatch && request.method === 'POST') {
    if (!participant) throw new HttpError(401, '请先加入房间', 'unauthorized');
    return uploadSharePoster(request, env, roomId, participant, sharePosterMatch[1]);
  }
  const ownedShareMatch = tail.match(/^shares\/([a-z2-9]{24})$/);
  if (ownedShareMatch && request.method === 'DELETE') {
    if (!participant) throw new HttpError(401, '请先加入房间', 'unauthorized');
    return revokeShare(request, env, roomId, participant, ownedShareMatch[1]);
  }
  if (tail === 'draft' && request.method === 'PATCH') {
    return proxyMutation(request, env, roomId, 'draft', participant);
  }
  if (tail === 'submit' && request.method === 'POST') {
    return proxyMutation(request, env, roomId, 'submit', participant);
  }
  if (tail === 'edit' && request.method === 'POST') {
    return proxyMutation(request, env, roomId, 'edit', participant);
  }
  if (tail === 'reopen-vote' && request.method === 'POST') {
    return proxyMutation(request, env, roomId, 'reopen', participant);
  }
  throw new HttpError(404, '接口不存在', 'not_found');
}

async function apiFetch(request: Request, env: Env, ctx: ExecutionContext) {
  const url = new URL(request.url);
  if (url.pathname === '/api/music/search') return musicSearchApi(request, ctx);
  if (url.pathname === '/api/music/artwork') return musicArtworkApi(request, ctx);
  if (request.method === 'POST' && url.pathname === '/api/rooms') return createRoom(request, env);
  const shareMatch = url.pathname.match(SHARE_PATH);
  if (shareMatch && request.method === 'GET') {
    return publicShareApi(request, env, shareMatch[1], shareMatch[2] ?? '');
  }
  const match = url.pathname.match(ROOM_PATH);
  if (!match) throw new HttpError(404, '接口不存在', 'not_found');
  return roomApi(request, env, match[1], match[2] ?? '');
}

async function cleanupExpired(env: Env) {
  const expiredResult = await env.DB.prepare('SELECT id FROM rooms WHERE expires_at <= ? LIMIT 100')
    .bind(nowIso())
    .all<{ id: string }>();
  for (const { id } of expiredResult.results) {
    const referenced = await env.DB.prepare(
      `SELECT sa.object_key
       FROM share_assets sa JOIN shares s ON s.id = sa.share_id
       WHERE s.room_id = ? AND s.status IN ('pending', 'active') AND s.expires_at > ?`,
    )
      .bind(id, nowIso())
      .all<{ object_key: string }>();
    const keptKeys = new Set(referenced.results.map((asset) => asset.object_key));
    let cursor: string | undefined;
    do {
      const listed = await env.AVATARS.list({ prefix: `${id}/`, cursor });
      const deletable = listed.objects.map((object) => object.key).filter((key) => !keptKeys.has(key));
      if (deletable.length) await env.AVATARS.delete(deletable);
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM reopen_votes WHERE room_id = ?').bind(id),
      env.DB.prepare('DELETE FROM answers WHERE room_id = ?').bind(id),
      env.DB.prepare('DELETE FROM rounds WHERE room_id = ?').bind(id),
      env.DB.prepare('DELETE FROM participants WHERE room_id = ?').bind(id),
      env.DB.prepare('DELETE FROM rooms WHERE id = ?').bind(id),
    ]);
  }
}

async function cleanupExpiredShares(env: Env) {
  const now = nowIso();
  const abandonedBefore = new Date(Date.now() - PENDING_SHARE_TTL_MS).toISOString();
  const result = await env.DB.prepare(
    `SELECT * FROM shares
     WHERE (status = 'active' AND expires_at <= ?)
        OR (status = 'pending' AND created_at <= ?)
     LIMIT 100`,
  )
    .bind(now, abandonedBefore)
    .all<ShareRow>();
  for (const row of result.results) await retireShare(env, row, 'expired');
}

export class RoomCoordinator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  private broadcast(event: ServerEvent, except?: WebSocket) {
    const message = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket !== except && socket.readyState === WebSocket.OPEN) socket.send(message);
    }
  }

  private sendToParticipant(participantId: string, event: ServerEvent) {
    const message = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets(`participant:${participantId}`)) {
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
    }
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/ws') return this.connectWebSocket(request);
      if (path === '/join') return this.join(request);
      const participantId = request.headers.get('X-Participant-Id');
      if (!participantId) throw new HttpError(401, '缺少参与者身份', 'unauthorized');
      if (path === '/draft') return this.saveDraft(request, participantId);
      if (path === '/avatar') return this.setAvatar(request, participantId);
      if (path === '/answer-image') return this.setAnswerImage(request, participantId);
      if (path === '/submit') return this.submit(request, participantId);
      if (path === '/edit') return this.editPublishedAnswer(participantId);
      if (path === '/reopen') return this.voteToReopen(request, participantId);
      if (path === '/join-code') return this.recoverJoinCode(participantId);
      throw new HttpError(404, '操作不存在', 'not_found');
    } catch (error) {
      if (error instanceof ZodError) return json({ error: 'validation_error', message: '填写内容格式不正确' }, { status: 400 });
      return errorResponse(error);
    }
  }

  private connectWebSocket(request: Request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      throw new HttpError(426, '需要 WebSocket 连接', 'upgrade_required');
    }
    const participantId = request.headers.get('X-Participant-Id');
    if (!participantId) throw new HttpError(401, '缺少参与者身份', 'unauthorized');
    const alreadyOnline = new Set<string>();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as { participantId?: string } | null;
      if (attachment?.participantId && attachment.participantId !== participantId) {
        alreadyOnline.add(attachment.participantId);
      }
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [`participant:${participantId}`]);
    server.serializeAttachment({ participantId });
    for (const onlineId of alreadyOnline) {
      server.send(JSON.stringify({ type: 'presence', participantId: onlineId, online: true } satisfies ServerEvent));
    }
    this.broadcast({ type: 'presence', participantId, online: true }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string) {
    const attachment = socket.deserializeAttachment() as { participantId?: string } | null;
    if (attachment?.participantId) {
      const stillOnline = this.ctx
        .getWebSockets(`participant:${attachment.participantId}`)
        .some((candidate) => candidate !== socket && candidate.readyState === WebSocket.OPEN);
      if (!stillOnline) {
        this.broadcast({ type: 'presence', participantId: attachment.participantId, online: false }, socket);
      }
    }
    socket.close(code, reason);
  }

  async webSocketError(socket: WebSocket) {
    socket.close(1011, '连接异常');
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (message === 'state') socket.send(JSON.stringify({ type: 'submission_changed' } satisfies ServerEvent));
  }

  private async roomAndParticipant(participantId: string) {
    const participant = await this.env.DB.prepare('SELECT * FROM participants WHERE id = ?')
      .bind(participantId)
      .first<ParticipantRow>();
    if (!participant) throw new HttpError(401, '参与者身份无效', 'unauthorized');
    const room = await getRoom(this.env.DB, participant.room_id);
    if (!room) throw new HttpError(404, '房间不存在', 'not_found');
    if (room.expires_at <= nowIso()) throw new HttpError(410, '房间已过期', 'expired');
    return { room, participant };
  }

  private async join(request: Request) {
    const input = joinRoomSchema.parse(await readJson(request));
    const roomId = this.roomIdFromObject();
    const room = await getRoom(this.env.DB, roomId);
    if (!room) throw new HttpError(404, '房间不存在', 'not_found');
    if (room.expires_at <= nowIso()) throw new HttpError(410, '房间已过期', 'expired');
    const clientKey = await hashSecret(request.headers.get('X-Client-IP') ?? 'local', this.env.AUTH_PEPPER);
    const rateKey = `join:${clientKey}`;
    const rate = (await this.ctx.storage.get<{ count: number; resetAt: number }>(rateKey)) ?? {
      count: 0,
      resetAt: Date.now() + 10 * 60_000,
    };
    if (rate.resetAt < Date.now()) {
      rate.count = 0;
      rate.resetAt = Date.now() + 10 * 60_000;
    }
    if (rate.count >= 8) throw new HttpError(429, '尝试次数过多，请稍后再试', 'rate_limited');
    const submittedHash = await hashSecret(input.joinCode, this.env.AUTH_PEPPER);
    if (!timingSafeEqual(submittedHash, room.join_code_hash)) {
      rate.count += 1;
      await this.ctx.storage.put(rateKey, rate);
      throw new HttpError(401, '加入码不正确', 'invalid_join_code');
    }
    await this.ctx.storage.delete(rateKey);

    const guestCount = await this.env.DB.prepare(
      'SELECT COUNT(*) AS count FROM participants WHERE room_id = ? AND slot = 2',
    )
      .bind(roomId)
      .first<{ count: number }>();
    if ((guestCount?.count ?? 0) >= MAX_GUESTS) {
      throw new HttpError(409, '这个房间的二号人数已满', 'room_full');
    }

    const participantId = crypto.randomUUID();
    const token = randomToken();
    const recoveryCode = randomString(12);
    const [tokenHash, recoveryHash] = await Promise.all([
      hashSecret(token, this.env.AUTH_PEPPER),
      hashSecret(recoveryCode, this.env.AUTH_PEPPER),
    ]);
    const now = nowIso();
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO participants (id, room_id, slot, nickname, token_hash, recovery_hash, created_at)
         VALUES (?, ?, 2, ?, ?, ?, ?)`,
      ).bind(participantId, roomId, input.nickname, tokenHash, recoveryHash, now),
      this.env.DB.prepare(
        `INSERT INTO answers (room_id, round_number, participant_id, content_json, version, updated_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
      ).bind(roomId, room.current_round, participantId, JSON.stringify(createEmptyDraft()), now),
      this.env.DB.prepare(
        `UPDATE rooms SET status = ?, version = version + 1, last_active_at = ?, expires_at = ? WHERE id = ?`,
      ).bind('filling', now, expiryIso(new Date(now)), roomId),
    ]);
    this.broadcast({ type: 'partner_joined' });
    return json({ roomId, recoveryCode, token }, { status: 201 });
  }

  private async recoverJoinCode(participantId: string) {
    const { room, participant } = await this.roomAndParticipant(participantId);
    if (participant.slot !== 1) {
      throw new HttpError(403, '只有房间创建者可以恢复加入码', 'host_only');
    }
    const joinCode = await deriveJoinCode(room.id, this.env.AUTH_PEPPER);
    const joinHash = await hashSecret(joinCode, this.env.AUTH_PEPPER);
    const rotated = !timingSafeEqual(joinHash, room.join_code_hash);
    if (rotated) {
      const now = nowIso();
      await this.env.DB.prepare(
        `UPDATE rooms SET join_code_hash = ?, version = version + 1, last_active_at = ?, expires_at = ?
         WHERE id = ?`,
      )
        .bind(joinHash, now, expiryIso(new Date(now)), room.id)
        .run();
    } else {
      await touchRoom(this.env.DB, room.id);
    }
    return json(
      { roomId: room.id, joinCode, rotated },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  private roomIdFromObject() {
    const name = this.ctx.id.name;
    if (!name) throw new HttpError(500, '房间协调器配置错误');
    return name;
  }

  private async saveDraft(request: Request, participantId: string) {
    const input = draftSchema.parse(await readJson(request));
    const { room } = await this.roomAndParticipant(participantId);
    if (!['waiting_partner', 'filling', 'partially_submitted'].includes(room.status)) {
      throw new HttpError(409, '当前轮次不能继续编辑', 'round_locked');
    }
    const current = await this.env.DB.prepare(
      'SELECT version, submitted_at FROM answers WHERE room_id = ? AND round_number = ? AND participant_id = ?',
    )
      .bind(room.id, room.current_round, participantId)
      .first<{ version: number; submitted_at: string | null }>();
    if (!current) throw new HttpError(404, '草稿不存在', 'not_found');
    if (current.submitted_at) throw new HttpError(409, '答案已经提交', 'already_submitted');
    if (current.version !== input.version) {
      throw new HttpError(409, '草稿已在其他页面更新，请刷新后重试', 'version_conflict');
    }
    const nextVersion = current.version + 1;
    const now = nowIso();
    await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE answers SET content_json = ?, version = ?, updated_at = ?
         WHERE room_id = ? AND round_number = ? AND participant_id = ?`,
      ).bind(JSON.stringify(input.answer), nextVersion, now, room.id, room.current_round, participantId),
      this.env.DB.prepare(
        'UPDATE rooms SET version = version + 1, last_active_at = ?, expires_at = ? WHERE id = ?',
      ).bind(now, expiryIso(new Date(now)), room.id),
    ]);
    this.sendToParticipant(participantId, { type: 'draft_saved', version: nextVersion });
    return json({ version: nextVersion });
  }

  private async setAvatar(request: Request, participantId: string) {
    const payload = (await readJson(request)) as { key?: unknown };
    const key = typeof payload.key === 'string' ? payload.key : '';
    const { room } = await this.roomAndParticipant(participantId);
    if (!key.startsWith(`${room.id}/${participantId}/`)) throw new HttpError(400, '头像键无效');
    if (!['filling', 'partially_submitted', 'waiting_partner'].includes(room.status)) {
      throw new HttpError(409, '当前轮次不能更换头像', 'round_locked');
    }
    const row = await this.env.DB.prepare(
      'SELECT content_json, version, submitted_at FROM answers WHERE room_id = ? AND round_number = ? AND participant_id = ?',
    )
      .bind(room.id, room.current_round, participantId)
      .first<{ content_json: string; version: number; submitted_at: string | null }>();
    if (!row || row.submitted_at) throw new HttpError(409, '答案已经提交', 'already_submitted');
    const previous = answerSchema.parse(JSON.parse(row.content_json));
    const next: AnswerDraft = { ...previous, avatarKey: key };
    const now = nowIso();
    await this.env.DB.batch([
      this.env.DB.prepare(
        'UPDATE answers SET content_json = ?, version = version + 1, updated_at = ? WHERE room_id = ? AND round_number = ? AND participant_id = ?',
      ).bind(JSON.stringify(next), now, room.id, room.current_round, participantId),
      this.env.DB.prepare('UPDATE rooms SET last_active_at = ?, expires_at = ? WHERE id = ?').bind(
        now,
        expiryIso(new Date(now)),
        room.id,
      ),
    ]);
    if (previous.avatarKey && previous.avatarKey !== key) {
      await deleteRoomMediaIfUnreferenced(this.env, previous.avatarKey);
    }
    return json({ avatarKey: key, version: row.version + 1 });
  }

  private async setAnswerImage(request: Request, participantId: string) {
    const payload = (await readJson(request)) as { field?: unknown; key?: unknown };
    const field = typeof payload.field === 'string' ? payload.field : '';
    if (!isAnswerFieldKey(field)) throw new HttpError(400, '答案字段无效', 'invalid_field');
    const { room } = await this.roomAndParticipant(participantId);
    if (!['filling', 'partially_submitted', 'waiting_partner'].includes(room.status)) {
      throw new HttpError(409, '当前轮次不能更换图片', 'round_locked');
    }
    const row = await this.env.DB.prepare(
      'SELECT content_json, version, submitted_at FROM answers WHERE room_id = ? AND round_number = ? AND participant_id = ?',
    )
      .bind(room.id, room.current_round, participantId)
      .first<{ content_json: string; version: number; submitted_at: string | null }>();
    if (!row || row.submitted_at) throw new HttpError(409, '答案已经提交', 'already_submitted');
    const previous = parseAnswer(row.content_json);
    const nextKey = request.method === 'DELETE' ? null : typeof payload.key === 'string' ? payload.key : '';
    if (nextKey && !nextKey.startsWith(`${room.id}/${participantId}/answers/${field}/`)) {
      throw new HttpError(400, '答案图片键无效', 'invalid_media_key');
    }
    if (request.method !== 'DELETE' && !nextKey) {
      throw new HttpError(400, '答案图片键无效', 'invalid_media_key');
    }
    const previousKey = previous.imageKeys[field];
    const next: AnswerDraft = {
      ...previous,
      imageKeys: { ...previous.imageKeys, [field]: nextKey || null },
    };
    const now = nowIso();
    await this.env.DB.batch([
      this.env.DB.prepare(
        'UPDATE answers SET content_json = ?, version = version + 1, updated_at = ? WHERE room_id = ? AND round_number = ? AND participant_id = ?',
      ).bind(JSON.stringify(next), now, room.id, room.current_round, participantId),
      this.env.DB.prepare('UPDATE rooms SET last_active_at = ?, expires_at = ? WHERE id = ?').bind(
        now,
        expiryIso(new Date(now)),
        room.id,
      ),
    ]);
    return json({ imageKey: nextKey || null, previousKey, version: row.version + 1 });
  }

  private async submit(_request: Request, participantId: string) {
    const { room } = await this.roomAndParticipant(participantId);
    if (!['waiting_partner', 'filling', 'partially_submitted'].includes(room.status)) {
      throw new HttpError(409, '当前轮次不能提交', 'round_locked');
    }
    const row = await this.env.DB.prepare(
      'SELECT content_json, submitted_at FROM answers WHERE room_id = ? AND round_number = ? AND participant_id = ?',
    )
      .bind(room.id, room.current_round, participantId)
      .first<{ content_json: string; submitted_at: string | null }>();
    if (!row) throw new HttpError(404, '答案不存在', 'not_found');
    if (row.submitted_at) return json({ status: room.status });
    const answer = answerSchema.parse(JSON.parse(row.content_json));
    if (!hasMinimumAnswer(answer)) {
      throw new HttpError(400, '请上传头像，并至少填写一段文字或上传一张答案图片', 'incomplete_answer');
    }
    const now = nowIso();
    await this.env.DB.prepare(
      'UPDATE answers SET submitted_at = ?, updated_at = ? WHERE room_id = ? AND round_number = ? AND participant_id = ?',
    )
      .bind(now, now, room.id, room.current_round, participantId)
      .run();
    await this.env.DB.prepare(
      `UPDATE rooms SET status = CASE WHEN status = 'waiting_partner' THEN 'waiting_partner' ELSE 'filling' END,
       version = version + 1, last_active_at = ?, expires_at = ? WHERE id = ?`,
    )
      .bind(now, expiryIso(new Date(now)), room.id)
      .run();
    this.broadcast({ type: 'result_published', participantId });
    return json({ status: 'published' });
  }

  private async editPublishedAnswer(participantId: string) {
    const { room } = await this.roomAndParticipant(participantId);
    const row = await this.env.DB.prepare(
      'SELECT version, submitted_at FROM answers WHERE room_id = ? AND round_number = ? AND participant_id = ?',
    )
      .bind(room.id, room.current_round, participantId)
      .first<{ version: number; submitted_at: string | null }>();
    if (!row) throw new HttpError(404, '答案不存在', 'not_found');
    if (!row.submitted_at) return json({ version: row.version });

    const guest = await this.env.DB.prepare(
      'SELECT 1 AS found FROM participants WHERE room_id = ? AND slot = 2 LIMIT 1',
    )
      .bind(room.id)
      .first<{ found: number }>();
    const now = nowIso();
    const nextVersion = row.version + 1;
    await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE answers SET submitted_at = NULL, version = ?, updated_at = ?
         WHERE room_id = ? AND round_number = ? AND participant_id = ?`,
      ).bind(nextVersion, now, room.id, room.current_round, participantId),
      this.env.DB.prepare(
        `UPDATE rooms SET status = ?, version = version + 1, last_active_at = ?, expires_at = ?
         WHERE id = ?`,
      ).bind(guest ? 'filling' : 'waiting_partner', now, expiryIso(new Date(now)), room.id),
      this.env.DB.prepare(
        'DELETE FROM reopen_votes WHERE room_id = ? AND round_number = ?',
      ).bind(room.id, room.current_round),
    ]);
    this.broadcast({ type: 'submission_changed' });
    return json({ version: nextVersion });
  }

  private async voteToReopen(_request: Request, participantId: string) {
    const { room } = await this.roomAndParticipant(participantId);
    if (!['revealed', 'reopen_pending'].includes(room.status)) {
      throw new HttpError(409, '现在还不能开启下一轮', 'invalid_state');
    }
    const now = nowIso();
    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO reopen_votes (room_id, round_number, participant_id, created_at)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(room.id, room.current_round, participantId, now)
      .run();
    const votes = await this.env.DB.prepare(
      'SELECT COUNT(*) AS count FROM reopen_votes WHERE room_id = ? AND round_number = ?',
    )
      .bind(room.id, room.current_round)
      .first<{ count: number }>();
    if ((votes?.count ?? 0) >= 2) {
      const nextRound = room.current_round + 1;
      const people = await this.env.DB.prepare('SELECT id FROM participants WHERE room_id = ? ORDER BY slot')
        .bind(room.id)
        .all<{ id: string }>();
      const statements = [
        this.env.DB.prepare('INSERT INTO rounds (room_id, round_number, created_at) VALUES (?, ?, ?)').bind(
          room.id,
          nextRound,
          now,
        ),
        ...people.results.map((person) =>
          this.env.DB.prepare(
            `INSERT INTO answers (room_id, round_number, participant_id, content_json, version, updated_at)
             VALUES (?, ?, ?, ?, 0, ?)`,
          ).bind(room.id, nextRound, person.id, JSON.stringify(createEmptyDraft()), now),
        ),
        this.env.DB.prepare(
          `UPDATE rooms SET status = 'filling', current_round = ?, version = version + 1,
           last_active_at = ?, expires_at = ? WHERE id = ?`,
        ).bind(nextRound, now, expiryIso(new Date(now)), room.id),
      ];
      await this.env.DB.batch(statements);
      this.broadcast({ type: 'round_started', roundNumber: nextRound });
      return json({ status: 'filling', roundNumber: nextRound });
    }
    await this.env.DB.prepare(
      `UPDATE rooms SET status = 'reopen_pending', version = version + 1, last_active_at = ?, expires_at = ? WHERE id = ?`,
    )
      .bind(now, expiryIso(new Date(now)), room.id)
      .run();
    this.broadcast({ type: 'reopen_vote' });
    return json({ status: 'reopen_pending' });
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) return secureHeaders(await apiFetch(request, env, ctx));
      return secureHeaders(await handle(request, env, ctx));
    } catch (error) {
      if (error instanceof ZodError) {
        return secureHeaders(json({ error: 'validation_error', message: '输入内容格式不正确' }, { status: 400 }));
      }
      return secureHeaders(errorResponse(error));
    }
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(cleanupExpiredShares(env).then(() => cleanupExpired(env)));
  },
} satisfies ExportedHandler<Env>;
