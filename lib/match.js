// Fuzzy matching between a source track (from Spotify / pasted text) and
// Apple Music catalog songs. Pure functions — no network — so it's testable.

// Words in parentheses/after a dash that describe the *same* recording and
// shouldn't count against a match ("2011 Remaster", "Radio Edit", "feat. X").
const NOISE_SEGMENT = /\b(feat\.?|ft\.?|featuring|with|remaster(ed)?|\d{4} remaster|mono|stereo|single version|album version|radio edit|explicit|clean|deluxe|bonus track)\b/i;

// Words that indicate a *different* recording. If the candidate has one and
// the source doesn't (or vice versa), penalise.
const VARIANT_WORDS = ['live', 'remix', 'acoustic', 'instrumental', 'karaoke', 'cover', 'demo', 'sped up', 'slowed', 'reverb', 'tribute'];

export function normalize(s = '') {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Strip "(feat. X)", "[2011 Remaster]", " - Radio Edit" style decorations.
export function coreTitle(title = '') {
  let t = title;
  t = t.replace(/[([]([^)\]]*)[)\]]/g, (m, inner) => (NOISE_SEGMENT.test(inner) ? ' ' : m));
  t = t.replace(/\s[-–—]\s(.*)$/, (m, tail) => (NOISE_SEGMENT.test(tail) ? '' : m));
  return normalize(t);
}

function bigrams(s) {
  const out = new Map();
  const str = s.replace(/\s/g, '');
  for (let i = 0; i < str.length - 1; i++) {
    const g = str.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

// Sørensen–Dice coefficient on character bigrams, 0..1.
export function similarity(a, b) {
  a = normalize(a);
  b = normalize(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.replace(/\s/g, '').length < 2 || b.replace(/\s/g, '').length < 2) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let overlap = 0;
  let total = 0;
  for (const [g, n] of A) {
    overlap += Math.min(n, B.get(g) || 0);
    total += n;
  }
  for (const n of B.values()) total += n;
  return (2 * overlap) / total;
}

function variantsIn(s) {
  const n = ` ${normalize(s)} `;
  return VARIANT_WORDS.filter((w) => n.includes(` ${w} `));
}

function artistScore(sourceArtists, candidateArtist) {
  if (!sourceArtists.length || !candidateArtist) return 0.5;
  const cand = normalize(candidateArtist);
  const primary = normalize(sourceArtists[0]);
  // Apple often joins collaborators: "A & B", "A, B & C".
  if (primary && ` ${cand} `.includes(` ${primary} `)) return 1;
  let best = similarity(sourceArtists.join(' '), candidateArtist);
  for (const a of sourceArtists) best = Math.max(best, similarity(a, candidateArtist));
  return best;
}

function durationScore(aMs, bMs) {
  if (!aMs || !bMs) return 0.5;
  const diff = Math.abs(aMs - bMs) / 1000;
  if (diff <= 3) return 1;
  if (diff >= 30) return 0;
  return 1 - (diff - 3) / 27;
}

/**
 * @param {{title:string, artists:string[], album?:string, durationMs?:number}} src
 * @param {{name:string, artistName:string, albumName?:string, durationMs?:number}} cand
 * @returns {number} 0..1
 */
export function scoreCandidate(src, cand) {
  const title = Math.max(
    similarity(coreTitle(src.title), coreTitle(cand.name)),
    similarity(src.title, cand.name) * 0.95,
  );
  const artist = artistScore(src.artists || [], cand.artistName);
  const duration = durationScore(src.durationMs, cand.durationMs);
  const album = src.album && cand.albumName ? similarity(src.album, cand.albumName) : 0.5;

  let score = 0.5 * title + 0.3 * artist + 0.13 * duration + 0.07 * album;

  const srcV = variantsIn(`${src.title} ${src.album || ''}`);
  const candV = variantsIn(`${cand.name} ${cand.albumName || ''}`);
  const mismatched = candV.filter((v) => !srcV.includes(v)).length + srcV.filter((v) => !candV.includes(v)).length;
  score -= 0.12 * Math.min(mismatched, 2);

  return Math.max(0, Math.min(1, score));
}

export const THRESHOLDS = { matched: 0.8, review: 0.55 };

export function statusFor(confidence) {
  if (confidence >= THRESHOLDS.matched) return 'matched';
  if (confidence >= THRESHOLDS.review) return 'review';
  return 'missing';
}

/** Build the search term we send to Apple Music for a track. */
export function searchTerm(src) {
  const t = coreTitle(src.title) || normalize(src.title);
  const a = normalize((src.artists || [])[0] || '');
  return `${t} ${a}`.trim().slice(0, 200);
}

/**
 * Parse a pasted list of tracks. Supports, one per line:
 *   Artist - Title
 *   Title by Artist
 *   Title<TAB>Artist[<TAB>Album]   (spreadsheet paste)
 *   CSV with a header row containing "title"/"track" and "artist"
 */
export function parseTrackList(text = '') {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];

  const header = splitCsv(lines[0]).map((h) => h.toLowerCase());
  const ti = header.findIndex((h) => /^(title|track( name)?|song|name)$/.test(h));
  const ai = header.findIndex((h) => /^(artist( name)?(\(s\))?|artists)$/.test(h));
  if (ti >= 0 && ai >= 0) {
    const li = header.findIndex((h) => /^(album( name)?)$/.test(h));
    return lines.slice(1).map((l) => {
      const c = splitCsv(l);
      return mk(c[ti], (c[ai] || '').split(/\s*[,;]\s*/), li >= 0 ? c[li] : undefined);
    }).filter((t) => t.title);
  }

  return lines.map((line) => {
    line = line.replace(/^\d+[.)]\s+/, ''); // "1. Artist - Title"
    if (line.includes('\t')) {
      const [title, artist, album] = line.split('\t');
      return mk(title, [artist], album);
    }
    const dash = line.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (dash) return mk(dash[2], [dash[1]]);
    const by = line.match(/^(.+)\s+by\s+(.+)$/i);
    if (by) return mk(by[1], [by[2]]);
    return mk(line, []);
  }).filter((t) => t.title);

  function mk(title, artists, album) {
    return {
      title: (title || '').trim(),
      artists: artists.map((a) => (a || '').trim()).filter(Boolean),
      album: album?.trim() || undefined,
    };
  }
}

function splitCsv(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
