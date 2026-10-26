const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (ms) => (ms ? `${Math.floor(ms / 60000)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}` : '');

const state = {
  status: {},
  source: null,          // { name, description, tracks: [...] }
  rows: [],              // [{ track, status, confidence, song, options, include }]
  music: null,           // MusicKit instance
  storefront: 'us',
  filter: 'all',
};

async function api(path, opts = {}) {
  const headers = { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...opts.headers };
  if (state.music?.isAuthorized) headers['X-Music-User-Token'] = state.music.musicUserToken;
  const res = await fetch(path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

function banner(msg, ok = false) {
  const el = $('#banner');
  el.textContent = msg;
  el.className = ok ? 'banner ok' : 'banner';
  el.hidden = !msg;
}

// ---------- Step 1: source ----------
document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => selectTab(tab.dataset.tab)));
function selectTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.pane').forEach((p) => { p.hidden = p.dataset.pane !== name; });
  if (name === 'login' && state.status.spotifyConnected) loadMyPlaylists();
}

$('#url-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('#url-input').value.trim();
  if (!url) return;
  await loadSpotifyPlaylist(`url=${encodeURIComponent(url)}`);
});

async function loadSpotifyPlaylist(query) {
  banner('');
  setSummary('Loading playlist…');
  try {
    setSource(await api(`/api/spotify/playlist?${query}`));
  } catch (err) {
    setSummary('');
    banner(err.message);
  }
}

let playlistsLoaded = false;
async function loadMyPlaylists() {
  if (playlistsLoaded) return;
  const list = $('#playlist-list');
  list.innerHTML = '<li class="muted">Loading…</li>';
  try {
    const { playlists } = await api('/api/spotify/playlists');
    playlistsLoaded = true;
    list.innerHTML = playlists.length ? '' : '<li class="muted">No playlists found.</li>';
    for (const p of playlists) {
      const li = document.createElement('li');
      li.innerHTML = `${p.image ? `<img src="${esc(p.image)}" alt="">` : '<div class="art"></div>'}
        <div><div class="t">${esc(p.name)}</div><div class="a muted">${esc(p.owner || '')}${p.total != null ? ` · ${p.total} tracks` : ''}</div></div>`;
      li.addEventListener('click', () => loadSpotifyPlaylist(`id=${encodeURIComponent(p.id)}`));
      list.append(li);
    }
  } catch (err) {
    list.innerHTML = `<li class="muted">${esc(err.message)}</li>`;
  }
}

$('#spotify-logout').addEventListener('click', async () => {
  await api('/auth/spotify/logout', { method: 'POST' });
  state.status.spotifyConnected = false;
  playlistsLoaded = false;
  renderSpotifyAuth();
});

$('#text-load').addEventListener('click', async () => {
  banner('');
  try {
    const src = await api('/api/parse-text', { method: 'POST', body: { text: $('#text-input').value } });
    if (!src.tracks.length) return banner('Couldn’t find any tracks in that text.');
    setSource(src);
  } catch (err) { banner(err.message); }
});

function setSummary(html) {
  const el = $('#source-summary');
  el.innerHTML = html;
  el.hidden = !html;
}

function setSource(src) {
  state.source = src;
  state.rows = [];
  $('#results').hidden = true;
  $('#pl-name').value = src.name || '';
  $('#create-result').hidden = true;
  setSummary(`<strong>${esc(src.name || 'Playlist')}</strong>${src.owner ? ` by ${esc(src.owner)}` : ''} — ${src.tracks.length} tracks loaded.`);
  updateButtons();
}

function renderSpotifyAuth() {
  $('#spotify-logged-out').hidden = state.status.spotifyConnected;
  $('#spotify-logged-in').hidden = !state.status.spotifyConnected;
}

// ---------- Step 2: Apple Music ----------
function loadMusicKitScript() {
  return new Promise((resolve, reject) => {
    if (window.MusicKit) return resolve();
    document.addEventListener('musickitloaded', () => resolve(), { once: true });
    const s = document.createElement('script');
    s.src = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';
    s.async = true;
    s.onerror = () => reject(new Error('Couldn’t load MusicKit JS'));
    document.head.append(s);
  });
}

async function initMusicKit() {
  if (state.music) return state.music;
  const { token } = await api('/api/apple/developer-token');
  await loadMusicKitScript();
  await MusicKit.configure({ developerToken: token, app: { name: 'cmdshift', build: '0.1.0' } });
  state.music = MusicKit.getInstance();
  return state.music;
}

