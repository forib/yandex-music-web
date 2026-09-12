// Fetch lyrics TEXT content server-side (two-step: signed meta call,
// then follow the pre-signed downloadUrl). Bypasses S3 CORS for browsers.
const { YANDEX_API, ANDROID_HEADERS, fetchWithTimeout, getSignRequest } = require('./_lib');

module.exports = async (req, res) => {
  const { trackId, format = 'TEXT' } = req.query;
  if (!trackId) return res.status(400).json({ error: 'trackId required' });

  const auth = req.headers['authorization'];
  try {
    const { timeStamp, sign } = getSignRequest(trackId);
    const metaUrl =
      `${YANDEX_API}/tracks/${trackId}/lyrics` +
      `?format=${format}&timeStamp=${timeStamp}&sign=${encodeURIComponent(sign)}`;
    const meta = await fetchWithTimeout(metaUrl, {
      headers: { ...ANDROID_HEADERS, ...(auth ? { Authorization: auth } : {}) },
    });
    if (!meta.ok) return res.status(meta.status).json({ error: `lyrics meta HTTP ${meta.status}` });
    const metaJson = await meta.json();
    const downloadUrl = metaJson?.result?.downloadUrl;
    if (!downloadUrl) return res.status(404).json({ error: 'no lyrics for this track' });

    const textRes = await fetchWithTimeout(downloadUrl, {}, 30000);
    if (!textRes.ok) return res.status(502).json({ error: `lyrics download HTTP ${textRes.status}` });
    res.json({ lyrics: await textRes.text() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
