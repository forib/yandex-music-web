const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const YANDEX_API = 'https://api.music.yandex.net';

function fetchWithTimeout(url, opts = {}, ms = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

app.use(express.static(path.join(__dirname, 'public')));

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

    console.log(`→ ${url.toString()}`);
    const upstream = await fetchWithTimeout(url.toString(), {
      headers: { ...YANDEX_HEADERS, ...(auth ? { Authorization: auth } : {}) },
    });
    const text = await upstream.text();
    console.log(`← ${upstream.status} ${apiPath} (${text.length}b)`);
    if (!upstream.ok) console.error('   body:', text.slice(0, 500));
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.status(upstream.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Proxy binary downloads (audio CDN, cover art) to bypass CORS — streamed, no buffering
app.get('/api/stream', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    const upstream = await fetchWithTimeout(decodeURIComponent(url));
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

// Resolve a Yandex download-info URL → final direct audio URL
// Does XML parse + MD5 sign server-side (Web Crypto can't do MD5)
app.get('/api/resolve-download', async (req, res) => {
  const { url, codec } = req.query;
  if (!url || !codec) return res.status(400).json({ error: 'url and codec required' });

  try {
    const infoUrl = decodeURIComponent(url);
    console.log('resolve-download fetching:', infoUrl);
    const upstream = await fetchWithTimeout(infoUrl);
    const xml = await upstream.text();
    console.log('resolve-download response:', xml.slice(0, 400));

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

// Fetch a playlist by UUID/lk-style ID — Yandex requires POST /playlists/list,
// so we expose a simple GET endpoint and do the POST server-side.
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

// Fetch lyrics via API (avoids CORS)
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

// ── Download CDN libs once, serve locally ────────────────────────────────────
const fs = require('fs');
const LIB_DIR = path.join(__dirname, 'public', 'lib');
if (!fs.existsSync(LIB_DIR)) fs.mkdirSync(LIB_DIR, { recursive: true });

async function ensureLib(url, filename) {
  const dest = path.join(LIB_DIR, filename);
  if (fs.existsSync(dest)) return;
  console.log(`Downloading ${filename}…`);
  try {
    const res = await fetch(url);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    console.log(`  → saved ${filename}`);
  } catch (e) {
    console.warn(`  ✗ failed to download ${filename}:`, e.message);
  }
}

app.listen(PORT, async () => {
  console.log(`Yandex Music Web running at http://localhost:${PORT}`);
  await Promise.all([
    ensureLib('https://cdn.jsdelivr.net/npm/browser-id3-writer@4.4.0/dist/browser-id3-writer.min.js', 'id3writer.min.js'),
    ensureLib('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js', 'jszip.min.js'),
  ]);
});