$('#apple-connect').addEventListener('click', async () => {
  banner('');
  try {
    const music = await initMusicKit();
    await music.authorize();
    if (!music.isAuthorized) throw new Error('Apple Music authorization was cancelled');
    state.storefront = music.storefrontId || (await api('/api/apple/storefront')).storefront || 'us';
    renderApple();
  } catch (err) {
    banner(err.message || 'Apple Music sign-in failed');
  }
});

function renderApple() {
  const ok = state.music?.isAuthorized;
  $('#apple-connect').textContent = ok ? 'Apple Music connected' : 'Connect Apple Music';
  $('#apple-connect').disabled = ok || !state.status.appleConfigured;
  $('#apple-status').textContent = ok ? `Storefront: ${state.storefront.toUpperCase()}` : 'You can match first and connect later.';
  updateButtons();
}

$('#match-btn').addEventListener('click', runMatching);

async function runMatching() {
  const tracks = state.source?.tracks || [];
  if (!tracks.length) return;
  banner('');
  $('#match-btn').disabled = true;
  const prog = $('#progress');
  prog.hidden = false;
  state.rows = [];
  const CHUNK = 20;
  try {
    for (let i = 0; i < tracks.length; i += CHUNK) {
      const chunk = tracks.slice(i, i + CHUNK);
      setProgress(i, tracks.length);
      const { results } = await api('/api/apple/match', { method: 'POST', body: { storefront: state.storefront, tracks: chunk } });
      results.forEach((r, j) => {
        const options = [r.best, ...r.alternatives].filter(Boolean);
        state.rows.push({ track: chunk[j], status: r.status, confidence: r.confidence, method: r.method, song: r.best, options, include: r.status !== 'missing' });
      });
      renderRows();
    }
    setProgress(tracks.length, tracks.length);
  } catch (err) {
    banner(err.message);
  } finally {
    $('#match-btn').disabled = false;
    updateButtons();
  }
}

function setProgress(done, total) {
  $('#progress .bar').style.width = `${(done / total) * 100}%`;
  $('#progress .label').textContent = done < total ? `Matching ${done} / ${total}…` : `Matched ${total} tracks`;
}

const STATUS_LABEL = { matched: 'Matched', review: 'Check', missing: 'Not found' };

function renderRows() {
  $('#results').hidden = false;
  const counts = { matched: 0, review: 0, missing: 0 };
  state.rows.forEach((r) => counts[r.status]++);
  const selected = state.rows.filter((r) => r.include && r.song).length;
  $('#stats').innerHTML = `
    <span class="pill matched">${counts.matched} matched</span>
    <span class="pill review">${counts.review} to check</span>
    <span class="pill missing">${counts.missing} not found</span>
    <span class="muted">${selected} selected</span>`;

  const tbody = $('#rows');
  tbody.innerHTML = '';
  state.rows.forEach((row, idx) => {
    if (state.filter !== 'all' && row.status !== state.filter) return;
    const t = row.track;
    const tr = document.createElement('tr');
    const opts = row.options.map((s, k) =>
      `<option value="${k}" ${s.id === row.song?.id ? 'selected' : ''}>${esc(s.name)} — ${esc(s.artistName)} (${esc(s.albumName || '')}${s.durationMs ? `, ${fmtTime(s.durationMs)}` : ''})</option>`).join('');
    tr.innerHTML = `
      <td><input type="checkbox" ${row.include ? 'checked' : ''} ${row.song ? '' : 'disabled'} aria-label="Include"></td>
      <td><div class="t">${esc(t.title)}</div><div class="a">${esc((t.artists || []).join(', '))}${t.durationMs ? ` · ${fmtTime(t.durationMs)}` : ''}</div></td>
      <td>${row.song ? `<div class="match">
          ${row.song.artwork ? `<img class="art" src="${esc(row.song.artwork)}" alt="">` : '<div class="art"></div>'}
          <div><div class="t">${esc(row.song.name)}</div><div class="a">${esc(row.song.artistName)}${row.song.durationMs ? ` · ${fmtTime(row.song.durationMs)}` : ''}</div>
          ${row.options.length > 1 ? `<select aria-label="Other versions">${opts}</select>` : ''}</div></div>` : '<span class="muted">—</span>'}</td>
      <td><span class="pill ${row.status}" title="${row.method === 'isrc' ? 'Exact ISRC match' : `Confidence ${Math.round(row.confidence * 100)}%`}">${STATUS_LABEL[row.status]}</span></td>
      <td><button class="btn small">Search</button></td>`;
    tr.querySelector('input').addEventListener('change', (e) => { row.include = e.target.checked; renderRows(); });
    tr.querySelector('select')?.addEventListener('change', (e) => {
      row.song = row.options[Number(e.target.value)];
      row.status = 'matched';
      row.include = true;
      renderRows();
    });
    tr.querySelector('button').addEventListener('click', () => openSearch(idx));
    tbody.append(tr);
  });
  updateButtons();
}

