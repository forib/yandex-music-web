function fetchWithTimeout(url, opts = {}, ms = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

module.exports = async (req, res) => {
  const { url, codec } = req.query;
  if (!url || !codec) return res.status(400).json({ error: 'url and codec required' });

  try {
    const infoUrl = decodeURIComponent(url);
    const upstream = await fetchWithTimeout(infoUrl);
    const xml = await upstream.text();

    const get = tag => xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`))?.[1];
    const host = get('host'), path = get('path'), ts = get('ts'), s = get('s');

    if (!host || !path || !ts || !s) {
      return res.status(502).json({ error: 'Bad download-info XML', raw: xml.slice(0, 300) });
    }

    const crypto = require('crypto');
    const md5 = crypto.createHash('md5').update(`XGRlBW9FXlekgbPrRHuSiA${path.slice(1)}${s}`).digest('hex');
    const directUrl = `https://${host}/get-${codec}/${md5}/${ts}${path}`;
    res.json({ url: directUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
