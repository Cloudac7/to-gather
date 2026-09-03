const encoder = new TextEncoder();

export function randomString(length: number, alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789') {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

export function randomRoomId() {
  return randomString(12, 'abcdefghjkmnpqrstuvwxyz23456789');
}

export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

export async function hashSecret(secret: string, pepper: string) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${pepper}:${secret}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function deriveJoinCode(roomId: string, pepper: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`to-gather:join-code:v1:${roomId}`),
  );
  const value = new DataView(signature).getUint32(0);
  return String(value % 1_000_000).padStart(6, '0');
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return result === 0;
}

export function participantCookieName(roomId: string) {
  return `duet_room_${roomId}`;
}

export function createParticipantCookie(roomId: string, token: string, secure = true) {
  const parts = [
    `${participantCookieName(roomId)}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${60 * 60 * 24 * 30}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function readCookie(request: Request, name: string) {
  const header = request.headers.get('Cookie') ?? '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function isSecureRequest(request: Request) {
  return new URL(request.url).protocol === 'https:';
}
