import { describe, expect, it } from 'vitest';
import { calculateAnswerCellLayout } from '../src/lib/poster';

describe('poster answer cell layout', () => {
  it('gives text-only square cells most of the available height', () => {
    const layout = calculateAnswerCellLayout(250, 250, false, true);

    expect(layout.maxTextLines).toBeGreaterThanOrEqual(5);
  });

  it('keeps answer images as contained thumbnails inside square cells', () => {
    const layout = calculateAnswerCellLayout(250, 250, true, false);

    expect(layout.imageFit).toBe('contain');
    expect(layout.imageBox?.width).toBeLessThanOrEqual(168);
    expect(layout.imageBox?.height).toBeLessThanOrEqual(132);
  });

  it('reserves two answer lines below an image in a square cell', () => {
    const layout = calculateAnswerCellLayout(250, 250, true, true);

    expect(layout.maxTextLines).toBe(2);
    expect(layout.textTop + layout.maxTextLines * layout.textLineHeight).toBeLessThanOrEqual(236);
  });
});
