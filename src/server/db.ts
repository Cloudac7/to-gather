import type {
  AnswerDraft,
  AuthenticatedRoomState,
  ParticipantView,
  RevealedAnswer,
  RoomState,
  RoomStatus,
  RoundHistory,
} from '../lib/types';
import { EMPTY_DRAFT } from '../lib/types';
import { hashSecret, participantCookieName, readCookie } from '../lib/security';

export interface RoomRow {
  id: string;
  join_code_hash: string;
  status: RoomStatus;
  current_round: number;
  version: number;
  created_at: string;
  last_active_at: string;
  expires_at: string;
}

export interface ParticipantRow {
  id: string;
  room_id: string;
  slot: 1 | 2;
  nickname: string;
  token_hash: string;
  recovery_hash: string;
  created_at: string;
}

interface AnswerRow {
  participant_id: string;
  slot: 1 | 2;
  nickname: string;
  content_json: string;
  version: number;
  submitted_at: string | null;
  round_number: number;
  revealed_at: string | null;
}

export const nowIso = () => new Date().toISOString();

export function expiryIso(from = new Date()) {
  return new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
}

export async function getRoom(db: D1Database, roomId: string) {
  return db.prepare('SELECT * FROM rooms WHERE id = ?').bind(roomId).first<RoomRow>();
}

export async function getParticipantFromRequest(request: Request, env: Env, roomId: string) {
  const token = readCookie(request, participantCookieName(roomId));
  if (!token) return null;
  const tokenHash = await hashSecret(token, env.AUTH_PEPPER);
  return env.DB.prepare(
    'SELECT * FROM participants WHERE room_id = ? AND token_hash = ?',
  )
    .bind(roomId, tokenHash)
    .first<ParticipantRow>();
}

export async function touchRoom(db: D1Database, roomId: string) {
  const now = nowIso();
  await db
    .prepare('UPDATE rooms SET last_active_at = ?, expires_at = ? WHERE id = ?')
    .bind(now, expiryIso(new Date(now)), roomId)
    .run();
}

function parseAnswer(content: string): AnswerDraft {
  try {
    return { ...EMPTY_DRAFT, ...JSON.parse(content) };
  } catch {
    return { ...EMPTY_DRAFT };
  }
}

export async function buildRoomState(
  env: Env,
  roomId: string,
  participant: ParticipantRow | null,
): Promise<RoomState> {
  const room = await getRoom(env.DB, roomId);
  if (!room) return { access: 'not_found', roomId };
  if (room.expires_at <= nowIso() || room.status === 'expired') {
    return { access: 'expired', roomId };
  }

  const peopleResult = await env.DB.prepare(
    'SELECT * FROM participants WHERE room_id = ? ORDER BY slot',
  )
    .bind(roomId)
    .all<ParticipantRow>();
  const people = peopleResult.results;

  if (!participant) {
    return { access: 'joinable', roomId };
  }

  // 一号可以管理整个房间；每个二号只和一号构成独立配对，
  // 因此绝不能从状态接口拿到其他二号的身份或答案。
  const visiblePeople =
    participant.slot === 1
      ? people
      : people.filter((person) => person.slot === 1 || person.id === participant.id);
  const visibleParticipantIds = new Set(visiblePeople.map((person) => person.id));

  const answerResult = await env.DB.prepare(
    `SELECT a.participant_id, p.slot, p.nickname, a.content_json, a.version,
      a.submitted_at, a.round_number, r.revealed_at
     FROM answers a
     JOIN participants p ON p.id = a.participant_id
     JOIN rounds r ON r.room_id = a.room_id AND r.round_number = a.round_number
     WHERE a.room_id = ?
     ORDER BY a.round_number DESC, p.slot ASC`,
  )
    .bind(roomId)
    .all<AnswerRow>();
  const answers = answerResult.results.filter((answer) => visibleParticipantIds.has(answer.participant_id));
  const currentAnswers = answers.filter((answer) => answer.round_number === room.current_round);
  const votesResult = await env.DB.prepare(
    'SELECT participant_id FROM reopen_votes WHERE room_id = ? AND round_number = ?',
  )
    .bind(roomId, room.current_round)
    .all<{ participant_id: string }>();
  const voters = new Set(votesResult.results.map((vote) => vote.participant_id));

  const participantViews: ParticipantView[] = visiblePeople.map((person) => ({
    id: person.id,
    slot: person.slot,
    nickname: person.nickname,
    isMe: person.id === participant.id,
    submitted: Boolean(currentAnswers.find((answer) => answer.participant_id === person.id)?.submitted_at),
    wantsReopen: voters.has(person.id),
  }));

  const ownAnswer = currentAnswers.find((answer) => answer.participant_id === participant.id);
  const publishedAnswers: RevealedAnswer[] = currentAnswers
    .filter((answer) => Boolean(answer.submitted_at))
    .map((answer) => ({
        participantId: answer.participant_id,
        slot: answer.slot,
        nickname: answer.nickname,
        answer: parseAnswer(answer.content_json),
      }));

  const historicalRoundNumbers = [
    ...new Set(
      answers
        .filter((answer) => answer.round_number < room.current_round && answer.revealed_at)
        .map((answer) => answer.round_number),
    ),
  ].sort((a, b) => b - a);
  const history: RoundHistory[] = historicalRoundNumbers.map((roundNumber) => {
    const roundAnswers = answers.filter((answer) => answer.round_number === roundNumber);
    return {
      roundNumber,
      revealedAt: roundAnswers[0]?.revealed_at ?? '',
      answers: roundAnswers.map((answer) => ({
        participantId: answer.participant_id,
        slot: answer.slot,
        nickname: answer.nickname,
        answer: parseAnswer(answer.content_json),
      })),
    };
  });

  const state: AuthenticatedRoomState = {
    access: 'participant',
    roomId,
    status: room.status,
    roundNumber: room.current_round,
    expiresAt: room.expires_at,
    version: ownAnswer?.version ?? 0,
    participants: participantViews,
    ownDraft: ownAnswer?.submitted_at ? null : ownAnswer ? parseAnswer(ownAnswer.content_json) : { ...EMPTY_DRAFT },
    publishedAnswers,
    history,
  };
  return state;
}
