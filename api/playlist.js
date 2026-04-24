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
};
