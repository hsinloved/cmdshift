// Apple Music API: developer token (JWT), catalog matching, playlist creation.
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { scoreCandidate, searchTerm, statusFor } from './match.js';

const API = 'https://api.music.apple.com';
const TOKEN_TTL_S = 12 * 60 * 60;

let cached = null;

export function appleConfigured() {
  return Boolean(process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID &&
    (process.env.APPLE_PRIVATE_KEY || process.env.APPLE_PRIVATE_KEY_PATH));
}

function privateKey() {
  const pem = process.env.APPLE_PRIVATE_KEY
    ? process.env.APPLE_PRIVATE_KEY.replace(/\\n/g, '\n')
    : readFileSync(process.env.APPLE_PRIVATE_KEY_PATH, 'utf8');
  return createPrivateKey(pem);
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** MusicKit developer token: ES256 JWT signed with your MusicKit .p8 key. */
export function developerToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - 60 > now) return cached.token;
  const header = { alg: 'ES256', kid: process.env.APPLE_KEY_ID };
  const payload = { iss: process.env.APPLE_TEAM_ID, iat: now, exp: now + TOKEN_TTL_S };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = sign('sha256', Buffer.from(input), { key: privateKey(), dsaEncoding: 'ieee-p1363' });
  cached = { token: `${input}.${b64url(sig)}`, exp: payload.exp };
  return cached.token;
}

async function appleFetch(path, { userToken, method = 'GET', body } = {}, attempt = 0) {
  const headers = { Authorization: `Bearer ${developerToken()}` };
  if (userToken) headers['Music-User-Token'] = userToken;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 429 && attempt < 4) {
    const wait = Number(res.headers.get('retry-after')) * 1000 || 500 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, wait));
    return appleFetch(path, { userToken, method, body }, attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Apple Music API ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

function toSong(s) {
  const a = s.attributes || {};
  return {
    id: s.id,
    name: a.name,
    artistName: a.artistName,
    albumName: a.albumName,
    durationMs: a.durationInMillis,
    isrc: a.isrc,
    url: a.url,
    artwork: a.artwork?.url?.replace('{w}', '120').replace('{h}', '120'),
    explicit: a.contentRating === 'explicit',
  };
}

export async function searchSongs(storefront, term, limit = 10) {
  const q = new URLSearchParams({ term, types: 'songs', limit: String(limit) });
  const json = await appleFetch(`/v1/catalog/${encodeURIComponent(storefront)}/search?${q}`);
  return (json.results?.songs?.data || []).map(toSong);
}

async function songsByIsrc(storefront, isrcs) {
  if (!isrcs.length) return [];
  const q = new URLSearchParams({ 'filter[isrc]': isrcs.join(',') });
  const json = await appleFetch(`/v1/catalog/${encodeURIComponent(storefront)}/songs?${q}`);
  return (json.data || []).map(toSong);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

/**
 * Find the best Apple Music catalog song for each source track.
 * Strategy: exact ISRC lookup first (batched, 25/request), then fuzzy search.
 */
export async function matchTracks(storefront, tracks) {
  const byIsrc = new Map();
  const isrcs = [...new Set(tracks.map((t) => t.isrc?.toUpperCase()).filter(Boolean))];
  for (let i = 0; i < isrcs.length; i += 25) {
    try {
      for (const song of await songsByIsrc(storefront, isrcs.slice(i, i + 25))) {
        const k = song.isrc?.toUpperCase();
        if (!k) continue;
        if (!byIsrc.has(k)) byIsrc.set(k, []);
        byIsrc.get(k).push(song);
      }
    } catch (e) {
      if (e.status === 401 || e.status === 403) throw e;
      // Otherwise fall through to text search for this batch.
    }
  }

  return mapLimit(tracks, 4, async (track) => {
    const rank = (songs) => songs
      .map((s) => ({ ...s, score: scoreCandidate(track, s) }))
      .sort((a, b) => b.score - a.score);

    const isrcHits = rank(byIsrc.get(track.isrc?.toUpperCase()) || []);
    if (isrcHits.length) {
      // Same recording; prefer the version whose metadata looks closest
      // (and the explicit version when the source is explicit).
      if (track.explicit != null) {
        isrcHits.sort((a, b) => (b.explicit === track.explicit) - (a.explicit === track.explicit) || b.score - a.score);
      }
      return { best: isrcHits[0], alternatives: isrcHits.slice(1, 5), confidence: 1, method: 'isrc', status: 'matched' };
    }

    try {
      let candidates = rank(await searchSongs(storefront, searchTerm(track)));
      if (!candidates.length || candidates[0].score < 0.6) {
        // Retry with title only — artist name spellings differ across services.
        const more = rank(await searchSongs(storefront, searchTerm({ ...track, artists: [] })));
        const seen = new Set(candidates.map((c) => c.id));
        candidates = [...candidates, ...more.filter((c) => !seen.has(c.id))].sort((a, b) => b.score - a.score);
      }
      const best = candidates[0] || null;
      const confidence = best ? Number(best.score.toFixed(3)) : 0;
      return { best, alternatives: candidates.slice(1, 5), confidence, method: 'search', status: best ? statusFor(confidence) : 'missing' };
    } catch (e) {
      if (e.status === 401 || e.status === 403) throw e;
      return { best: null, alternatives: [], confidence: 0, method: 'error', status: 'missing', error: e.message };
    }
  });
}

export async function storefrontForUser(userToken) {
  const json = await appleFetch('/v1/me/storefront', { userToken });
  return json.data?.[0]?.id || 'us';
}

/** Create a library playlist and add songs in batches. */
export async function createPlaylist(userToken, { name, description, songIds }) {
  const created = await appleFetch('/v1/me/library/playlists', {
    userToken,
    method: 'POST',
    body: { attributes: { name, description: description || '' } },
  });
  const playlist = created.data?.[0];
  if (!playlist) throw new Error('Apple Music did not return the new playlist');

  let added = 0;
  for (let i = 0; i < songIds.length; i += 100) {
    const data = songIds.slice(i, i + 100).map((id) => ({ id, type: 'songs' }));
    await appleFetch(`/v1/me/library/playlists/${encodeURIComponent(playlist.id)}/tracks`, {
      userToken, method: 'POST', body: { data },
    });
    added += data.length;
  }
  return { id: playlist.id, name: playlist.attributes?.name || name, added };
}
