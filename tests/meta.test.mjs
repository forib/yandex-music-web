// tagFlac / tagMp3 / extractMeta / buildFilename / filterAlbum / parseYandexUrl.
// No network.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend, concat } from './helpers.mjs';

const { tagFlac, tagMp3, extractMeta, buildFilename, filterAlbum, parseYandexUrl } = loadFrontend({ withID3: true });

function flacFile() {
  const block = (type, data, last) => {
    const h = new Uint8Array(4);
    h[0] = (last ? 0x80 : 0) | type;
    h[1] = (data.length >> 16) & 0xFF; h[2] = (data.length >> 8) & 0xFF; h[3] = data.length & 0xFF;
    return concat(h, data);
  };
  return concat(
    new Uint8Array([0x66, 0x4C, 0x61, 0x43]),
    block(0, new Uint8Array(34), false),
    block(1, new Uint8Array(16), true),
    new Uint8Array([0xFF, 0xF8, 0x69, 0x03, 0xAA, 0xBB, 0xCC]),
  );
}
const META = {
  title: 'Song (Remix)', album: 'Alb', artists: ['A1', 'A2'], albumArtists: ['AA'],
  date: '2024-01-15', trackNumber: 3, discNumber: 2, genre: 'pop',
  lyrics: 'la la', url: 'https://music.yandex.ru/album/1/track/2',
};

describe('tagFlac', () => {
  const out = tagFlac(flacFile(), META, new Uint8Array([0xFF, 0xD8, 0xFF, 0x00]), 'image/jpeg');
  const s = Buffer.from(out).toString('latin1');
  it('keeps magic + frames', () => {
    assert.deepEqual([...out.slice(0, 4)], [0x66, 0x4C, 0x61, 0x43]);
    assert.equal(out[out.length - 1], 0xCC);
  });
  for (const want of ['TITLE=Song (Remix)', 'ALBUM=Alb', 'ARTIST=A1', 'ARTIST=A2',
    'ALBUMARTIST=AA', 'DATE=2024-01-15', 'TRACKNUMBER=3', 'DISCNUMBER=2',
    'GENRE=pop', 'LYRICS=la la', 'COMMENT=https://music.yandex.ru/album/1/track/2']) {
    it(`has ${want.split('=')[0]}`, () => assert.ok(s.includes(want)));
  }
});

describe('tagMp3 (ID3Writer)', () => {
  // ID3Writer appends frames (strings go UTF-16, so check frame ids, not text)
  const out = tagMp3(new Uint8Array(1024), META, null, null);
  const s = Buffer.from(out).toString('latin1');
  it('returns larger buffer', () => assert.ok(out.length > 1024));
  for (const id of ['TIT2', 'TALB', 'TPE1', 'TPE2', 'TRCK', 'TCON', 'USLT']) {
    it(`has ${id}`, () => assert.ok(s.includes(id)));
  }
});

describe('extractMeta', () => {
  const fake = {
    id: '2', title: 'Song', version: 'Remix', artists: [{ name: 'A1' }],
    albums: [{ id: '1', title: 'Alb', artists: [{ name: 'AA' }],
      trackPosition: { index: 3, volume: 2 }, year: 2020, genre: 'pop', coverUri: 'x/%%/y' }],
  };
  const m = extractMeta(fake);
  it('title + version', () => assert.equal(m.title, 'Song (Remix)'));
  it('positions', () => {
    assert.equal(m.trackNumber, 3);
    assert.equal(m.discNumber, 2);
  });
});

describe('buildFilename', () => {
  const fake = (disc) => ({
    id: '2', title: 'S:T', artists: [{ name: 'A/1' }],
    albums: [{ id: '1', title: 'Al?b', artists: [{ name: 'AA' }],
      trackPosition: { index: 3, volume: disc }, year: 2020 }],
  });
  it('folders + sanitizes segments, keeps slashes', () => {
    assert.equal(buildFilename(fake(1), 'm4a', '{album_artist}/{album}/{track} - {title}'),
      'AA/Al_b/03 - S_T.m4a');
  });
  it('disc token + traversal neutralized', () => {
    assert.equal(buildFilename(fake(2), 'mp3', '{disc}-{track}'), '2-03.mp3');
    assert.equal(buildFilename({ ...fake(1), title: '..' }, 'mp3', '{title}'), '_.mp3');
  });
  it('default template', () => {
    assert.equal(buildFilename(fake(1), 'flac', ''), '03 - S_T.flac');
  });
});

describe('filterAlbum (mirrors ymd filter_album)', () => {
  const alb = (o) => ({ id: 1, available: true, metaType: 'music', artists: [{ id: 5 }], ...o });
  it('keeps normal', () => assert.ok(filterAlbum(alb(), 5, {})));
  it('drops unavailable / null id', () => {
    assert.ok(!filterAlbum(alb({ available: false }), 5, {}));
    assert.ok(!filterAlbum(alb({ id: null }), 5, {}));
  });
  it('onlyMusic', () => {
    assert.ok(!filterAlbum(alb({ metaType: 'podcast' }), 5, { onlyMusic: true }));
    assert.ok(filterAlbum(alb({ metaType: 'podcast' }), 5, {}));
  });
  it('stickToArtist (string id ok)', () => {
    assert.ok(!filterAlbum(alb(), 7, { stickToArtist: true }));
    assert.ok(filterAlbum(alb(), '5', { stickToArtist: true }));
  });
});

describe('parseYandexUrl', () => {
  it('track/album/artist/playlist/lk', () => {
    assert.deepEqual(parseYandexUrl('https://music.yandex.ru/album/1/track/2'), { type: 'track', albumId: '1', trackId: '2' });
    assert.deepEqual(parseYandexUrl('https://music.yandex.ru/album/3'), { type: 'album', albumId: '3' });
    assert.deepEqual(parseYandexUrl('https://music.yandex.ru/artist/4'), { type: 'artist', artistId: '4' });
    assert.deepEqual(parseYandexUrl('https://music.yandex.ru/users/u/playlists/5'), { type: 'playlist', owner: 'u', kind: '5' });
    assert.deepEqual(parseYandexUrl('https://music.yandex.ru/playlists/lk.abc?a=1'), { type: 'public-playlist', playlistId: 'lk.abc' });
    assert.equal(parseYandexUrl('https://example.com/nope'), null);
  });
});
