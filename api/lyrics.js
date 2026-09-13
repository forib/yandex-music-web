const { YANDEX_API, ANDROID_HEADERS, fetchWithTimeout, getSignRequest } = require('./_lib');

module.exports = async (req, res) => {
  const { trackId, format = 'TEXT' } = req.query;
  if (!trackId) return res.status(400).json({ error: 'trackId required' });

  const auth = req.headers['authorization'];
  try {
    // Lyrics require a signed request (timeStamp+sign), see _lib.getSignRequest.
    // Like get-file-info, lyrics gate by client: Android headers (403 otherwise).
    const { timeStamp, sign } = getSignRequest(trackId);
    const url = `${YANDEX_API}/tracks/${trackId}/lyrics?format=${format}&timeStamp=${timeStamp}&sign=${encodeURIComponent(sign)}`;
    const upstream = await fetchWithTimeout(url, {
      headers: { ...ANDROID_HEADERS, ...(auth ? { Authorization: auth } : {}) },
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
