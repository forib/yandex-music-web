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
};
