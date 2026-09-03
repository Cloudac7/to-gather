import { describe, expect, it } from 'vitest';
import { MUSIC_FIELD_ENTITIES, musicArtworkProxyUrl, musicSelectionText } from '../src/lib/music';
import { MUSIC_ROOM_TEMPLATE } from '../src/lib/types';
import { answerSchema, hasMinimumAnswer } from '../src/lib/validation';
import { parseAnswer, parseRoomTemplate } from '../src/server/db';
import {
  isAllowedArtworkUrl,
  normalizeAudioDbArtist,
  normalizeItunesResult,
  normalizeMusicSearchTerm,
} from '../src/server/music';

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

  it('only proxies HTTPS artwork from the configured music image hosts', () => {
    expect(isAllowedArtworkUrl(song.artworkUrl)).toBe(true);
    expect(isAllowedArtworkUrl('https://www.theaudiodb.com/images/media/artist/thumb/artist.jpg')).toBe(true);
    expect(isAllowedArtworkUrl('https://r2.theaudiodb.com/images/media/artist/thumb/artist.jpg')).toBe(true);
    expect(isAllowedArtworkUrl('http://is1-ssl.mzstatic.com/image.jpg')).toBe(false);
    expect(isAllowedArtworkUrl('https://mzstatic.com.evil.example/image.jpg')).toBe(false);
    expect(isAllowedArtworkUrl('https://www.theaudiodb.com.evil.example/image.jpg')).toBe(false);
    expect(isAllowedArtworkUrl('https://cdn-images.dzcdn.net/images/artist/image.jpg')).toBe(false);
    expect(isAllowedArtworkUrl('https://example.com/image.jpg')).toBe(false);
  });
});
