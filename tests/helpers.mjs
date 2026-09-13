// Shared loader: browser scripts have no exports — eval them jointly
// (mirrors <script> tag globals) and pick the needed functions.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadFrontend({ withID3 = false } = {}) {
  let id3;
  if (withID3) {
    const src = fs.readFileSync(path.join(root, 'public/lib/id3writer.min.js'), 'utf8');
    const m = { exports: {} };
    new Function('module', 'exports', src)(m, m.exports);
    id3 = m.exports?.ID3Writer || m.exports;
  }
  const apiSrc = fs.readFileSync(path.join(root, 'public/yandex-api.js'), 'utf8');
  const dlSrc = fs.readFileSync(path.join(root, 'public/downloader.js'), 'utf8').split('let _dirHandle')[0];
  const mod = { exports: {} };
  new Function('module', 'exports', 'ID3Writer', apiSrc + '\n' + dlSrc +
    ';module.exports={tagM4a,tagFlac,tagMp3,extractMeta,buildFilename,filterAlbum,parseYandexUrl,mp4children,mp4u32};'
  )(mod, mod.exports, id3);
  return mod.exports;
}

export function concat(...as) {
  const o = new Uint8Array(as.reduce((s, a) => s + a.length, 0));
  let p = 0;
  for (const a of as) { o.set(a, p); p += a.length; }
  return o;
}

// Minimal MP4 box builder (latin1 4CC, like the lib must use).
export function mp4box(type, ...payloads) {
  const size = 8 + payloads.reduce((s, p) => s + p.length, 0);
  const o = new Uint8Array(size);
  o[0] = size >>> 24; o[1] = (size >>> 16) & 255; o[2] = (size >>> 8) & 255; o[3] = size & 255;
  o.set(Buffer.from(type, 'latin1'), 4);
  let p = 8;
  for (const pl of payloads) { o.set(pl, p); p += pl.length; }
  return o;
}

export function mp4stco(entries) {
  const o = new Uint8Array(8 + entries.length * 4);
  o[7] = entries.length;
  entries.forEach((v, i) => {
    o[8 + i * 4] = v >>> 24; o[9 + i * 4] = (v >>> 16) & 255;
    o[10 + i * 4] = (v >>> 8) & 255; o[11 + i * 4] = v & 255;
  });
  return mp4box('stco', o);
}

export const META = {
  title: 'T', album: 'A', artists: ['A1', 'A2'], albumArtists: ['AA'],
  date: '2024-01-15', trackNumber: 5, discNumber: 2, genre: 'rock',
  lyrics: 'la', url: 'https://x/y',
};
