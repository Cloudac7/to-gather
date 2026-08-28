import { z } from 'zod';
import { ANSWER_FIELD_KEYS, DEFAULT_ROOM_TEMPLATE } from './types';

const shortText = z.string().trim().max(80);
const mediaKey = z.string().max(240).nullable();

export const answerImagesSchema = z.object({
  favoriteAnimal: mediaKey,
  favoriteColor: mediaKey,
  favoritePerson: mediaKey,
  favoriteSong: mediaKey,
  mbti: mediaKey,
  recentProduct: mediaKey,
  dreamActivity: mediaKey,
  curiousAbout: mediaKey,
  message: mediaKey,
}).strict();

export const answerSchema = z.object({
  favoriteAnimal: shortText,
  favoriteColor: shortText,
  favoritePerson: shortText,
  favoriteSong: shortText,
  mbti: z.string().trim().max(16),
  recentProduct: z.string().trim().max(120),
  dreamActivity: z.string().trim().max(240),
  curiousAbout: z.string().trim().max(240),
  message: z.string().trim().max(500),
  avatarKey: mediaKey,
  imageKeys: answerImagesSchema,
});

const singleLine = (max: number) => z.string().trim().max(max).refine((value) => !/[\r\n]/.test(value), {
  message: '标题不能换行',
});

export const roomTemplateSchema = z.object({
  title: singleLine(24).min(1),
  subtitle: singleLine(40),
  fieldLabels: z.object({
    favoriteAnimal: singleLine(12).min(1),
    favoriteColor: singleLine(12).min(1),
    favoritePerson: singleLine(12).min(1),
    favoriteSong: singleLine(12).min(1),
    mbti: singleLine(12).min(1),
    recentProduct: singleLine(12).min(1),
    dreamActivity: singleLine(12).min(1),
    curiousAbout: singleLine(12).min(1),
    message: singleLine(12).min(1),
  }).strict(),
});

export const createRoomSchema = z.object({
  nickname: z.string().trim().min(1).max(24),
  template: roomTemplateSchema.default(DEFAULT_ROOM_TEMPLATE),
});

export const joinRoomSchema = z.object({
  nickname: z.string().trim().min(1).max(24),
  joinCode: z.string().trim().regex(/^\d{6}$/),
});

export const recoverRoomSchema = z.object({
  nickname: z.string().trim().min(1).max(24),
  slot: z.union([z.literal(1), z.literal(2)]),
  recoveryCode: z.string().trim().toUpperCase().regex(/^[A-Z2-9]{12}$/),
});

export const draftSchema = z.object({
  answer: answerSchema,
  version: z.number().int().min(0),
});

export const shareCreateSchema = z.object({
  pairParticipantId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  forceNew: z.boolean().optional().default(false),
});

export function hasMinimumAnswer(answer: z.infer<typeof answerSchema>) {
  const hasText = ANSWER_FIELD_KEYS.some((key) => Boolean(answer[key]));
  const hasImage = ANSWER_FIELD_KEYS.some((key) => Boolean(answer.imageKeys[key]));
  return Boolean(answer.avatarKey && (hasText || hasImage));
}
