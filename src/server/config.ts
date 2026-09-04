const DEFAULT_MAX_GUESTS = 50;

export function maxRoomGuests(env: Pick<Env, 'MAX_ROOM_GUESTS'>) {
  const configured = Number.parseInt(env.MAX_ROOM_GUESTS ?? '', 10);
  return Number.isFinite(configured) && configured >= 1 && configured <= 500
    ? configured
    : DEFAULT_MAX_GUESTS;
}
