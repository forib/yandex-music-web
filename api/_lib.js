// Shared helpers for /api/* serverless functions.
// NOTE: underscore prefix — Vercel does NOT expose this file as a route.
const YANDEX_API = 'https://api.music.yandex.net';

const YANDEX_HEADERS = {
  'X-Yandex-Music-Client': 'WindowsPhone/3.20',
  'Accept': 'application/json',
};

// Signed/personalized endpoints (get-file-info, lyrics) gate by client identity:
// WindowsPhone gets 403, the Android build string from the yandex-music lib works.
const ANDROID_HEADERS = {
  'X-Yandex-Music-Client': 'YandexMusicAndroid/24023621',
  'Accept': 'application/json',
};

function fetchWithTimeout(url, opts = {}, ms = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// GET with retries on 5xx/429/network errors.
// Mirrors ymd/core.py::init_client retry wrapper (tries + backoff).
// CDN edge nodes occasionally answer 500 on fresh signed URLs (seen live).
async function fetchWithRetry(url, opts = {}, ms = 60000, tries = 3) {
  let lastErr = new Error('no attempts');
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetchWithTimeout(url, opts, ms);
      if (r.ok || (r.status < 500 && r.status !== 429)) return r;
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise(r => setTimeout(r, 2000 * (a + 1)));
  }
  throw lastErr;
}

// ── get-file-info (port of ymd/api.py::get_download_info) ────────────────────
// New endpoint for lossless (encraw transport). The legacy `download-info`
// endpoint used by getTrackDownloadInfo() has no decryption key, so FLAC
// tracks downloaded through it stay encrypted. This one returns `key`.
//
// Signing replicates the Python version exactly:
//   sign = base64(hmac_sha256(SIGN_KEY, f"{ts}{trackId}{quality}{codecs_no_commas}encraw"))[:-1]
const FILE_INFO_SIGN_KEY = 'p93jhgh689SBReK6ghtw62'; // DEFAULT_SIGN_KEY from yandex-music (public const)
const FILE_INFO_CODECS = ['flac', 'flac-mp4', 'mp3', 'aac', 'he-aac', 'aac-mp4', 'he-aac-mp4'];
const FILE_INFO_QUALITY = { 2: 'lossless', 1: 'nq', 0: 'lq' };

const FILE_FORMAT_MAP = {
  'flac':       { container: 'flac', codec: 'flac' },
  'flac-mp4':   { container: 'm4a',  codec: 'flac' },
  'mp3':        { container: 'mp3',  codec: 'mp3'  },
  'aac':        { container: 'm4a',  codec: 'aac'  },
  'he-aac':     { container: 'm4a',  codec: 'aac'  },
  'aac-mp4':    { container: 'm4a',  codec: 'aac'  },
  'he-aac-mp4': { container: 'm4a',  codec: 'aac'  },
};

async function getFileInfo(trackId, qualityLevel, auth) {
  const crypto = require('crypto');
  const quality = FILE_INFO_QUALITY[qualityLevel] ?? 'lossless';
  const ts = Math.floor(Date.now() / 1000);
  const codecsParam = FILE_INFO_CODECS.join(',');
  const signBase = `${ts}${trackId}${quality}${FILE_INFO_CODECS.join('')}encraw`;
  const sign = crypto
    .createHmac('sha256', FILE_INFO_SIGN_KEY)
    .update(signBase)
    .digest('base64')
    .replace(/=$/, '');

  const url = new URL(`${YANDEX_API}/get-file-info`);
  url.searchParams.set('ts', String(ts));
  url.searchParams.set('trackId', String(trackId));
  url.searchParams.set('quality', quality);
  url.searchParams.set('codecs', codecsParam);
  url.searchParams.set('transports', 'encraw');
  url.searchParams.set('sign', sign);

  // NB: the endpoint gates by client identity — the WindowsPhone header used
  // for catalog calls gets HTTP 403 not-allowed here (verified live).
  const upstream = await fetchWithTimeout(url.toString(), {
    headers: { ...ANDROID_HEADERS, ...(auth ? { Authorization: auth } : {}) },
  });
  const text = await upstream.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`get-file-info non-JSON: ${text.slice(0, 200)}`); }
  if (!upstream.ok) {
    throw new Error(`get-file-info HTTP ${upstream.status}: ${text.slice(0, 300)}`);
  }
  // python client unwraps `result`, raw HTTP nests under downloadInfo — accept both
  const e = data.downloadInfo || data.result?.downloadInfo || data.result;
  if (!e || !Array.isArray(e.urls) || !e.codec) {
    throw new Error(`Bad get-file-info response: ${text.slice(0, 300)}`);
  }
  const fmt = FILE_FORMAT_MAP[e.codec];
  if (!fmt) throw new Error(`Unknown codec: ${e.codec}`);
  return {
    ...fmt,
    quality: e.quality,
    urls: e.urls,
    key: e.key ?? null,
    bitrate: e.bitrate || 0,
  };
}

// ── lyrics signing (port of yandex_music/utils/sign_request.py) ─────────────
// GET /tracks/{id}/lyrics requires timeStamp+sign params:
//   sign = base64(hmac_sha256(SIGN_KEY, f"{trackId}{timestamp}"))  (padding KEPT)
function getSignRequest(trackId) {
  const crypto = require('crypto');
  const numericId = String(trackId).split(':')[0];
  const timeStamp = Math.floor(Date.now() / 1000);
  const sign = crypto
    .createHmac('sha256', FILE_INFO_SIGN_KEY)
    .update(`${numericId}${timeStamp}`)
    .digest('base64');
  return { timeStamp, sign };
}

module.exports = {
  YANDEX_API,
  YANDEX_HEADERS,
  ANDROID_HEADERS,
  fetchWithTimeout,
  fetchWithRetry,
  FILE_FORMAT_MAP,
  getFileInfo,
  getSignRequest,
};
