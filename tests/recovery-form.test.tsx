// @vitest-environment happy-dom

import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { JoinScreen } from '../src/components/RoomApp';

describe('recovery form', () => {
  afterEach(() => {
    document.body.replaceChildren();
    window.history.replaceState({}, '', '/');
  });

  it('prefills the join code embedded in an invitation QR URL', () => {
    window.history.replaceState({}, '', '/room/abc234def567#join=654321');
    const container = document.createElement('div');
    document.body.appendChild(container);

    render(<JoinScreen roomId="abc234def567" full={false} onJoined={() => {}} />, container);

    expect(container.querySelector<HTMLInputElement>('#join-code')?.value).toBe('654321');
    expect(container.textContent).toContain('你只需填写昵称');
  });

  it('accepts a valid recovery code after switching from the join form', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    render(<JoinScreen roomId="room-id" full={false} onJoined={() => {}} />, container);

    const recoverButton = [...container.querySelectorAll<HTMLButtonElement>('.segmented button')]
      .find((button) => button.textContent === '恢复身份');
    expect(recoverButton).toBeDefined();

    await act(() => recoverButton?.click());

    const nicknameInput = container.querySelector<HTMLInputElement>('#join-name');
    const recoveryInput = container.querySelector<HTMLInputElement>('#recovery-code');
    expect(nicknameInput).not.toBeNull();
    expect(recoveryInput).not.toBeNull();

    await act(() => {
      if (!nicknameInput || !recoveryInput) return;
      nicknameInput.value = '恢复码测试';
      nicknameInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
      recoveryInput.value = 'ABCD2EFG3HJK';
      recoveryInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
    });

    expect(recoveryInput?.getAttribute('pattern')).toBeNull();
    expect(recoveryInput?.validity.patternMismatch).toBe(false);
    expect(recoveryInput?.form?.checkValidity()).toBe(true);
  });
});
