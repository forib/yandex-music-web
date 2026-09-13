// Download pipeline: fetch → decrypt → tag → save

// ── Utilities ────────────────────────────────────────────────────────────────

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i >> 1] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}

function concat(...arrays) {
  const len = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

function sanitizeFilename(s) {
  return s.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 200);
}

// Per-segment variant: keeps '/' as a folder separator (handled by caller)
// and neutralizes '.' / '..' so a template cannot escape the target folder.
function sanitizeSegment(s) {
  const out = sanitizeFilename(s);
  return (!out || out === '.' || out === '..') ? '_' : out;
}

// ── Decryption ────────────────────────────────────────────────────────────────

async function decryptAesCtr(encBytes, keyHex) {
  const keyBytes = hexToBytes(keyHex);
  const keyObj = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CTR' }, false, ['decrypt']);
  // PyCryptodome: nonce=bytes(12), initial_value=0  →  counter block = 16 zero bytes
  const counter = new Uint8Array(16);
  const plain = await crypto.subtle.decrypt({ name: 'AES-CTR', counter, length: 32 }, keyObj, encBytes);
  return new Uint8Array(plain);
}

// ── Binary download ───────────────────────────────────────────────────────────

async function fetchBinary(url, onProgress, signal) {
  const res = await fetch(url, signal ? { signal } : {});
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const total = parseInt(res.headers.get('content-length') || '0');
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (onProgress && total) onProgress(loaded / total);
  }
  return concat(...chunks);
}

// ── FLAC metadata writer ──────────────────────────────────────────────────────

function writeLE32(view, off, v) { view.setUint32(off, v, true); }
function writeBE32(view, off, v) { view.setUint32(off, v, false); }

function buildVorbisCommentBlock(comments) {
  const enc = new TextEncoder();
  const vendor = enc.encode('yandex-music-web');
  const encoded = comments.map(c => enc.encode(c));
  let size = 4 + vendor.length + 4 + encoded.reduce((s, c) => s + 4 + c.length, 0);
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  let pos = 0;
  writeLE32(dv, pos, vendor.length); pos += 4;
  buf.set(vendor, pos); pos += vendor.length;
  writeLE32(dv, pos, encoded.length); pos += 4;
  for (const c of encoded) {
    writeLE32(dv, pos, c.length); pos += 4;
    buf.set(c, pos); pos += c.length;
  }
  return buf;
}

function buildPictureBlock(imgBytes, mime) {
  const enc = new TextEncoder();
  const mimeBytes = enc.encode(mime);
  const size = 4 + 4 + mimeBytes.length + 4 + 4*4 + 4 + imgBytes.length;
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  let pos = 0;
  writeBE32(dv, pos, 3); pos += 4;          // COVER_FRONT
  writeBE32(dv, pos, mimeBytes.length); pos += 4;
  buf.set(mimeBytes, pos); pos += mimeBytes.length;
  writeBE32(dv, pos, 0); pos += 4;           // description length = 0
  writeBE32(dv, pos, 0); pos += 4;           // width (unknown)
  writeBE32(dv, pos, 0); pos += 4;           // height (unknown)
  writeBE32(dv, pos, 0); pos += 4;           // color depth (unknown)
  writeBE32(dv, pos, 0); pos += 4;           // color count
  writeBE32(dv, pos, imgBytes.length); pos += 4;
  buf.set(imgBytes, pos);
  return buf;
}

function buildFlacBlock(type, data, isLast) {
  const header = new Uint8Array(4);
  header[0] = (isLast ? 0x80 : 0x00) | (type & 0x7F);
  header[1] = (data.length >> 16) & 0xFF;
  header[2] = (data.length >> 8) & 0xFF;
  header[3] = data.length & 0xFF;
  return concat(header, data);
}

