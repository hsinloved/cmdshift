import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize as normPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as spotify from './lib/spotify.js';
import * as apple from './lib/apple.js';
import { parseTrackList } from './lib/match.js';
import { loadSession, sessionKey } from './lib/session.js';

const PORT = Number(process.env.PORT) || 8888;
const HOST = process.env.HOST || '127.0.0.1';
// RENDER_EXTERNAL_URL is set automatically on Render.
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const SECURE = BASE_URL.startsWith('https:');
const SPOTIFY_REDIRECT = `${BASE_URL}/auth/spotify/callback`;
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const MAX_BODY = 2 * 1024 * 1024;

if (!process.env.SESSION_SECRET) {
  console.warn('  ! SESSION_SECRET not set — using a random one; Spotify logins will reset on restart');
}
const SESSION_KEY = sessionKey(process.env.SESSION_SECRET || randomBytes(32).toString('hex'));

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  ...(SECURE ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string';
  res.writeHead(status, { 'Content-Type': isJson ? 'application/json' : 'text/plain; charset=utf-8', ...SECURITY_HEADERS, ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = normPath(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=300',
      ...SECURITY_HEADERS,
    });
    res.end(data);
  } catch {
    send(res, 404, 'Not found');
  }
}

const requireUserToken = (req) => {
  const t = req.headers['x-music-user-token'];
  if (!t) throw Object.assign(new Error('Connect Apple Music first'), { status: 401 });
  return t;
};

const validTrack = (t) => t && typeof t.title === 'string' && t.title.length < 500;

const routes = {
  'GET /healthz': async (req, res) => send(res, 200, { ok: true }),

  'GET /api/status': async (req, res, s) => send(res, 200, {
    spotifyConfigured: spotify.spotifyConfigured(),
    appleConfigured: apple.appleConfigured(),
    spotifyConnected: Boolean(s.spotify),
  }),

  // ---- Spotify ----
  'GET /auth/spotify/login': async (req, res, s) => {
    if (!spotify.spotifyConfigured()) return send(res, 500, 'Spotify is not configured on the server');
    s.oauthState = randomBytes(16).toString('hex');
    send(res, 302, '', { Location: spotify.authorizeUrl(SPOTIFY_REDIRECT, s.oauthState) });
  },

  'GET /auth/spotify/callback': async (req, res, s, url) => {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state || state !== s.oauthState) {
      return send(res, 302, '', { Location: '/?error=' + encodeURIComponent(url.searchParams.get('error') || 'spotify_login_failed') });
    }
    delete s.oauthState;
    s.spotify = await spotify.exchangeCode(code, SPOTIFY_REDIRECT);
    send(res, 302, '', { Location: '/?spotify=connected' });
  },

  'POST /auth/spotify/logout': async (req, res, s) => {
    delete s.spotify;
    send(res, 200, { ok: true });
  },

  'GET /api/spotify/playlists': async (req, res, s) => {
    const token = await spotify.userAccessToken(s);
    if (!token) return send(res, 401, { error: 'Connect Spotify first' });
    send(res, 200, { playlists: await spotify.listMyPlaylists(token) });
  },

  'GET /api/spotify/playlist': async (req, res, s, url) => {
    const id = spotify.parsePlaylistId(url.searchParams.get('url') || url.searchParams.get('id') || '');
    if (!id) return send(res, 400, { error: 'That doesn’t look like a Spotify playlist link' });
    if (!spotify.spotifyConfigured()) return send(res, 500, { error: 'Spotify is not configured on the server' });
    try {
      send(res, 200, await spotify.getPlaylist(id, await spotify.userAccessToken(s)));
    } catch (e) {
      if (e.status === 404 || e.status === 403) {
        return send(res, e.status, {
          error: s.spotify
            ? 'Spotify wouldn’t share this playlist. It may be private, or Spotify-owned (editorial/algorithmic playlists are blocked for third-party apps).'
            : 'Spotify wouldn’t share this playlist. Try “Log in with Spotify”, or paste the track list as text instead.',
        });
      }
      throw e;
    }
  },

  // ---- Text paste ----
  'POST /api/parse-text': async (req, res) => {
    const { text } = await readJson(req);
    send(res, 200, { name: 'Imported playlist', tracks: parseTrackList(String(text || '')).slice(0, 5000) });
  },

  // ---- Apple Music ----
  'GET /api/apple/developer-token': async (req, res) => {
    if (!apple.appleConfigured()) return send(res, 500, { error: 'Apple Music is not configured on the server' });
    send(res, 200, { token: apple.developerToken() });
  },

  'GET /api/apple/storefront': async (req, res) => {
    send(res, 200, { storefront: await apple.storefrontForUser(requireUserToken(req)) });
  },

  'POST /api/apple/match': async (req, res) => {
    const { storefront = 'us', tracks } = await readJson(req);
    if (!Array.isArray(tracks) || tracks.length > 50 || !tracks.every(validTrack)) {
      return send(res, 400, { error: 'Send 1–50 tracks per request' });
    }
    send(res, 200, { results: await apple.matchTracks(String(storefront).slice(0, 8), tracks) });
  },

  'GET /api/apple/search': async (req, res, s, url) => {
    const term = (url.searchParams.get('term') || '').slice(0, 200);
    if (!term) return send(res, 400, { error: 'term is required' });
    send(res, 200, { songs: await apple.searchSongs(url.searchParams.get('storefront') || 'us', term, 10) });
  },

  'POST /api/apple/playlists': async (req, res) => {
    const userToken = requireUserToken(req);
    const { name, description, songIds } = await readJson(req);
    if (!name || !Array.isArray(songIds) || !songIds.length || songIds.length > 10000) {
      return send(res, 400, { error: 'name and songIds are required' });
    }
    send(res, 200, await apple.createPlaylist(userToken, {
      name: String(name).slice(0, 200),
      description: String(description || '').slice(0, 1000),
      songIds: songIds.map(String),
    }));
  },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, BASE_URL);
  const handler = routes[`${req.method} ${url.pathname}`];
  try {
    if (handler) return await handler(req, res, loadSession(SESSION_KEY, req, res, { secure: SECURE }), url);
    if (req.method === 'GET') return await serveStatic(url.pathname, res);
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(`${req.method} ${url.pathname}:`, e.message);
    if (!res.headersSent) send(res, e.status && e.status < 600 ? e.status : 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`cmdshift listening on ${HOST}:${PORT} — public URL ${BASE_URL}`);
  console.log(`  Spotify redirect URI: ${SPOTIFY_REDIRECT}`);
  if (!spotify.spotifyConfigured()) console.warn('  ! SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not set — only text paste will work');
  if (!apple.appleConfigured()) console.warn('  ! APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY(_PATH) not set — Apple Music won’t work');
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
