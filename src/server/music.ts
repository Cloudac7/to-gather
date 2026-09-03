import { z } from 'zod';
import type { MusicEntityKind, MusicSearchResult } from '../lib/types';
import { HttpError, json } from './http';

const SEARCH_LIMIT = 8;
const SEARCH_RESPONSE_LIMIT = 256_000;
const ARTWORK_RESPONSE_LIMIT = 5_000_000;
const UPSTREAM_TIMEOUT_MS = 8_000;
const MUSIC_CACHE_NAME = 'to-gather-music-v5';

const searchQuerySchema = z.object({
  term: z.string().trim().min(2).max(80),
  entity: z.enum(['artist', 'album', 'song']),
});

const itunesResultSchema = z.object({
  artistId: z.number().int().nonnegative().optional(),
  collectionId: z.number().int().nonnegative().optional(),
  trackId: z.number().int().nonnegative().optional(),
  artistName: z.string().optional(),
  collectionName: z.string().optional(),
  trackName: z.string().optional(),
  artworkUrl100: z.url().optional(),
  artworkUrl60: z.url().optional(),
  artistViewUrl: z.url().optional(),
  collectionViewUrl: z.url().optional(),
  trackViewUrl: z.url().optional(),
}).loose();

type ItunesResult = z.infer<typeof itunesResultSchema>;

const audioDbArtistSchema = z.object({
  idArtist: z.string().regex(/^\d+$/),
  strArtist: z.string(),
  strArtistAlternate: z.string().nullable().optional(),
  strArtistThumb: z.url().nullable().optional(),
}).loose();

const audioDbResponseSchema = z.object({
  artists: z.array(audioDbArtistSchema).max(10).nullable(),
}).loose();

type AudioDbArtist = z.infer<typeof audioDbArtistSchema>;

const audioDbAlbumSchema = z.object({
  idAlbum: z.string().regex(/^\d+$/),
  idArtist: z.string().regex(/^\d+$/).nullable().optional(),
  strAlbum: z.string(),
  strArtist: z.string().nullable().optional(),
  strAlbumThumb: z.url().nullable().optional(),
}).loose();

const audioDbAlbumResponseSchema = z.object({
  album: z.array(audioDbAlbumSchema).max(10).nullable(),
}).loose();

const audioDbTrackSchema = z.object({
  idTrack: z.string().regex(/^\d+$/),
  idAlbum: z.string().regex(/^\d+$/).nullable().optional(),
  idArtist: z.string().regex(/^\d+$/).nullable().optional(),
  strTrack: z.string(),
  strAlbum: z.string().nullable().optional(),
  strArtist: z.string().nullable().optional(),
  strTrackThumb: z.url().nullable().optional(),
}).loose();

const audioDbTrackResponseSchema = z.object({
  track: z.array(audioDbTrackSchema).max(10).nullable(),
}).loose();

type AudioDbAlbum = z.infer<typeof audioDbAlbumSchema>;
type AudioDbTrack = z.infer<typeof audioDbTrackSchema>;

function largerArtwork(url: string | undefined) {
  return url?.replace(/\/\d+x\d+bb\./, '/600x600bb.') ?? null;
}

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

export function normalizeAudioDbAlbum(result: AudioDbAlbum): MusicSearchResult | null {
  const title = result.strAlbum.trim();
  if (!title) return null;
  const artistName = result.strArtist?.trim() ?? '';
  return {
    provider: 'theaudiodb',
    id: Number(result.idAlbum),
    kind: 'album',
    title,
    artistName,
    collectionName: title,
    artworkUrl: result.strAlbumThumb ?? null,
    storeUrl: null,
  };
}

export function normalizeAudioDbTrack(result: AudioDbTrack): MusicSearchResult | null {
  const title = result.strTrack.trim();
  if (!title) return null;
  const artistName = result.strArtist?.trim() ?? '';
  return {
    provider: 'theaudiodb',
    id: Number(result.idTrack),
    kind: 'song',
    title,
    artistName,
    collectionName: result.strAlbum?.trim() || null,
    artworkUrl: result.strTrackThumb ?? null,
    storeUrl: null,
  };
}

