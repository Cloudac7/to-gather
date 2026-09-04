import { z } from 'zod';
import type { MusicEntityKind, MusicSearchResult } from '../lib/types';
import { HttpError, json } from './http';

const SEARCH_LIMIT = 8;
const SEARCH_RESPONSE_LIMIT = 256_000;
const ARTWORK_RESPONSE_LIMIT = 5_000_000;
const UPSTREAM_TIMEOUT_MS = 8_000;
const MUSIC_CACHE_NAME = 'to-gather-music-v7';
const QQ_SMART_SEARCH_ENDPOINT = 'https://c6.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg';
const QQ_SONG_SEARCH_ENDPOINT = 'https://c6.y.qq.com/soso/fcgi-bin/client_search_cp';

const searchQuerySchema = z.object({
  term: z.string().trim().min(2).max(80),
  entity: z.enum(['artist', 'album', 'song']),
  roomId: z.string().regex(/^[a-z2-9]{12}$/),
}).loose();

const audioDbIdSchema = z.preprocess(
  (value) => typeof value === 'number' ? String(value) : value,
  z.string().regex(/^\d+$/),
);
const audioDbUrlSchema = z.preprocess(
  (value) => value === '' ? null : value,
  z.url().nullable().optional(),
);

const audioDbArtistSchema = z.object({
  idArtist: audioDbIdSchema,
  strArtist: z.string(),
  strArtistAlternate: z.string().nullable().optional(),
  strArtistThumb: audioDbUrlSchema,
}).loose();

const audioDbResponseSchema = z.object({
  artists: z.array(audioDbArtistSchema).max(10).nullable(),
}).loose();

const qqIdentifierSchema = z.union([z.string(), z.number()]);
const qqSingerSchema = z.object({
  id: qqIdentifierSchema.optional(),
  mid: z.string().optional(),
  name: z.string().optional(),
  singerID: qqIdentifierSchema.optional(),
  singerMID: z.string().optional(),
  singerName: z.string().optional(),
}).loose();
const qqAlbumSchema = z.object({
  id: qqIdentifierSchema.optional(),
  mid: z.string().optional(),
  name: z.string().optional(),
  title: z.string().optional(),
  albumID: qqIdentifierSchema.optional(),
  albumMID: z.string().optional(),
  albumName: z.string().optional(),
  singerName: z.string().optional(),
  singer: z.union([z.string(), z.array(qqSingerSchema)]).optional(),
}).loose();
const qqSongSchema = z.object({
  id: qqIdentifierSchema.optional(),
  mid: z.string().optional(),
  name: z.string().optional(),
  title: z.string().optional(),
  songid: qqIdentifierSchema.optional(),
  songmid: z.string().optional(),
  songname: z.string().optional(),
  albummid: z.string().optional(),
  albumname: z.string().optional(),
  singer: z.array(qqSingerSchema).optional(),
  album: qqAlbumSchema.optional(),
}).loose();
const qqSmartSearchSchema = z.object({
  code: z.number(),
  data: z.object({
    singer: z.object({ itemlist: z.array(z.unknown()).max(100) }).loose().optional(),
    album: z.object({ itemlist: z.array(z.unknown()).max(100) }).loose().optional(),
  }).loose(),
}).loose();
const qqSongSearchSchema = z.object({
  code: z.number(),
  data: z.object({
    song: z.object({ list: z.array(z.unknown()).max(100) }).loose(),
  }).loose(),
}).loose();

type AudioDbArtist = z.infer<typeof audioDbArtistSchema>;
type QqSinger = z.infer<typeof qqSingerSchema>;
type QqAlbum = z.infer<typeof qqAlbumSchema>;
type QqSong = z.infer<typeof qqSongSchema>;