function tagFlac(audioBytes, meta, coverBytes, coverMime) {
  const marker = [0x66, 0x4C, 0x61, 0x43]; // fLaC
  for (let i = 0; i < 4; i++) {
    if (audioBytes[i] !== marker[i]) throw new Error('Not a FLAC file');
  }

  // Parse existing metadata blocks, keep everything except VORBIS_COMMENT(4) and PICTURE(6)
  const kept = [];
  let pos = 4;
  let isLast = false;
  while (!isLast && pos + 4 <= audioBytes.length) {
    const b0 = audioBytes[pos];
    isLast = !!(b0 & 0x80);
    const type = b0 & 0x7F;
    const len = (audioBytes[pos+1] << 16) | (audioBytes[pos+2] << 8) | audioBytes[pos+3];
    const data = audioBytes.slice(pos + 4, pos + 4 + len);
    pos += 4 + len;
    if (type !== 4 && type !== 6) kept.push({ type, data });
  }
  const audioFrames = audioBytes.slice(pos);

  // Build new Vorbis comment block
  const comments = [];
  if (meta.title)  comments.push(`TITLE=${meta.title}`);
  if (meta.album)  comments.push(`ALBUM=${meta.album}`);
  for (const a of (meta.artists || []))      comments.push(`ARTIST=${a}`);
  for (const a of (meta.albumArtists || [])) comments.push(`ALBUMARTIST=${a}`);
  if (meta.date)        comments.push(`DATE=${meta.date}`);
  if (meta.trackNumber) comments.push(`TRACKNUMBER=${meta.trackNumber}`);
  if (meta.discNumber)  comments.push(`DISCNUMBER=${meta.discNumber}`);
  if (meta.genre)       comments.push(`GENRE=${meta.genre}`);
  if (meta.lyrics)      comments.push(`LYRICS=${meta.lyrics}`);
  if (meta.url)         comments.push(`COMMENT=${meta.url}`);

  const blocks = [...kept, { type: 4, data: buildVorbisCommentBlock(comments) }];
  if (coverBytes) blocks.push({ type: 6, data: buildPictureBlock(coverBytes, coverMime || 'image/jpeg') });

  const parts = [new Uint8Array([0x66, 0x4C, 0x61, 0x43])];
  for (let i = 0; i < blocks.length; i++) {
    parts.push(buildFlacBlock(blocks[i].type, blocks[i].data, i === blocks.length - 1));
  }
  parts.push(audioFrames);
  return concat(...parts);
}

// ── M4A tagging (iTunes ilst atoms) ────────────────────────────────────────────
// Pure-JS port of ymd/core.py::set_tags MP4 branch. Rewrites moov/udta/meta/ilst
// and shifts stco/co64 chunk offsets when moov grows in front of mdat.

const _T = new TextEncoder();
const _D = new TextDecoder('latin1');

