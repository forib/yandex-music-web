// Yandex Music API wrapper — browser-side, all calls go through /api/proxy

const FILE_FORMAT_MAP = {
  'flac':       { container: 'flac', codec: 'flac' },
  'mp3':        { container: 'mp3',  codec: 'mp3'  },
  'aac':        { container: 'm4a',  codec: 'aac'  },
  'he-aac':     { container: 'm4a',  codec: 'he-aac' },
};

// quality selector value → preferred quality string in download-info response
const QUALITY_PREF = { 2: 'lossless', 1: 'high', 0: 'low' };
const QUALITY_RANK = { lossless: 4, high: 3, medium: 2, low: 1 };

function authHeader(token) {
  return token ? { 'Authorization': `OAuth ${token}` } : {};
}

async function apiGet(apiPath, params, token) {
  const qs = new URLSearchParams({ path: apiPath, ...params }).toString();
  const res = await fetch(`/api/proxy?${qs}`, { headers: authHeader(token) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`${res.status} on ${apiPath}: non-JSON response: ${text.slice(0, 200)}`); }
  if (!res.ok) {
    const pick = v => (typeof v === 'string' && v) || null;
    const detail =
      pick(data?.result?.message) ||
      pick(data?.error?.message)  ||
      pick(data?.error)           ||
      JSON.stringify(data).slice(0, 300);
    throw new Error(`${res.status} on ${apiPath}: ${detail}`);
  }
  return data;
}

async function getTrackDownloadInfo(trackId, token, qualityLevel = 2) {
  const data = await apiGet(`tracks/${trackId}/download-info`, {}, token);
  const options = data.result;
  if (!options?.length) throw new Error('No download options returned');

  const pref = QUALITY_PREF[qualityLevel] ?? 'lossless';
  const sorted = [...options].sort((a, b) =>
    (QUALITY_RANK[b.quality] ?? 0) - (QUALITY_RANK[a.quality] ?? 0)
  );
  const chosen = sorted.find(o => o.quality === pref) || sorted[0];

  if (!chosen.downloadInfoUrl) throw new Error('downloadInfoUrl missing in API response');
  const res = await fetch(
    `/api/resolve-download?url=${encodeURIComponent(chosen.downloadInfoUrl)}&codec=${chosen.codec}`
  );
  const rawText = await res.text();
  let resolved;
  try { resolved = JSON.parse(rawText); }
  catch { throw new Error('resolve-download non-JSON: ' + rawText.slice(0, 200)); }
  if (!res.ok) throw new Error('resolve-download failed: ' + (resolved.error || rawText.slice(0, 200)));

  const fmt = FILE_FORMAT_MAP[chosen.codec] ?? { container: chosen.codec, codec: chosen.codec };
  return {
    ...fmt,
    quality: chosen.quality,
    urls: [resolved.url],
    key: null,
    bitrate: chosen.bitrateInKbps || 0,
  };
}

async function getTrack(trackId, token) {
  const data = await apiGet('tracks', { trackIds: trackId }, token);
  const tracks = data.result;
  if (!tracks?.length) throw new Error(`Track ${trackId} not found`);
  return tracks[0];
}

async function getAlbumWithTracks(albumId, token) {
  const data = await apiGet(`albums/${albumId}/with-tracks`, {}, token);
  return data.result;
}

async function getArtistAlbums(artistId, token, page = 0) {
  const data = await apiGet(`artists/${artistId}/direct-albums`, { page, pageSize: 20 }, token);
  return data.result;
}

async function getUserPlaylist(owner, kind, token) {
  const data = await apiGet(`users/${owner}/playlists/${kind}`, {}, token);
  return data.result;
}

async function getTracksById(trackIds, token) {
  const data = await apiGet('tracks', { trackIds: trackIds.join(',') }, token);
  return data.result || [];
}

// ── Artist tracks ─────────────────────────────────────────────────────────────
// Yandex API uses 'page-size' (dash), and returns snake_case pager fields.
async function getArtistTracks(artistId, token) {
  const tracks = [];
  let page = 0;
  while (true) {
    const data = await apiGet(`artists/${artistId}/tracks`, { page, 'page-size': 100 }, token);
    const result = data.result;
    const batch = result?.tracks || [];
    if (!batch.length) break;
    tracks.push(...batch);
    const pager = result?.pager;
    const perPage = pager?.perPage ?? pager?.per_page ?? 20;
    if (!pager || perPage * (pager.page + 1) >= pager.total) break;
    page = pager.page + 1;
  }
  return tracks;
}

// ── Cached account info ───────────────────────────────────────────────────────
let _cachedUid   = null;
let _cachedLogin = null;
async function getMyAccount(token) {
  if (_cachedUid) return { uid: _cachedUid, login: _cachedLogin };
  const data = await apiGet('account/status', {}, token);
  const acc = data.result?.account;
  if (!acc?.uid) throw new Error('Could not determine account UID — is the token valid?');
  _cachedUid   = acc.uid;
  _cachedLogin = acc.login;
  return { uid: _cachedUid, login: _cachedLogin };
}
async function getMyUid(token) { return (await getMyAccount(token)).uid; }

