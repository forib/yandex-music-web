const { YANDEX_API, YANDEX_HEADERS, fetchWithTimeout } = require('./_lib');

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
