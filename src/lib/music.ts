import { z } from 'zod';
import type { AnswerFieldKey, MusicEntityKind, MusicProvider, MusicSelection } from './types';

const ITUNES_SEARCH_LIMIT = 8;
const ITUNES_RESPONSE_LIMIT = 256_000;

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

const itunesResponseSchema = z.object({
  results: z.array(itunesResultSchema).max(ITUNES_SEARCH_LIMIT * 8),
}).loose();

type ItunesResult = z.infer<typeof itunesResultSchema>;

function largerArtwork(url: string | undefined) {
  return url?.replace(/\/\d+x\d+bb\./, '/600x600bb.') ?? null;
}

export const MUSIC_FIELD_ENTITIES: Record<AnswerFieldKey, MusicEntityKind | null> = {
  favoriteAnimal: 'artist',
  favoriteColor: 'album',
  favoritePerson: 'song',
  favoriteSong: 'song',
  mbti: 'song',
  recentProduct: 'song',
  dreamActivity: 'song',
  curiousAbout: 'song',
  message: null,
};

export function musicSelectionText(selection: MusicSelection) {
  if (selection.kind === 'artist') return selection.artistName || selection.title;
  if (selection.kind === 'album') return selection.title;
  return selection.artistName ? `${selection.title} — ${selection.artistName}` : selection.title;
}

export function musicArtworkProxyUrl(artworkUrl: string | null | undefined) {
  return artworkUrl ? `/api/music/artwork?url=${encodeURIComponent(artworkUrl)}` : null;
}

export function musicProviderName(provider: MusicProvider) {
  return provider === 'theaudiodb' ? 'TheAudioDB' : 'iTunes';
}

export function normalizeItunesResult(result: ItunesResult, kind: MusicEntityKind): MusicSelection | null {
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

export function buildItunesSearchUrl(term: string, entity: Exclude<MusicEntityKind, 'artist'>) {
  const url = new URL('https://itunes.apple.com/search');
  url.search = new URLSearchParams({
    term: term.normalize('NFKC').trim().replace(/\s+/g, ' '),
    media: 'music',
    entity,
    country: 'HK',
    limit: String(ITUNES_SEARCH_LIMIT),
  }).toString();
  return url;
}

export function parseItunesSearchBody(text: string, entity: Exclude<MusicEntityKind, 'artist'>) {
  if (text.length > ITUNES_RESPONSE_LIMIT) throw new Error('iTunes 搜索响应过大');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('iTunes 搜索返回了无效数据');
  }
  const validated = itunesResponseSchema.safeParse(parsed);
  if (!validated.success) throw new Error('iTunes 搜索返回了无效数据');
  return validated.data.results
    .map((result) => normalizeItunesResult(result, entity))
    .filter((result): result is MusicSelection => result !== null)
    .slice(0, ITUNES_SEARCH_LIMIT);
}

export async function searchItunesMusic(
  term: string,
  entity: Exclude<MusicEntityKind, 'artist'>,
  signal?: AbortSignal,
) {
  const response = await fetch(buildItunesSearchUrl(term, entity), {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (response.status === 429) throw new Error('iTunes 搜索过于频繁，请稍后再试');
  if (!response.ok) throw new Error('iTunes 搜索暂时不可用');
  return parseItunesSearchBody(await response.text(), entity);
}
