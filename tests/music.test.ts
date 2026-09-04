import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildItunesSearchUrl,
  MUSIC_FIELD_ENTITIES,
  musicArtworkProxyUrl,
  musicSelectionText,
  normalizeItunesResult,
  parseItunesSearchBody,
  searchItunesMusic,
} from '../src/lib/music';
import { MUSIC_ROOM_TEMPLATE } from '../src/lib/types';
import { answerSchema, hasMinimumAnswer } from '../src/lib/validation';
import { parseAnswer, parseRoomTemplate } from '../src/server/db';
import {
  buildQqMusicSearchUrl,
  isAllowedArtworkUrl,
  normalizeAudioDbArtist,
  normalizeMusicSearchTerm,
  parseAudioDbArtistSearchBody,
  parseQqMusicSearchBody,
} from '../src/server/music';

afterEach(() => vi.unstubAllGlobals());

const song = {
  provider: 'itunes' as const,
  id: 42,
  kind: 'song' as const,
  title: '夜曲',
  artistName: '周杰伦',
  collectionName: '十一月的萧邦',
  artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/example/600x600bb.jpg',
  storeUrl: 'https://music.apple.com/cn/album/example/42',
};

describe('music room preset', () => {
  it('uses the reference copy and assigns search kinds to its fields', () => {
    expect(MUSIC_ROOM_TEMPLATE).toMatchObject({
      variant: 'music',
      title: '靠 我的歌品真他妈牛逼',
      subtitle: '亲友你懂我的歌品',
      fieldLabels: {
        favoriteAnimal: '最喜欢的歌手',
        favoriteColor: '最喜欢的专辑',
        favoritePerson: '循环最多的歌曲',
        message: '自由发言区',
      },
    });
    expect(MUSIC_FIELD_ENTITIES.favoriteAnimal).toBe('artist');
    expect(MUSIC_FIELD_ENTITIES.favoriteColor).toBe('album');
    expect(MUSIC_FIELD_ENTITIES.message).toBeNull();
  });

  it('keeps old rooms and answers backward compatible', () => {
    expect(parseRoomTemplate(JSON.stringify({ title: '旧卡片' })).variant).toBe('classic');
    const oldMusicRoom = parseRoomTemplate(JSON.stringify({ variant: 'music', title: '旧音乐卡' }));
    expect(oldMusicRoom.fieldTypes.favoriteAnimal).toBe('artist');
    expect(oldMusicRoom.fieldTypes.favoriteColor).toBe('album');
    const answer = parseAnswer(JSON.stringify({ favoriteAnimal: '熊猫' }));
    expect(answer.favoriteAnimal).toBe('熊猫');
    expect(answer.musicSelections.favoriteAnimal).toBeNull();
    expect(answerSchema.safeParse({ ...answer, musicSelections: undefined }).success).toBe(true);
  });

  it('treats a selected catalog item as content and formats song text', () => {
    const answer = parseAnswer('{}');
    answer.avatarKey = 'room/person/avatar.webp';
    answer.musicSelections.favoritePerson = song;
    expect(hasMinimumAnswer(answer)).toBe(true);
    expect(musicSelectionText(song)).toBe('夜曲 — 周杰伦');
    expect(musicArtworkProxyUrl(song.artworkUrl)).toContain('/api/music/artwork?url=');
  });
});

