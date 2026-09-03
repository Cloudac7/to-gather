// @vitest-environment happy-dom

import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import HomeApp from '../src/components/HomeApp';

describe('home template picker', () => {
  afterEach(() => document.body.replaceChildren());

  it('loads the music preset and lets the creator edit its title and fields', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(<HomeApp />, container);

    const musicButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('一起听卡片'));
    expect(musicButton).toBeTruthy();
    musicButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const title = container.querySelector<HTMLInputElement>('#card-title');
    const firstLabel = container.querySelector<HTMLInputElement>('[aria-label="第 1 个字段标题"]');
    const firstType = container.querySelector<HTMLInputElement>('[aria-label="第 1 个字段类型"]');
    expect(title?.value).toBe('靠 我的歌品真他妈牛逼');
    expect(firstLabel?.value).toBe('最喜欢的歌手');
    expect(firstType?.value).toBe('artist');

    if (!title || !firstLabel || !firstType) throw new Error('模板编辑器未渲染');
    title.value = '我们的私藏歌单';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    firstLabel.value = '最懂我的歌手';
    firstLabel.dispatchEvent(new Event('input', { bubbles: true }));
    firstType.value = 'album';
    firstType.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(title.value).toBe('我们的私藏歌单');
    expect(firstLabel.value).toBe('最懂我的歌手');
    expect(firstType.value).toBe('album');
    expect(container.querySelector('.template-settings summary')?.textContent).toContain('已修改');
  });
});
