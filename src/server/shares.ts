import type {
  AnswerImageUrlMap,
  PublicAnswer,
  PublicShareState,
  RevealedAnswer,
  ShareSnapshot,
  ShareStatus,
} from '../lib/types';
import { ANSWER_FIELD_KEYS, EMPTY_ANSWER_IMAGES, EMPTY_MUSIC_SELECTIONS } from '../lib/types';
import { nowIso, parseRoomTemplate } from './db';

export const SHARE_ID_PATTERN = /^[a-z2-9]{24}$/;

export interface ShareRow {
  id: string;
  room_id: string;
  owner_participant_id: string;
  pair_participant_id: string;
  round_number: number;
  status: ShareStatus;
  fingerprint: string;
  snapshot_json: string | null;
  poster_key: string | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  cleaned_at: string | null;
}

export function effectiveShareStatus(row: ShareRow): ShareStatus {
  if ((row.status === 'active' || row.status === 'pending') && row.expires_at <= nowIso()) return 'expired';
  return row.status;
}

export async function getShareRow(db: D1Database, shareId: string) {
  return db.prepare('SELECT * FROM shares WHERE id = ?').bind(shareId).first<ShareRow>();
}

function publicAnswer(
  shareId: string,
  answer: RevealedAnswer,
  assetIds: Map<string, string>,
): PublicAnswer {
  const { avatarKey, imageKeys, musicSelections = EMPTY_MUSIC_SELECTIONS, ...textAnswer } = answer.answer;
  const imageUrls = { ...EMPTY_ANSWER_IMAGES } as AnswerImageUrlMap;
  for (const key of ANSWER_FIELD_KEYS) {
    const objectKey = imageKeys[key];
    const assetId = objectKey ? assetIds.get(objectKey) : null;
    imageUrls[key] = assetId ? `/api/shares/${shareId}/media/${assetId}` : null;
  }
  const avatarAssetId = avatarKey ? assetIds.get(avatarKey) : null;
  return {
    participantId: answer.participantId,
    slot: answer.slot,
    nickname: answer.nickname,
    answer: {
      ...textAnswer,
      musicSelections: { ...EMPTY_MUSIC_SELECTIONS, ...musicSelections },
      avatarUrl: avatarAssetId ? `/api/shares/${shareId}/media/${avatarAssetId}` : '',
      imageUrls,
    },
  };
}

export async function getPublicShareState(env: Env, shareId: string): Promise<PublicShareState> {
  if (!SHARE_ID_PATTERN.test(shareId)) return { status: 'not_found', id: shareId };
  const row = await getShareRow(env.DB, shareId);
  if (!row || row.status === 'pending') return { status: 'not_found', id: shareId };
  const status = effectiveShareStatus(row);
  if (status === 'revoked' || status === 'expired') return { status, id: shareId };
  if (!row.snapshot_json || !row.poster_key) return { status: 'not_found', id: shareId };

  let snapshot: ShareSnapshot;
  try {
    snapshot = JSON.parse(row.snapshot_json) as ShareSnapshot;
  } catch {
    return { status: 'not_found', id: shareId };
  }
  const assets = await env.DB.prepare('SELECT asset_id, object_key FROM share_assets WHERE share_id = ?')
    .bind(shareId)
    .all<{ asset_id: string; object_key: string }>();
  const assetIds = new Map(assets.results.map((asset) => [asset.object_key, asset.asset_id]));
  return {
    status: 'active',
    id: shareId,
    title: `${snapshot.host.nickname} × ${snapshot.guest.nickname}｜${snapshot.template.title}`,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    posterUrl: `/api/shares/${shareId}/poster`,
    template: parseRoomTemplate(JSON.stringify(snapshot.template)),
    host: publicAnswer(shareId, snapshot.host, assetIds),
    guest: publicAnswer(shareId, snapshot.guest, assetIds),
  };
}
