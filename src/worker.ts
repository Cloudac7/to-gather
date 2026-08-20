import { handle } from '@astrojs/cloudflare/handler';
import { DurableObject } from 'cloudflare:workers';
import { ZodError } from 'zod';
import type { AnswerDraft, ServerEvent } from './lib/types';
import { EMPTY_DRAFT } from './lib/types';
import {
  createParticipantCookie,
  hashSecret,
  isSecureRequest,
  randomRoomId,
  randomString,
  randomToken,
  timingSafeEqual,
} from './lib/security';
import {
  answerSchema,
  createRoomSchema,
  draftSchema,
  hasMinimumAnswer,
  joinRoomSchema,
  recoverRoomSchema,
} from './lib/validation';
import {
  buildRoomState,
  expiryIso,
  getParticipantFromRequest,
  getRoom,
  nowIso,
  touchRoom,
  type ParticipantRow,
} from './server/db';
import { assertSameOrigin, errorResponse, HttpError, json, readJson } from './server/http';

const ROOM_PATH = /^\/api\/rooms\/([a-z2-9]{12})(?:\/(.*))?$/;

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

async function createRoom(request: Request, env: Env) {
  assertSameOrigin(request);
  const input = createRoomSchema.parse(await readJson(request));
  const roomId = randomRoomId();
  const participantId = crypto.randomUUID();
  const joinCode = randomString(6, '0123456789');
  const recoveryCode = randomString(12);
  const token = randomToken();
  const [joinHash, recoveryHash, tokenHash] = await Promise.all([
    hashSecret(joinCode, env.AUTH_PEPPER),
    hashSecret(recoveryCode, env.AUTH_PEPPER),
    hashSecret(token, env.AUTH_PEPPER),
  ]);
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO rooms (id, join_code_hash, status, current_round, version, created_at, last_active_at, expires_at)
       VALUES (?, ?, 'waiting_partner', 1, 1, ?, ?, ?)`,
    ).bind(roomId, joinHash, now, now, expiryIso(new Date(now))),
    env.DB.prepare(
      `INSERT INTO participants (id, room_id, slot, nickname, token_hash, recovery_hash, created_at)
       VALUES (?, ?, 1, ?, ?, ?, ?)`,
    ).bind(participantId, roomId, input.nickname, tokenHash, recoveryHash, now),
    env.DB.prepare('INSERT INTO rounds (room_id, round_number, created_at) VALUES (?, 1, ?)').bind(
      roomId,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO answers (room_id, round_number, participant_id, content_json, version, updated_at)
       VALUES (?, 1, ?, ?, 0, ?)`,
    ).bind(roomId, participantId, JSON.stringify(EMPTY_DRAFT), now),
  ]);

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

async function roomApi(request: Request, env: Env, roomId: string, tail = ''): Promise<Response> {
  const participant = await getParticipantFromRequest(request, env, roomId);
  if (request.method === 'GET' && !tail) {
    if (participant) await touchRoom(env.DB, roomId);
    return json(await buildRoomState(env, roomId, participant));
  }
  if (request.method === 'POST' && tail === 'join') return joinRoom(request, env, roomId);
  if (request.method === 'POST' && tail === 'recover') return recoverRoom(request, env, roomId);
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
  if (tail === 'draft' && request.method === 'PATCH') {
    return proxyMutation(request, env, roomId, 'draft', participant);
  }
  if (tail === 'submit' && request.method === 'POST') {
    return proxyMutation(request, env, roomId, 'submit', participant);
  }
  if (tail === 'reopen-vote' && request.method === 'POST') {
    return proxyMutation(request, env, roomId, 'reopen', participant);
  }
  throw new HttpError(404, '接口不存在', 'not_found');
}

async function apiFetch(request: Request, env: Env) {
  const url = new URL(request.url);
  if (request.method === 'POST' && url.pathname === '/api/rooms') return createRoom(request, env);
  const match = url.pathname.match(ROOM_PATH);
  if (!match) throw new HttpError(404, '接口不存在', 'not_found');
  return roomApi(request, env, match[1], match[2] ?? '');
}

async function cleanupExpired(env: Env) {
  const expiredResult = await env.DB.prepare('SELECT id FROM rooms WHERE expires_at <= ? LIMIT 100')
    .bind(nowIso())
    .all<{ id: string }>();
  for (const { id } of expiredResult.results) {
    let cursor: string | undefined;
    do {
      const listed = await env.AVATARS.list({ prefix: `${id}/`, cursor });
      if (listed.objects.length) await env.AVATARS.delete(listed.objects.map((object) => object.key));
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
      if (path === '/submit') return this.submit(request, participantId);
      if (path === '/reopen') return this.voteToReopen(request, participantId);
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
      ).bind(roomId, room.current_round, participantId, JSON.stringify(EMPTY_DRAFT), now),
      this.env.DB.prepare(
        `UPDATE rooms SET status = ?, version = version + 1, last_active_at = ?, expires_at = ? WHERE id = ?`,
      ).bind('filling', now, expiryIso(new Date(now)), roomId),
    ]);
    this.broadcast({ type: 'partner_joined' });
    return json({ roomId, recoveryCode, token }, { status: 201 });
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
    if (previous.avatarKey && previous.avatarKey !== key) await this.env.AVATARS.delete(previous.avatarKey);
    return json({ avatarKey: key, version: row.version + 1 });
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
      throw new HttpError(400, '请上传头像并至少填写一个答案', 'incomplete_answer');
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
          ).bind(room.id, nextRound, person.id, JSON.stringify(EMPTY_DRAFT), now),
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
      if (url.pathname.startsWith('/api/')) return secureHeaders(await apiFetch(request, env));
      return secureHeaders(await handle(request, env, ctx));
    } catch (error) {
      if (error instanceof ZodError) {
        return secureHeaders(json({ error: 'validation_error', message: '输入内容格式不正确' }, { status: 400 }));
      }
      return secureHeaders(errorResponse(error));
    }
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(cleanupExpired(env));
  },
} satisfies ExportedHandler<Env>;
