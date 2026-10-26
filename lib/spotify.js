// Spotify Web API: OAuth (authorization code), app token, playlist reading.
const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';
export const SCOPES = 'playlist-read-private playlist-read-collaborative';

let appToken = null;

export function spotifyConfigured() {
  return Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
}

const basicAuth = () => 'Basic ' + Buffer.from(
  `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`,
).toString('base64');

async function tokenRequest(params) {
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Spotify token error: ${json.error_description || json.error || res.status}`);
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt: Date.now() + json.expires_in * 1000 };
}

export function authorizeUrl(redirectUri, state) {
  const q = new URLSearchParams({
    response_type: 'code', client_id: process.env.SPOTIFY_CLIENT_ID, scope: SCOPES, redirect_uri: redirectUri, state,
  });
  return `${ACCOUNTS}/authorize?${q}`;
}

export const exchangeCode = (code, redirectUri) =>
  tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });

/** Returns a valid user access token, refreshing it in-place on the session. */
export async function userAccessToken(session) {
  const t = session.spotify;
  if (!t) return null;
  if (t.expiresAt - 60_000 > Date.now()) return t.accessToken;
  const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refreshToken });
  session.spotify = { ...fresh, refreshToken: fresh.refreshToken || t.refreshToken };
  return session.spotify.accessToken;
}

async function appAccessToken() {
  if (appToken && appToken.expiresAt - 60_000 > Date.now()) return appToken.accessToken;
  appToken = await tokenRequest({ grant_type: 'client_credentials' });
  return appToken.accessToken;
}

async function api(pathOrUrl, token) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : API + pathOrUrl;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429 && attempt < 4) {
      await new Promise((r) => setTimeout(r, (Number(res.headers.get('retry-after')) || 1) * 1000));
      continue;
    }
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      const err = new Error(`Spotify API ${res.status}: ${json.error?.message || res.statusText}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }
}

/** Accepts open.spotify.com URLs (incl. /intl-xx/), spotify:playlist: URIs or bare IDs. */
export function parsePlaylistId(input = '') {
  const s = input.trim();
  const m = s.match(/playlist[/:]([A-Za-z0-9]{10,})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9]{22}$/.test(s)) return s;
  return null;
}

export async function listMyPlaylists(token) {
  const out = [];
  let next = '/me/playlists?limit=50';
  while (next) {
    const page = await api(next, token);
    for (const p of page.items || []) {
      if (!p) continue;
      out.push({
        id: p.id,
        name: p.name,
        owner: p.owner?.display_name,
        image: p.images?.at(-1)?.url,
        total: p.items?.total ?? p.tracks?.total,
      });
    }
    next = page.next;
  }
  return out;
}

function toTrack(entry) {
  // Feb 2026 API: entries are { item }, previously { track }.
  const t = entry?.item ?? entry?.track;
  if (!t || t.type === 'episode') return null;
  return {
    title: t.name,
    artists: (t.artists || []).map((a) => a.name).filter(Boolean),
    album: t.album?.name,
    durationMs: t.duration_ms,
    isrc: t.external_ids?.isrc,
    explicit: t.explicit,
    spotifyId: t.id,
  };
}

/**
 * Reads a playlist and all of its tracks. Uses the logged-in user's token if
 * present (needed for private playlists), else the app's client-credentials token.
 */
export async function getPlaylist(id, userToken) {
  const token = userToken || await appAccessToken();
  const meta = await api(`/playlists/${id}?fields=name,description,owner(display_name),images`, token);

  const tracks = [];
  let next = `/playlists/${id}/items?limit=100`;
  let triedLegacy = false;
  while (next) {
    let page;
    try {
      page = await api(next, token);
    } catch (e) {
      // Fall back to the pre-2026 path in case /items isn't available.
      if (!triedLegacy && tracks.length === 0 && (e.status === 404 || e.status === 403)) {
        triedLegacy = true;
        next = `/playlists/${id}/tracks?limit=100`;
        continue;
      }
      throw e;
    }
    for (const entry of page.items || []) {
      const t = toTrack(entry);
      if (t?.title) tracks.push(t);
    }
    next = page.next;
  }

  return {
    name: meta.name,
    description: meta.description,
    owner: meta.owner?.display_name,
    image: meta.images?.[0]?.url,
    tracks,
  };
}
