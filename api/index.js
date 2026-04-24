// Vercel serverless entry — all /api/* routes, no static serving, no listen
const express = require('express');

const app = express();
const YANDEX_API = 'https://api.music.yandex.net';

function fetchWithTimeout(url, opts = {}, ms = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

const YANDEX_HEADERS = {
  'X-Yandex-Music-Client': 'WindowsPhone/3.20',
  'Accept': 'application/json',
};

// Forward JSON API calls to api.music.yandex.net
app.get('/api/proxy', async (req, res) => {
  const { path: apiPath, ...queryParams } = req.query;
  if (!apiPath) return res.status(400).json({ error: 'path required' });

  const auth = req.headers['authorization'];
  try {
    const url = new URL(`${YANDEX_API}/${apiPath}`);
    for (const [k, v] of Object.entries(queryParams)) url.searchParams.set(k, v);

    const upstream = await fetchWithTimeout(url.toString(), {
      headers: { ...YANDEX_HEADERS, ...(auth ? { Authorization: auth } : {}) },
    });
    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.status(upstream.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Proxy binary downloads (audio CDN, cover art) to bypass CORS — streamed
app.get('/api/stream', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    const upstream = await fetchWithTimeout(decodeURIComponent(url), {}, 60000);
    if (!upstream.ok) return res.status(upstream.status).end();
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
app.get('/api/resolve-download', async (req, res) => {
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
app.get('/api/playlist', async (req, res) => {
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

// Fetch lyrics (avoids CORS)
app.get('/api/lyrics', async (req, res) => {
  const { trackId, format = 'TEXT' } = req.query;
  if (!trackId) return res.status(400).json({ error: 'trackId required' });

  const auth = req.headers['authorization'];
  try {
    const url = `${YANDEX_API}/tracks/${trackId}/lyrics?format=${format}`;
    const upstream = await fetchWithTimeout(url, {
      headers: { ...YANDEX_HEADERS, ...(auth ? { Authorization: auth } : {}) },
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = app;
