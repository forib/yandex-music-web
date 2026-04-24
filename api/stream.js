function fetchWithTimeout(url, opts = {}, ms = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

module.exports = async (req, res) => {
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
};