function mp4u32(b, o) { return (b[o] * 0x1000000) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; }
function mp4set32(b, o, v) { b[o] = (v >>> 24) & 0xFF; b[o + 1] = (v >>> 16) & 0xFF; b[o + 2] = (v >>> 8) & 0xFF; b[o + 3] = v & 0xFF; }
function mp4type(b, o) { return _D.decode(b.slice(o, o + 4)); }
// 4CC box names are single-byte (latin1): UTF-8 would encode © as 2 bytes.
function mp4cc(s) { return Uint8Array.from([...s], c => c.charCodeAt(0) & 0xFF); }
function mp4box(type, ...payloads) {
  const size = 8 + payloads.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(size);
  mp4set32(out, 0, size);
  out.set(mp4cc(type), 4);
  let p = 8;
  for (const pl of payloads) { out.set(pl, p); p += pl.length; }
  return out;
}
// Parse direct children of a box payload. Returns [{type, start, size, header}].
// `full` skips the 4 version/flags bytes (meta). Handles 64-bit largesize.
function mp4children(buf, start, end, full = false) {
  const out = [];
  let p = start + (full ? 4 : 0);
  while (p + 8 <= end) {
    let size = mp4u32(buf, p);
    let header = 8;
    if (size === 1) {
      const hi = mp4u32(buf, p + 8), lo = mp4u32(buf, p + 12);
      if (hi !== 0 || lo > 0xFFFFFFFF) throw new Error('MP4 box too large');
      size = lo; header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) throw new Error('Broken MP4 box');
    out.push({ type: mp4type(buf, p + header - (header === 16 ? 12 : 4)), start: p, size, header });
    p += size;
  }
  return out;
}
function mp4find(buf, start, end, type, full = false) {
  return mp4children(buf, start, end, full).find(c => c.type === type) || null;
}
function mp4data(payload, dtype) {
  const head = new Uint8Array(8);
  mp4set32(head, 0, dtype); mp4set32(head, 4, 0);
  return mp4box('data', head, payload);
}
function mp4textItem(name, str) {
  return mp4box(name, mp4data(_T.encode(str), 1));
}
function mp4numItem(name, n) {
  // trkn/disk: reserved(2), number(2), total(2)=0, reserved(2) — iTunes layout
  const v = new Uint8Array(8);
  v[2] = (n >>> 8) & 0xFF; v[3] = n & 0xFF;
  return mp4box(name, mp4data(v, 0));
}
// Replace (or append) a direct child box; fixes the parent size. kidsOffset is
// 8 for plain boxes, 12 for full boxes like meta (size+type+version/flags).
function mp4swap(buf, boxStart, kidsOffset, type, newBox) {
  const boxSize = mp4u32(buf, boxStart);
  const kids = mp4children(buf, boxStart + kidsOffset, boxStart + boxSize);
  const parts = [buf.slice(boxStart, boxStart + kidsOffset)];
  let done = false;
  for (const k of kids) {
    if (!done && k.type === type) { parts.push(newBox); done = true; }
    else parts.push(buf.slice(k.start, k.start + k.size));
  }
  if (!done) parts.push(newBox);
  const out = concat(...parts);
  mp4set32(out, 0, out.length);
  return out;
}
// Only true containers are descended into — leaf boxes (mvhd, stsd, data, …)
// would misparse as boxes and never contain chunk offsets anyway.
const MP4_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'mvex', 'moof', 'traf']);
// Shift every stco/co64 entry under moov by delta (mdat moved).
function mp4shiftOffsets(moov, delta) {
  const walk = (s, e) => {
    for (const c of mp4children(moov, s, e)) {
      if (c.type === 'stco') {
        const n = mp4u32(moov, c.start + 12);
        for (let i = 0; i < n; i++) {
          const o = c.start + 16 + i * 4;
          mp4set32(moov, o, mp4u32(moov, o) + delta);
        }
      } else if (c.type === 'co64') {
        const n = mp4u32(moov, c.start + 12);
        for (let i = 0; i < n; i++) {
          const o = c.start + 16 + i * 8;
          const v = mp4u32(moov, o) * 0x100000000 + mp4u32(moov, o + 4) + delta;
          mp4set32(moov, o, Math.floor(v / 0x100000000)); mp4set32(moov, o + 4, v >>> 0);
        }
      } else if (MP4_CONTAINERS.has(c.type)) {
        walk(c.start + c.header, c.start + c.size);
      }
    }
  };
  walk(8, moov.length);
}

