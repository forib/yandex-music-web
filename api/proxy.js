const YANDEX_API = 'https://api.music.yandex.net';
const YANDEX_HEADERS = {
  'X-Yandex-Music-Client': 'WindowsPhone/3.20',
  'Accept': 'application/json',
};

function fetchWithTimeout(url, opts = {}, ms = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

module.exports = async (req, res) => {
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
};
