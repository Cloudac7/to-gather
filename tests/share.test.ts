import { describe, expect, it } from 'vitest';
import { effectiveShareStatus, SHARE_ID_PATTERN, type ShareRow } from '../src/server/shares';

function shareRow(expiresAt: string): ShareRow {
  return {
    id: 'abcd2345efgh6789jkmnpqrs',
    room_id: 'abcd2345efgh',
    owner_participant_id: 'owner',
    pair_participant_id: 'pair',
    round_number: 1,
    status: 'active',
    fingerprint: 'fingerprint',
    snapshot_json: '{}',
    poster_key: 'shares/id/poster.png',
    created_at: '2026-01-01T00:00:00.000Z',
    expires_at: expiresAt,
    revoked_at: null,
    cleaned_at: null,
  };
}

describe('public share lifecycle', () => {
  it('uses unguessable URL-safe share ids', () => {
    expect(SHARE_ID_PATTERN.test('abcd2345efgh6789jkmnpqrs')).toBe(true);
    expect(SHARE_ID_PATTERN.test('abcd2345efgh')).toBe(false);
  });

  it('treats an active row as expired immediately after its fixed deadline', () => {
    expect(effectiveShareStatus(shareRow('2999-01-01T00:00:00.000Z'))).toBe('active');
    expect(effectiveShareStatus(shareRow('2000-01-01T00:00:00.000Z'))).toBe('expired');
  });
});
