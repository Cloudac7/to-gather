import { z } from 'zod';

const shortText = z.string().trim().max(80);

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
  avatarKey: z.string().max(180).nullable(),
});

export const createRoomSchema = z.object({
  nickname: z.string().trim().min(1).max(24),
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

export function hasMinimumAnswer(answer: z.infer<typeof answerSchema>) {
  const textValues = Object.entries(answer)
    .filter(([key]) => key !== 'avatarKey')
    .map(([, value]) => value);
  return Boolean(answer.avatarKey && textValues.some(Boolean));
}
