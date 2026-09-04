import { z } from 'zod';
import type { MusicSearchResult } from '../lib/types';
import { HttpError, json } from './http';

const SEARCH_LIMIT = 8;
const SEARCH_RESPONSE_LIMIT = 256_000;
const ARTWORK_RESPONSE_LIMIT = 5_000_000;
const UPSTREAM_TIMEOUT_MS = 8_000;
const MUSIC_CACHE_NAME = 'to-gather-music-v6';

const searchQuerySchema = z.object({
  term: z.string().trim().min(2).max(80),
  entity: z.literal('artist'),
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

type AudioDbArtist = z.infer<typeof audioDbArtistSchema>;

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

  const upstreamUrl = new URL('https://www.theaudiodb.com/api/v1/json/123/search.php');
  upstreamUrl.search = new URLSearchParams({ s: term }).toString();
  let upstream: Response;
  try {
    upstream = await fetchWithTimeout(upstreamUrl, { headers: { Accept: 'application/json' } });
  } catch {
    throw new HttpError(504, '音乐搜索超时，请稍后重试', 'music_search_timeout');
  }
  if (!upstream.ok) throw new HttpError(502, '音乐搜索暂时不可用', 'music_search_unavailable');
  const body = await readLimitedBody(upstream, SEARCH_RESPONSE_LIMIT);
  const results = parseAudioDbArtistSearchBody(body);
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