describe('music result normalization and artwork safety', () => {
  it('treats TheAudioDB empty successful artist response as no results', () => {
    expect(parseAudioDbArtistSearchBody(new Uint8Array())).toEqual([]);
  });

  it('builds direct iTunes searches against the mainland storefront by default', () => {
    const songUrl = buildItunesSearchUrl('  Ｃｏｌｄｐｌａｙ   Yellow ', 'song');
    expect(songUrl.origin).toBe('https://itunes.apple.com');
    expect(songUrl.searchParams.get('term')).toBe('Coldplay Yellow');
    expect(songUrl.searchParams.get('entity')).toBe('song');
    expect(songUrl.searchParams.get('country')).toBe('CN');
    expect(buildItunesSearchUrl('周杰伦', 'album', 'HK').searchParams.get('country')).toBe('HK');
  });

  it('falls back from the mainland iTunes storefront to Hong Kong once', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{
        trackId: 42,
        trackName: '夜曲',
        artistName: '周杰伦',
        collectionName: '十一月的萧邦',
      }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(searchItunesMusic('夜曲', 'song')).resolves.toHaveLength(1);
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('country')).toBe('CN');
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('country')).toBe('HK');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('builds the verified QQ Music smart and song search URLs', () => {
    const artistUrl = buildQqMusicSearchUrl('周杰伦', 'artist');
    const albumUrl = buildQqMusicSearchUrl('叶惠美', 'album');
    const songUrl = buildQqMusicSearchUrl('夜曲', 'song');
    expect(artistUrl.pathname).toContain('smartbox_new.fcg');
    expect(artistUrl.searchParams.get('key')).toBe('周杰伦');
    expect(albumUrl.pathname).toContain('smartbox_new.fcg');
    expect(albumUrl.searchParams.get('key')).toBe('叶惠美');
    expect(songUrl.pathname).toContain('client_search_cp');
    expect(songUrl.searchParams.get('w')).toBe('夜曲');
    expect(songUrl.searchParams.get('new_json')).toBeNull();
  });

  it('parses QQ Music artist, album and song results with proxy-safe artwork', () => {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    const artist = parseQqMusicSearchBody(encode({ code: 0, data: { singer: { itemlist: [{
      id: '4558', mid: '0025NhlN2yWrP4', name: '周杰伦', singer: '周杰伦',
    }] } } }), 'artist')[0];
    const album = parseQqMusicSearchBody(encode({ code: 0, data: { album: { itemlist: [{
      id: '8220', mid: '000MkMni19ClKG', name: '叶惠美', singer: '周杰伦',
    }] } } }), 'album')[0];
    const qqSong = parseQqMusicSearchBody(encode({ code: 0, data: { song: { list: [{
      songmid: '0039MnYb0qxYhV', songname: '晴天',
      singer: [{ mid: '0025NhlN2yWrP4', name: '周杰伦' }],
      albummid: '000MkMni19ClKG', albumname: '叶惠美',
    }] } } }), 'song')[0];

    expect(artist).toMatchObject({ provider: 'qqmusic', kind: 'artist', title: '周杰伦' });
    expect(album).toMatchObject({ provider: 'qqmusic', kind: 'album', title: '叶惠美', artistName: '周杰伦' });
    expect(qqSong).toMatchObject({ provider: 'qqmusic', kind: 'song', title: '晴天', artistName: '周杰伦' });
    expect(artist.artworkUrl).toContain('T001R500x500M000');
    expect(album.artworkUrl).toContain('T002R500x500M000');
    expect(isAllowedArtworkUrl(qqSong.artworkUrl ?? '')).toBe(true);
  });

  it('uses a real TheAudioDB artist photo instead of an album cover', () => {
    expect(normalizeAudioDbArtist({
      idArtist: '111239',
      strArtist: 'Coldplay',
      strArtistAlternate: '酷玩乐队',
      strArtistThumb: 'https://r2.theaudiodb.com/images/media/artist/thumb/uxrqxy1347913147.jpg',
    })).toEqual({
      provider: 'theaudiodb',
      id: 111239,
      kind: 'artist',
      title: 'Coldplay',
      artistName: 'Coldplay',
      collectionName: null,
      artworkUrl: 'https://r2.theaudiodb.com/images/media/artist/thumb/uxrqxy1347913147.jpg',
      storeUrl: null,
    });
    expect(normalizeAudioDbArtist({
      idArtist: '1',
      strArtist: '无图片歌手',
      strArtistThumb: null,
    })).toBeNull();
  });

  it('normalizes case, Unicode width and repeated spaces before lookup', () => {
    expect(normalizeMusicSearchTerm('  ＴａＹＬｏＲ   SWIFT  ')).toBe('taylor swift');
  });

  it('normalizes a track and requests a larger artwork size', () => {
    expect(normalizeItunesResult({
      trackId: 42,
      trackName: '夜曲',
      artistName: '周杰伦',
      collectionName: '十一月的萧邦',
      artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/example/100x100bb.jpg',
      trackViewUrl: 'https://music.apple.com/cn/album/example/42',
    }, 'song')).toEqual(song);
  });

  it('parses and validates an iTunes search response', () => {
    expect(parseItunesSearchBody(JSON.stringify({ results: [{
      trackId: 42,
      trackName: '夜曲',
      artistName: '周杰伦',
      collectionName: '十一月的萧邦',
      artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/example/100x100bb.jpg',
      trackViewUrl: 'https://music.apple.com/cn/album/example/42',
    }] }), 'song')).toEqual([song]);
  });

  it('only proxies HTTPS artwork from the configured music image hosts', () => {
    expect(isAllowedArtworkUrl(song.artworkUrl)).toBe(true);
    expect(isAllowedArtworkUrl('https://www.theaudiodb.com/images/media/artist/thumb/artist.jpg')).toBe(true);
    expect(isAllowedArtworkUrl('https://r2.theaudiodb.com/images/media/artist/thumb/artist.jpg')).toBe(true);
    expect(isAllowedArtworkUrl('https://y.gtimg.cn/music/photo_new/T001R500x500M0000025NhlN2yWrP4.jpg')).toBe(true);
    expect(isAllowedArtworkUrl('http://is1-ssl.mzstatic.com/image.jpg')).toBe(false);
    expect(isAllowedArtworkUrl('https://mzstatic.com.evil.example/image.jpg')).toBe(false);
    expect(isAllowedArtworkUrl('https://www.theaudiodb.com.evil.example/image.jpg')).toBe(false);
    expect(isAllowedArtworkUrl('https://y.gtimg.cn.evil.example/image.jpg')).toBe(false);
    expect(isAllowedArtworkUrl('https://cdn-images.dzcdn.net/images/artist/image.jpg')).toBe(false);
    expect(isAllowedArtworkUrl('https://example.com/image.jpg')).toBe(false);
  });
});
