import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coreTitle, scoreCandidate, statusFor, parseTrackList, similarity } from '../lib/match.js';
import { parsePlaylistId } from '../lib/spotify.js';

test('coreTitle strips remaster / feat decorations but keeps meaningful parts', () => {
  assert.equal(coreTitle('Bohemian Rhapsody - Remastered 2011'), 'bohemian rhapsody');
  assert.equal(coreTitle('Stay (feat. Justin Bieber)'), 'stay');
  assert.equal(coreTitle('Hurt (Live)'), 'hurt live');
});

test('same song across services scores high', () => {
  const src = { title: 'Bohemian Rhapsody - Remastered 2011', artists: ['Queen'], album: 'A Night At The Opera (2011 Remaster)', durationMs: 354320 };
  const cand = { name: 'Bohemian Rhapsody', artistName: 'Queen', albumName: 'A Night At the Opera (Deluxe Edition)', durationMs: 354947 };
  assert.equal(statusFor(scoreCandidate(src, cand)), 'matched');
});

test('collaborations joined with & still match the primary artist', () => {
  const src = { title: 'Stay (with Justin Bieber)', artists: ['The Kid LAROI', 'Justin Bieber'], durationMs: 141805 };
  const cand = { name: 'STAY', artistName: 'The Kid LAROI & Justin Bieber', durationMs: 141806 };
  assert.equal(statusFor(scoreCandidate(src, cand)), 'matched');
});

test('live / karaoke versions are penalised', () => {
  const src = { title: 'Hurt', artists: ['Johnny Cash'], durationMs: 218000 };
  const studio = { name: 'Hurt', artistName: 'Johnny Cash', durationMs: 216000 };
  const karaoke = { name: 'Hurt (Karaoke Version)', artistName: 'Johnny Cash', durationMs: 218000 };
  assert.ok(scoreCandidate(src, studio) > scoreCandidate(src, karaoke) + 0.1);
});

test('wrong artist does not count as matched', () => {
  const src = { title: 'Hello', artists: ['Adele'], durationMs: 295000 };
  const cand = { name: 'Hello', artistName: 'Lionel Richie', durationMs: 248000 };
  assert.notEqual(statusFor(scoreCandidate(src, cand)), 'matched');
});

test('similarity handles accents and case', () => {
  assert.equal(similarity('Beyoncé', 'beyonce'), 1);
});

test('parseTrackList handles common formats', () => {
  const out = parseTrackList('1. Radiohead - Karma Police\nBohemian Rhapsody by Queen\nTitle\tArtist\tAlbum');
  assert.deepEqual(out[0], { title: 'Karma Police', artists: ['Radiohead'], album: undefined });
  assert.deepEqual(out[1], { title: 'Bohemian Rhapsody', artists: ['Queen'], album: undefined });
  assert.deepEqual(out[2], { title: 'Title', artists: ['Artist'], album: 'Album' });
});

test('parseTrackList reads CSV with headers', () => {
  const out = parseTrackList('Track Name,Artist Name(s),Album Name\n"Hey, Soul Sister",Train,Save Me San Francisco');
  assert.deepEqual(out, [{ title: 'Hey, Soul Sister', artists: ['Train'], album: 'Save Me San Francisco' }]);
});

test('parsePlaylistId accepts urls, uris and ids', () => {
  const id = '37i9dQZF1DXcBWIGoYBM5M';
  assert.equal(parsePlaylistId(`https://open.spotify.com/playlist/${id}?si=abc`), id);
  assert.equal(parsePlaylistId(`https://open.spotify.com/intl-de/playlist/${id}`), id);
  assert.equal(parsePlaylistId(`spotify:playlist:${id}`), id);
  assert.equal(parsePlaylistId(id), id);
  assert.equal(parsePlaylistId('https://open.spotify.com/album/xyz'), null);
});