export function normalizeItunesResult(result: ItunesResult, kind: MusicEntityKind): MusicSearchResult | null {
  const artistName = result.artistName?.trim() ?? '';
  if (kind === 'artist') {
    if (result.artistId === undefined || !artistName) return null;
    return {
      provider: 'itunes', id: result.artistId, kind, title: artistName, artistName,
      collectionName: null,
      artworkUrl: largerArtwork(result.artworkUrl100 ?? result.artworkUrl60),
      storeUrl: result.artistViewUrl ?? null,
    };
  }
  if (kind === 'album') {
    const title = result.collectionName?.trim() ?? '';
    if (result.collectionId === undefined || !title) return null;
    return {
      provider: 'itunes', id: result.collectionId, kind, title, artistName,
      collectionName: title,
      artworkUrl: largerArtwork(result.artworkUrl100 ?? result.artworkUrl60),
      storeUrl: result.collectionViewUrl ?? null,
    };
  }
  const title = result.trackName?.trim() ?? '';
  if (result.trackId === undefined || !title) return null;
  return {
    provider: 'itunes', id: result.trackId, kind, title, artistName,
    collectionName: result.collectionName?.trim() || null,
    artworkUrl: largerArtwork(result.artworkUrl100 ?? result.artworkUrl60),
    storeUrl: result.trackViewUrl ?? null,
  };
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

function cacheResponse(request: Request, response: Response, ctx: ExecutionContext) {
  ctx.waitUntil(caches.open(MUSIC_CACHE_NAME).then((cache) => cache.put(request, response.clone())));
  return response;
}

export async function musicSearchApi(request: Request, ctx: ExecutionContext) {
  if (request.method !== 'GET') throw new HttpError(405, '仅支持 GET 请求', 'method_not_allowed');
  const url = new URL(request.url);
  const input = searchQuerySchema.parse({
    term: url.searchParams.get('term') ?? '',
    entity: url.searchParams.get('entity') ?? '',
  });
  const term = normalizeMusicSearchTerm(input.term);
  const normalizedUrl = new URL('/api/music/search', url.origin);
  normalizedUrl.search = new URLSearchParams({ term, entity: input.entity }).toString();
  const cacheRequest = new Request(normalizedUrl, { method: 'GET' });
  const cache = await caches.open(MUSIC_CACHE_NAME);
  const cached = await cache.match(cacheRequest);
  if (cached) return cached;

  const endpoint = input.entity === 'artist'
    ? 'search.php'
    : input.entity === 'album' ? 'searchalbum.php' : 'searchtrack.php';
  const upstreamUrl = new URL(`https://www.theaudiodb.com/api/v1/json/123/${endpoint}`);
  upstreamUrl.search = new URLSearchParams({ s: term }).toString();
  let upstream: Response;
  try {
    upstream = await fetchWithTimeout(upstreamUrl, { headers: { Accept: 'application/json' } });
  } catch {
    throw new HttpError(504, '音乐搜索超时，请稍后重试', 'music_search_timeout');
  }
  if (!upstream.ok) throw new HttpError(502, '音乐搜索暂时不可用', 'music_search_unavailable');
  const body = await readLimitedBody(upstream, SEARCH_RESPONSE_LIMIT);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new HttpError(502, '音乐搜索返回了无效数据', 'invalid_music_response');
  }
  let results: MusicSearchResult[];
  if (input.entity === 'artist') {
    const validated = audioDbResponseSchema.safeParse(parsed);
    if (!validated.success) throw new HttpError(502, '音乐搜索返回了无效数据', 'invalid_music_response');
    results = (validated.data.artists ?? []).map(normalizeAudioDbArtist)
      .filter((result): result is MusicSearchResult => result !== null).slice(0, SEARCH_LIMIT);
  } else if (input.entity === 'album') {
    const validated = audioDbAlbumResponseSchema.safeParse(parsed);
    if (!validated.success) throw new HttpError(502, '音乐搜索返回了无效数据', 'invalid_music_response');
    results = (validated.data.album ?? []).map(normalizeAudioDbAlbum)
      .filter((result): result is MusicSearchResult => result !== null).slice(0, SEARCH_LIMIT);
  } else {
    const validated = audioDbTrackResponseSchema.safeParse(parsed);
    if (!validated.success) throw new HttpError(502, '音乐搜索返回了无效数据', 'invalid_music_response');
    results = (validated.data.track ?? []).map(normalizeAudioDbTrack)
      .filter((result): result is MusicSearchResult => result !== null).slice(0, SEARCH_LIMIT);
  }
  const cacheSeconds = 3_600;
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
    upstream = await fetchWithTimeout(source, { headers: { Accept: 'image/avif,image/webp,image/jpeg,image/png' } });
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
