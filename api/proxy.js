const { YANDEX_API, YANDEX_HEADERS, fetchWithRetry } = require('./_lib');

module.exports = async (req, res) => {
  const { path: apiPath, ...queryParams } = req.query;
  if (!apiPath) return res.status(400).json({ error: 'path required' });

  const auth = req.headers['authorization'];
  try {
    const url = new URL(`${YANDEX_API}/${apiPath}`);
    for (const [k, v] of Object.entries(queryParams)) url.searchParams.set(k, v);

    // fetchWithRetry absorbs transient 429/5xx; a persistent 429 is re-surfaced
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
};
