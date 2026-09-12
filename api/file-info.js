// Resolve a track to download URLs via the NEW get-file-info endpoint
// (HMAC-signed, encraw transport) — returns a decryption `key` for
// encrypted (lossless) tracks. Replaces the legacy download-info flow
// which yields key-less URLs that stay encrypted.
const { getFileInfo } = require('./_lib');

module.exports = async (req, res) => {
  const { trackId, quality = '2' } = req.query;
  if (!trackId) return res.status(400).json({ error: 'trackId required' });

  const auth = req.headers['authorization'];
  try {
    const info = await getFileInfo(trackId, parseInt(quality, 10), auth);
    res.json(info);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};
