import type { AnswerFieldKey, MusicEntityKind, MusicProvider, MusicSelection } from './types';

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