// ── UUID-format playlists ─────────────────────────────────────────────────────
// POST /playlists/list only accepts numeric kinds — UUID kinds are rejected.
// Strategy: GET /users/{uid}/playlists/list returns all user playlists including
// their playlistUuid field. We match on that, then fetch by numeric kind.
async function getPublicPlaylist(playlistId, token) {
  const { uid } = await getMyAccount(token);
  const bareId = playlistId.replace(/^lk\./i, '');

  // Strategy 1: own playlists list — match by playlistUuid, use found.uid as owner
  try {
    const data = await apiGet(`users/${uid}/playlists/list`, {}, token);
    const playlists = data.result || [];
    const found = playlists.find(p =>
      p.playlistUuid === bareId     ||
      p.playlistUuid === playlistId ||
      String(p.kind) === bareId     ||
      String(p.kind) === playlistId
    );
    if (found) return await getUserPlaylist(found.uid || uid, found.kind, token);
  } catch (_) {}

  // Strategy 2: liked/saved playlists (lk. = "лайки").
  try {
    const data = await apiGet(`users/${uid}/likes/playlists`, {}, token);
    // Response can be a flat array or wrapped — handle both
    const raw = data.result;
    const refs = Array.isArray(raw) ? raw
               : (raw?.library?.playlists || raw?.playlists || []);
    console.log('[likes/playlists] count:', refs.length,
                'first 3:', JSON.stringify(refs.slice(0, 3)));

    // Fast path: some responses include full playlist objects with playlistUuid
    const directMatch = refs.find(r =>
      r.playlistUuid === bareId     ||
      r.playlistUuid === playlistId ||
      r?.playlist?.playlistUuid === bareId ||
      r?.playlist?.playlistUuid === playlistId
    );
    if (directMatch) {
      const pl = directMatch.playlist || directMatch;
      const ownerUid = pl.uid || pl.owner?.uid || directMatch.uid;
      const kind = pl.kind;
      if (ownerUid && kind != null) return await getUserPlaylist(ownerUid, kind, token);
      if (pl.tracks !== undefined) return pl;
    }

    // Slow path: refs are {playlist:{uid,kind}, timestamp} objects — fetch each to compare UUID
    for (const ref of refs) {
      const inner   = ref.playlist || ref;
      const refUid  = inner.uid  || inner.owner?.uid || inner.owner;
      const refKind = inner.kind;
      if (!refUid || refKind == null) continue;
      try {
        const pl = await getUserPlaylist(refUid, refKind, token);
        if (pl.playlistUuid === bareId || pl.playlistUuid === playlistId) return pl;
      } catch (e2) {
        console.warn('[likes/playlists] fetch failed for uid=%s kind=%s:', refUid, refKind, e2.message);
      }
    }
  } catch (e) {
    console.warn('[likes/playlists] strategy failed:', e.message);
  }

  // Strategy 3: direct GET /playlists/{uuid} (editorial / public playlists)
  try {
    const data = await apiGet(`playlists/${bareId}`, {}, token);
    const r = data.result;
    if (r) return Array.isArray(r) ? r[0] : r;
  } catch (_) {}

  // Strategy 4: try the full id (with lk. prefix) as a direct playlist path
  try {
    const data = await apiGet(`playlists/${playlistId}`, {}, token);
    const r = data.result;
    if (r) return Array.isArray(r) ? r[0] : r;
  } catch (_) {}

  // Strategy 5: try current user's own playlists endpoint (different from /list)
  try {
    const data = await apiGet(`users/${uid}/playlists`, {}, token);
    const playlists = Array.isArray(data.result) ? data.result : [];
    const found = playlists.find(p =>
      p.playlistUuid === bareId || p.playlistUuid === playlistId
    );
    if (found) return found;
  } catch (_) {}

  // Strategy 6: "lk." = liked-tracks playlist (kind=3 in Yandex Music).
  // The user's saved-tracks playlist gets a UUID-based share URL with an "lk." prefix.
  if (/^lk\./i.test(playlistId)) {
    try {
      const pl = await getUserPlaylist(uid, 3, token);
      console.log('[lk-strategy] kind=3 playlistUuid:', pl.playlistUuid, 'looking for:', bareId);
      if (pl) return pl;  // only playlist kind with "lk." prefix — return unconditionally
    } catch (e) {
      console.warn('[lk-strategy] kind=3 fetch failed:', e.message);
    }
  }

  // Strategy 7: try UUID directly as the kind in the user's playlist endpoint
  // (Yandex sometimes accepts UUID-format kinds via GET /users/{uid}/playlists/{uuid})
  try {
    const pl = await getUserPlaylist(uid, bareId, token);
    if (pl) return pl;
  } catch (_) {}

  // Strategy 8: server-side POST /playlists/list with various ID formats
  for (const id of [bareId, playlistId, `${uid}:${bareId}`]) {
    try {
      const res = await fetch(`/api/playlist?id=${encodeURIComponent(id)}`, {
        headers: authHeader(token),
      });
      const data = await res.json();
      const r = data.result;
      if (r?.length) {
        console.log('[playlist-post] matched with id format:', id);
        return r[0];
      }
    } catch (_) {}
  }

  throw new Error(
    `Cannot resolve playlist "${playlistId}". ` +
    `If it belongs to another user, use music.yandex.ru/users/{owner}/playlists/{kind} instead.`
  );
}

