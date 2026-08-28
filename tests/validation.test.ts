import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOM_TEMPLATE, EMPTY_DRAFT } from '../src/lib/types';
import {
  answerSchema,
  createRoomSchema,
  hasMinimumAnswer,
  joinRoomSchema,
  recoverRoomSchema,
  roomTemplateSchema,
  shareCreateSchema,
} from '../src/lib/validation';

describe('room input validation', () => {
  it('trims and accepts a valid nickname', () => {
    expect(createRoomSchema.parse({ nickname: '  小雨  ' })).toEqual({
      nickname: '小雨',
      template: DEFAULT_ROOM_TEMPLATE,
    });
  });

  it('requires an exact six-digit join code', () => {
    expect(joinRoomSchema.safeParse({ nickname: 'A', joinCode: '123456' }).success).toBe(true);
    expect(joinRoomSchema.safeParse({ nickname: 'A', joinCode: '12345x' }).success).toBe(false);
  });

  it('normalizes recovery codes before validation at the API boundary', () => {
    expect(
      recoverRoomSchema.safeParse({ nickname: 'A', slot: 1, recoveryCode: 'ABCD2EFG3HJK' }).success,
    ).toBe(true);
    expect(
      recoverRoomSchema.safeParse({ nickname: 'A', slot: 3, recoveryCode: 'ABCD2EFG3HJK' }).success,
    ).toBe(false);
  });

  it('validates the fixed room template limits', () => {
    expect(roomTemplateSchema.safeParse(DEFAULT_ROOM_TEMPLATE).success).toBe(true);
    expect(roomTemplateSchema.safeParse({ ...DEFAULT_ROOM_TEMPLATE, title: 'x'.repeat(25) }).success).toBe(false);
    expect(roomTemplateSchema.safeParse({ ...DEFAULT_ROOM_TEMPLATE, title: '标题\n换行' }).success).toBe(false);
  });

  it('accepts only UUID participant ids when creating a share', () => {
    expect(shareCreateSchema.safeParse({ pairParticipantId: '7849f678-5988-4bf5-a134-10b726de3590' }).success).toBe(true);
    expect(shareCreateSchema.safeParse({ pairParticipantId: 'guest-1' }).success).toBe(false);
  });
});

describe('answer validation', () => {
  it('keeps an empty draft valid for autosave', () => {
    expect(answerSchema.parse(EMPTY_DRAFT)).toEqual(EMPTY_DRAFT);
  });

  it('requires an avatar and at least one answer before submit', () => {
    expect(hasMinimumAnswer(EMPTY_DRAFT)).toBe(false);
    expect(hasMinimumAnswer({ ...EMPTY_DRAFT, avatarKey: 'room/person/avatar.webp' })).toBe(false);
    expect(
      hasMinimumAnswer({ ...EMPTY_DRAFT, avatarKey: 'room/person/avatar.webp', favoriteAnimal: '猫' }),
    ).toBe(true);
    expect(
      hasMinimumAnswer({
        ...EMPTY_DRAFT,
        imageKeys: { ...EMPTY_DRAFT.imageKeys, favoriteAnimal: 'room/person/answer.webp' },
        avatarKey: 'room/person/avatar.webp',
      }),
    ).toBe(true);
  });

  it('rejects overlong free text', () => {
    expect(answerSchema.safeParse({ ...EMPTY_DRAFT, message: 'x'.repeat(501) }).success).toBe(false);
  });
});