export function normalizeMusicSearchTerm(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

export function normalizeAudioDbArtist(result: AudioDbArtist): MusicSearchResult | null {
  const title = result.strArtist.trim();
  if (!title || !result.strArtistThumb) return null;
  return {
    provider: 'theaudiodb',
    id: Number(result.idArtist),
    kind: 'artist',
    title,
    artistName: title,
    collectionName: null,
    artworkUrl: result.strArtistThumb,
    storeUrl: null,
  };
}

export function parseAudioDbArtistSearchBody(body: Uint8Array): MusicSearchResult[] {
  const text = new TextDecoder().decode(body).replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(502, '音乐搜索返回了无效数据', 'invalid_music_response');
  }

  const validated = audioDbResponseSchema.safeParse(parsed);
  if (!validated.success) throw new HttpError(502, '音乐搜索返回了无效数据', 'invalid_music_response');
  return (validated.data.artists ?? []).map(normalizeAudioDbArtist)
    .filter((result): result is MusicSearchResult => result !== null).slice(0, SEARCH_LIMIT);
}

function firstText(...values: Array<string | null | undefined>) {
  return values.map((value) => value?.trim()).find(Boolean) ?? '';
}

function safeQqMid(value: string | undefined) {
  const mid = value?.trim() ?? '';
  return /^[A-Za-z0-9]{4,80}$/.test(mid) ? mid : '';
}

function qqArtistNames(singers: QqSinger[] | string | undefined) {
  if (typeof singers === 'string') return singers.trim();
  return (singers ?? [])
    .map((singer) => firstText(singer.name, singer.singerName))
    .filter(Boolean)
    .join(' / ');
}

function qqArtworkUrl(kind: 'artist' | 'album', mid: string) {
  const prefix = kind === 'artist' ? 'T001' : 'T002';
  return `https://y.gtimg.cn/music/photo_new/${prefix}R500x500M000${mid}.jpg`;
}

export function normalizeQqSinger(result: QqSinger): MusicSearchResult | null {
  const mid = safeQqMid(firstText(result.mid, result.singerMID));
  const title = firstText(result.name, result.singerName);
  if (!mid || !title) return null;
  return {
    provider: 'qqmusic',
    id: mid,
    kind: 'artist',
    title,
    artistName: title,
    collectionName: null,
    artworkUrl: qqArtworkUrl('artist', mid),
    storeUrl: `https://y.qq.com/n/ryqq/singer/${encodeURIComponent(mid)}`,
  };
}

export function normalizeQqAlbum(result: QqAlbum): MusicSearchResult | null {
  const mid = safeQqMid(firstText(result.mid, result.albumMID));
  const title = firstText(result.name, result.title, result.albumName);
  const artistName = firstText(result.singerName, qqArtistNames(result.singer));
  if (!mid || !title) return null;
  return {
    provider: 'qqmusic',
    id: mid,
    kind: 'album',
    title,
    artistName,
    collectionName: title,
    artworkUrl: qqArtworkUrl('album', mid),
    storeUrl: `https://y.qq.com/n/ryqq/albumDetail/${encodeURIComponent(mid)}`,
  };
}

export function normalizeQqSong(result: QqSong): MusicSearchResult | null {
  const mid = safeQqMid(firstText(result.mid, result.songmid));
  const title = firstText(result.name, result.title, result.songname);
  if (!mid || !title) return null;
  const albumMid = safeQqMid(firstText(result.album?.mid, result.album?.albumMID, result.albummid));
  const collectionName = firstText(
    result.album?.name,
    result.album?.title,
    result.album?.albumName,
    result.albumname,
  ) || null;
  return {
    provider: 'qqmusic',
    id: mid,
    kind: 'song',
    title,
    artistName: qqArtistNames(result.singer),
    collectionName,
    artworkUrl: albumMid ? qqArtworkUrl('album', albumMid) : null,
    storeUrl: `https://y.qq.com/n/ryqq/songDetail/${encodeURIComponent(mid)}`,
  };
}

function parseJsonBody(body: Uint8Array) {
  const text = new TextDecoder().decode(body).replace(/^\uFEFF/, '').trim();
  if (!text) throw new HttpError(502, '音乐搜索返回了无效数据', 'invalid_music_response');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(502, '音乐搜索返回了无效数据', 'invalid_music_response');
  }
}

