const { fetchWithRetry } = require('./_lib');

module.exports = async (req, res) => {
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
};
