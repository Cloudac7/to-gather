import { describe, expect, it } from 'vitest';
import { maxRoomGuests } from '../src/server/config';

describe('maxRoomGuests', () => {
  it('defaults to 50 guests', () => {
    expect(maxRoomGuests({})).toBe(50);
  });

  it('accepts a configured value within the supported range', () => {
    expect(maxRoomGuests({ MAX_ROOM_GUESTS: '120' })).toBe(120);
  });

  it.each(['0', '501', 'invalid'])('falls back for invalid value %s', (value) => {
    expect(maxRoomGuests({ MAX_ROOM_GUESTS: value })).toBe(50);
  });
});