export function parseQqMusicSearchBody(body: Uint8Array, entity: MusicEntityKind): MusicSearchResult[] {
  const root = parseJsonBody(body);
  if (entity === 'artist') {
    const validated = qqSmartSearchSchema.safeParse(root);
    if (!validated.success || validated.data.code !== 0) {
      throw new HttpError(502, 'QQ 音乐搜索返回了无效数据', 'invalid_music_response');
    }
    const list = validated.data.data.singer?.itemlist ?? [];
    return list.map((item) => qqSingerSchema.safeParse(item))
      .filter((result) => result.success)
      .map((result) => normalizeQqSinger(result.data))
      .filter((result): result is MusicSearchResult => result !== null)
      .slice(0, SEARCH_LIMIT);
  }
  if (entity === 'album') {
    const validated = qqSmartSearchSchema.safeParse(root);
    if (!validated.success || validated.data.code !== 0) {
      throw new HttpError(502, 'QQ 音乐搜索返回了无效数据', 'invalid_music_response');
    }
    const list = validated.data.data.album?.itemlist ?? [];
    return list.map((item) => qqAlbumSchema.safeParse(item))
      .filter((result) => result.success)
      .map((result) => normalizeQqAlbum(result.data))
      .filter((result): result is MusicSearchResult => result !== null)
      .slice(0, SEARCH_LIMIT);
  }
  const validated = qqSongSearchSchema.safeParse(root);
  if (!validated.success || validated.data.code !== 0) {
    throw new HttpError(502, 'QQ 音乐搜索返回了无效数据', 'invalid_music_response');
  }
  const list = validated.data.data.song.list;
  return list.map((item) => qqSongSchema.safeParse(item))
    .filter((result) => result.success)
    .map((result) => normalizeQqSong(result.data))
    .filter((result): result is MusicSearchResult => result !== null)
    .slice(0, SEARCH_LIMIT);
}

export function buildQqMusicSearchUrl(term: string, entity: MusicEntityKind) {
  if (entity === 'song') {
    const url = new URL(QQ_SONG_SEARCH_ENDPOINT);
    url.search = new URLSearchParams({
      w: term,
      n: String(SEARCH_LIMIT),
      p: '1',
      format: 'json',
      inCharset: 'utf8',
      outCharset: 'utf-8',
      ct: '24',
      qqmusic_ver: '1298',
      platform: 'yqq.json',
      needNewCode: '0',
      aggr: '1',
      cr: '1',
    }).toString();
    return url;
  }
  const url = new URL(QQ_SMART_SEARCH_ENDPOINT);
  url.search = new URLSearchParams({
    format: 'json',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    platform: 'yqq.json',
    key: term,
  }).toString();
  return url;
}

