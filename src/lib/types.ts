export const ROOM_STATUSES = [
  'waiting_partner',
  'filling',
  'partially_submitted',
  'revealed',
  'reopen_pending',
  'expired',
] as const;

export type RoomStatus = (typeof ROOM_STATUSES)[number];

export const ANSWER_FIELD_KEYS = [
  'favoriteAnimal',
  'favoriteColor',
  'favoritePerson',
  'favoriteSong',
  'mbti',
  'recentProduct',
  'dreamActivity',
  'curiousAbout',
  'message',
] as const;

export type AnswerFieldKey = (typeof ANSWER_FIELD_KEYS)[number];
export type GridAnswerFieldKey = Exclude<AnswerFieldKey, 'message'>;
export type AnswerImageMap = Record<AnswerFieldKey, string | null>;
export type AnswerImageUrlMap = Record<AnswerFieldKey, string | null>;
export type RoomVariant = 'classic' | 'music';
export type MusicEntityKind = 'artist' | 'album' | 'song';
export type MusicFieldType = MusicEntityKind | 'custom';
export type MusicProvider = 'itunes' | 'theaudiodb';

export interface MusicSelection {
  provider: MusicProvider;
  id: number;
  kind: MusicEntityKind;
  title: string;
  artistName: string;
  collectionName: string | null;
  artworkUrl: string | null;
  storeUrl: string | null;
}

export type MusicSelectionMap = Record<AnswerFieldKey, MusicSelection | null>;
export type MusicSearchResult = MusicSelection;

export interface MusicSearchResponse {
  results: MusicSearchResult[];
}

export const DEFAULT_ROOM_TEMPLATE = {
  variant: 'classic',
  title: '这样的两个人，是亲友？',
  subtitle: '不知道啊，我们就玩到一起了',
  fieldLabels: {
    favoriteAnimal: '最喜欢的动物',
    favoriteColor: '最喜欢的颜色',
    favoritePerson: '最喜欢的人物',
    favoriteSong: '最喜欢的歌',
    mbti: 'MBTI',
    recentProduct: '最近买的产品',
    dreamActivity: '最想和对方一起做的事情',
    curiousAbout: '想问但一直没认真了解的',
    message: '自由发言（搏击）区',
  },
  fieldTypes: {
    favoriteAnimal: 'custom',
    favoriteColor: 'custom',
    favoritePerson: 'custom',
    favoriteSong: 'custom',
    mbti: 'custom',
    recentProduct: 'custom',
    dreamActivity: 'custom',
    curiousAbout: 'custom',
    message: 'custom',
  },
} satisfies RoomTemplate;

export const MUSIC_ROOM_TEMPLATE = {
  variant: 'music',
  title: '靠 我的歌品真他妈牛逼',
  subtitle: '亲友你懂我的歌品',
  fieldLabels: {
    favoriteAnimal: '最喜欢的歌手',
    favoriteColor: '最喜欢的专辑',
    favoritePerson: '循环最多的歌曲',
    favoriteSong: '最喜欢的歌词',
    mbti: '最喜欢的华语歌',
    recentProduct: '最近听上的歌',
    dreamActivity: '最想给对面推荐的歌',
    curiousAbout: '最喜欢的其他语言的歌曲',
    message: '自由发言区',
  },
  fieldTypes: {
    favoriteAnimal: 'artist',
    favoriteColor: 'album',
    favoritePerson: 'song',
    favoriteSong: 'song',
    mbti: 'song',
    recentProduct: 'song',
    dreamActivity: 'song',
    curiousAbout: 'song',
    message: 'custom',
  },
} satisfies RoomTemplate;

export interface RoomTemplate {
  variant: RoomVariant;
  title: string;
  subtitle: string;
  fieldLabels: Record<AnswerFieldKey, string>;
  fieldTypes: Record<AnswerFieldKey, MusicFieldType>;
}

export const EMPTY_ANSWER_IMAGES: AnswerImageMap = {
  favoriteAnimal: null,
  favoriteColor: null,
  favoritePerson: null,
  favoriteSong: null,
  mbti: null,
  recentProduct: null,
  dreamActivity: null,
  curiousAbout: null,
  message: null,
};

export const EMPTY_MUSIC_SELECTIONS: MusicSelectionMap = {
  favoriteAnimal: null,
  favoriteColor: null,
  favoritePerson: null,
  favoriteSong: null,
  mbti: null,
  recentProduct: null,
  dreamActivity: null,
  curiousAbout: null,
  message: null,
};

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
  imageKeys: AnswerImageMap;
  musicSelections: MusicSelectionMap;
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
  imageKeys: { ...EMPTY_ANSWER_IMAGES },
  musicSelections: { ...EMPTY_MUSIC_SELECTIONS },
};

export function createEmptyDraft(): AnswerDraft {
  return {
    ...EMPTY_DRAFT,
    imageKeys: { ...EMPTY_ANSWER_IMAGES },
    musicSelections: { ...EMPTY_MUSIC_SELECTIONS },
  };
}

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

export type ShareStatus = 'pending' | 'active' | 'revoked' | 'expired';

export interface ShareSummary {
  id: string;
  pairParticipantId: string;
  pairNickname: string;
  status: ShareStatus;
  createdAt: string;
  expiresAt: string;
  shareUrl: string;
  posterUrl: string | null;
}

export interface AuthenticatedRoomState {
  access: 'participant';
  roomId: string;
  status: RoomStatus;
  roundNumber: number;
  expiresAt: string;
  version: number;
  template: RoomTemplate;
  participants: ParticipantView[];
  ownDraft: AnswerDraft | null;
  publishedAnswers: RevealedAnswer[];
  history: RoundHistory[];
  myShares: ShareSummary[];
}

export interface VisitorRoomState {
  access: 'joinable' | 'full' | 'expired' | 'not_found';
  roomId: string;
}

export type RoomState = AuthenticatedRoomState | VisitorRoomState;

export interface ShareSnapshot {
  roomId: string;
  roundNumber: number;
  template: RoomTemplate;
  host: RevealedAnswer;
  guest: RevealedAnswer;
  createdAt: string;
}

export interface PublicAnswer {
  participantId: string;
  slot: 1 | 2;
  nickname: string;
  answer: Omit<AnswerDraft, 'avatarKey' | 'imageKeys'> & {
    avatarUrl: string;
    imageUrls: AnswerImageUrlMap;
  };
}

export interface ActivePublicShare {
  status: 'active';
  id: string;
  title: string;
  createdAt: string;
  expiresAt: string;
  posterUrl: string;
  template: RoomTemplate;
  host: PublicAnswer;
  guest: PublicAnswer;
}

export type PublicShareState =
  | ActivePublicShare
  | { status: 'revoked' | 'expired' | 'not_found'; id: string };

export interface CreateShareResponse {
  share: ShareSummary;
  reused: boolean;
  needsPoster: boolean;
}

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

export interface RecoverJoinCodeResponse {
  roomId: string;
  joinCode: string;
  rotated: boolean;
}