document.querySelectorAll('input[name=filter]').forEach((r) => r.addEventListener('change', (e) => {
  state.filter = e.target.value;
  renderRows();
}));

// Manual search dialog
let searchRow = null;
function openSearch(idx) {
  searchRow = state.rows[idx];
  const t = searchRow.track;
  $('#search-term').value = `${t.title} ${(t.artists || [])[0] || ''}`.trim();
  $('#search-results').innerHTML = '';
  $('#search-dialog').showModal();
  doSearch();
}
$('#search-go').addEventListener('click', doSearch);
$('#search-term').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });

async function doSearch() {
  const term = $('#search-term').value.trim();
  if (!term) return;
  const ul = $('#search-results');
  ul.innerHTML = '<li class="muted">Searching…</li>';
  try {
    const { songs } = await api(`/api/apple/search?storefront=${encodeURIComponent(state.storefront)}&term=${encodeURIComponent(term)}`);
    ul.innerHTML = songs.length ? '' : '<li class="muted">No results.</li>';
    for (const s of songs) {
      const li = document.createElement('li');
      li.innerHTML = `${s.artwork ? `<img class="art" src="${esc(s.artwork)}" alt="">` : '<div class="art"></div>'}
        <div><div class="t">${esc(s.name)}</div><div class="a muted">${esc(s.artistName)} · ${esc(s.albumName || '')} ${fmtTime(s.durationMs)}</div></div>`;
      li.addEventListener('click', () => {
        if (!searchRow.options.some((o) => o.id === s.id)) searchRow.options.unshift(s);
        searchRow.song = s;
        searchRow.status = 'matched';
        searchRow.include = true;
        $('#search-dialog').close();
        renderRows();
      });
      ul.append(li);
    }
  } catch (err) {
    ul.innerHTML = `<li class="muted">${esc(err.message)}</li>`;
  }
}

$('#export-missing').addEventListener('click', () => {
  const missing = state.rows.filter((r) => !r.include || !r.song);
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const csv = ['Title,Artist,Album', ...missing.map((r) => [r.track.title, (r.track.artists || []).join(', '), r.track.album].map(q).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `${(state.source?.name || 'playlist').replace(/[^\w-]+/g, '_')}-unmatched.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---------- Step 3: create ----------
$('#create-btn').addEventListener('click', async () => {
  const songIds = [...new Set(state.rows.filter((r) => r.include && r.song).map((r) => r.song.id))];
  const name = $('#pl-name').value.trim() || state.source?.name || 'Imported from Spotify';
  if (!state.music?.isAuthorized) return banner('Connect Apple Music first (step 2).');
  banner('');
  const btn = $('#create-btn');
  btn.disabled = true;
  btn.textContent = 'Creating…';
  try {
    const out = await api('/api/apple/playlists', {
      method: 'POST',
      body: { name, description: 'Transferred from Spotify with cmdshift', songIds },
    });
    const skipped = state.rows.length - songIds.length;
    const el = $('#create-result');
    el.hidden = false;
    el.innerHTML = `✅ Created <strong>${esc(out.name)}</strong> with ${out.added} tracks${skipped ? ` (${skipped} skipped)` : ''}.
      It’ll appear in your Apple Music library shortly — <a href="https://music.apple.com/library/playlist/${encodeURIComponent(out.id)}" target="_blank" rel="noopener">open it</a>.`;
  } catch (err) {
    banner(err.message);
  } finally {
    btn.textContent = 'Create in Apple Music';
    updateButtons();
  }
});

function updateButtons() {
  const hasTracks = Boolean(state.source?.tracks?.length);
  $('#match-btn').disabled = !hasTracks || !state.status.appleConfigured;
  const selected = state.rows.some((r) => r.include && r.song);
  $('#create-btn').disabled = !selected || !state.music?.isAuthorized;
}

// ---------- boot ----------
(async function boot() {
  try {
    state.status = await api('/api/status');
  } catch {
    banner('Couldn’t reach the server.');
    return;
  }
  const params = new URLSearchParams(location.search);
  if (params.get('error')) banner(`Spotify login failed: ${params.get('error')}`);
  if (params.get('spotify') === 'connected') selectTab('login');
  if (params.toString()) history.replaceState(null, '', '/');

  if (!state.status.spotifyConfigured) {
    $('#url-input').placeholder = 'Spotify isn’t configured on the server — use “Paste text / CSV”';
  }
  if (!state.status.appleConfigured) {
    banner('Apple Music isn’t configured on the server. Set APPLE_TEAM_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY_PATH in .env.');
    $('#apple-connect').disabled = true;
  }
  renderSpotifyAuth();
  renderApple();
})();
