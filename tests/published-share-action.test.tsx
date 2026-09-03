// @vitest-environment happy-dom

import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { directJoinUrl, invitationClipboardText, PublishedConfirmation, shareClipboardText } from '../src/components/RoomApp';
import { DEFAULT_ROOM_TEMPLATE } from '../src/lib/types';

describe('published share action', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('keeps the room invitation button available after publishing', async () => {
    const container = document.createElement('div');
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    document.body.appendChild(container);

    render(
      <PublishedConfirmation
        slot={1}
        roomId="abc234def567"
        template={{ ...DEFAULT_ROOM_TEMPLATE, title: '我们的默契卡' }}
        inviteUrl="https://to-gather.tomori.xyz/room/abc234def567"
        joinCode="123456"
        publishedAnswer={null}
        onRecoverJoinCode={vi.fn()}
        onEdit={vi.fn()}
      />,
      container,
    );

    const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('复制房间邀请信息'));
    expect(button).toBeTruthy();
    expect(button?.hasAttribute('disabled')).toBe(false);
    button?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(writeText).toHaveBeenCalledWith('我们的默契卡\nhttps://to-gather.tomori.xyz/room/abc234def567#join=123456\n加入码：123456');
    expect(button?.textContent).toContain('邀请信息已复制');
    expect(container.textContent).toContain('生成单人邀请卡');
  });

  it('offers published guests a way to become the host of a copied room', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    render(
      <PublishedConfirmation
        slot={2}
        roomId="abc234def567"
        template={{ ...DEFAULT_ROOM_TEMPLATE, title: '我们的默契卡' }}
        inviteUrl="https://to-gather.tomori.xyz/room/abc234def567"
        joinCode={null}
        publishedAnswer={null}
        onRecoverJoinCode={vi.fn()}
        onEdit={vi.fn()}
      />,
      container,
    );

    expect(container.textContent).toContain('用我的内容创建新房间');
    expect(container.textContent).toContain('你将担任一号');
  });

  it('formats the room title together with the invitation URL', () => {
    expect(shareClipboardText('这样的两个人，是亲友？', 'https://to-gather.tomori.xyz/room/abc234def567'))
      .toBe('这样的两个人，是亲友？\nhttps://to-gather.tomori.xyz/room/abc234def567');
  });

  it('includes the host join code in copied invitation details', () => {
    expect(invitationClipboardText('我们的默契卡', 'https://example.com/room/abc234def567', '654321'))
      .toBe('我们的默契卡\nhttps://example.com/room/abc234def567#join=654321\n加入码：654321');
  });

  it('recovers a missing host join code before copying the invitation', async () => {
    const container = document.createElement('div');
    const writeText = vi.fn(async () => undefined);
    const onRecoverJoinCode = vi.fn(async () => ({
      roomId: 'abc234def567',
      joinCode: '654321',
      rotated: false,
    }));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    document.body.appendChild(container);

    render(
      <PublishedConfirmation
        slot={1}
        roomId="abc234def567"
        template={{ ...DEFAULT_ROOM_TEMPLATE, title: '我们的默契卡' }}
        inviteUrl="https://to-gather.tomori.xyz/room/abc234def567"
        joinCode={null}
        publishedAnswer={null}
        onRecoverJoinCode={onRecoverJoinCode}
        onEdit={vi.fn()}
      />,
      container,
    );

    const button = Array.from(container.querySelectorAll('button'))
      .find((item) => item.textContent?.includes('复制房间邀请信息'));
    button?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onRecoverJoinCode).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(
      '我们的默契卡\nhttps://to-gather.tomori.xyz/room/abc234def567#join=654321\n加入码：654321',
    );
    expect(container.textContent).toContain('加入码已恢复');
  });

  it('puts the join code in a URL fragment for the invitation QR', () => {
    expect(directJoinUrl('https://example.com/room/abc234def567', '654321'))
      .toBe('https://example.com/room/abc234def567#join=654321');
  });

  it('lets either published participant withdraw and edit without changing old shares', async () => {
    const container = document.createElement('div');
    const onEdit = vi.fn(async () => undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    document.body.appendChild(container);

    render(
      <PublishedConfirmation
        slot={2}
        roomId="abc234def567"
        template={DEFAULT_ROOM_TEMPLATE}
        inviteUrl="https://to-gather.tomori.xyz/room/abc234def567"
        joinCode={null}
        publishedAnswer={null}
        onRecoverJoinCode={vi.fn()}
        onEdit={onEdit}
      />,
      container,
    );

    const button = Array.from(container.querySelectorAll('button'))
      .find((item) => item.textContent?.includes('修改已发布内容'));
    button?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onEdit).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('已经生成的公开分享仍保留原内容');
  });
});