function tagM4a(audioBytes, meta, coverBytes, coverMime) {
  if (mp4type(audioBytes, 4) !== 'ftyp') throw new Error('Not an MP4 file');
  const top = mp4children(audioBytes, 0, audioBytes.length);

  let moov = top.find(c => c.type === 'moov');
  if (!moov) throw new Error('MP4 without moov');
  let moovBuf = audioBytes.slice(moov.start, moov.start + moov.size);

  // Bottom-up rebuild via mp4swap (appends the child when missing)
  const hdlrNew = () => mp4box('hdlr', new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 109, 100, 105, 114, 97, 112, 112, 108, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  let udta = mp4find(moovBuf, 8, moovBuf.length, 'udta');

  // Build new ilst. Artists joined with '; ' (ymd compatibility-level 1).
  const items = [];
  if (meta.title)  items.push(mp4textItem('\xa9nam', meta.title));
  if (meta.album)  items.push(mp4textItem('\xa9alb', meta.album));
  if (meta.artists?.length)      items.push(mp4textItem('\xa9ART', meta.artists.join('; ')));
  if (meta.albumArtists?.length) items.push(mp4textItem('aART', meta.albumArtists.join('; ')));
  if (meta.date)        items.push(mp4textItem('\xa9day', meta.date));
  if (meta.trackNumber) items.push(mp4numItem('trkn', meta.trackNumber));
  if (meta.discNumber)  items.push(mp4numItem('disk', meta.discNumber));
  if (meta.genre)       items.push(mp4textItem('\xa9gen', meta.genre));
  if (meta.lyrics)      items.push(mp4textItem('\xa9lyr', meta.lyrics));
  if (meta.url)         items.push(mp4textItem('\xa9cmt', meta.url));
  if (coverBytes) {
    const fmt = coverMime === 'image/png' ? 14 : 13;
    items.push(mp4box('covr', mp4data(coverBytes, fmt)));
  }
  const ilstNew = mp4box('ilst', ...items);

  // meta <- ilst, then udta <- meta, then moov <- udta
  let metaNew;
  if (!udta) {
    metaNew = mp4box('meta', new Uint8Array([0, 0, 0, 0]), hdlrNew(), ilstNew);
  } else {
    const udtaKids = mp4children(moovBuf, udta.start + udta.header, udta.start + udta.size);
    const meta = udtaKids.find(c => c.type === 'meta');
    metaNew = meta
      ? mp4swap(moovBuf, meta.start, meta.header + 4, 'ilst', ilstNew)
      : mp4box('meta', new Uint8Array([0, 0, 0, 0]), hdlrNew(), ilstNew);
  }
  const udtaNew = udta
    ? mp4swap(moovBuf, udta.start, udta.header, 'meta', metaNew)
    : mp4box('udta', metaNew);
  const moovNew = mp4swap(moovBuf, 0, 8, 'udta', udtaNew);

  const delta = moovNew.length - moov.size;
  if (delta !== 0) {
    // If mdat sits after moov, chunk offsets shifted — patch them.
    const firstMdat = top.find(c => c.type === 'mdat');
    if (firstMdat && firstMdat.start > moov.start) mp4shiftOffsets(moovNew, delta);
  }

  const parts = top.map(c => (c.type === 'moov' ? moovNew : audioBytes.slice(c.start, c.start + c.size)));
  return concat(...parts);
}

// ── MP3 tagging via browser-id3-writer ───────────────────────────────────────

function tagMp3(audioBytes, meta, coverBytes, coverMime) {
  // browser-id3-writer must be loaded via CDN script tag
  if (typeof ID3Writer === 'undefined') {
    console.warn('ID3Writer not loaded — MP3 returned without tags');
    return audioBytes;
  }
  const writer = new ID3Writer(audioBytes.buffer);
  if (meta.title)  writer.setFrame('TIT2', meta.title);
  if (meta.album)  writer.setFrame('TALB', meta.album);
  if (meta.artists?.length) writer.setFrame('TPE1', meta.artists);
  if (meta.albumArtists?.length) writer.setFrame('TPE2', meta.albumArtists);
  if (meta.date)   writer.setFrame('TYER', parseInt(meta.date));
  if (meta.trackNumber) writer.setFrame('TRCK', String(meta.trackNumber));
  if (meta.genre)  writer.setFrame('TCON', [meta.genre]);
  if (meta.lyrics) writer.setFrame('USLT', { description: '', lyrics: meta.lyrics });
  if (coverBytes) {
    writer.setFrame('APIC', {
      type: 3,
      data: coverBytes.buffer,
      description: '',
      useUnicodeEncoding: false,
    });
  }
  writer.addTag();
  return new Uint8Array(writer.arrayBuffer);
}

// ── Track metadata extraction from API response ───────────────────────────────

function extractMeta(track) {
  const album = track.albums?.[0] || {};
  const pos = album.trackPosition;
  const rd = album.releaseDate;
  let date = null;
  if (rd) { try { date = rd.slice(0, 10); } catch {} }
  if (!date && album.year) date = String(album.year);

  return {
    title: track.title + (track.version ? ` (${track.version})` : ''),
    album: (album.title || '') + (album.version ? ` (${album.version})` : ''),
    artists: (track.artists || []).map(a => a.name).filter(Boolean),
    albumArtists: (album.artists || []).map(a => a.name).filter(Boolean),
    date,
    trackNumber: pos?.index ?? null,
    discNumber: pos?.volume ?? null,
    genre: album.genre || null,
    coverUri: track.coverUri || album.coverUri || null,
    url: album.id && track.id
      ? `https://music.yandex.ru/album/${album.id}/track/${track.id}`
      : null,
  };
}

// Returns a RELATIVE path (may contain '/' folders from the template).
// Default mirrors ymd DEFAULT_PATH_PATTERN: #album-artist/#album/#number - #title.
// The {disc} token avoids multi-disc collisions (01 - Intro on disc 1 and 2).
function buildFilename(track, container, template) {
  const meta = extractMeta(track);
  const tokens = {
    title:        meta.title || 'Unknown',
    artist:       meta.artists[0] || meta.albumArtists[0] || 'Unknown',
    album_artist: meta.albumArtists[0] || meta.artists[0] || 'Unknown',
    album:        meta.album || '',
    track:        meta.trackNumber ? String(meta.trackNumber).padStart(2, '0') : '',
    disc:         meta.discNumber ? String(meta.discNumber) : '',
    year:         meta.date ? meta.date.slice(0, 4) : '',
  };
  const tpl = (template && template.trim()) ? template : '{track} - {title}';
  let name = tpl;
  for (const [k, v] of Object.entries(tokens)) name = name.replaceAll(`{${k}}`, v);
  const parts = name.split('/').map(sanitizeSegment).filter(p => p !== '');
  if (!parts.length) parts.push('Unknown');
  return parts.join('/') + '.' + container;
}

function basename(p) { return String(p).split('/').pop(); }

// ── Main download function ────────────────────────────────────────────────────

async function downloadTrack(track, token, quality, opts = {}, onStatus, signal) {
  const { embedCover = true, fetchLyrics = false, filenameTemplate = '', coverResolution = 400 } = opts;

  onStatus?.('Getting download info...');
  const dlInfo = await getTrackDownloadInfo(track.id, token, quality);

  const audioUrl = dlInfo.urls[Math.floor(Math.random() * dlInfo.urls.length)];

  onStatus?.(`Downloading ${dlInfo.codec.toUpperCase()} ${dlInfo.bitrate > 0 ? dlInfo.bitrate + 'kbps' : ''}...`);
  let audioBytes = await fetchBinary(
    `/api/stream?url=${encodeURIComponent(audioUrl)}`,
    p => onStatus?.(`Downloading… ${Math.round(p * 100)}%`),
    signal
  );

  if (dlInfo.key) {
    onStatus?.('Decrypting...');
    audioBytes = await decryptAesCtr(audioBytes, dlInfo.key);
  }

  let coverBytes = null;
  let coverMime = 'image/jpeg';
  const meta = extractMeta(track);

  if (meta.coverUri) {
    try {
      // coverResolution <= 0 means original size (mirrors ymd --cover-resolution).
      const size = coverResolution > 0 ? `${coverResolution}x${coverResolution}` : 'orig';
      const coverUrl = `https://${meta.coverUri.replace('%%', size)}`;
      const coverRes = await fetchBinary(`/api/stream?url=${encodeURIComponent(coverUrl)}`);
      coverBytes = coverRes;
      if (coverBytes[0] === 0x89 && coverBytes[1] === 0x50) coverMime = 'image/png';
    } catch (e) {
      console.warn('Cover fetch failed:', e);
    }
  }

  let lyrics = null;
  if (fetchLyrics && track.lyricsInfo?.hasAvailableTextLyrics) {
    try { lyrics = await getLyrics(track.id, token, 'TEXT'); } catch {}
  }

  onStatus?.('Tagging metadata...');
  const fullMeta = { ...meta, lyrics };
  let tagged;
  if (dlInfo.container === 'flac') {
    tagged = tagFlac(audioBytes, fullMeta, embedCover ? coverBytes : null, coverMime);
  } else if (dlInfo.container === 'mp3') {
    tagged = tagMp3(audioBytes, fullMeta, embedCover ? coverBytes : null, coverMime);
  } else {
    tagged = tagM4a(audioBytes, fullMeta, embedCover ? coverBytes : null, coverMime);
  }

  const relpath = buildFilename(track, dlInfo.container, filenameTemplate);
  return { bytes: tagged, filename: basename(relpath), relpath };
}

// Generic worker pool: at most n fn() in flight. shouldStop() is checked
// between items (used by the UI Stop button). Resolves when all done.
async function runPool(n, items, fn, shouldStop) {
  let ptr = 0;
  const workers = [];
  const total = items.length;
  for (let w = 0; w < Math.min(Math.max(1, n || 1), total); w++) {
    workers.push((async () => {
      while (!(shouldStop && shouldStop()) && ptr < total) {
        const k = ptr++;
        await fn(items[k], k);
      }
    })());
  }
  await Promise.all(workers);
}

// True if any likely output (mp3/flac/m4a) already exists under the picked
// folder. Container is unknown before download-info, so all 3 are probed.
// Returns false when no folder was picked yet (nothing to skip).
async function outputFileExistsAny(track, template) {
  if (typeof _dirHandle === 'undefined' || !_dirHandle) return false;
  for (const c of ['mp3', 'flac', 'm4a']) {
    const segs = buildFilename(track, c, template).split('/').filter(Boolean);
    const name = segs.pop();
    try {
      let dir = _dirHandle;
      for (const s of segs) dir = await dir.getDirectoryHandle(s);
      await dir.getFileHandle(name);
      return true;
    } catch {}
  }
  return false;
}

// Pick a non-colliding filename inside a directory handle: `x.m4a`, `x (2).m4a`, …
// (Multi-disc albums otherwise overwrite `01 - Intro` from disc 1 with disc 2.)
async function uniqueName(dir, filename) {
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  let name = filename;
  for (let n = 2; ; n++) {
    try { await dir.getFileHandle(name); name = `${base} (${n})${ext}`; }
    catch { return name; }
  }
}

let _dirHandle = null;

function _blobDownload(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes]));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// Save bytes — target may contain '/' subfolders (created on the fly).
// Firefox fallback (single save dialog) uses the basename only.
async function saveFile(bytes, target) {
  const segs = String(target).split('/').filter(Boolean);
  const filename = segs.pop() || 'unknown';
  if ('showDirectoryPicker' in window) {
    if (!_dirHandle) {
      _dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    }
    let dir = _dirHandle;
    for (const s of segs) dir = await dir.getDirectoryHandle(s, { create: true });
    const fh = await dir.getFileHandle(await uniqueName(dir, filename), { create: true });
    const w  = await fh.createWritable();
    await w.write(bytes);
    await w.close();
  } else {
    _blobDownload(bytes, filename);
  }
}

// Batch-save all items as a single ZIP (Firefox fallback for "Download All").
// Respects relpath folders; de-duplicates like uniqueName.
async function saveAsZip(items, zipName) {
  const zip = new JSZip();
  const seen = new Set();
  for (const { bytes, filename, relpath } of items) {
    let p = String(relpath || filename).replace(/^\/+/, '');
    if (seen.has(p)) {
      const dot = p.lastIndexOf('.');
      const base = dot > 0 ? p.slice(0, dot) : p;
      const ext = dot > 0 ? p.slice(dot) : '';
      let n = 2;
      while (seen.has(`${base} (${n})${ext}`)) n++;
      p = `${base} (${n})${ext}`;
    }
    seen.add(p);
    zip.file(p, bytes);
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  _blobDownload(blob, zipName);
}
