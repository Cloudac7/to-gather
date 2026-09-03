import { describe, expect, it } from 'vitest';
import { buildSingleInvitePosterInput, calculateAnswerCellLayout } from '../src/lib/poster';
import { DEFAULT_ROOM_TEMPLATE, EMPTY_ANSWER_IMAGES, EMPTY_DRAFT } from '../src/lib/types';

describe('poster answer cell layout', () => {
  it('gives text-only square cells most of the available height', () => {
    const layout = calculateAnswerCellLayout(250, 250, false, true);

    expect(layout.maxTextLines).toBeGreaterThanOrEqual(5);
  });

  it('uses the text-free answer area for a large contained image', () => {
    const layout = calculateAnswerCellLayout(250, 250, true, false);

    expect(layout.imageFit).toBe('contain');
    expect(layout.imageBox?.width).toBeGreaterThanOrEqual(210);
    expect(layout.imageBox?.height).toBeGreaterThanOrEqual(180);
  });

  it('reserves two answer lines below an image in a square cell', () => {
    const layout = calculateAnswerCellLayout(250, 250, true, true);

    expect(layout.maxTextLines).toBe(2);
    expect(layout.imageBox?.width).toBeLessThanOrEqual(168);
    expect(layout.imageBox?.height).toBeLessThanOrEqual(132);
    expect(layout.textTop + layout.maxTextLines * layout.textLineHeight).toBeLessThanOrEqual(236);
  });

  it('builds an invitation poster with a completely blank guest side', () => {
    const input = buildSingleInvitePosterInput(
      DEFAULT_ROOM_TEMPLATE,
      {
        nickname: '一号',
        slot: 1,
        avatarUrl: '/avatar.webp',
        answer: { ...EMPTY_DRAFT, favoriteAnimal: '猫' },
        imageUrls: { ...EMPTY_ANSWER_IMAGES },
      },
      'https://to-gather.tomori.xyz/room/abc234def567#join=123456',
    );

    expect(input.guest.blank).toBe(true);
    expect(input.guest.nickname).toBe('');
    expect(input.guest.answer).toEqual(EMPTY_DRAFT);
    expect(Object.values(input.guest.imageUrls).every((value) => value === null)).toBe(true);
    expect(input.qrCaption).toBe('扫码加入房间填写');
    expect(input.shareUrl).toContain('#join=123456');
  });
});
