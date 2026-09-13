// Vercel serverless entry — all /api/* routes, no static serving, no listen
// NOTE: Vercel strips the /api prefix before calling this function,
// so routes here use /proxy, /stream etc. (not /api/proxy, /api/stream).
const express = require('express');

const app = express();
const { YANDEX_API, YANDEX_HEADERS, ANDROID_HEADERS, fetchWithTimeout, fetchWithRetry, getSignRequest, getFileInfo } = require('./_lib');

// Forward JSON API calls to api.music.yandex.net
app.get(['/proxy', '/api/proxy'], async (req, res) => {
  const { path: apiPath, ...queryParams } = req.query;
  if (!apiPath) return res.status(400).json({ error: 'path required' });

  const auth = req.headers['authorization'];
  try {
    const url = new URL(`${YANDEX_API}/${apiPath}`);
    for (const [k, v] of Object.entries(queryParams)) url.searchParams.set(k, v);

    // fetchWithRetry absorbs transient 429/5xx; persistent 429 re-surfaced
    // with its status so the browser can back off too (see apiGet).
    const upstream = await fetchWithRetry(url.toString(), {
      headers: { ...YANDEX_HEADERS, ...(auth ? { Authorization: auth } : {}) },
    });
    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.status(upstream.status).json(data);
  } catch (e) {
    const m = String((e && e.message) || '').match(/^HTTP (\d{3})$/);
    res.status(m ? Number(m[1]) : 500).json({ error: e.message });
  }
});

// Proxy binary downloads (audio CDN, cover art) to bypass CORS — streamed
app.get(['/stream', '/api/stream'], async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    // Retry transient CDN 5xx (seen live on fresh signed URLs)
    const upstream = await fetchWithRetry(decodeURIComponent(url));
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    const cl = upstream.headers.get('content-length');
    if (cl) res.setHeader('Content-Length', cl);
    const { Readable } = require('stream');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Resolve a Yandex download-info URL → final direct audio URL (XML parse + MD5 sign)
app.get(['/resolve-download', '/api/resolve-download'], async (req, res) => {
  const { url, codec } = req.query;
  if (!url || !codec) return res.status(400).json({ error: 'url and codec required' });

  try {
    const infoUrl = decodeURIComponent(url);
    const upstream = await fetchWithTimeout(infoUrl);
    const xml = await upstream.text();

    const get = tag => xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`))?.[1];
    const host = get('host'), path = get('path'), ts = get('ts'), s = get('s');

    if (!host || !path || !ts || !s) {
      return res.status(502).json({ error: 'Bad download-info XML', raw: xml.slice(0, 300) });
    }

    const crypto = require('crypto');
    const md5 = crypto.createHash('md5').update(`XGRlBW9FXlekgbPrRHuSiA${path.slice(1)}${s}`).digest('hex');
    const directUrl = `https://${host}/get-${codec}/${md5}/${ts}${path}`;
    res.json({ url: directUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Server-side POST to /playlists/list (UUID kinds rejected by that endpoint via GET)
app.get(['/playlist', '/api/playlist'], async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });

  const auth = req.headers['authorization'];
  try {
    const upstream = await fetchWithTimeout(`${YANDEX_API}/playlists/list`, {
      method: 'POST',
      headers: {
        ...YANDEX_HEADERS,
        ...(auth ? { Authorization: auth } : {}),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `playlist-ids=${encodeURIComponent(id)}`,
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fetch lyrics (avoids CORS) — signed request, see _lib.getSignRequest
app.get(['/lyrics', '/api/lyrics'], async (req, res) => {
  const { trackId, format = 'TEXT' } = req.query;
  if (!trackId) return res.status(400).json({ error: 'trackId required' });

  const auth = req.headers['authorization'];
  try {
    const { timeStamp, sign } = getSignRequest(trackId);
    const url = `${YANDEX_API}/tracks/${trackId}/lyrics?format=${format}&timeStamp=${timeStamp}&sign=${encodeURIComponent(sign)}`;
    const upstream = await fetchWithTimeout(url, {
      headers: { ...ANDROID_HEADERS, ...(auth ? { Authorization: auth } : {}) },
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lyrics text content (two-step: signed meta + pre-signed S3 download, no CORS)
app.get(['/lyrics-text', '/api/lyrics-text'], async (req, res) => {
  const { trackId, format = 'TEXT' } = req.query;
  if (!trackId) return res.status(400).json({ error: 'trackId required' });

  const auth = req.headers['authorization'];
  try {
    const { timeStamp, sign } = getSignRequest(trackId);
    const metaUrl =
      `${YANDEX_API}/tracks/${trackId}/lyrics` +
      `?format=${format}&timeStamp=${timeStamp}&sign=${encodeURIComponent(sign)}`;
    const meta = await fetchWithTimeout(metaUrl, {
      headers: { ...ANDROID_HEADERS, ...(auth ? { Authorization: auth } : {}) },
    });
    if (!meta.ok) return res.status(meta.status).json({ error: `lyrics meta HTTP ${meta.status}` });
    const downloadUrl = (await meta.json())?.result?.downloadUrl;
    if (!downloadUrl) return res.status(404).json({ error: 'no lyrics for this track' });
    const textRes = await fetchWithTimeout(downloadUrl, {}, 30000);
    if (!textRes.ok) return res.status(502).json({ error: `lyrics download HTTP ${textRes.status}` });
    res.json({ lyrics: await textRes.text() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// New get-file-info endpoint (HMAC-signed, encraw) — returns decryption key
app.get(['/file-info', '/api/file-info'], async (req, res) => {
  const { trackId, quality = '2' } = req.query;
  if (!trackId) return res.status(400).json({ error: 'trackId required' });

  const auth = req.headers['authorization'];
  try {
    res.json(await getFileInfo(trackId, parseInt(quality, 10), auth));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = app;
