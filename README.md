# cmdshift

A small, self-hosted alternative to TuneMyMusic's transfer page: take a Spotify playlist and rebuild it in Apple Music.

1. **Choose a source:** paste a Spotify playlist link, log in with Spotify and pick one of your playlists, or paste a plain-text/CSV track list.
2. **Find tracks:** each track is looked up in the Apple Music catalog. Exact **ISRC** matches come first, then fuzzy search scored on title, artist, duration and album. Live, remix and karaoke versions are penalised. You review the results, switch to other versions, or search by hand.
3. **Create the playlist** in your Apple Music library. You can download the tracks it couldn't match as a CSV.

No npm dependencies. It needs Node ≥ 20.6.

## Run locally

```bash
cp .env.example .env    # fill in, see "Credentials" below
npm start               # or: docker compose up --build
open http://127.0.0.1:8888
npm test
```

## Deploy

The server prints the exact Spotify redirect URI on startup. Register it in your Spotify app for every URL you deploy to. Always set a `SESSION_SECRET` (`openssl rand -hex 32`). Logins are kept in an encrypted cookie, so they survive restarts and redeploys.

### Option A: Render (no server to manage)
1. Push this repo to GitHub, then on Render choose **New → Blueprint** and pick the repo. `render.yaml` sets up the service, the health check and a generated `SESSION_SECRET`.
2. Fill in the Spotify and Apple env vars when prompted. For `APPLE_PRIVATE_KEY`, paste the .p8 contents or the output of `base64 -w0 AuthKey_XXX.p8`.
3. Add `https://<your-app>.onrender.com/auth/spotify/callback` to your Spotify app's Redirect URIs. `BASE_URL` is picked up from Render automatically.

The free plan sleeps when idle, so the first request after a sleep takes about 30 seconds.

### Option B: your own server (any VPS with Docker)
1. Point a DNS record (e.g. `music.example.com`) at the server, and open ports 80 and 443.
2. On the server:
   ```bash
   git clone <repo> cmdshift && cd cmdshift
   cp .env.example .env
   # in .env set: BASE_URL=https://music.example.com, SESSION_SECRET, Spotify + Apple values
   mkdir -p secrets && cp ~/AuthKey_XXX.p8 secrets/AuthKey.p8   # if using APPLE_PRIVATE_KEY_PATH
   DOMAIN=music.example.com docker compose --profile https up -d --build
   ```
   Caddy gets and renews the HTTPS certificate automatically.
3. Register `https://music.example.com/auth/spotify/callback` with Spotify.
4. To update: `git pull && DOMAIN=music.example.com docker compose --profile https up -d --build`.

### Option C: anywhere that runs containers
CI publishes `ghcr.io/<owner>/<repo>:latest` on every push to `main`. Run it with the env vars from `.env.example`, and expose port 8888 behind HTTPS. The health check is at `GET /healthz`.

### CI
`.github/workflows/ci.yml` runs the tests, checks that the server boots, and builds the Docker image on every push and PR. On `main`, it also pushes the image to GHCR.

## Credentials

### Spotify (optional; without it only text paste works)
1. Create an app at <https://developer.spotify.com/dashboard>. Since Feb 2026 the app owner needs Spotify Premium, and a Development Mode app is limited to 5 users, whom you add in the dashboard.
2. Add the redirect URI `http://127.0.0.1:8888/auth/spotify/callback`. Spotify rejects `localhost`, so use `127.0.0.1`.
3. Put the Client ID and secret into `.env`. Add your deployed URL's redirect URI too (see Deploy).

Spotify-owned editorial/algorithmic playlists (e.g. "Today's Top Hits") are blocked for third-party apps. For those, copy the tracks out and use **Paste text / CSV**.

### Apple Music (required)
1. You need a paid Apple Developer account. Under *Certificates, IDs & Profiles → Identifiers*, create a **Media ID**. Under *Keys*, create a key with **Media Services (MusicKit)** enabled for it, and download the `.p8`.
2. Set `APPLE_TEAM_ID`, `APPLE_KEY_ID`, and either `APPLE_PRIVATE_KEY_PATH` or `APPLE_PRIVATE_KEY` (the PEM text or its base64).
3. The person using the app needs an Apple Music subscription to save playlists to their library.

The server signs a short-lived MusicKit developer token (ES256 JWT). The browser uses MusicKit JS to sign the user in to Apple Music and obtain a Music User Token. The server then calls the Apple Music API with both tokens.

## Layout
```
server.js        HTTP server, routes, health check
lib/session.js   encrypted-cookie sessions
lib/spotify.js   OAuth, playlist reading (/playlists/{id}/items with /tracks fallback)
lib/apple.js     developer token, ISRC + search matching, playlist creation
lib/match.js     normalisation, scoring, text/CSV parsing (pure, unit tested)
public/          single-page UI (vanilla JS)
Dockerfile, compose.yaml, deploy/Caddyfile, render.yaml, .github/workflows/ci.yml
```

## Limitations
- Only playlists are supported. Albums and liked songs are not.
- A Spotify app in Development Mode allows at most 5 users. You add them in the Spotify dashboard. More users need Spotify's extended quota approval.
