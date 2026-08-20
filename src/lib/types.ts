export const ROOM_STATUSES = [
  'waiting_partner',
  'filling',
  'partially_submitted',
  'revealed',
  'reopen_pending',
  'expired',
] as const;

export type RoomStatus = (typeof ROOM_STATUSES)[number];

export interface AnswerDraft {
  favoriteAnimal: string;
  favoriteColor: string;
  favoritePerson: string;
  favoriteSong: string;
  mbti: string;
  recentProduct: string;
  dreamActivity: string;
  curiousAbout: string;
  message: string;
  avatarKey: string | null;
}

export const EMPTY_DRAFT: AnswerDraft = {
  favoriteAnimal: '',
  favoriteColor: '',
  favoritePerson: '',
  favoriteSong: '',
  mbti: '',
  recentProduct: '',
  dreamActivity: '',
  curiousAbout: '',
  message: '',
  avatarKey: null,
};

export interface ParticipantView {
  id: string;
  slot: 1 | 2;
  nickname: string;
  isMe: boolean;
  submitted: boolean;
  wantsReopen: boolean;
}

export interface RevealedAnswer {
  participantId: string;
  slot: 1 | 2;
  nickname: string;
  answer: AnswerDraft;
}

export interface RoundHistory {
  roundNumber: number;
  revealedAt: string;
  answers: RevealedAnswer[];
}

export interface AuthenticatedRoomState {
  access: 'participant';
  roomId: string;
  status: RoomStatus;
  roundNumber: number;
  expiresAt: string;
  version: number;
  participants: ParticipantView[];
  ownDraft: AnswerDraft | null;
  publishedAnswers: RevealedAnswer[];
  history: RoundHistory[];
}

export interface VisitorRoomState {
  access: 'joinable' | 'full' | 'expired' | 'not_found';
  roomId: string;
}

export type RoomState = AuthenticatedRoomState | VisitorRoomState;

export type ServerEvent =
  | { type: 'presence'; participantId: string; online: boolean }
  | { type: 'partner_joined' }
  | { type: 'draft_saved'; version: number }
  | { type: 'submission_changed' }
  | { type: 'result_published'; participantId: string }
  | { type: 'revealed' }
  | { type: 'reopen_vote' }
  | { type: 'round_started'; roundNumber: number }
  | { type: 'room_expired' }
  | { type: 'error'; message: string };

export interface CreateRoomResponse {
  roomId: string;
  inviteUrl: string;
  joinCode: string;
  recoveryCode: string;
}

export interface JoinRoomResponse {
  roomId: string;
  recoveryCode: string;
}
