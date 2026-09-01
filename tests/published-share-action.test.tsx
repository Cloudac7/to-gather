// @vitest-environment happy-dom

import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublishedConfirmation, shareClipboardText } from '../src/components/RoomApp';

describe('published share action', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('keeps the room invitation button available after publishing', async () => {
    const container = document.createElement('div');
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    document.body.appendChild(container);

    render(
      <PublishedConfirmation
        slot={1}
        title="我们的默契卡"
        inviteUrl="https://to-gather.tomori.xyz/room/abc234def567"
      />,
      container,
    );

    const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('复制填写邀请链接'));
    expect(button).toBeTruthy();
    expect(button?.hasAttribute('disabled')).toBe(false);
    button?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(writeText).toHaveBeenCalledWith('我们的默契卡\nhttps://to-gather.tomori.xyz/room/abc234def567');
    expect(button?.textContent).toContain('邀请链接已复制');
  });

  it('formats the room title together with the invitation URL', () => {
    expect(shareClipboardText('这样的两个人，是亲友？', 'https://to-gather.tomori.xyz/room/abc234def567'))
      .toBe('这样的两个人，是亲友？\nhttps://to-gather.tomori.xyz/room/abc234def567');
  });
});