async function getLyrics(trackId, token, format = 'TEXT') {
  const res = await fetch(`/api/lyrics?trackId=${trackId}&format=${format}`, {
    headers: authHeader(token),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.result?.lyrics || null;
}

// ── URL parsing ───────────────────────────────────────────────────────────────
function parseYandexUrl(url) {
  try {
    const pathname = new URL(url.trim()).pathname;
    let m;
    // track inside album (must come before plain album)
    if ((m = pathname.match(/\/album\/(\d+)\/track\/(\d+)/)))
      return { type: 'track', albumId: m[1], trackId: m[2] };
    if ((m = pathname.match(/\/track\/(\d+)/)))
      return { type: 'track', trackId: m[1] };
    if ((m = pathname.match(/\/album\/(\d+)/)))
      return { type: 'album', albumId: m[1] };
    // artist tracks page (must come before plain artist)
    if ((m = pathname.match(/\/artist\/(\d+)\/tracks/)))
      return { type: 'artist-tracks', artistId: m[1] };
    if ((m = pathname.match(/\/artist\/(\d+)/)))
      return { type: 'artist', artistId: m[1] };
    // user playlists: /users/{owner}/playlists/{kind}
    if ((m = pathname.match(/\/users\/([\w.\-@]+)\/playlists\/(\d+)/)))
      return { type: 'playlist', owner: m[1], kind: m[2] };
    // public/editorial playlists: /playlists/{uuid} or /playlists/lk.{uuid}
    if ((m = pathname.match(/\/playlists\/([\w.\-]+)/)))
      return { type: 'public-playlist', playlistId: m[1] };
  } catch {}
  return null;
}

// ── Tracklist resolver ────────────────────────────────────────────────────────
async function resolveTracklist(parsed, token, onStatus) {
  if (parsed.type === 'track') {
    onStatus?.('Fetching track...');
    const track = await getTrack(parsed.trackId, token);
    return [track];
  }

  if (parsed.type === 'album') {
    onStatus?.('Fetching album...');
    const album = await getAlbumWithTracks(parsed.albumId, token);
    const tracks = (album.volumes || []).flat();
    return tracks.filter(t => t.available !== false);
  }

  if (parsed.type === 'playlist') {
    onStatus?.('Fetching playlist...');
    const pl = await getUserPlaylist(parsed.owner, parsed.kind, token);
    const refs = pl.tracks || [];
    if (!refs.length) return [];
    onStatus?.(`Fetching ${refs.length} tracks...`);
    const result = [];
    for (let i = 0; i < refs.length; i += 10) {
      const ids = refs.slice(i, i + 10).map(r => r.id);
      const batch = await getTracksById(ids, token);
      result.push(...batch.filter(t => t.available !== false));
    }
    return result;
  }

  if (parsed.type === 'artist-tracks') {
    onStatus?.('Fetching artist tracks...');
    const tracks = await getArtistTracks(parsed.artistId, token);
    return tracks.filter(t => t.available !== false);
  }

  if (parsed.type === 'public-playlist') {
    onStatus?.('Fetching playlist...');
    const pl = await getPublicPlaylist(parsed.playlistId, token);
    const refs = pl.tracks || [];
    if (!refs.length) return [];
    onStatus?.(`Fetching ${refs.length} tracks...`);
    const result = [];
    for (let i = 0; i < refs.length; i += 10) {
      const ids = refs.slice(i, i + 10).map(r => r.id ?? r);
      const batch = await getTracksById(ids, token);
      result.push(...batch.filter(t => t.available !== false));
    }
    return result;
  }

  if (parsed.type === 'artist') {
    onStatus?.('Fetching artist albums...');
    const tracks = [];
    let page = 0;
    while (true) {
      const info = await getArtistAlbums(parsed.artistId, token, page);
      const albums = info?.albums || [];
      if (!albums.length) break;
      for (const album of albums) {
        if (!album.available || album.id == null) continue;
        const full = await getAlbumWithTracks(album.id, token);
        tracks.push(...(full.volumes || []).flat().filter(t => t.available !== false));
      }
      const pager = info?.pager;
      if (!pager || pager.perPage * (pager.page + 1) >= pager.total) break;
      page = pager.page + 1;
    }
    return tracks;
  }

  throw new Error('Unknown URL type');
}
