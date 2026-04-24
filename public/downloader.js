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

function buildFilename(track, container, template) {
  const meta = extractMeta(track);
  const tokens = {
    title:        sanitizeFilename(meta.title || 'Unknown'),
    artist:       sanitizeFilename(meta.artists[0] || meta.albumArtists[0] || 'Unknown'),
    album_artist: sanitizeFilename(meta.albumArtists[0] || meta.artists[0] || 'Unknown'),
    album:        sanitizeFilename(meta.album || ''),
    track:        meta.trackNumber ? String(meta.trackNumber).padStart(2, '0') : '',
    disc:         meta.discNumber  ? String(meta.discNumber) : '',
    year:         meta.date ? meta.date.slice(0, 4) : '',
  };
  if (!template) {
    return `${tokens.track ? tokens.track + ' - ' : ''}${tokens.title}.${container}`;
  }
  let name = template;
  for (const [k, v] of Object.entries(tokens)) name = name.replaceAll(`{${k}}`, v);
  return sanitizeFilename(name.trim()) + '.' + container;
}

// ── Main download function ────────────────────────────────────────────────────

async function downloadTrack(track, token, quality, opts = {}, onStatus, signal) {
  const { embedCover = true, fetchLyrics = false, filenameTemplate = '' } = opts;

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
      const coverUrl = `https://${meta.coverUri.replace('%%', '400x400')}`;
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
    // M4A: return untagged for now
    tagged = audioBytes;
  }

  return { bytes: tagged, filename: buildFilename(track, dlInfo.container, filenameTemplate) };
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

// Save a file — dialog-free on Chrome/Edge (picks folder once, reuses it).
// Falls back to a single blob-download dialog on Firefox/Safari.
async function saveFile(bytes, filename) {
  if ('showDirectoryPicker' in window) {
    if (!_dirHandle) {
      _dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    }
    const fh = await _dirHandle.getFileHandle(filename, { create: true });
    const w  = await fh.createWritable();
    await w.write(bytes);
    await w.close();
  } else {
    _blobDownload(bytes, filename);
  }
}

// Batch-save all items as a single ZIP (Firefox fallback for "Download All").
async function saveAsZip(items, zipName) {
  const zip = new JSZip();
  for (const { bytes, filename } of items) zip.file(filename, bytes);
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  _blobDownload(blob, zipName);
}