async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readLimitedBody(response: Response, limit: number) {
  if (!response.body) return new Uint8Array();
  const declaredLength = Number(response.headers.get('Content-Length') ?? 0);
  if (declaredLength > limit) throw new HttpError(502, '上游响应过大', 'upstream_too_large');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new HttpError(502, '上游响应过大', 'upstream_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function searchQqMusic(term: string, entity: MusicEntityKind) {
  const upstream = await fetchWithTimeout(buildQqMusicSearchUrl(term, entity), {
    headers: {
      Accept: 'application/json',
      Referer: 'https://y.qq.com/',
    },
  });
  if (!upstream.ok) throw new HttpError(502, 'QQ 音乐搜索暂时不可用', 'qq_music_unavailable');
  return parseQqMusicSearchBody(await readLimitedBody(upstream, SEARCH_RESPONSE_LIMIT), entity);
}

async function searchAudioDbArtist(term: string) {
  const upstreamUrl = new URL('https://www.theaudiodb.com/api/v1/json/123/search.php');
  upstreamUrl.search = new URLSearchParams({ s: term }).toString();
  const upstream = await fetchWithTimeout(upstreamUrl, { headers: { Accept: 'application/json' } });
  if (!upstream.ok) throw new HttpError(502, 'TheAudioDB 搜索暂时不可用', 'audiodb_unavailable');
  return parseAudioDbArtistSearchBody(await readLimitedBody(upstream, SEARCH_RESPONSE_LIMIT));
}

function cacheResponse(request: Request, response: Response, ctx: ExecutionContext) {
  ctx.waitUntil(caches.open(MUSIC_CACHE_NAME).then((cache) => cache.put(request, response.clone())));
  return response;
}

export async function musicSearchApi(
  request: Request,
  ctx: ExecutionContext,
  enforceRateLimit?: (roomId: string) => Promise<void>,
) {
  if (request.method !== 'GET') throw new HttpError(405, '仅支持 GET 请求', 'method_not_allowed');
  const url = new URL(request.url);
  const input = searchQuerySchema.parse({
    term: url.searchParams.get('term') ?? '',
    entity: url.searchParams.get('entity') ?? '',
    roomId: url.searchParams.get('roomId') ?? '',
  });
  const term = normalizeMusicSearchTerm(input.term);
  const normalizedUrl = new URL('/api/music/search', url.origin);
  normalizedUrl.search = new URLSearchParams({ term, entity: input.entity }).toString();
  const cacheRequest = new Request(normalizedUrl, { method: 'GET' });
  const cache = await caches.open(MUSIC_CACHE_NAME);
  const cached = await cache.match(cacheRequest);
  if (cached) return cached;

  await enforceRateLimit?.(input.roomId);

  let results: MusicSearchResult[] = [];
  let qqFailed = false;
  try {
    results = await searchQqMusic(term, input.entity);
  } catch {
    qqFailed = true;
  }

  if (!results.length && input.entity === 'artist') {
    try {
      results = await searchAudioDbArtist(term);
    } catch {
      if (qqFailed) throw new HttpError(502, '歌手搜索暂时不可用', 'music_search_unavailable');
    }
  }

  const cacheSeconds = results.length ? 3_600 : 300;
  const response = json({ results }, { headers: { 'Cache-Control': `public, max-age=${cacheSeconds}` } });
  return cacheResponse(cacheRequest, response, ctx);
}

export function isAllowedArtworkUrl(value: string) {
  if (!value || value.length > 1_000) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (
      url.hostname === 'theaudiodb.com'
      || url.hostname === 'www.theaudiodb.com'
      || url.hostname === 'r2.theaudiodb.com'
      || url.hostname === 'mzstatic.com'
      || url.hostname.endsWith('.mzstatic.com')
      || url.hostname === 'y.gtimg.cn'
    );
  } catch {
    return false;
  }
}

export async function musicArtworkApi(request: Request, ctx: ExecutionContext) {
  if (request.method !== 'GET') throw new HttpError(405, '仅支持 GET 请求', 'method_not_allowed');
  const requestUrl = new URL(request.url);
  const source = requestUrl.searchParams.get('url') ?? '';
  if (!isAllowedArtworkUrl(source)) throw new HttpError(400, '封面地址无效', 'invalid_artwork_url');
  const cacheRequest = new Request(requestUrl, { method: 'GET' });
  const cache = await caches.open(MUSIC_CACHE_NAME);
  const cached = await cache.match(cacheRequest);
  if (cached) return cached;

  let upstream: Response;
  try {
    const sourceUrl = new URL(source);
    const headers: Record<string, string> = { Accept: 'image/avif,image/webp,image/jpeg,image/png' };
    if (sourceUrl.hostname === 'y.gtimg.cn') headers.Referer = 'https://y.qq.com/';
    upstream = await fetchWithTimeout(source, { headers });
  } catch {
    throw new HttpError(504, '封面加载超时', 'artwork_timeout');
  }
  if (!upstream.ok) throw new HttpError(502, '封面暂时无法加载', 'artwork_unavailable');
  const contentType = upstream.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() ?? '';
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(contentType)) {
    throw new HttpError(415, '封面返回的不是图片', 'invalid_artwork_type');
  }
  const body = await readLimitedBody(upstream, ARTWORK_RESPONSE_LIMIT);
  const response = new Response(body, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    },
  });
  return cacheResponse(cacheRequest, response, ctx);
}
