import { describe, expect, it, vi } from 'vitest';
import { EMPTY_DRAFT } from '../src/lib/types';
import { forkAnswerMedia } from '../src/server/room-fork';

const context = {
  sourceRoomId: 'source234abc',
  sourceParticipantId: '7849f678-5988-4bf5-a134-10b726de3590',
  targetRoomId: 'target234abc',
  targetParticipantId: 'f3498ce7-18c5-4b5d-9bb7-5f2df2936568',
};

describe('forking a guest answer into a new room', () => {
  it('keeps text while assigning copied media to the new room and host', async () => {
    const source = {
      ...EMPTY_DRAFT,
      favoriteAnimal: '熊猫',
      avatarKey: `${context.sourceRoomId}/${context.sourceParticipantId}/avatar.png`,
      imageKeys: {
        ...EMPTY_DRAFT.imageKeys,
        favoriteAnimal: `${context.sourceRoomId}/${context.sourceParticipantId}/answers/favoriteAnimal/answer.webp`,
      },
    };
    const copyMedia = vi.fn(async () => undefined);

    const forked = await forkAnswerMedia(source, context, copyMedia);

    expect(forked.favoriteAnimal).toBe('熊猫');
    expect(forked.avatarKey).toMatch(new RegExp(`^${context.targetRoomId}/${context.targetParticipantId}/.+\\.png$`));
    expect(forked.imageKeys.favoriteAnimal).toMatch(
      new RegExp(`^${context.targetRoomId}/${context.targetParticipantId}/answers/favoriteAnimal/.+\\.webp$`),
    );
    expect(copyMedia).toHaveBeenCalledTimes(2);
    expect(source.avatarKey).toContain(context.sourceRoomId);
  });

  it('refuses media that does not belong to the source participant', async () => {
    await expect(forkAnswerMedia(
      { ...EMPTY_DRAFT, avatarKey: 'another-room/person/avatar.webp' },
      context,
      async () => undefined,
    )).rejects.toThrow('归属无效');
  });
});
