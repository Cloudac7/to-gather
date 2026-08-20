import { describe, expect, it } from 'vitest';
import {
  createParticipantCookie,
  hashSecret,
  participantCookieName,
  randomRoomId,
  randomString,
  timingSafeEqual,
} from '../src/lib/security';

describe('room secrets', () => {
  it('creates URL-safe room identifiers', () => {
    expect(randomRoomId()).toMatch(/^[a-z2-9]{12}$/);
  });

  it('creates numeric join codes at the requested length', () => {
    expect(randomString(6, '0123456789')).toMatch(/^\d{6}$/);
  });

  it('hashes the same secret deterministically and compares it safely', async () => {
    const first = await hashSecret('secret', 'pepper');
    const second = await hashSecret('secret', 'pepper');
    const other = await hashSecret('different', 'pepper');
    expect(timingSafeEqual(first, second)).toBe(true);
    expect(timingSafeEqual(first, other)).toBe(false);
  });

  it('uses an isolated HttpOnly cookie per room', () => {
    const roomId = 'abcd2345efgh';
    expect(participantCookieName(roomId)).toBe(`duet_room_${roomId}`);
    expect(createParticipantCookie(roomId, 'token', true)).toContain('HttpOnly');
    expect(createParticipantCookie(roomId, 'token', true)).toContain('Secure');
    expect(createParticipantCookie(roomId, 'token', true)).toContain('SameSite=Lax');
  });
});
