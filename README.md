# cmdshift

A small, self-hosted alternative to TuneMyMusic's transfer page: take a Spotify playlist and rebuild it in Apple Music.

1. **Choose a source:** paste a Spotify playlist link, log in with Spotify and pick one of your playlists, or paste a plain-text/CSV track list.
2. **Find tracks:** each track is looked up in the Apple Music catalog. Exact **ISRC** matches come first, then fuzzy search scored on title, artist, duration and album. Live, remix and karaoke versions are penalised. You review the results, switch to other versions, or search by hand.
3. **Create the playlist** in your Apple Music library. You can download the tracks it couldn't match as a CSV.

No npm dependencies. It needs Node ≥ 20.6.

## Setup

```bash
cp .env.example .env    # then fill it in, see below
npm start               # http://127.0.0.1:8888
npm test
```

### Spotify (optional; without it only text paste works)
1. Create an app at <https://developer.spotify.com/dashboard>. Since Feb 2026 the app owner needs Spotify Premium, and a Development Mode app is limited to 5 users, whom you add in the dashboard.
2. Add the redirect URI `http://127.0.0.1:8888/auth/spotify/callback`. Spotify rejects `localhost`, so use `127.0.0.1`.
3. Put the Client ID and secret into `.env`.

Spotify-owned editorial/algorithmic playlists (e.g. "Today's Top Hits") are blocked for third-party apps. For those, copy the tracks out and use **Paste text / CSV**.

### Apple Music (required)
1. You need a paid Apple Developer account. Under *Certificates, IDs & Profiles → Identifiers*, create a **Media ID**. Under *Keys*, create a key with **Media Services (MusicKit)** enabled for it, and download the `.p8`.
2. Set `APPLE_TEAM_ID`, `APPLE_KEY_ID`, and either `APPLE_PRIVATE_KEY_PATH` or `APPLE_PRIVATE_KEY`.
3. The person using the app needs an Apple Music subscription to save playlists to their library.

The server signs a short-lived MusicKit developer token (ES256 JWT). The browser uses MusicKit JS to sign the user in to Apple Music and obtain a Music User Token. The server then calls the Apple Music API with both tokens.

## Layout
```
server.js        HTTP server, routes, in-memory sessions
lib/spotify.js   OAuth, playlist reading (/playlists/{id}/items with /tracks fallback)
lib/apple.js     developer token, ISRC + search matching, playlist creation
lib/match.js     normalisation, scoring, text/CSV parsing (pure, unit tested)
public/          single-page UI (vanilla JS)
```

## Limitations
- Sessions are kept in memory, so restarting the server logs everyone out of Spotify.
- Only playlists are supported. Albums and liked songs are not.
- Before deploying publicly, set `BASE_URL` to your https origin and register the matching Spotify redirect URI.
