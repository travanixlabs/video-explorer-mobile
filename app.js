'use strict';

/* Video Explorer for phones: browses OneDrive through Graph, no PC involved. */

import * as auth from './auth.js';
import * as graph from './graph.js';

const $ = (sel) => document.querySelector(sel);

// The desktop's vocabularies and merge, from shared/facets.js and
// shared/merge.js (loaded before this module; see index.html). Read from the
// global scope rather than copied: a race or a tier added on the desktop used
// to miss the phone, because the copy here was typed in by hand.
const {
  RACES, TRAITS, TIERS, DEFAULT_TIER, PERSON_FACETS, RATING_MAX, FACE_FLOOR, STAR_POINTS,
} = globalThis;
if (typeof FACE_FLOOR !== 'number' || !Array.isArray(RACES) || typeof globalThis.mergeLibraries !== 'function') {
  throw new Error('shared/facets.js and shared/merge.js did not load before app.js');
}

/**
 * One collator for every comparison a sort makes. `localeCompare` with options
 * builds the locale machinery afresh on each call, and a sort of a flattened
 * library is hundreds of thousands of calls -- a measurable pause on a phone,
 * paid on every render.
 */
const collate = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;

const state = {
  account: null,
  stack: [],          // [{ driveId, itemId, name }] — the trail from the root
  folders: [],
  videos: [],
  library: { version: 1, records: {} },
  libraryLoaded: false, // the sidecar was really read; without this, no writing
  faces: null,        // the desktop's face suggestions, or null when it has never run
  geom: null,         // the preview cache's geometry, so a strip can be addressed
  dirty: false,       // library edits waiting to be written back
  query: '',
  sort: 'rating',     // matches the desktop default: highest rated first
  sortDir: 'desc',
  scrub: null,        // { card, video, url } while a finger is down
  load: null,         // token identifying the in-flight folder load
  next: null,
  flatten: false,     // every video below here, not just this folder
  // '' | 'models' | 'suggested' -- off, by who is credited, by who the faces
  // look like. Empty rather than false because everything downstream asks
  // whether it is grouped far more often than it asks how.
  grouped: '',
  groups: [],         // [{ key, name, files }] while grouped, favourites first
  walk: null,         // { driveId, itemId, next } — where the flattened walk is
  queue: [],          // folders the walk has seen but not visited yet
  playingId: null,    // which video the player has open, for swipe-to-next
  selecting: false,   // selection mode: taps toggle instead of scrubbing
  cardWidth: 320,     // per-device, not a judgement about a video; the CSS default
  loading: false,     // a folder is still streaming in
  skipped: 0,         // folders the flattened walk gave up on, said in the count line
  offline: false,     // the listing on screen is the saved copy, not the network's
  selected: new Set(), // item ids
};

/**
 * Every card's thumbnail is fetched, on screen or not, 20 per Graph $batch
 * call and one call at a time. Expanding them into the listing itself is still
 * refused -- that cost 6s per page against 0.7s plain -- so they come as their
 * own requests behind the grid, in the order the cards were built.
 */
const wanted = new Map(); // item id -> the .shot element waiting for a URL
// Client-side sorting means the grid gets rebuilt rather than appended to, so
// URLs already fetched are kept — a rebuild must not re-hit Graph.
const thumbCache = new Map(); // item id -> url
let thumbTimer = null;

/**
 * What is on screen goes first. The queue is in card order, which is the right
 * order to work through a folder in but the wrong one to answer a scroll with:
 * a flattened five thousand is two hundred and fifty batches, and a tile deep
 * in the listing would wait out most of them blank. On screen, or 400px from
 * it, a tile jumps the queue -- everything else still arrives, just after.
 */
const urgent = new Set(); // item ids currently near the screen
const eye = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((entries) => {
    let poke = false;
    for (const entry of entries) {
      const id = entry.target.dataset.id;
      if (!entry.isIntersecting) { urgent.delete(id); continue; }
      if (wanted.has(id)) { urgent.add(id); poke = true; }
    }
    if (poke) flushThumbs();
  }, { rootMargin: '400px 0px' })
  : null;

/** Asks for one card's thumbnail. The wait coalesces a render into one batch. */
function wantThumb(el) {
  wanted.set(el.dataset.id, el);
  if (eye) eye.observe(el);
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(flushThumbs, 120);
}

// One call in flight at a time. A folder of five thousand is two hundred and
// fifty batches, and firing those together is how you get throttled by Graph
// rather than how you get thumbnails.
let flushing = false;

async function flushThumbs() {
  if (flushing) return;
  flushing = true;
  try {
    while (wanted.size) await flushBatch();
  } finally {
    flushing = false;
  }
}

async function flushBatch() {
  const batch = [];
  const take = (onlyUrgent) => {
    for (const [id, el] of wanted) {
      if (batch.length === 20) return;
      if (onlyUrgent && !urgent.has(id)) continue;
      wanted.delete(id);
      urgent.delete(id);
      if (eye) eye.unobserve(el);
      // Its card was thrown away by a re-render before its turn came. The
      // rebuilt one asks again, so dropping it costs nothing, saves a request.
      if (!el.isConnected) continue;
      batch.push([id, el]);
    }
  };
  take(true);   // whatever is near the screen
  take(false);  // then the folder in its own order
  if (!batch.length) return;

  const items = batch.map(([id, el]) => ({ id, driveId: el.dataset.drive }));
  try {
    const urls = await graph.thumbnailsFor(items);
    for (const [id, el] of batch) {
      const url = urls.get(id);
      if (!url) continue;
      thumbCache.set(id, url);
      if (el.isConnected) el.style.backgroundImage = `url("${url}")`;
    }
  } catch { /* a missing thumbnail is a blank tile, not an error worth a toast */ }
}

// --------------------------------------------------------------- utilities

function fmtBytes(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function toast(message, kind = '', action = null) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = message;
  // A toast with an action stays up long enough to press it.
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-act';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { el.remove(); action.run(); });
    el.appendChild(btn);
  }
  $('#toasts').appendChild(el);
  // A sticky one waits to be answered.
  if (!(action && action.sticky)) setTimeout(() => el.remove(), action ? 8000 : 3200);
}

function setBusy(text) {
  $('#status').textContent = text || '';
  $('#status').hidden = !text;
}

// ------------------------------------------------------------------ library

const EMPTY_RECORD = Object.freeze({
  rating: 0, tags: [], models: [], notModels: [], studio: '', production: '', url: '',
  resume: 0, updated: 0,
});

/**
 * Fields with exactly one value, as against a list of them.
 *
 * A video comes from one production house and carries one reference code; it
 * can have any number of performers. That difference decides how a field is
 * stored, filtered, sorted and edited, so it is written down once here rather
 * than special-cased at each of those.
 */
const SINGLE_FIELDS = new Set(['studio', 'production']);

/** Whatever a field holds, as a list — one value or many. */
function valuesOf(record, field) {
  if (!SINGLE_FIELDS.has(field)) return record[field] || [];
  return record[field] ? [record[field]] : [];
}

/**
 * Which version of the labels everything derived from them was worked out
 * against. Bumped by every change -- an edit, a favourite, a fresh read, a
 * merge adopted from a save -- so a memo only has to compare one number.
 */
let libVersion = 0;

function libraryChanged(key = null) {
  libVersion += 1;
  if (key === null) recordCache.clear();
  else recordCache.delete(key);
}

/**
 * Normalised records, made once each. A sort asks for the same record dozens
 * of times and every one of those built a fresh object; they are shared
 * now, so nothing may mutate what recordFor hands back.
 *
 * Tied to the records object as well as to the version: a library replaced
 * wholesale (a read, a merge) is a different object, and that alone clears it.
 */
const recordCache = new Map(); // record key -> normalised record
let recordCacheFor = null;

function recordFor(video) {
  const key = graph.recordKey(video);
  const records = state.library.records;
  if (recordCacheFor !== records) {
    recordCache.clear();
    recordCacheFor = records;
  }
  const hit = recordCache.get(key);
  if (hit) return hit;
  const made = makeRecord(records[key]);
  recordCache.set(key, made);
  return made;
}

function makeRecord(record) {
  if (!record) return EMPTY_RECORD;
  return {
    rating: record.rating || 0,
    tags: record.tags || [],
    models: record.models || [],
    // Names turned down for this video: the desktop's answer to a face
    // suggestion, "not her", kept so the same name is not offered again.
    notModels: record.notModels || [],
    studio: record.studio || '',
    // The reference's letter code — the series within the house.
    production: record.production || '',
    url: record.url || '',
    // Where playback stood when this was last closed, on any device -- the
    // desktop writes the same field.
    resume: record.resume || 0,
    // When the labels last changed, which the date sort counts as a change to
    // the video: tagging one does not touch the file.
    updated: record.updated || 0,
  };
}

/**
 * What the face recognition made of a video: the names it suggests, and whether
 * it has looked at all.
 *
 * "Profiled and matched nobody" and "never profiled" are different answers and
 * the filter has to tell them apart, so the digest lists a key with an empty
 * array for the first and omits it entirely for the second.
 */
function facesFor(video) {
  const digest = state.faces;
  if (!digest) return { profiled: false, suggested: [] };
  const found = digest.videos[graph.recordKey(video)];
  if (!found) return { profiled: false, suggested: [] };
  return { profiled: true, suggested: found };
}

/**
 * Whether a video's suggestions are all accounted for by the names on it.
 *
 * Not "does it suggest anyone" — a video credited to A that also suggests B and
 * C is exactly the case worth finding, since B might be the one who should have
 * been on it. Settled means every suggested name is already credited.
 */
function suggestionMatch(video, want) {
  const { profiled, suggested } = facesFor(video);
  if (want === 'unprofiled') return !profiled;
  if (!profiled) return false;
  // Read, and it gave the recogniser nothing to work with. The digest lists
  // these separately because an empty suggestion list cannot say which of the
  // two it is, and only one of them has work left in it.
  const faceless = facelessKeys().has(graph.recordKey(video));
  if (want === 'faceless') return faceless;
  // A name turned down is as settled as one credited: both are a decision
  // made about that suggestion, which is what the desktop counts too.
  const record = recordFor(video);
  const named = new Set([...(record.models || []), ...(record.notModels || [])]
    .map((m) => String(m).toLowerCase()));
  const settled = suggested.length > 0
    && suggested.every((s) => named.has(String(s.name).toLowerCase()));
  if (want === 'nomatch') return !faceless && !settled;
  return settled;
}

// Built once per digest rather than per video: this is asked while filtering
// thousands of rows, and the published list is an array.
let facelessAt = null;
let facelessSet = new Set();

function facelessKeys() {
  const digest = state.faces;
  if (!digest) return new Set();
  if (facelessAt !== digest) {
    facelessAt = digest;
    facelessSet = new Set(digest.faceless || []);
  }
  return facelessSet;
}

/**
 * The desktop's preview strip for this video: ten frames in one image.
 *
 * The desktop decodes these once and they sit in the sync root, so the phone can
 * have all ten for about 17KB. The alternative — which is what this did before,
 * and still does when a strip is missing — is seeking the video itself ten times
 * over mobile data.
 *
 * Addressable only because the cache name is `<size>_<mtime>-<salt>`, keyed the same
 * way the labels are. It used to hash the file's local path, which the phone has
 * no way of knowing.
 */
function stripName(video) {
  if (!state.geom || !state.geom.sprite) return null;
  return `cache/${video.size}_${Math.round(video.mtime)}-${state.geom.sprite}.jpg`;
}

function stripFor(video) {
  const rel = stripName(video);
  return rel ? graph.asset(rel) : Promise.resolve(null);
}

/**
 * Paints frame `index` of a strip into an element.
 *
 * Every tile is letterboxed to the same box by the encoder -- the manifest says
 * which -- but the element it goes into is not that shape. The player's stage is
 * whatever height the phone and the details panel leave it, so sizing the sprite
 * to the element, which is what this did, stretched every frame to fill it. The
 * <video> underneath letterboxes itself, so the preview and the playthrough were
 * showing the same picture at two different shapes.
 *
 * The tile is fitted to the element and centred instead, in pixels, the way
 * `contain` would. Measured on every paint rather than remembered: a rotation
 * changes the answer, and the preview repaints once a second anyway.
 */
function showFrame(el, url, index, frames) {
  el.style.backgroundImage = `url(${url})`;
  el.style.backgroundRepeat = 'no-repeat';

  const box = el.getBoundingClientRect();
  const geom = state.geom || {};
  const aspect = geom.tileW > 0 && geom.tileH > 0 ? geom.tileW / geom.tileH : 16 / 9;

  // Nothing to measure -- the element is not laid out yet. Fill it, as this
  // always did, rather than painting a frame of nothing.
  if (!(box.width > 0) || !(box.height > 0)) {
    el.style.backgroundSize = `${frames * 100}% 100%`;
    el.style.backgroundPosition = `${(index / (frames - 1)) * 100}% 0`;
    el.style.clipPath = '';
    return;
  }

  let w = box.width;
  let h = w / aspect;
  if (h > box.height) { h = box.height; w = h * aspect; }

  const x = (box.width - w) / 2;
  const y = (box.height - h) / 2;
  el.style.backgroundSize = `${frames * w}px ${h}px`;
  el.style.backgroundPosition = `${x - index * w}px ${y}px`;
  // The image is ten frames wide. Fitting one into the middle of a box wider
  // than a frame leaves the ones AFTER it in the margin to the right -- small
  // pictures beside the preview, over a video playing behind them. A card's
  // .shot is exactly a frame's shape, so nothing is cropped there.
  el.style.clipPath = x > 0.5 || y > 0.5
    ? `inset(${y}px ${box.width - w - x}px ${box.height - h - y}px ${x}px)`
    : '';
}

/**
 * Takes a strip back off, putting the poster underneath back.
 *
 * A card's poster is itself a background image on the same element, so painting
 * a frame replaces it rather than covering it -- which means letting go has to
 * restore it explicitly, and reset the sizing the strip needed.
 */
function clearFrame(el, poster = '') {
  el.style.backgroundImage = poster ? `url("${poster}")` : '';
  el.style.backgroundSize = poster ? 'cover' : '';
  el.style.backgroundPosition = poster ? 'center' : '';
  el.style.clipPath = '';
}

/**
 * The crop the recognition actually looked at, for a video key and face group.
 *
 * Addressable for the same reason the strips are: `<size>_<mtime>-<person>.png`,
 * keyed the way everything else here is keyed. These are the evidence — a name
 * and a percentage is a claim, and this is what the claim was made from.
 */
function cropName(key, person = 0) {
  return `faces/thumbs/${String(key).replace(':', '_')}-${person}.png`;
}

function cropFor(key, person = 0) {
  return graph.asset(cropName(key, person));
}

/** Fills an <img> from OneDrive, and removes it if there is nothing there. */
function paintCrop(img, key, person) {
  cropFor(key, person).then((url) => {
    if (url) img.src = url;
    else img.remove();
  }).catch(() => img.remove());
}

/** Case-insensitive dedupe, keeping the spelling that arrived first. */
function normaliseList(values) {
  const seen = new Map();
  for (const raw of values || []) {
    const value = String(raw).trim().replace(/\s+/g, ' ');
    if (!value) continue;
    const key = value.toLowerCase();
    if (!seen.has(key)) seen.set(key, value);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function editRecord(video, patch) {
  // Nothing may be written on top of labels that were never read. `state.library`
  // is empty in both cases — loaded-and-empty and never-loaded — and only this
  // flag tells them apart.
  if (!state.libraryLoaded) {
    // Usually a minute of bad signal rather than anything permanent, so the
    // answer is to try again rather than to send you off to fix something.
    toast('Labels have not loaded — retrying, give that another tap', 'err');
    readLibrary();
    return;
  }
  const key = graph.recordKey(video);
  const current = state.library.records[key]
    || { rating: 0, tags: [], models: [], name: video.name };
  // Where playback stood is bookkeeping, not labelling: it must not push the
  // video to the top of the date sort. Same rule as the desktop's apply().
  const onlyResume = Object.keys(patch).every((k) => k === 'resume');
  const next = {
    ...current,
    name: video.name,
    updated: onlyResume ? (current.updated || 0) : Date.now(),
    ...patch,
  };
  if (next.resume !== undefined) {
    const at = Math.max(0, Math.round(Number(next.resume) || 0));
    if (at > 0) next.resume = at;
    else delete next.resume;
  }

  // The desktop's shapes, so a record written here reads the same there: lists
  // deduped and sorted, the studio a single trimmed string, a url only if it is
  // one the app would be willing to open.
  for (const field of ['tags', 'models', 'notModels']) {
    if (Array.isArray(next[field])) next[field] = normaliseList(next[field]);
  }
  if (next.notModels && !next.notModels.length) delete next.notModels;
  if (next.studio !== undefined) {
    next.studio = String(next.studio || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  }
  if (next.production !== undefined) {
    // Upper-cased like the desktop: the site writes MD, RS, MCY that way, and a
    // code differing only in case is the same code.
    next.production = String(next.production || '')
      .trim().replace(/\s+/g, ' ').slice(0, 24).toUpperCase();
  }
  if (next.url !== undefined) {
    next.url = /^https?:\/\//i.test(String(next.url || '').trim()) ? String(next.url).trim() : '';
  }

  // An empty record is noise in a file that syncs; match the desktop and drop it.
  // A turned-down name counts as content, as it does there: dropping the record
  // would hand the same suggestion straight back. So does a bookmark, which
  // the phone does not draw but must not throw away.
  if (!next.rating && !(next.tags || []).length && !(next.models || []).length
    && !(next.notModels || []).length && !(next.marks || []).length
    && !next.studio && !next.production && !next.url && !next.resume) {
    delete state.library.records[key];
  } else state.library.records[key] = next;
  libraryChanged(key);
  state.dirty = true;
  scheduleSave();
}

/**
 * Reads the sidecar, and records whether it was really read.
 *
 * A failure leaves the app browsable and the labels frozen, which is the right
 * trade in both directions: you can still watch things, and a bad minute of
 * signal cannot cost you the ratings. `state.library` stays whatever it was, so
 * a retry that succeeds mid-session simply picks up.
 */
// Ratings run 0 (unrated) to RATING_MAX (shared/facets.js). They ran to 5 until 2026-10-05.
const RATING_VALUES = Array.from({ length: RATING_MAX + 1 }, (_, n) => n);

/** A rating as a filter chip: its stars, half one and all. */
function ratingChipLabel(value) {
  return value === 0 ? 'unrated' : starsNode(value);
}

/**
 * A stored rating (0-10) drawn as stars: 7 is three whole stars and a half
 * one -- the star glyph with only its left half gold.
 */
function starsNode(rating) {
  const r = Math.max(0, Math.min(RATING_MAX, Math.round(Number(rating) || 0)));
  const run = document.createElement('span');
  run.className = 'star-run';
  for (let i = 1; i <= Math.ceil(r / 2); i += 1) {
    const star = document.createElement('span');
    star.className = 'sr' + (r >= i * 2 ? '' : ' half');
    star.textContent = '\u2605';
    run.appendChild(star);
  }
  return run;
}

/** A stored rating as a number of stars, for tooltips: 7 is "3.5". */
function starsNumber(rating) {
  return String((Math.round(Number(rating) || 0)) / 2);
}

/** Lights a row of five for a value: whole stars, then a half if it is odd. */
function paintStarRow(wrap, value) {
  wrap.querySelectorAll('.star').forEach((star, i) => {
    const full = value >= (i + 1) * 2;
    const half = !full && value === i * 2 + 1;
    star.classList.toggle('on', full);
    star.classList.toggle('half', half);
    star.textContent = full || half ? '\u2605' : '\u2606';
  });
}

/**
 * Five stars, each worth two steps: the left half of a star is the half, the
 * right half the whole. Hovering previews where a click would land; clicking
 * the rating already held clears it.
 */
function buildStarRow(current, onPick, className = 'stars') {
  const wrap = document.createElement('span');
  wrap.className = className;
  const at = (star, ev) => {
    const box = star.getBoundingClientRect();
    const i = Number(star.dataset.n);
    return ev.clientX - box.left < box.width / 2 ? i * 2 - 1 : i * 2;
  };
  for (let i = 1; i <= RATING_MAX / 2; i += 1) {
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'star';
    star.dataset.n = String(i);
    star.addEventListener('pointermove', (ev) => {
      const v = at(star, ev);
      paintStarRow(wrap, v);
      star.title = v === current ? 'Clear rating' : `Rate ${starsNumber(v)}`;
    });
    star.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      const v = at(star, ev);
      onPick(v === current ? 0 : v);
    });
    wrap.appendChild(star);
  }
  wrap.addEventListener('pointerleave', () => paintStarRow(wrap, current));
  paintStarRow(wrap, current);
  return wrap;
}

/**
 * The same five stars, to read rather than press.
 *
 * On a card each half-star was a target about nine pixels wide, under a thumb
 * that had come to scroll -- ratings changed by accident far more often than
 * on purpose. The player's stars are twice the size and are where rating
 * happens; a card only says what the rating is. `onTap`, when given, makes the
 * whole row one target for something bigger (the selection's labels sheet).
 */
function buildStarDisplay(current, onTap = null, className = 'stars') {
  const wrap = document.createElement(onTap ? 'button' : 'span');
  wrap.className = className + ' read-only';
  if (onTap) {
    wrap.type = 'button';
    wrap.title = 'Rate in the labels sheet';
    wrap.addEventListener('click', (ev) => { ev.stopPropagation(); onTap(); });
  }
  wrap.setAttribute('aria-label', current ? `Rated ${starsNumber(current)} of 5` : 'Unrated');
  for (let i = 1; i <= RATING_MAX / 2; i += 1) {
    const star = document.createElement('span');
    star.className = 'star';
    wrap.appendChild(star);
  }
  paintStarRow(wrap, current);
  return wrap;
}


/**
 * The same once-only move the desktop makes when it opens the file: a library
 * that does not say it is out of ten is out of five, so every rating doubles
 * and the file is marked. Normally the PC has done it already and this finds
 * nothing to do; if the phone gets there first, its next save carries it.
 */
function toTenStars(library) {
  if (!library || !library.records || library.ratingScale === RATING_MAX) return library;
  for (const record of Object.values(library.records)) {
    const was = Math.round(Number(record.rating) || 0);
    if (was > 0) record.rating = Math.min(RATING_MAX, was * 2);
  }
  library.ratingScale = RATING_MAX;
  return library;
}

async function readLibrary() {
  try {
    state.library = toTenStars(await graph.loadLibrary());
    state.libraryLoaded = true;
    libraryChanged();
    graph.noteLoaded(state.library);
    // A read that only succeeded on the second attempt has cards on screen
    // already, drawn without their ratings.
    if (state.videos.length) render();
    // Day's copy, in the background — never worth waiting on.
    graph.dailyBackup(state.library).catch(() => {});
    // Same for the face suggestions: a listing renders perfectly well without
    // them, and they are a nicety rather than something to hold the app on.
    graph.loadSuggestions().then((faces) => {
      if (!faces) return;
      state.faces = faces;
      libraryChanged(); // the Faces filter reads these
      if (state.videos.length) render();
    }).catch(() => {});
    // And the preview cache's geometry, without which a strip cannot be named.
    graph.veJson('cache/manifest.json').then((geom) => { state.geom = geom; }).catch(() => {});
    // The desktop's Settings colours. Late is fine: the grid repaints once
    // they land, and until then chips wear the stylesheet's defaults.
    graph.veJson('cache/colours.json').then((colours) => {
      if (!colours) return;
      state.colours = colours;
      render();
      if (!$('#labels').hidden) renderLabelSuggestions();
    }).catch(() => {});
    return true;
  } catch (err) {
    state.libraryLoaded = false;
    if (err.offline) {
      // No signal: the copy this phone last held, shown but never written --
      // libraryLoaded stays false, so editRecord refuses and asks again,
      // and coming back to the app with signal reads the real one.
      if (err.library) {
        state.library = toTenStars(err.library);
        libraryChanged();
        if (state.videos.length) render();
        toast('Offline — showing saved labels', 'err');
      } else {
        toast('Offline — labels will load when the signal is back', 'err');
      }
      return false;
    }
    toast(`${err.message} — labels are read-only until this works`, 'err');
    return false;
  }
}

let saveTimer = null;
let dirtySince = 0;
/**
 * A save is three megabytes over mobile data, so edits are gathered up rather
 * than sent one at a time: rating five videos in a row is one upload.
 *
 * With a ceiling, though. A pure debounce means a steady hand -- a star every
 * second down a long list -- never reaches a quiet moment, and nothing is
 * written at all until it stops. So a burst that has been going for
 * SAVE_AT_MOST is written where it stands and starts gathering again.
 */
const SAVE_AFTER_MS = 1200;
const SAVE_AT_MOST_MS = 15000;

function scheduleSave() {
  if (!dirtySince) dirtySince = Date.now();
  clearTimeout(saveTimer);
  const waited = Date.now() - dirtySince;
  saveTimer = setTimeout(runSave, Math.max(0, Math.min(SAVE_AFTER_MS, SAVE_AT_MOST_MS - waited)));
}

/**
 * A failed save tries again by itself, further apart each time.
 *
 * It used to toast and stop, leaving the edits dirty in memory with nothing
 * coming to write them: unless another star was pressed, or the app went to
 * the background, they were lost when the tab was. Two seconds, then four, up
 * to a minute between tries; one toast for the run of failures rather than one
 * per try. A refusal that would only repeat (the empty-library guard) stops.
 */
const SAVE_RETRY_FIRST_MS = 2000;
const SAVE_RETRY_MAX_MS = 60000;
let saveFailures = 0;

async function runSave() {
  saveTimer = null;
  if (!state.libraryLoaded || !state.dirty) return;
  try {
    await saveAndAdopt();
    dirtySince = 0;
    if (saveFailures) toast('Labels saved', 'ok');
    saveFailures = 0;
  } catch (err) {
    dirtySince = 0;
    // saveAndAdopt has put state.dirty back; nothing is lost by waiting.
    if (err.permanent) { toast(err.message, 'err'); return; }
    saveFailures += 1;
    if (saveFailures === 1) toast(`${err.message} — will keep trying`, 'err');
    const wait = Math.min(SAVE_RETRY_MAX_MS, SAVE_RETRY_FIRST_MS * 2 ** (saveFailures - 1));
    clearTimeout(saveTimer);
    saveTimer = setTimeout(runSave, wait);
  }
}

// A pending edit must not be lost to a backgrounded tab — and coming back is
// the natural moment to retry a read that failed, since a phone that has been
// in a pocket has usually found signal again by now.
window.addEventListener('visibilitychange', () => {
  // Where the open video stands, written now: going to the background is
  // often the last chance this tab gets. Not on every tick of playback --
  // each save is the whole library up a phone's mobile data.
  if (document.visibilityState === 'hidden') notePlaybackPosition();
  // Through runSave, so a save that fails here still re-arms its retry.
  if (document.visibilityState === 'hidden' && state.dirty && state.libraryLoaded) {
    clearTimeout(saveTimer);
    runSave();
  }
  // Back with a save still waiting out its backoff: signal is likeliest now.
  if (document.visibilityState === 'visible' && state.dirty && state.libraryLoaded && saveFailures) {
    clearTimeout(saveTimer);
    runSave();
  }
  if (document.visibilityState === 'visible' && !state.libraryLoaded) readLibrary();
  // Back after a while with nothing unsaved: the desktop may have labelled
  // things since. A newer file is read in; the eTag check costs almost nothing.
  else if (document.visibilityState === 'visible' && !state.dirty) {
    graph.libraryChanged().then((changed) => { if (changed && !state.dirty) readLibrary(); }).catch(() => {});
  }
});

/**
 * Saves, and takes on whatever the save merged in: when the desktop wrote
 * first, what lands on OneDrive is both sets of edits, and that is now ours.
 */
async function saveAndAdopt() {
  // What is sent is a snapshot: an edit made while the upload is in the air
  // lands on state.library, marks it dirty again and is saved next time.
  // Records are replaced, never mutated, so a shallow copy is enough.
  const sent = { ...state.library, records: { ...state.library.records } };
  state.dirty = false;
  let saved;
  try {
    saved = await graph.saveLibrary(sent);
  } catch (err) {
    state.dirty = true;
    throw err;
  }
  if (saved !== sent) {
    state.library = graph.mergeLibraries(sent, state.library, saved);
    libraryChanged();
    graph.noteLoaded(state.library);
    if (state.videos.length) render();
  }
}

// ---------------------------------------------------------------- navigation

/**
 * Renders the first page as soon as it lands, then keeps pulling the rest in
 * the background. A folder used to sit on "Loading…" until every page had
 * arrived — on a folder of a few thousand videos that was minutes.
 */
async function openFolder(entry, { push = true } = {}) {
  const run = Symbol('load');
  state.load = run;

  if (push) {
    if (entry) state.stack.push(entry);
    else state.stack = [];
  }
  // Something for Back to walk up out of.
  if (state.stack.length) armTrap();
  state.folders = [];
  state.videos = [];
  state.next = null;
  state.queue = [];
  state.walk = null;
  state.skipped = 0;
  state.offline = false;
  render();
  window.scrollTo(0, 0);
  setBusy('Loading…');

  const driveId = entry ? entry.driveId : null;
  const itemId = entry ? entry.itemId : null;
  state.source = { driveId, itemId, run, saveKey: listingKey(itemId) };
  // Flattened, the listing is a walk that starts here and works downwards.
  if (state.flatten) state.walk = { driveId, itemId, next: null };

  // Folders and videos are separate queries with different orderings, so they
  // run side by side rather than one behind the other.
  let foldersOk = false;
  const folders = graph.listFolders(driveId, itemId).then((found) => {
    if (state.load !== run) return;
    state.folders = atRoot() ? found.filter(isLibraryFolder) : found;
    foldersOk = true;
    renderFolders();
  }).catch((err) => {
    if (state.load !== run) return;
    if (graph.isOffline(err)) useSavedListing(run);
    else toast(err.message, 'err');
  });

  const complete = await loadMore();
  await folders;
  // The whole of it arrived: kept, for the next time there is no signal.
  if (complete && foldersOk && state.load === run && !state.offline) {
    graph.kvSet(state.source.saveKey, { folders: state.folders, videos: state.videos }).catch(() => {});
  }
}

/** Where a folder's last listing is kept: flattened or not are different lists. */
function listingKey(itemId) {
  return `folder:${itemId || 'root'}${state.flatten ? ':flat' : ''}`;
}

/**
 * No network: the last listing this phone saw of the folder, if it ever saw
 * one, rather than an empty grid and an error. Said so, since it may be out of
 * date and none of it will play until the signal is back.
 */
let offlineTried = null;

async function useSavedListing(run) {
  if (offlineTried === run) return; // folders and videos both fail; one answer
  offlineTried = run;
  const saved = await graph.kvGet(state.source.saveKey);
  if (state.load !== run) return;
  if (!saved || !Array.isArray(saved.videos)) {
    toast('Offline — nothing saved for this folder yet', 'err');
    return;
  }
  state.offline = true;
  state.folders = saved.folders || [];
  state.videos = saved.videos;
  state.next = null;
  state.walk = null;
  state.queue = [];
  setBusy('');
  gridKey = '';
  render();
  toast('Offline — showing the last listing saved here', 'err');
}

/**
 * A redraw during a load, at most a few a second.
 *
 * Appending a page is cheap, but a grid held in any order other than the
 * server's own has to be rebuilt when one lands — and a folder that now streams
 * all the way through lands twenty-five of them rather than three. Tied to the
 * clock instead of to the pages, the cost of loading a large folder stops
 * growing with the square of its size.
 */
let redrawAt = 0;
let redrawTimer = null;
const REDRAW_MS = 400;

function renderSoon() {
  const wait = redrawAt + REDRAW_MS - Date.now();
  if (wait <= 0) {
    clearTimeout(redrawTimer);
    redrawTimer = null;
    redrawAt = Date.now();
    render();
    return;
  }
  if (redrawTimer) return; // one is already coming
  redrawTimer = setTimeout(() => { redrawTimer = null; renderSoon(); }, wait);
}

/** Whether anything is left to load, in either mode. */
function moreToLoad() {
  return state.flatten ? Boolean(state.walk) : Boolean(state.next);
}

/**
 * Pulls the folder until there is nothing left of it. Graph hands out 200 at a
 * time and a walk hands out a folder at a time, so the pages are the API's, not
 * the listing's: the grid grows as they land and never stops part-way waiting
 * to be asked. It used to stop at three pages behind a "Load more" button,
 * which on a five-thousand-video folder meant most of it was simply not there.
 */
/**
 * A folder the walk could not read goes to the back of the queue, not straight
 * into the next round: Graph has already retried anything throttled inside the
 * batch, so what reaches here is a folder that needs longer -- 1s, then 2s,
 * then it is skipped and counted.
 */
const SPOT_RETRIES = 2;
const spotDue = (spot) => !spot.notBefore || spot.notBefore <= Date.now();

async function loadMore() {
  const { driveId, itemId, run } = state.source;

  state.loading = true;
  try {
    do {
      if (state.flatten && !state.walk) return state.skipped === 0; // the walk finished
      if (state.flatten) {
        // Only folders backing off left: wait for the first of them, rather
        // than asking again for something Graph has just refused.
        if (!spotDue(state.walk)) {
          const at = state.queue.findIndex(spotDue);
          if (at >= 0) {
            const due = state.queue.splice(at, 1)[0];
            state.queue.push(state.walk);
            state.walk = due;
          } else {
            const soonest = Math.min(state.walk.notBefore,
              ...state.queue.map((s) => s.notBefore || 0));
            await new Promise((done) => setTimeout(done, Math.max(0, soonest - Date.now())));
            if (state.load !== run) return false;
            continue;
          }
        }
        // A level at a time, twenty folders per round trip, through $batch:
        // one folder per round trip was the measured minute on a library
        // folder of five thousand.
        const round = [state.walk];
        const later = []; // backing off, kept in their place for a later round
        while (round.length < graph.BATCH && state.queue.length) {
          const spot = state.queue.shift();
          if (!spotDue(spot)) { later.push(spot); continue; }
          if (!('next' in spot)) spot.next = null;
          round.push(spot);
        }
        state.queue.unshift(...later);
        const pages = await graph.listChildrenBatch(round);
        // A folder tapped while this one was still streaming wins; anything
        // this loop produces from here belongs to a screen the user has left.
        if (state.load !== run) return false;

        const going = []; // folders with pages still to fetch, kept at the front
        pages.forEach((page, i) => {
          const spot = round[i];
          if (page.failed) {
            const tries = (spot.tries || 0) + 1;
            if (tries <= SPOT_RETRIES) {
              state.queue.push({ ...spot, tries, notBefore: Date.now() + 1000 * 2 ** (tries - 1) });
            } else {
              state.skipped += 1; // that folder alone is the cost, and it is said
            }
            return;
          }
          for (const video of page.videos) video.folderName = spot.name || '';
          state.videos.push(...page.videos);
          if (page.next) going.push({ ...spot, next: page.next });
          state.queue.push(...page.folders.map((f) => ({
            // Without a drive of its own a subfolder is in the one holding it;
            // passing the gap on asks Graph for /drives/null/items/… .
            driveId: f.driveId || spot.driveId, itemId: f.id, name: f.name, next: null,
          })));
        });
        // Breadth-first still: half-read folders finish before new ones start.
        state.queue.unshift(...going);
        state.walk = state.queue.shift() || null;
        if (state.walk && !('next' in state.walk)) state.walk.next = null;
      } else {
        const page = await graph.listPage(driveId, itemId, state.next);
        if (state.load !== run) return false;
        state.videos.push(...page.videos);
        state.next = page.next;
      }
      renderSoon();
      setBusy(moreToLoad() ? `Loading… ${state.videos.length} so far` : '');
    } while (moreToLoad());
    // Complete unless a folder had to be skipped: a listing with holes in it
    // is not one worth keeping as "the last listing of this folder".
    return state.skipped === 0;
  } catch (err) {
    if (state.load === run) {
      setBusy('');
      // Nothing came at all, for want of a network: the saved copy instead.
      // Part of a folder and then the signal going is left as it is, with the
      // button that picks the load back up.
      if (graph.isOffline(err) && !state.videos.length) useSavedListing(run);
      else toast(err.message, 'err');
    }
    return false;
  } finally {
    // Whether it finished or stopped on an error, it is no longer running --
    // and the button that offers to pick it up again is shown on that.
    if (state.load === run) {
      state.loading = false;
      clearTimeout(redrawTimer);
      redrawTimer = null;
      render();   // the whole folder, in order, whatever the throttle skipped
    }
  }
}

/**
 * Pushes an entry for the next Back to absorb, in manual scroll-restoration
 * mode. These entries are a back-button trap, not navigation — the folder trail
 * is app state — so there is nothing the browser could usefully restore, and on
 * 'auto' it restored the offset recorded for the entry Back lands on, which is
 * the top of the page. That is what threw the grid away when you left a video.
 *
 * The mode belongs to an entry rather than the document, so it is set on both
 * sides of the push: the entry we are leaving and the one we are creating.
 */
function pushTrap() {
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  history.pushState(null, '');
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
}

/**
 * One trap at a time, and only while Back has something to undo.
 *
 * It used to be pushed again on every Back, unconditionally -- so at the root,
 * with nothing open, Back did nothing at all and the app could not be left
 * with it. Now the trap is armed when there is something to walk out of (a
 * folder, an overlay, a selection) and re-armed only while there still is.
 */
let trapArmed = false;

function armTrap() {
  if (trapArmed) return;
  trapArmed = true;
  pushTrap();
}

async function goUp() {
  if (!state.stack.length) return;
  state.stack.pop();
  const parent = state.stack[state.stack.length - 1] || null;
  await openFolder(parent, { push: false });
}

/* ------------------------------------------------------- the page underneath
 *
 * An overlay is fixed to the viewport, and on a phone the viewport changes
 * height underneath it: scroll, and the browser slides its own address bar
 * away. The strip that bar was covering becomes real screen, the overlay does
 * not grow into it, and the listing shows through the gap -- scrollable, in the
 * bottom tenth of the screen, under an open video.
 *
 * Two halves to the fix. The stylesheet sizes the overlays in dvh: the height
 * that is on screen right now, re-measured as the bar comes and goes. And the
 * page underneath is pinned while an overlay is open, because a page that
 * cannot scroll cannot send the address bar away in the first place -- and a
 * drag over the video was quietly scrolling the listing behind it anyway.
 *
 * Pinned rather than `overflow: hidden`, which iOS does not honour on the body.
 * The offset is handed back on the way out, so the listing is where it was.
 */
/**
 * Every overlay, once: innermost first -- the order Back unwinds them in, the
 * same order Escape uses on the desktop. The lineup opens over the player and
 * the labels sheet from it, so either closes before the player does. Each says
 * how it closes, since the player and the lineup have more to undo than the
 * hidden attribute.
 */
const OVERLAYS = [
  { sel: '#lineup', close: () => closeLineup() },
  { sel: '#labels', close: () => { $('#labels').hidden = true; } },
  { sel: '#adv', close: () => { $('#adv').hidden = true; } },
  { sel: '#picker', close: () => { $('#picker').hidden = true; } },
  { sel: '#player', close: () => closePlayer() },
];

/** The innermost overlay showing, or null. */
function openOverlay() {
  return OVERLAYS.find(({ sel }) => {
    const el = $(sel);
    return el && !el.hidden;
  }) || null;
}

function overlayOpen() {
  return Boolean(openOverlay());
}

let pinnedAt = null;

// While it is pinned the window sits at zero, so anything that wants to know
// where the listing actually is has to ask for the mark instead.
function pageScrollY() {
  return pinnedAt === null ? window.scrollY : pinnedAt;
}

function syncPagePin() {
  const open = overlayOpen();
  // Whatever opened it, Back now has something to close.
  if (open) armTrap();
  if (open === (pinnedAt !== null)) return; // an overlay over an overlay changes nothing
  if (open) {
    pinnedAt = window.scrollY;
    document.body.style.top = `${-pinnedAt}px`;
    document.body.classList.add('pinned');
  } else {
    const back = pinnedAt;
    pinnedAt = null;
    document.body.classList.remove('pinned');
    document.body.style.top = '';
    window.scrollTo(0, back);
  }
}

// Overlays open and close by their hidden attribute in a dozen places. Watching
// the attribute is one place instead of a dozen, and cannot be forgotten by the
// next one added.
function watchOverlays() {
  const spy = new MutationObserver(syncPagePin);
  for (const { sel } of OVERLAYS) {
    const el = $(sel);
    if (el) spy.observe(el, { attributes: true, attributeFilter: ['hidden'] });
  }
}

// Android's back button should walk the folder trail, not leave the app --
// until there is no trail left to walk, and then it should.
window.addEventListener('popstate', () => {
  trapArmed = false; // this Back just used it
  // Unwind one layer at a time, innermost first, so back never leaves the app
  // while something is still open.
  const top = openOverlay();
  if (top) top.close();
  else if (state.selecting) exitSelection();
  else if (state.stack.length) goUp();
  else return; // the root, nothing open: the next Back leaves
  // Still something under that? Then the next Back is ours too. (goUp pops
  // the stack before its first await, so the length is already the new one.)
  if (overlayOpen() || state.selecting || state.stack.length) armTrap();
});

/**
 * The root of the drive is a home page, not a directory listing: it is the one
 * place where OneDrive's own furniture — Documents, Pictures, an apps folder —
 * sits beside the video libraries. Only the numbered ones belong here, which is
 * the same rule the desktop applies through its homeFolders setting.
 *
 * Matched by name rather than configured, because the phone has no settings file
 * to configure it in and the convention is already the one on disk.
 */
const LIBRARY_FOLDER = /^folder\s*\d+$/i;

function atRoot() {
  return state.stack.length === 0;
}

function isLibraryFolder(folder) {
  return LIBRARY_FOLDER.test(String(folder.name || '').trim());
}

// -------------------------------------------------------------------- render

function render() {
  renderCrumb();
  renderFolders();
  renderVideos();
}

function renderCrumb() {
  const bar = $('#crumb');
  bar.innerHTML = '';

  const up = document.createElement('button');
  up.className = 'crumb-btn';
  up.textContent = '↑';
  up.disabled = !state.stack.length;
  up.addEventListener('click', goUp);
  bar.appendChild(up);

  const home = document.createElement('button');
  home.className = 'crumb';
  home.textContent = 'OneDrive';
  home.addEventListener('click', () => openFolder(null));
  bar.appendChild(home);

  for (const [index, entry] of state.stack.entries()) {
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.textContent = '›';
    bar.appendChild(sep);

    const crumb = document.createElement('button');
    crumb.className = 'crumb' + (index === state.stack.length - 1 ? ' current' : '');
    crumb.textContent = entry.name;
    crumb.addEventListener('click', () => {
      state.stack = state.stack.slice(0, index);
      openFolder(entry);
    });
    bar.appendChild(crumb);
  }
}

function renderFolders() {
  const wrap = $('#folders');
  wrap.innerHTML = ''; // folders are few; rebuilding them costs nothing
  const list = filterByName(state.folders);
  $('#foldersSection').hidden = !list.length;
  $('#folderCount').textContent = `(${list.length})`;

  for (const folder of list) {
    const tile = document.createElement('button');
    tile.className = 'folder';
    tile.addEventListener('click', () => openFolder({
      driveId: folder.driveId, itemId: folder.id, name: folder.name,
    }));

    const icon = document.createElement('span');
    icon.className = 'folder-icon';
    icon.textContent = folder.shared ? '🔗' : '📁';
    tile.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'folder-name';
    name.textContent = folder.name;
    tile.appendChild(name);

    const count = document.createElement('span');
    count.className = 'folder-count';
    count.textContent = folder.childCount ? String(folder.childCount) : '';
    tile.appendChild(count);

    wrap.appendChild(tile);
  }
}

/**
 * The listing as shown, worked out once per change rather than once per ask.
 *
 * A render asks for it, then the player asks on every swipe, arrow, edit and
 * prime -- and each ask was a fresh filter and sort of every video in the
 * folder, twenty-seven thousand flattened. Remembered against everything it
 * depends on: the list (by identity and length, since pages are pushed into
 * it), the search, the filter in force, the sort, whether the listing is still
 * streaming, and the version of the labels. The answer is shared; nothing may
 * mutate it.
 */
let shownMemo = { key: null, list: null, out: null };

function advSignature(f = adv) {
  return JSON.stringify(Object.entries(f).map(([k, v]) => [k, v instanceof Map ? [...v] : v]));
}

function filterByName(list) {
  const streaming = state.loading && moreToLoad();
  const key = list === state.videos
    ? [list.length, state.query, advSignature(), state.sort, state.sortDir, streaming, libVersion].join('\u0001')
    : null;
  if (key !== null && shownMemo.list === list && shownMemo.key === key) return shownMemo.out;
  const out = filterAndSort(list, streaming);
  if (key !== null) shownMemo = { key, list, out };
  return out;
}

function filterAndSort(list, streaming) {
  const terms = state.query.split(/\s+/).filter(Boolean);
  let out = list;
  if (terms.length) {
    out = out.filter((item) => {
      const record = recordFor(item);
      const tags = (record.tags || []).join(' ').toLowerCase();
      const hay = item.name.toLowerCase();
      return terms.every((term) => {
        if (term.startsWith('#')) return tags.includes(term.slice(1));
        // A bare term searches both the name and the tags.
        return hay.includes(term) || tags.includes(term);
      });
    });
  }
  // Folders have no rating or labels, so the advanced filter applies to videos
  // only — a folder row is navigation, not a result.
  if (advActive()) out = out.filter((item) => item.isFolder || matchesAdv(item));
  // While a folder is still streaming in, the order is the order it arrives in.
  //
  // Any other ordering means an arriving page can belong anywhere, which moves
  // the last card and makes appending wrong -- so the grid was thrown away and
  // rebuilt from scratch on every page. Flattening the library under a rating
  // sort is a thousand pages, and so a thousand rebuilds of a grid that ends up
  // thousands of cards long. Sorted once at the end instead, where it costs one.
  if (streaming) return out === list ? list.slice() : out;
  return sortVideos(out);
}

/**
 * Sorts videos, leaving folders where they are — they render in their own
 * section, so ordering them by rating would be meaningless.
 */
/** Which label a sort key reads, and what it reads out of it. */
const LABEL_SORTS = {
  models: (v) => firstAlphabetically(recordFor(v).models),
  tags: (v) => firstAlphabetically(recordFor(v).tags),
};

/**
 * The name a list sorts under: the alphabetically first, taken by comparing
 * rather than by reading element zero, so a record written by hand sorts the
 * same as one the app wrote.
 */
function firstAlphabetically(values) {
  let best = '';
  for (const raw of values || []) {
    const value = String(raw).trim();
    if (!value) continue;
    if (!best || collate(value, best) < 0) best = value;
  }
  return best;
}

/**
 * When this video was last touched — the file itself, or what is known about it,
 * whichever came later. Tagging a video does not change the file, so sorting by
 * date otherwise leaves the work you just did wherever the file happened to sit.
 */
function touchedAt(video) {
  return Math.max(Number(video.mtime) || 0, Number(recordFor(video).updated) || 0);
}

/**
 * What a video sorts by, read once per sort rather than twice per comparison:
 * a sort of n videos compares about n·log n times, and every comparison was
 * looking the record up again.
 */
function sortValue(video, key) {
  if (key === 'mtime') return touchedAt(video);
  if (key === 'rating') return recordFor(video).rating || 0;
  if (LABEL_SORTS[key]) return LABEL_SORTS[key](video);
  if (key === 'folder') return String(video.folderName || '');
  if (key === 'name') return video.name;
  return Number(video[key]) || 0;
}

function sortVideos(list) {
  const dir = state.sortDir === 'asc' ? 1 : -1;
  const key = state.sort;
  const values = new Map();
  for (const item of list) if (!item.isFolder) values.set(item, sortValue(item, key));
  const byName = (a, b) => collate(a.name, b.name);
  return list.slice().sort((a, b) => {
    if (a.isFolder || b.isFolder) return 0;
    const av = values.get(a);
    const bv = values.get(b);
    let cmp;
    if (key === 'name') {
      cmp = collate(av, bv);
    } else if (key === 'mtime') {
      cmp = av - bv;
      if (cmp === 0) return byName(a, b);
    } else if (key === 'rating') {
      cmp = av - bv;
      // Returned unflipped: within one rating band names should read A→Z
      // whichever way the ratings point, or the unrated bulk comes out backwards.
      if (cmp === 0) return byName(a, b);
    } else if (LABEL_SORTS[key]) {
      // By a label: its first value, since a video has one studio but any
      // number of performers. Unlabelled last whichever way the arrow points,
      // like the unrated — reversing should bring the labelled tail up, not a
      // wall of blanks.
      if (!av && !bv) return byName(a, b);
      if (!av) return 1;
      if (!bv) return -1;
      cmp = collate(av, bv);
      if (cmp === 0) return byName(a, b);
    } else if (key === 'folder') {
      // Only meaningful flattened, which is the only time a listing mixes
      // folders — and within one folder it falls back to the name.
      cmp = collate(av, bv);
      if (cmp === 0) return byName(a, b);
    } else {
      cmp = av - bv;
    }
    return cmp * dir;
  });
}

/**
 * The current listing, split into one section per performer.
 *
 * A video with three performers belongs to three sections, so the same card is
 * built three times — that is the view, not a flaw in it: you are looking at
 * each video once per person in it. Videos with nobody named collect at the end
 * rather than being dropped, or switching views would quietly hide part of the
 * listing.
 *
 * Favourites lead, then the Top performers ranking. Ordering by how many videos
 * each has would move a section every time the filter changed.
 */
const GROUP_MODES = ['', 'models', 'suggested'];

/**
 * Which grouping is on, on the button itself.
 *
 * Two groupings behind one control, so the state has to be legible without
 * tapping it: the heart fills for either and turns violet for the suggested
 * one, which is the colour suggestions use everywhere else here.
 */
function syncGroupButton() {
  const btn = $('#groupBtn');
  if (!btn) return;
  btn.classList.toggle('on', Boolean(state.grouped));
  btn.classList.toggle('by-suggested', state.grouped === 'suggested');
  btn.title = {
    '': 'Ungrouped \u2014 tap to group by credited performer',
    models: 'Grouped by credited performer \u2014 tap to group by suggested performer',
    suggested: 'Grouped by suggested performer, from the face index '
      + '\u2014 tap for the plain listing',
  }[state.grouped];
}

/**
 * How sure the recogniser has to be before a suggestion is worth showing.
 *
 * The desktop keeps this in filter.js, which the phone does not load. Same
 * number on purpose: a group here and a suggestion there disagreeing about who
 * might be in a video is the confusing part, not the number itself.
 */
// FACE_FLOOR: shared/facets.js.

function buildModelGroups(list, mode = 'models') {
  const groups = new Map();
  const unnamed = [];
  const guessed = mode === 'suggested';

  for (const video of list) {
    if (video.isFolder) continue;
    const record = recordFor(video);
    // The credited names, or the ones the recogniser put forward. Same view
    // over a different question: who is in this, against who might be.
    //
    // Only the ones at the floor, matching the desktop: a section built from
    // guesses that weak is a performer you cannot act on.
    //
    // Nor anyone turned down for this video: "not her" is an answer, and a
    // section built on a refused guess is the desktop's rule broken here.
    const refused = guessed && record.notModels.length
      ? new Set(record.notModels.map((n) => String(n).toLowerCase())) : null;
    const names = (guessed
      ? facesFor(video).suggested
        .filter((s) => s.score >= FACE_FLOOR && !(refused && refused.has(String(s.name).toLowerCase())))
        .map((s) => s.name)
      : (record.models || [])).map((n) => String(n).trim()).filter(Boolean);
    if (!names.length) { unnamed.push(video); continue; }
    const rating = Math.max(0, Math.min(RATING_MAX, Math.round(Number(record.rating) || 0)));
    for (const name of names) {
      const key = name.toLowerCase();
      let group = groups.get(key);
      if (!group) {
        group = { key, name, files: [], points: 0, good: 0 };
        groups.set(key, group);
      }
      group.files.push(video);
      group.points += STAR_POINTS[rating];
      if (rating >= 8) group.good += 1;
    }
  }

  const { favs } = personIndex(); // once for the pass, not per comparison
  const out = [...groups.values()].sort((a, b) => {
    const fa = favs.has(a.key) ? 0 : 1;
    const fb = favs.has(b.key) ? 0 : 1;
    // Marked first — that is what makes this a favourites view rather than a
    // leaderboard — then the Top performers order among the rest. Ties go to
    // whoever has more well-rated videos, since ten fours and one five score
    // alike, and the name settles the rest so the order never wobbles.
    return fa - fb
      || b.points - a.points
      || b.good - a.good
      || collate(a.name, b.name);
  });
  if (unnamed.length) {
    out.push({
      key: '',
      name: '',
      files: unnamed,
      unnamed: true,
      // Not the same absence: one is nobody credited, the other is nobody the
      // recogniser could name -- which includes every video it has not read.
      label: guessed ? 'Nobody suggested' : 'Nobody named',
    });
  }
  return out;
}

/**
 * One performer's heading: the heart that marks them, their name, what this
 * listing is worth to them, and how many of it is theirs.
 *
 * The heart writes to the library rather than to any video, so it takes effect
 * everywhere at once — including the order of these very sections, which is why
 * it re-renders rather than just recolouring itself.
 */
function buildGroupHead(group) {
  const head = document.createElement('div');
  head.className = 'group-head' + (group.unnamed ? ' unnamed' : '');

  if (!group.unnamed) {
    const marked = isFavouriteModel(group.name);
    const tier = marked ? favouriteTier(group.name) : 0;
    const heart = document.createElement('button');
    heart.className = 'group-fav' + (marked ? ' on' : '');
    heart.textContent = marked ? '\u2665' : '\u2661';
    if (marked) {
      const sup = document.createElement('sup');
      sup.className = 'group-tier';
      sup.textContent = String(tier);
      heart.appendChild(sup);
    }
    heart.setAttribute('aria-label', marked ? `Unmark ${group.name}` : `Mark ${group.name}`);
    heart.title = marked ? `Tier ${tier} \u2014 hold to change the tier` : 'Tap to mark, hold to pick a tier';
    // Hold for a tier, the desktop's 1-5. A press that became a hold must not
    // also land as the tap that toggles.
    let hold = null;
    let held = false;
    const cancelHold = () => { clearTimeout(hold); hold = null; };
    heart.addEventListener('pointerdown', () => {
      held = false;
      cancelHold();
      hold = setTimeout(() => {
        hold = null;
        held = true;
        if (navigator.vibrate) navigator.vibrate(12);
        openTierMenu(heart, group.name);
      }, 480);
    });
    heart.addEventListener('pointerup', cancelHold);
    heart.addEventListener('pointercancel', cancelHold);
    heart.addEventListener('pointerleave', cancelHold);
    heart.addEventListener('contextmenu', (ev) => ev.preventDefault());
    heart.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (held) { held = false; return; }
      const on = toggleFavouriteModel(group.name);
      toast(on ? `${group.name} marked a favourite` : `${group.name} unmarked`, 'ok');
      gridKey = ''; // favourites lead, so this section has moved
      render();
    });
    head.appendChild(heart);
  }

  const name = document.createElement('button');
  name.className = 'group-name';
  name.textContent = group.unnamed ? (group.label || 'Nobody named') : group.name;
  if (!group.unnamed) {
    // Straight to the flat listing for this one performer, the way a chip on a
    // card behaves: grouping is for finding someone, not for working through
    // them.
    name.addEventListener('click', () => filterByLabel('models', group.name));
  }
  head.appendChild(name);

  if (!group.unnamed) {
    const score = document.createElement('span');
    score.className = 'group-score';
    score.textContent = group.points.toLocaleString();
    head.appendChild(score);
  }

  const count = document.createElement('span');
  count.className = 'group-count';
  count.textContent = `${group.files.length} video${group.files.length === 1 ? '' : 's'}`;
  head.appendChild(count);

  return head;
}

// Which folder + filter the grid currently shows, so an extra page can be
// appended instead of rebuilding thousands of cards and re-fetching their
// thumbnails on every arrival.
let gridKey = '';
let gridCount = 0;
let gridTail = ''; // id of the last card appended, so a reorder is noticed

/**
 * How many cards the grid builds before waiting to be scrolled.
 *
 * Nothing is hidden from you: the whole folder is in the listing and the count
 * above says so. This is only about how much of it exists as HTML at once --
 * a flattened library is twenty-seven thousand cards, which on a phone is more
 * memory than the browser will give the page, and every one of them wants a
 * thumbnail fetched over mobile data for a tile nobody has scrolled to.
 */
const GRID_CHUNK = 120;
let gridShown = GRID_CHUNK;
let gridTailWatcher = null;

function syncVideosTail(total) {
  const tail = $('#videosTail');
  if (!tail) return;
  tail.hidden = gridCount >= total;
  if (!gridTailWatcher) {
    gridTailWatcher = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      if (gridCount >= gridShown) {
        gridShown = gridCount + GRID_CHUNK;
        renderVideos();
      }
    }, { rootMargin: '800px 0px' });
    gridTailWatcher.observe(tail);
  }
}

function renderVideos() {
  const wrap = $('#videos');
  const list = filterByName(state.videos);
  // Sort belongs in the key: pages arrive in the server's name order, so any
  // other ordering means a new page can belong anywhere and appending is wrong.
  // The length is deliberately NOT in the key: it changed on every arriving
  // page, so the grid was wiped and rebuilt each time -- thousands of cards
  // re-created, their thumbnails re-fetched, and the page height collapsing
  // under a finger that was scrolling. What actually invalidates the appended
  // cards is a different folder, filter or sort, or the order changing beneath
  // us, and the tail check below catches that.
  const key = state.stack.map((s) => s.itemId).join('/')
    + '|' + state.query + '|' + state.sort + state.sortDir + '|' + state.flatten
    + '|' + state.grouped;
  const tailMoved = gridCount > 0 && (list[gridCount - 1] || {}).id !== gridTail;

  if (key !== gridKey || tailMoved) {
    wrap.innerHTML = '';
    wanted.clear();
    gridKey = key;
    gridCount = 0;
    gridShown = GRID_CHUNK;
  }

  // Never fewer than are already built: an arriving page must not un-draw what
  // is on screen under a finger.
  const upTo = Math.min(list.length, Math.max(gridShown, gridCount));

  if (state.grouped) {
    // Sections cannot be appended to the way a flat tail can: an arriving page
    // can belong to any of them, and can invent a new one that sorts to the
    // top. So grouping rebuilds — which is why it is a view you switch into on
    // a settled listing rather than the mode the app lives in.
    if (gridCount !== upTo) {
      wrap.innerHTML = '';
      wanted.clear();
      state.groups = buildModelGroups(list, state.grouped);
      let drawn = 0;
      for (const group of state.groups) {
        if (drawn >= upTo) break;
        wrap.appendChild(buildGroupHead(group));
        for (const video of group.files) {
          if (drawn >= upTo) break;
          wrap.appendChild(buildCard(video));
          drawn += 1;
        }
      }
      gridCount = drawn;
    }
  } else {
    state.groups = [];
    // Built off-document and attached once, rather than a layout per card.
    const frag = document.createDocumentFragment();
    for (let i = gridCount; i < upTo; i += 1) frag.appendChild(buildCard(list[i]));
    wrap.appendChild(frag);
    gridCount = upTo;
  }
  gridTail = gridCount ? list[gridCount - 1].id : '';
  syncVideosTail(list.length);

  // Grouped, the honest number is cards rather than videos: the same video is
  // on screen once per performer in it, and "12 of 9" would look like a bug.
  const cards = state.grouped
    ? state.groups.reduce((n, g) => n + g.files.length, 0)
    : list.length;
  const noun = state.grouped ? 'card' : 'video';
  $('#videoCount').textContent = list.length
    ? `${cards} ${noun}${cards === 1 ? '' : 's'}`
      + (state.grouped ? ` in ${state.groups.length} section${state.groups.length === 1 ? '' : 's'}` : '')
      + (moreToLoad() ? ' so far' : '')
      // Said, not hidden: a folder the walk gave up on is videos missing from
      // this count, and pull-to-refresh is the way to go back for them.
      + (state.skipped ? ` · ${state.skipped} folder${state.skipped === 1 ? '' : 's'} skipped` : '')
      + (state.offline ? ' · saved copy, offline' : '')
    : (moreToLoad() ? 'Loading…' : 'No videos here');

  // Nothing is left to press: a folder loads all the way through on its own.
  // The button is only there when the run stopped early -- an error, or the
  // network going out mid-folder -- so there is a way to pick it back up.
  const more = $('#loadMore');
  more.hidden = !moreToLoad() || state.loading;
  more.textContent = `Resume loading (${state.videos.length} so far)`;
}

// -------------------------------------------------------------- selection

/**
 * Long-press enters selection mode, then a tap toggles. A phone has no shift-
 * click, and a permanently visible checkbox on every card would compete with
 * the thumbnail for the one thing the grid is for.
 */
function toggleSelect(video, card) {
  if (state.selected.has(video.id)) state.selected.delete(video.id);
  else state.selected.add(video.id);
  card.classList.toggle('picked', state.selected.has(video.id));
  if (!state.selected.size) exitSelection();
  else updateSelectionBar();
}

function enterSelection(video, card) {
  state.selecting = true;
  document.body.classList.add('selecting');
  state.selected.add(video.id);
  card.classList.add('picked');
  // The pointerup that ends this long press would otherwise read as a tap and
  // immediately deselect the card the press just selected.
  card.classList.add('just-picked');
  if (navigator.vibrate) navigator.vibrate(12);
  armTrap(); // Back leaves the selection before anything else
  updateSelectionBar();
}

function exitSelection() {
  state.selecting = false;
  state.selected.clear();
  document.body.classList.remove('selecting');
  for (const el of document.querySelectorAll('.card.picked')) el.classList.remove('picked');
  $('#selectionBar').hidden = true;
}

function selectedVideos() {
  return state.videos.filter((v) => state.selected.has(v.id));
}

function updateSelectionBar() {
  const bar = $('#selectionBar');
  const picked = selectedVideos();
  bar.hidden = !picked.length;
  $('#selCount').textContent = `${picked.length} selected`;

  // A filled rating only when they all agree, so a shared value reads back but
  // a mixed one does not claim otherwise.
  const first = recordFor(picked[0] || {}).rating || 0;
  const uniform = picked.every((v) => (recordFor(v).rating || 0) === first);
  const stars = $('#selStars');
  stars.innerHTML = '';
  // Read out, and a tap opens the labels sheet, whose stars are big enough
  // for a thumb and rate the whole selection the same way.
  stars.appendChild(buildStarDisplay(uniform ? first : 0, tagSelection));
}

function tagSelection() {
  openLabels(selectedVideos());
}

/**
 * Deletes the selection, to the OneDrive recycle bin rather than for good.
 *
 * Named in the confirmation, and one at a time so a failure part-way through
 * says which ones went. The sidecar records go with them: a record keyed to
 * bytes that no longer exist is dead weight in a file that syncs.
 */
async function deleteSelection() {
  const picked = selectedVideos();
  if (!picked.length) return;
  const many = picked.length === 1;
  const asked = window.confirm(many
    ? `Delete "${picked[0].name}"?\n\nIt goes to the OneDrive recycle bin.`
    : `Delete these ${picked.length} videos?\n\nThey go to the OneDrive recycle bin.`);
  if (!asked) return;

  let gone = 0;
  setBusy('Deleting…');
  for (const video of picked) {
    try {
      await graph.deleteItem(video);
      delete state.library.records[graph.recordKey(video)];
      libraryChanged(graph.recordKey(video));
      state.dirty = true;
      state.videos = state.videos.filter((v) => v.id !== video.id);
      state.selected.delete(video.id);
      gone += 1;
    } catch (err) {
      toast(`${video.name}: ${err.message}`, 'err');
      break;
    }
  }
  setBusy('');
  scheduleSave();
  exitSelection();
  gridKey = '';
  render();
  toast(`Deleted ${gone} video${gone === 1 ? '' : 's'}`, 'ok');
}

/**
 * How wide a card is: per-device rather than shared through the sidecar, since a
 * phone and a desktop browser want different answers and the sidecar is for
 * judgements about videos. Only read now -- the screen that set it has gone --
 * so a width chosen back then still applies. The page size it also held is
 * gone: it pinned listings at 200 a page where Graph will serve 999.
 */
const SETTINGS_KEY = 've.settings';

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (Number(saved.cardWidth)) state.cardWidth = Number(saved.cardWidth);
  } catch { /* first run, or storage blocked */ }
  applyCardWidth();
}
function applyCardWidth() {
  document.documentElement.style.setProperty('--card-width', state.cardWidth + 'px');
}
// -------------------------------------------------------------- favourites

/**
 * What a rating is worth to a performer's standing. Each step up the scale is an
 * order of magnitude — a five is worth ten fours, a four ten threes — so no pile
 * of threes adds up to one good video. A two or a one is a verdict against and
 * scores nothing, same as never having rated it.
 */
// Points per rating, unrated to ten stars: STAR_POINTS, shared/facets.js.

/**
 * Favourite performers, beside the records rather than inside them.
 *
 * The same list the desktop keeps, in the same place: a favourite belongs to a
 * person, not to a file, so marking one from the phone shows up on the PC
 * without touching a single video's record.
 */
function favouriteModels() {
  return (state.library.favourites || []).slice();
}

/**
 * The per-performer lookups, built once per version of the labels rather than
 * once per video: the favourites as a Set, the races, the traits and the
 * tiers. The filter asks about every video in the listing, and each ask used
 * to make a fresh Set of every favourite.
 */
let personMemo = { at: -1, lib: null, index: null };

function personIndex() {
  const lib = state.library || {};
  if (personMemo.at === libVersion && personMemo.lib === lib) return personMemo.index;
  const index = {
    favs: new Set((lib.favourites || []).map((n) => String(n).toLowerCase())),
    tiers: lib.favouriteTiers || {},
    races: lib.races || {},
    traits: lib.traits || {},
  };
  personMemo = { at: libVersion, lib, index };
  return index;
}

function isFavouriteModel(name) {
  const key = String(name || '').trim().toLowerCase();
  return !!key && personIndex().favs.has(key);
}

/** A favourite's tier, 1 (the most) to 5; one with none recorded is the default, as on the desktop. */
function favouriteTier(name) {
  const held = Number(personIndex().tiers[String(name || '').trim().toLowerCase()]);
  return TIERS.includes(held) ? held : DEFAULT_TIER;
}

/**
 * Marks or unmarks one performer -- the desktop's setFavouriteModel, kept in
 * step: `tier` places a favourite (left out, it keeps the one it had), and
 * unmarking takes the tier with it, so a name marked again later starts afresh.
 */
function setFavouriteModel(name, on, tier = null) {
  if (!state.libraryLoaded) {
    toast('Labels have not loaded — retrying, give that another tap', 'err');
    readLibrary();
    return false;
  }
  const clean = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!clean) return false;
  const key = clean.toLowerCase();
  // Filter then push, so a second marking cannot duplicate a name.
  const list = favouriteModels().filter((m) => String(m).toLowerCase() !== key);
  if (on) list.push(clean);
  list.sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' }));
  state.library.favourites = list;
  const tiers = { ...(state.library.favouriteTiers || {}) };
  if (on && TIERS.includes(Number(tier))) tiers[key] = Number(tier);
  else if (!on) delete tiers[key];
  state.library.favouriteTiers = tiers;
  libraryChanged();
  state.dirty = true;
  scheduleSave();
  return on;
}

function toggleFavouriteModel(name) {
  return setFavouriteModel(name, !isFavouriteModel(name));
}

/**
 * Tier 1 to 5 for one performer, from a hold on her heart: a small menu by
 * the heart, gone on any tap outside it. Choosing a tier marks her if she was
 * not marked; Unmark is there too, so the hold can do everything the tap can.
 */
function openTierMenu(anchor, name) {
  closeTierMenu();
  const menu = document.createElement('div');
  menu.className = 'tier-menu';
  menu.id = 'tierMenu';
  const marked = isFavouriteModel(name);
  const current = marked ? favouriteTier(name) : 0;
  const pick = (tier) => {
    closeTierMenu();
    setFavouriteModel(name, tier !== null, tier);
    toast(tier === null ? `${name} unmarked` : `${name} — tier ${tier}`, 'ok');
    gridKey = '';
    render();
  };
  for (const tier of TIERS) {
    const btn = document.createElement('button');
    btn.className = 'chip' + (tier === current ? ' on' : '');
    btn.textContent = `Tier ${tier}`;
    btn.addEventListener('click', (ev) => { ev.stopPropagation(); pick(tier); });
    menu.appendChild(btn);
  }
  if (marked) {
    const off = document.createElement('button');
    off.className = 'chip';
    off.textContent = 'Unmark';
    off.addEventListener('click', (ev) => { ev.stopPropagation(); pick(null); });
    menu.appendChild(off);
  }
  document.body.appendChild(menu);
  const box = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, box.left))}px`;
  menu.style.top = `${box.bottom + 6}px`;
  // On the next turn, so the release of this very hold does not close it.
  setTimeout(() => document.addEventListener('pointerdown', tierMenuOutside, true), 0);
}

function tierMenuOutside(ev) {
  const menu = $('#tierMenu');
  if (menu && menu.contains(ev.target)) return;
  closeTierMenu();
}

function closeTierMenu() {
  document.removeEventListener('pointerdown', tierMenuOutside, true);
  const menu = $('#tierMenu');
  if (menu) menu.remove();
}

/**
 * Which videos the ranking counts, by tag. The same Map-of-tag → 'in' | 'out'
 * shape as a facet of the advanced filter, so the chips and cycling are shared,
 * and kept out here so a filter survives closing the panel.
 */


// -------------------------------------------------------- advanced filters

/**
 * Empty maps mean "no constraint", so a fresh filter is transparent rather than
 * matching nothing.
 *
 * A facet is a Map of value to 'in' or 'out' rather than a Set, because
 * "everything by her except the ones tagged solo" is a thing you want to ask
 * and two Sets per facet is the same thing spelled worse.
 */
function newAdvFilter() {
  return {
    tags: new Map(),
    models: new Map(),
    ratings: new Map(),
    // Per facet: "all of these tags" and "any of these performers" is a
    // reasonable pair to ask for. Exclusions are always all-of, since "not
    // this" means not this either way.
    mode: {
      tags: 'all', models: 'all', height: 'all', bust: 'all', body: 'all', race: 'all', favourites: 'all',
    },
    height: new Map(),
    bust: new Map(),
    body: new Map(),
    race: new Map(),
    favourites: new Map(),
    // What the desktop's face recognition made of a video -- one question with
    // four answers, each included or excluded like a chip anywhere else.
    faces: new Map(), // match | nomatch | faceless | unprofiled
  };
}

/**
 * The Faces row: suggestionMatch() was written for it, and was left with no
 * caller when the row came off the panel. Back, as the one face question
 * worth a filter -- which videos still have a suggestion nobody has answered.
 */
const FACE_CHOICES = [
  ['nomatch', 'someone not credited'],
  ['match', 'all suggestions answered'],
  ['faceless', 'no usable face'],
  ['unprofiled', 'not profiled'],
];

/**
 * Included if it matches any included answer, excluded if it matches an
 * excluded one. Exclusion wins, the way it does for tags.
 */
function facesFilterMatch(map, video) {
  if (!map || !map.size) return true;
  let wanted = false;
  let hit = false;
  for (const [value, mode] of map) {
    const is = suggestionMatch(video, value);
    if (mode === 'out' && is) return false;
    if (mode === 'in') { wanted = true; if (is) hit = true; }
  }
  return !wanted || hit;
}

/**
 * Race, as labelled per performer on the desktop -- four answers. Nothing
 * works it out: every video credited to a performer carries hers, so a video
 * has as many races as it has labelled performers.
 */
// RACES: shared/facets.js.

function racesOf(record) {
  return personValues('race', record);
}

/**
 * What belongs to a performer rather than a file -- the desktop labels them,
 * and they live beside the races in the library file. A video carries whatever
 * its credited performers have, so each is matched like a tag list.
 */
// PERSON_FACETS: shared/facets.js (TRAITS, then race, then the tiers).
const PERSON_FIELDS = Object.keys(PERSON_FACETS);

/** One performer facet's values on a video, in that facet's order. */
function personValues(field, record) {
  const { favs, tiers, races, traits } = personIndex();
  const have = new Set();
  for (const raw of record.models || []) {
    const name = String(raw).trim().toLowerCase();
    if (field === 'race') {
      const race = races[name];
      if (race) have.add(race);
    } else if (field === 'favourites') {
      if (favs.has(name)) have.add(`Tier ${TIERS.includes(Number(tiers[name])) ? Number(tiers[name]) : 3}`);
    } else {
      const value = (traits[name] || {})[field];
      for (const v of Array.isArray(value) ? value : (value ? [value] : [])) have.add(v);
    }
  }
  return PERSON_FACETS[field].filter((v) => have.has(v));
}


/**
 * The "no tags" / "no models" chip lives in the same map as the values, under a
 * key no label can have — so it copies, clears and counts for free.
 */
const NOTHING = '\u0000';

const FACETS = ['tags', 'models', 'ratings', 'faces'].concat(PERSON_FIELDS);

let adv = newAdvFilter();
let advDraft = newAdvFilter();

function advActive(f = adv) {
  return FACETS.some((name) => f[name] && f[name].size > 0);
}

/** The values a facet requires, or excludes. The emptiness chip is not a value. */
function picked(facet, want) {
  return [...facet].filter(([value, mode]) => mode === want && value !== NOTHING)
    .map(([value]) => value);
}

/** Everything in use for a field across the whole library, not just this folder. */
/**
 * Both remembered per version of the labels: the labels sheet asks on every
 * keystroke, and each ask walked every record in the library. Shared answers --
 * callers read them and never sort or splice them in place.
 */
const vocabMemo = new Map(); // `${by}:${field}` -> { at, out }

function memoVocab(id, make) {
  const hit = vocabMemo.get(id);
  if (hit && hit.at === libVersion) return hit.out;
  const out = make();
  vocabMemo.set(id, { at: libVersion, out });
  return out;
}

function vocabulary(field = 'tags') {
  return memoVocab(`count:${field}`, () => countVocabulary(field));
}

function countVocabulary(field) {
  const counts = new Map();
  for (const record of Object.values(state.library.records || {})) {
    for (const tag of valuesOf(record, field)) {
      const key = String(tag).toLowerCase();
      const hit = counts.get(key);
      if (hit) hit.count += 1;
      else counts.set(key, { tag, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** The same, alphabetically: a facet is picked by looking a word up. */
function vocabularyByName(field) {
  // A copy to sort: vocabulary()'s own answer is shared, in count order.
  return memoVocab(`name:${field}`, () => vocabulary(field).slice().sort((a, b) => collate(a.tag, b.tag)));
}

/**
 * Does this video match that filter?
 *
 * Takes the filter rather than reading the one in force, so the panel can ask
 * about its draft before it is applied.
 */
function matchesFilter(video, f) {
  const record = recordFor(video);

  if (f.ratings.size) {
    const rating = record.rating || 0;
    const wanted = picked(f.ratings, 'in');
    const barred = picked(f.ratings, 'out');
    if (wanted.length && !wanted.includes(rating)) return false;
    if (barred.includes(rating)) return false;
  }

  if (!facesFilterMatch(f.faces, video)) return false;

  for (const field of PERSON_FIELDS.concat(['tags', 'models'])) {
    if (!f[field] || !f[field].size) continue;
    const held = PERSON_FACETS[field] ? personValues(field, record) : valuesOf(record, field);
    const have = new Set(held.map((t) => String(t).toLowerCase()));

    // "Has none at all" is its own question, asked before any value is compared.
    const nothing = f[field].get(NOTHING);
    if (nothing === 'in' && have.size) return false;
    if (nothing === 'out' && !have.size) return false;

    const wanted = picked(f[field], 'in').map((t) => t.toLowerCase());
    const barred = picked(f[field], 'out').map((t) => t.toLowerCase());
    const mode = (f.mode || {})[field] || 'all';
    if (wanted.length) {
      const hit = mode === 'any'
        ? wanted.some((t) => have.has(t))
        : wanted.every((t) => have.has(t));
      if (!hit) return false;
    }
    if (barred.some((t) => have.has(t))) return false;
  }

  // Folder selection is handled by loading those folders' videos, not by
  // filtering — there is nothing to filter until they have been fetched.
  return true;
}

function matchesAdv(video) {
  return matchesFilter(video, adv);
}

function openAdv() {
  // Every Map copied, not listed by hand. The draft has to be editable without
  // touching the filter in force -- closing the sheet has to mean cancel -- and
  // a list of facets to clone goes stale the moment a new one is added.
  advDraft = { ...adv, mode: { ...adv.mode } };
  for (const [key, value] of Object.entries(adv)) {
    if (value instanceof Map) advDraft[key] = new Map(value);
  }
  $('#adv').hidden = false;
  renderAdv();
}

/** The performer rows: facet, host, its "none" chip, and its all/any button. */
const PERSON_ROWS = [
  ['height', '#advHeight', 'no height', '#advHeightMode'],
  ['bust', '#advBust', 'no bust', '#advBustMode'],
  ['body', '#advBody', 'no body', '#advBodyMode'],
  ['race', '#advRace', 'no race', '#advRaceMode'],
  ['favourites', '#advFavourites', 'no favourite', '#advFavouritesMode'],
];

/** A performer row: its answers and a "none" chip, cycling as tags do. */
function renderPersonRow(host, values, facet, none, redraw) {
  if (!host) return;
  host.innerHTML = '';
  for (const value of values) {
    host.appendChild(advChip(value, facet.get(value), () => { cycleIn(facet, value); redraw(); }));
  }
  const gap = advChip(none, facet.get(NOTHING), () => { cycleIn(facet, NOTHING); redraw(); });
  gap.classList.add('none');
  host.appendChild(gap);
}

function renderAdv() {
  for (const [field, host, none] of PERSON_ROWS) {
    renderPersonRow($(host), PERSON_FACETS[field], advDraft[field], none, () => renderAdv());
  }
  // Only offered once the desktop has profiled something: on a library where
  // the feature has never run, every video would give the same answer.
  const facesRow = $('#advFacesRow');
  if (facesRow) {
    facesRow.hidden = !state.faces;
    const host = $('#advFaces');
    host.innerHTML = '';
    for (const [value, label] of FACE_CHOICES) {
      host.appendChild(advChip(label, advDraft.faces.get(value), () => {
        cycleIn(advDraft.faces, value);
        renderAdv();
      }));
    }
  }

  const ratings = $('#advRating');
  ratings.innerHTML = '';
  for (const value of RATING_VALUES) {
    ratings.appendChild(advChip(
      ratingChipLabel(value),
      advDraft.ratings.get(value),
      () => { cycleIn(advDraft.ratings, value); renderAdv(); },
    ));
  }

  // No model gold in here: this panel paints green for "required" and red for
  // "excluded", so an unselected chip in its own colour reads as one that has
  // been chosen. The label colours belong on a card, where nothing else is
  // coloured.
  for (const [field, box, none] of [
    ['models', '#advModels', 'no models'],
    ['tags', '#advTags', 'no tags'],
  ]) {
    const host = $(box);
    host.innerHTML = '';

    // First, because "which of these have none" is a question about the whole
    // listing rather than one more value in it.
    const gap = advChip(none, advDraft[field].get(NOTHING), () => {
      cycleIn(advDraft[field], NOTHING);
      renderAdv();
    });
    gap.classList.add('none');
    host.appendChild(gap);

    // Five thousand performers is a list with no end on a phone. Only the names
    // you have picked are shown; the rest are found through the box below.
    if (field === 'models') {
      const counts = new Map(vocabularyByName('models').map((e) => [e.tag, e.count]));
      for (const [name, mode] of advDraft.models) {
        if (name === NOTHING) continue;
        const n = counts.get(name);
        host.appendChild(advChip(n ? `${name} · ${n}` : name, mode, () => {
          cycleIn(advDraft.models, name);
          renderAdv();
        }));
      }
      renderAdvModelsFound();
      continue;
    }

    const vocab = vocabularyByName(field);
    if (!vocab.length) host.insertAdjacentHTML('beforeend', '<span class="dim">nothing yet</span>');
    for (const entry of vocab) {
      const chip = advChip(`${entry.tag} · ${entry.count}`, advDraft[field].get(entry.tag), () => {
        cycleIn(advDraft[field], entry.tag);
        renderAdv();
      });
      host.appendChild(chip);
    }
  }


  $('#advTagMode').textContent = advDraft.mode.tags;
  $('#advModelMode').textContent = advDraft.mode.models;
  for (const [field, , , modeId] of PERSON_ROWS) {
    $(modeId).textContent = advDraft.mode[field] || 'all';
  }

  const bits = [];
  const say = (field, one, many = one + 's') => {
    const inn = picked(advDraft[field], 'in').length;
    const out = picked(advDraft[field], 'out').length;
    if (inn) bits.push(`${inn} ${inn === 1 ? one : many}`);
    if (out) bits.push(`without ${out} ${out === 1 ? one : many}`);
    const nothing = advDraft[field].get(NOTHING);
    if (nothing === 'in') bits.push(`no ${many} at all`);
    if (nothing === 'out') bits.push(`some ${many}`);
  };
  say('height', 'height', 'heights');
  say('bust', 'bust', 'busts');
  say('body', 'body type', 'body types');
  say('race', 'race', 'races');
  say('favourites', 'favourite tier', 'favourite tiers');
  say('models', 'model');
  say('ratings', 'rating');
  say('faces', 'face answer');
  say('tags', 'tag');
  $('#advSummary').textContent = bits.join(' · ') || 'no filters';
}

/**
 * What the model search box has found. Nothing until two letters are typed:
 * one letter matches thousands and would bring the endless list straight back.
 * Tapping a match requires it and empties the box, ready for the next name.
 */
function renderAdvModelsFound() {
  const host = $('#advModelsFound');
  const box = $('#advModelsFind');
  if (!host || !box) return;
  host.innerHTML = '';
  const want = box.value.trim().toLowerCase();
  if (want.length < 2) return;
  const found = vocabularyByName('models')
    .filter((e) => !advDraft.models.has(e.tag) && e.tag.toLowerCase().includes(want));
  if (!found.length) { host.innerHTML = '<span class="dim">no one by that name</span>'; return; }
  for (const entry of found) {
    host.appendChild(advChip(`${entry.tag} · ${entry.count}`, null, () => {
      advDraft.models.set(entry.tag, 'in');
      box.value = '';
      renderAdv();
    }));
  }
}

function advChip(label, mode, onClick) {
  const chip = document.createElement('button');
  chip.className = 'chip tri' + (mode === 'in' ? ' in' : mode === 'out' ? ' out' : '');
  if (typeof label === 'string') chip.textContent = label;
  else chip.appendChild(label);
  chip.addEventListener('click', onClick);
  return chip;
}

/** Off, then required, then excluded, then off again. */
function cycleIn(facet, value) {
  const now = facet.get(value);
  if (!now) facet.set(value, 'in');
  else if (now === 'in') facet.set(value, 'out');
  else facet.delete(value);
}

function applyAdv() {
  adv = advDraft;
  $('#adv').hidden = true;
  $('#advDot').hidden = !advActive();
  $('#advBtn').classList.toggle('on', advActive());
  gridKey = '';
  render();
}

/**
 * Clears every facet and means it, rather than leaving Apply to be pressed —
 * which is what the desktop does, and for the same reason: saying "show me
 * everything" should not take two taps.
 */
function resetAdv() {
  advDraft = newAdvFilter();
  renderAdv();
  applyAdv();
}

/**
 * Tapping a pill on a card is a filter, not a search: exactly that one value in
 * its own facet, with everything else cleared. It used to type `#tag` into the
 * search box, which left the filter panel describing something else.
 */
function filterByLabel(field, value) {
  // Its own facet is replaced; the others stay. A race pill tapped under a
  // rating filter means those, of that race -- not a fresh start.
  const next = { ...adv, mode: { ...adv.mode } };
  for (const [key, held] of Object.entries(adv)) {
    if (held instanceof Map) next[key] = new Map(held);
  }
  if (!next[field]) next[field] = new Map();
  next[field].clear();
  next[field].set(value, 'in');
  adv = next;
  advDraft = newAdvFilter();
  $('#search').value = '';
  state.query = '';
  $('#advDot').hidden = !advActive();
  $('#advBtn').classList.toggle('on', advActive());
  gridKey = '';
  render();
  toast(`${value} — ${filterByName(state.videos).length} here`, 'ok');
}

// ------------------------------------------------------------ move picker

const picker = { stack: [], folders: [], loading: false };

function openMovePicker() {
  if (!state.selected.size) return;
  // Start where you already are. A destination is nearly always a sibling or a
  // subfolder of the folder you are looking at, so opening at the drive root
  // meant retracing the whole path you had just walked.
  picker.stack = state.stack.slice();
  $('#pickerTitle').textContent = `Move ${state.selected.size} video${state.selected.size === 1 ? '' : 's'} to…`;
  $('#picker').hidden = false;
  loadPickerFolders(pickerDestination());
}

async function loadPickerFolders(entry) {
  picker.loading = true;
  $('#pickerList').innerHTML = '<div class="dim pad">Loading…</div>';
  renderPicker();
  try {
    picker.folders = await graph.listFolders(
      entry ? entry.driveId : null,
      entry ? entry.itemId : null,
    );
  } catch (err) {
    picker.folders = [];
    toast(err.message, 'err');
  }
  picker.loading = false;
  renderPicker();
}

function pickerDestination() {
  return picker.stack[picker.stack.length - 1] || null;
}

function renderPicker() {
  const crumb = $('#pickerCrumb');
  crumb.innerHTML = '';

  const root = document.createElement('button');
  root.className = 'crumb';
  root.textContent = 'OneDrive';
  root.addEventListener('click', () => { picker.stack = []; loadPickerFolders(null); });
  crumb.appendChild(root);

  for (const [index, entry] of picker.stack.entries()) {
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.textContent = '›';
    crumb.appendChild(sep);
    const btn = document.createElement('button');
    btn.className = 'crumb' + (index === picker.stack.length - 1 ? ' current' : '');
    btn.textContent = entry.name;
    btn.addEventListener('click', () => {
      picker.stack = picker.stack.slice(0, index + 1);
      loadPickerFolders(entry);
    });
    crumb.appendChild(btn);
  }

  const dest = pickerDestination();
  const here = state.stack[state.stack.length - 1] || null;
  // Since the picker now opens on the current folder, its own folder is the
  // first thing offered — and moving files into the folder they are already in
  // is the one destination that can never be meant.
  const sameFolder = Boolean(dest && here && dest.itemId === here.itemId)
    || (!dest && !here);

  $('#pickerWhere').textContent = sameFolder
    ? 'already here — pick another folder'
    : (dest ? dest.name : 'OneDrive root');
  $('#pickerConfirm').disabled = picker.loading || sameFolder;

  if (picker.loading) return;
  const list = $('#pickerList');
  list.innerHTML = '';
  if (!picker.folders.length) {
    list.innerHTML = '<div class="dim pad">No subfolders here</div>';
    return;
  }
  for (const folder of picker.folders) {
    const tile = document.createElement('button');
    tile.className = 'folder';
    tile.innerHTML = '<span class="folder-icon">📁</span>';
    const name = document.createElement('span');
    name.className = 'folder-name';
    name.textContent = folder.name;
    tile.appendChild(name);
    tile.addEventListener('click', () => {
      const entry = { driveId: folder.driveId, itemId: folder.id, name: folder.name };
      picker.stack.push(entry);
      loadPickerFolders(entry);
    });
    list.appendChild(tile);
  }
}

async function confirmMove() {
  const dest = pickerDestination();
  if (!dest) { toast('Pick a folder first', 'err'); return; }

  const moving = selectedVideos();
  $('#picker').hidden = true;
  setBusy(`Moving ${moving.length}…`);

  const failed = [];
  let moved = 0;
  for (const video of moving) {
    try {
      await graph.moveItem(video, dest);
      moved += 1;
      state.videos = state.videos.filter((v) => v.id !== video.id);
    } catch (err) {
      failed.push(`${video.name}: ${err.message}`);
    }
  }

  setBusy('');
  exitSelection();
  gridKey = ''; // the grid shrank, so it has to be rebuilt rather than appended
  render();

  // Undo puts each one back where it came from -- the parent Graph reported
  // when it was listed. Within one drive by construction: it just came from there.
  const undoable = moving.filter((v) => v.parentId
    && !failed.some((f) => f.startsWith(`${v.name}:`)));
  if (moved) {
    toast(`Moved ${moved} to ${dest.name}`, 'ok', undoable.length ? {
      label: 'Undo',
      run: async () => {
        setBusy('Putting them back…');
        let back = 0;
        for (const video of undoable) {
          try {
            await graph.moveItem({ ...video, driveId: video.driveId }, {
              driveId: video.driveId, itemId: video.parentId,
            });
            back += 1;
          } catch { /* it stays where it was moved; the toast below says so */ }
        }
        setBusy('');
        toast(back === undoable.length
          ? `Put ${back} back`
          : `Put ${back} of ${undoable.length} back`, back ? 'ok' : 'err');
        const here = state.stack[state.stack.length - 1] || null;
        openFolder(here, { push: false });
      },
    } : null);
  }
  if (failed.length) toast(`${failed.length} failed — ${failed[0]}`, 'err');
}

function buildCard(video) {
  const card = document.createElement('article');
  card.className = 'card' + (state.selected.has(video.id) ? ' picked' : '');

  const shot = document.createElement('div');
  shot.className = 'shot';
  shot.dataset.id = video.id;
  shot.dataset.drive = video.driveId;
  const cached = thumbCache.get(video.id);
  if (cached) shot.style.backgroundImage = `url("${cached}")`;
  else wantThumb(shot);

  const scrubHint = document.createElement('div');
  scrubHint.className = 'scrub-hint';
  scrubHint.textContent = 'drag to scrub';
  shot.appendChild(scrubHint);

  const badge = document.createElement('span');
  badge.className = 'badge';
  // Duration comes free from Graph's video facet, so it leads and size follows.
  badge.textContent = video.duration ? fmtTime(video.duration) : fmtBytes(video.size);
  shot.appendChild(badge);

  const play = document.createElement('button');
  play.className = 'play';
  play.textContent = '▶';
  play.addEventListener('click', (ev) => { ev.stopPropagation(); openPlayer(video); });
  shot.appendChild(play);

  const tick = document.createElement('span');
  tick.className = 'tick';
  tick.textContent = '✓';
  shot.appendChild(tick);

  attachScrub(shot, video);
  attachSelection(shot, card, video);
  card.appendChild(shot);

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = video.name;
  card.appendChild(name);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = [
    video.width ? `${video.width}×${video.height}` : '',
    fmtBytes(video.size),
    video.bitrate ? `${Math.round(video.bitrate / 1000)} kbps` : '',
  ].filter(Boolean).join('  ·  ');
  card.appendChild(meta);

  card.appendChild(buildRecordRow(video));
  const line = buildFolderLine(video);
  if (line) card.appendChild(line);
  return card;
}

/**
 * The kinds of label a card shows, in the order the desktop shows them: the
 * performers, then the tags. Studio and production were taken out of the app;
 * what is stored under them is kept, just no longer drawn or edited.
 */
const LABEL_FIELDS = [
  { field: 'models', chip: 'chip model' },
  { field: 'tags', chip: 'chip' },
];

/**
 * The colour Settings on the desktop gave a chip, or '' for the default: a tag
 * by its own name, a performer by the one colour all performers share.
 */
function chipColour(field, value) {
  const colours = state.colours || {};
  if (field === 'tags') return (colours.labels || {})[String(value).toLowerCase()] || '';
  return (colours.facets || {})[field] || '';
}

function paintChip(el, field, value) {
  const colour = chipColour(field, value);
  if (colour) el.style.setProperty('--chip-colour', colour);
  return el;
}

function buildLabelChips(video, row) {
  const record = recordFor(video);
  const chips = document.createElement('span');
  chips.className = 'chips';

  // Models, then tags. Race is not shown, in the player or on a card: it
  // belongs to a person, and is filtered from the advanced filters.

  for (const spec of LABEL_FIELDS) {
    for (const value of valuesOf(record, spec.field)) {
      const chip = document.createElement('button');
      chip.className = spec.chip;
      paintChip(chip, spec.field, value);
      chip.textContent = value;
      chip.title = value;
      chip.addEventListener('click', (ev) => {
        ev.stopPropagation();
        filterByLabel(spec.field, value);
      });
      chips.appendChild(chip);
    }
  }

  // No add-a-label chip here any more. Labelling is a deliberate act and the
  // selection bar is where it lives: long-press to select, then Tags. A dashed
  // "+ tag" on every card in a grid of hundreds is a target you hit by
  // accident far more often than on purpose.
  return chips;
}

/**
 * Which folder a card came out of, and nothing else.
 *
 * The date and the source hostname used to ride along here. Neither is what you
 * come to a listing to find out, and on the player the folder is already in the
 * meta row above -- so the player does not call this at all now, and the line is
 * a card-only affordance for the one question a flattened listing raises: which
 * of the mixed-together subfolders is this one from.
 */
function buildFolderLine(video) {
  // Nothing to say: no row rather than an empty one holding space open.
  if (!video.folderName) return null;

  const line = document.createElement('div');
  line.className = 'folder-line';

  const where = document.createElement('span');
  where.className = 'folder-where';
  where.textContent = video.folderName;
  line.appendChild(where);

  return line;
}

/**
 * One sheet for every label, over one video or a selection.
 *
 * It replaces two window.prompt calls — one for a card, one for the selection
 * bar — which between them could only edit tags, and could not show you what
 * vocabulary already existed. Add merges, Replace overwrites, exactly as on the
 * desktop; the studio is a single value, so Add only sets it when the box has
 * something in it.
 */
let labelTargets = [];

/** The rating the sheet will save; null means leave each video's alone. */
let labelRating = null;

function renderLabelRating() {
  const box = $('#labelRating');
  if (!box) return;
  box.innerHTML = '';
  box.appendChild(buildStarRow(labelRating || 0, (n) => {
    labelRating = n;
    renderLabelRating();
  }));
  if (labelRating === null) box.insertAdjacentHTML('beforeend', '<span class="dim">unchanged</span>');
}

function openLabels(videos) {
  if (!videos.length) return;
  labelTargets = videos;
  const single = videos.length === 1;

  $('#labelsTitle').textContent = single ? videos[0].name : `${videos.length} videos`;
  $('#labelsHint').textContent = single
    ? 'Add appends. Replace saves exactly these.'
    : `Add appends to each. Replace overwrites all ${videos.length}.`;
  $('#labelsReplace').textContent = single ? 'Replace' : `Replace on ${videos.length}`;

  // One video's values make Replace a sensible edit; across several there is no
  // shared starting point unless they already agree.
  const first = recordFor(videos[0]);
  labelDraft.tags = single ? [...(first.tags || [])] : [];
  labelDraft.models = single ? [...(first.models || [])] : [];
  $('#labelTags').value = '';
  $('#labelModels').value = '';
  labelRating = single ? (Number(first.rating) || 0) : null;
  renderLabelRating();

  renderLabelSuggestions();
  $('#labels').hidden = false;
}

const LABEL_INPUTS = {
  models: { input: '#labelModels', suggest: '#labelModelsSuggest', picked: '#labelModelsPicked', chip: 'chip model' },
  tags: { input: '#labelTags', suggest: '#labelTagsSuggest', picked: '#labelTagsPicked', chip: 'chip' },
};

/**
 * What the sheet will save, per field, as a list. The box used to hold it as
 * comma-separated text, which left every pick sitting there as words; now the
 * picks are pills with a cross and the box only finds the next one.
 */
const labelDraft = { tags: [], models: [] };

function draftAdd(field, raw) {
  const value = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!value) return false;
  const known = vocabularyByName(field).find((e) => e.tag.toLowerCase() === value.toLowerCase());
  const name = known ? known.tag : value;
  if (labelDraft[field].some((t) => t.toLowerCase() === name.toLowerCase())) return false;
  labelDraft[field].push(name);
  return true;
}

function parseList(text) {
  return text.split(',').map((t) => t.trim()).filter(Boolean);
}

/** The vocabulary as taps, which beats typing a name on a phone. */
function renderLabelSuggestions() {
  for (const [field, spec] of Object.entries(LABEL_INPUTS)) {
    // The pills: what will be saved, each with its own cross.
    const pills = $(spec.picked);
    pills.innerHTML = '';
    for (const name of labelDraft[field]) {
      const pill = document.createElement('span');
      pill.className = spec.chip + ' has-x';
      paintChip(pill, field, name);
      const text = document.createElement('span');
      text.className = 'chip-text';
      text.textContent = name;
      const cross = document.createElement('button');
      cross.className = 'chip-x';
      cross.textContent = '\u2715';
      cross.setAttribute('aria-label', `Take off ${name}`);
      cross.addEventListener('click', () => {
        labelDraft[field] = labelDraft[field].filter((t) => t.toLowerCase() !== name.toLowerCase());
        renderLabelSuggestions();
      });
      pill.append(text, cross);
      pills.appendChild(pill);
    }
    pills.hidden = !labelDraft[field].length;

    const box = $(spec.suggest);
    box.innerHTML = '';
    const vocab = vocabularyByName(field);
    const want = $(spec.input).value.trim().toLowerCase();
    const used = new Set(labelDraft[field].map((t) => t.toLowerCase()));
    const found = vocab.filter((entry) => !used.has(entry.tag.toLowerCase())
      && (!want || entry.tag.toLowerCase().includes(want)));
    // Performers are found by typing; with nothing typed, no list at all.
    if (field === 'models' && !want) { box.hidden = true; continue; }
    box.hidden = false;
    if (!found.length) {
      box.innerHTML = want
        ? '<span class="dim">nothing by that name \u2014 tap enter to add it</span>'
        : '<span class="dim">nothing yet</span>';
      continue;
    }
    // Typing narrows to every match. With nothing typed, a first 60 to tap
    // from: the whole performer list on a phone is a scroll with no end.
    for (const entry of want ? found : found.slice(0, 60)) {
      const chip = document.createElement('button');
      chip.className = spec.chip;
      paintChip(chip, field, entry.tag);
      chip.textContent = `${entry.tag} · ${entry.count}`;
      chip.addEventListener('click', () => {
        draftAdd(field, entry.tag);
        $(spec.input).value = '';
        renderLabelSuggestions();
      });
      box.appendChild(chip);
    }
  }
}

/**
 * An edit can take the open video out of the listing — rating it while looking
 * at the unrated. That edit is you finishing with it, so the player follows the
 * listing rather than sitting on something no longer in it.
 */
function followListing(before) {
  if ($('#player').hidden || !state.playingId) return;
  const list = playerList();
  if (list.some((v) => v.id === state.playingId)) return;
  if (!list.length) { closePlayer(); return; }
  const at = before.findIndex((v) => v.id === state.playingId);
  // Forwards, and shown: this move is the app's doing rather than a gesture, so
  // it needs the cue more than a swipe does, not less.
  goToVideo(list[Math.min(at < 0 ? 0 : at, list.length - 1)], 1);
}

function commitLabels(mode) {
  // A name typed but not yet entered still counts.
  for (const spec of Object.values(LABEL_INPUTS)) {
    const field = spec.input === '#labelTags' ? 'tags' : 'models';
    if (draftAdd(field, $(spec.input).value)) $(spec.input).value = '';
  }
  const tags = [...labelDraft.tags];
  const models = [...labelDraft.models];
  const videos = labelTargets;
  $('#labels').hidden = true;

  const rating = labelRating === null ? {} : { rating: labelRating };
  for (const video of videos) {
    const record = recordFor(video);
    const patch = mode === 'replace'
      ? { tags, models, ...rating }
      : {
        tags: [...(record.tags || []), ...tags],
        models: [...(record.models || []), ...models],
        ...rating,
      };
    editRecord(video, patch);
  }

  const before = playerList();
  render();
  // The player's own row shows what was just saved, rather than what was
  // there when it opened.
  const open = !$('#player').hidden && videos.find((v) => v.id === state.playingId);
  if (open) renderPlayerDetails(open);
  followListing(before);
  const n = videos.length;
  toast(mode === 'replace'
    ? `Labels set on ${n} video${n === 1 ? '' : 's'}`
    : `Added to ${n} video${n === 1 ? '' : 's'}`, 'ok');
}

/**
 * Who the face recognition thinks is in this video, and a tap to credit her.
 *
 * Never applied on its own — the desktop's rule, kept here: a suggestion is an
 * opinion, and putting a name on a video is yours to do.
 *
 * Only names that are not on it yet. The recogniser still ranks a performer who
 * is already credited and still agrees with the label; that agreement is just
 * not a recommendation, and it was a chip that could not be tapped sitting in a
 * row where every other one can be. With nothing left to offer there is no row.
 */
function buildSuggestions(video) {
  const { profiled, suggested: ranked } = facesFor(video);
  if (!state.faces || !profiled || !ranked.length) return null;

  const record = recordFor(video);
  const named = new Set((record.models || []).map((m) => m.toLowerCase()));
  // Nor the names turned down for this video, here or on the desktop: "not
  // her" was the answer, and asking again is what the list exists to stop.
  const refused = new Set((record.notModels || []).map((m) => String(m).toLowerCase()));
  const suggested = ranked.filter((s) => {
    const key = String(s.name).toLowerCase();
    return !named.has(key) && !refused.has(key);
  });
  if (!suggested.length) return null;

  const row = document.createElement('div');
  row.className = 'suggests';

  const lead = document.createElement('span');
  lead.className = 'suggests-lead';
  lead.textContent = named.size ? 'Also looks like' : 'Looks like';
  row.appendChild(lead);

  for (const one of suggested) {
    const wrap = document.createElement('span');
    wrap.className = 'face-pair';

    // The crop the match was made from, and a tap on it opens the rest of her.
    const look = document.createElement('button');
    look.className = 'face-look';
    look.title = `Other faces of ${one.name}`;
    const img = document.createElement('img');
    img.alt = '';
    paintCrop(img, graph.recordKey(video), one.person || 0);
    look.appendChild(img);
    look.addEventListener('click', (ev) => { ev.stopPropagation(); openLineup(one.name); });
    wrap.appendChild(look);

    // Always a plus: every chip here is a name not on the video yet.
    const chip = document.createElement('button');
    chip.className = `chip face band-${one.band || 'maybe'}`;
    chip.textContent = `${one.name} ${Math.round((one.score || 0) * 100)}% +`;
    chip.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const before = playerList();
      editRecord(video, { models: [...(recordFor(video).models || []), one.name] });
      // Redraw for whatever is open now, which an edit that filters the
      // listing may already have changed.
      const open = playerList().find((v) => v.id === state.playingId);
      if (open) renderPlayerDetails(open);
      if (advActive()) { render(); followListing(before); }
      toast(`${one.name} added`, 'ok');
    });
    wrap.appendChild(chip);

    // And the other answer: not her. Written to notModels, the desktop's own
    // list, so the PC stops offering the name for this video as well.
    const no = document.createElement('button');
    no.className = 'face-no';
    no.textContent = '✕';
    no.title = `Not ${one.name}`;
    no.setAttribute('aria-label', `Not ${one.name}`);
    no.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (!state.libraryLoaded) { editRecord(video, {}); return; } // says why, and retries
      const before = playerList();
      editRecord(video, { notModels: [...(recordFor(video).notModels || []), one.name] });
      const open = playerList().find((v) => v.id === state.playingId);
      if (open) renderPlayerDetails(open);
      if (advActive()) { render(); followListing(before); }
      toast(`${one.name} turned down`, 'ok', {
        label: 'Undo',
        run: () => {
          const lower = String(one.name).toLowerCase();
          editRecord(video, {
            notModels: (recordFor(video).notModels || []).filter((n) => String(n).toLowerCase() !== lower),
          });
          const still = playerList().find((v) => v.id === state.playingId);
          if (still) renderPlayerDetails(still);
          if (advActive()) render();
        },
      });
    });
    wrap.appendChild(no);
    row.appendChild(wrap);
  }
  return row;
}

/**
 * Her other faces, so a name can be checked rather than taken on trust.
 *
 * The ordering is the desktop's and comes precomputed: every one of her vectors
 * against every other, most like the rest of her first. That is not something
 * the phone could work out — the vectors are deliberately not published — so
 * lineups.json carries the conclusion, and the crops it names come straight out
 * of the sync root.
 *
 * The odd ones stay in the list and are marked rather than hidden. They are part
 * of what the match was made against, and dropping them would make a nicer
 * picture of a less honest answer.
 */
let lineups = null;

async function openLineup(name) {
  const box = $('#lineup');
  $('#lineupTitle').textContent = name;
  $('#lineupHint').textContent = 'Loading…';
  $('#lineupGrid').innerHTML = '';
  box.hidden = false;

  if (!lineups) {
    try {
      lineups = await graph.veJson('faces/lineups.json') || { performers: {} };
    } catch {
      lineups = { performers: {} };
    }
  }

  const found = lineups.performers[name]
    || lineups.performers[Object.keys(lineups.performers)
      .find((n) => n.toLowerCase() === name.toLowerCase()) || ''];
  if (!found) {
    $('#lineupHint').textContent = `Nothing stored for ${name} yet — `
      + 'the desktop needs three of her videos read before it can average her.';
    return;
  }

  const apart = Number(lineups.apart) || 0.3;
  $('#lineupHint').textContent = `${found.contributing} of ${found.total} videos build her average`
    + (found.odd ? ` · ${found.odd} look like someone else` : '');

  const grid = $('#lineupGrid');
  for (const face of found.faces) {
    const cell = document.createElement('figure');
    cell.className = 'face-cell'
      + (face.agrees !== null && face.agrees < apart ? ' odd' : '');

    const img = document.createElement('img');
    img.alt = '';
    paintCrop(img, face.key, 0);
    cell.appendChild(img);

    const cap = document.createElement('figcaption');
    cap.textContent = face.agrees === null ? '—' : `${Math.round(face.agrees * 100)}%`;
    cap.title = face.name || '';
    cell.appendChild(cap);
    grid.appendChild(cell);
  }
}

function closeLineup() {
  $('#lineup').hidden = true;
}

function buildRecordRow(video, { add = false } = {}) {
  const record = recordFor(video);
  const row = document.createElement('div');
  // `add` is only ever set by the player, which is also where race shows.
  row.className = 'record' + (add ? ' in-player' : '');

  // Pressable only in the player. On a card they say what the rating is;
  // rating is the player's, or the labels sheet's for a selection.
  row.appendChild(add
    ? buildStarRow(record.rating || 0, (rating) => {
      const before = playerList();
      editRecord(video, { rating });
      row.replaceWith(buildRecordRow(video, { add }));
      if (advActive()) { render(); followListing(before); }
    })
    : buildStarDisplay(record.rating || 0));

  const chips = buildLabelChips(video, row);
  // Only in the player: there you are looking at one video and naming it is
  // the obvious next thing. On a card in a grid of hundreds it was a target
  // hit by accident far more than on purpose, which is why it went.
  if (add) {
    const plus = document.createElement('button');
    plus.className = 'chip chip-add';
    plus.textContent = '+';
    plus.title = 'Models, tags and rating';
    plus.addEventListener('click', (ev) => { ev.stopPropagation(); openLabels([video]); });
    chips.appendChild(plus);
  }
  row.appendChild(chips);
  return row;
}

// ---------------------------------------------------------------- scrubbing

/**
 * The desktop hovers; a phone has no hover, so dragging across the thumbnail
 * scrubs it. Position maps straight to time, which beats a timed slideshow on
 * touch — your finger is already the timeline.
 *
 * The stream URL is fetched on the first drag, not with the listing: a folder
 * of 200 videos would otherwise cost 200 Graph calls to show one screen.
 */
function attachScrub(shot, video) {
  const hint = () => shot.querySelector('.scrub-hint');

  // A finger that has landed but not yet said what it wants. Touch has to
  // declare itself: until it moves there is no telling a scrub from a page
  // scroll, and claiming the gesture on contact is what made a screen of
  // thumbnails a wall the scroller could not get through.
  let intent = null;

  const onDown = (ev) => {
    if (ev.button !== undefined && ev.button !== 0) return; // left / primary only
    if (ev.target.closest('.play')) return;                 // ▶ is not a scrub handle
    if (state.selecting) return;                            // selection mode owns taps
    if (ev.pointerType === 'touch') {
      // No preventDefault and no capture yet -- both would take the scroll away.
      intent = { id: ev.pointerId, x: ev.clientX, y: ev.clientY };
      return;
    }
    begin(ev); // a mouse or pen drag was never going to scroll the page
  };

  const onMove = (ev) => {
    if (!intent || ev.pointerId !== intent.id) { move(ev); return; }
    const dx = Math.abs(ev.clientX - intent.x);
    const dy = Math.abs(ev.clientY - intent.y);
    // Whichever axis clears the threshold first owns the gesture, and the loser
    // does not get a second chance on the same finger.
    if (dy > 8 && dy > dx) { intent = null; return; }
    if (dx > 8) { intent = null; begin(ev); }
  };

  const finish = (ev) => {
    if (intent && ev.pointerId === intent.id) intent = null;
    endScrub();
  };

  const begin = async (ev) => {
    if (state.scrub) endScrub();
    ev.preventDefault();

    // Without capture the drag dies the moment the pointer crosses out of the
    // tile — and with a finger that is most of the gesture.
    try { shot.setPointerCapture(ev.pointerId); } catch { /* not captureable */ }

    const el = document.createElement('video');
    el.className = 'scrub-video';
    el.muted = true;
    el.playsInline = true;
    el.preload = 'metadata';
    shot.appendChild(el);
    shot.classList.add('scrubbing');

    const session = { shot, el, video, ready: false, pending: null, seeking: false, pointerId: ev.pointerId };
    state.scrub = session;
    hint().textContent = 'loading…';

    // The desktop has usually already decoded ten frames of this and left them
    // in the sync root. Seventeen kilobytes against streaming the video itself,
    // so it is worth asking before falling back to the network.
    const strip = await stripFor(video);
    if (state.scrub !== session) return;   // the finger left while that was in flight
    if (strip) {
      session.strip = strip;
      session.frames = (state.geom && state.geom.frames) || 10;
      session.ready = true;
      hint().textContent = 'drag to scrub';
      move(session.pendingEvent || ev);
      return;
    }

    // The first drag has to wait for a Graph round trip and then for the file's
    // metadata. Positions moved through in the meantime are not dropped — the
    // last one is replayed once duration is known, so a drag that starts
    // instantly still lands where the finger ended up.
    el.addEventListener('loadedmetadata', () => {
      session.ready = true;
      if (session.pending !== null) seekTo(session, session.pending);
    });
    el.addEventListener('error', () => {
      if (state.scrub === session) hint().textContent = 'preview unavailable';
    });

    try {
      el.src = await graph.streamUrl(video.driveId, video.id);
    } catch (err) {
      if (state.scrub === session) {
        hint().textContent = 'preview failed';
        toast(err.message, 'err');
      }
      return;
    }
    move(ev);
  };

  const move = (ev) => {
    const session = state.scrub;
    if (!session || session.shot !== shot) return;
    ev.preventDefault();
    const box = shot.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (ev.clientX - box.left) / box.width));

    if (session.strip) {
      // Ten frames means ten steps, and the finger picks one. No seeking, no
      // decoding, and no bytes beyond the one image already in hand.
      const at = Math.min(session.frames - 1, Math.floor(fraction * session.frames));
      showFrame(session.shot, session.strip, at, session.frames);
      const hintEl = session.shot.querySelector('.scrub-hint');
      if (hintEl && session.video.duration) {
        hintEl.textContent = fmtTime((session.video.duration / session.frames) * (at + 1));
      }
      return;
    }

    if (!session.ready) {
      session.pending = fraction;
      session.pendingEvent = ev;
      return;
    }
    seekTo(session, fraction);
  };

  shot.addEventListener('pointerdown', onDown);
  shot.addEventListener('pointermove', onMove);
  shot.addEventListener('pointerup', finish);
  shot.addEventListener('pointercancel', finish);
  // Deliberately no pointerleave: with capture the pointer legitimately travels
  // outside the tile mid-drag, and ending there is exactly the bug this had.
}

/**
 * Long-press to start selecting, tap to toggle once selecting. The press timer
 * is cancelled by movement, so a scrub drag never turns into a selection.
 */
function attachSelection(shot, card, video) {
  let timer = null;
  let origin = null;

  shot.addEventListener('pointerdown', (ev) => {
    if (ev.target.closest('.play')) return;
    origin = { x: ev.clientX, y: ev.clientY };
    if (state.selecting) return;
    timer = setTimeout(() => {
      timer = null;
      endScrub();          // a long press was never a scrub
      enterSelection(video, card);
    }, 480);
  });

  shot.addEventListener('pointermove', (ev) => {
    if (!timer || !origin) return;
    if (Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) > 8) {
      clearTimeout(timer);
      timer = null;
    }
  });

  const settle = (ev) => {
    clearTimeout(timer);
    const wasTap = timer !== null;
    timer = null;
    if (!state.selecting) return;
    // In selection mode a tap toggles. Suppress it for the press that opened
    // selection in the first place, or that card would immediately deselect.
    if (wasTap || !origin || Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < 8) {
      if (!card.classList.contains('just-picked')) toggleSelect(video, card);
    }
    card.classList.remove('just-picked');
    origin = null;
  };

  shot.addEventListener('pointerup', settle);
  shot.addEventListener('pointercancel', () => { clearTimeout(timer); timer = null; });
}

function seekTo(session, fraction) {
  const duration = session.el.duration;
  if (!duration || !isFinite(duration)) return;
  const at = Math.min(duration * fraction, Math.max(0, duration - 0.1));
  const hint = session.shot.querySelector('.scrub-hint');
  if (hint) hint.textContent = fmtTime(at);

  // One seek in flight at a time: a dragging finger fires far faster than a
  // network seek completes, and queueing them all makes it lag behind. The
  // latest position is kept and applied as soon as the current seek lands.
  session.pending = fraction;
  if (session.seeking) return;
  session.seeking = true;
  session.el.currentTime = at;
  session.el.addEventListener('seeked', () => {
    session.seeking = false;
    const latest = session.pending;
    if (latest !== null && Math.abs(latest - at / duration) > 0.001 && state.scrub === session) {
      seekTo(session, latest);
    }
  }, { once: true });
}

function fmtTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function endScrub() {
  const current = state.scrub;
  if (!current) return;
  try { current.shot.releasePointerCapture(current.pointerId); } catch { /* already gone */ }
  // Clearing src before removal stops the connection immediately; leaving it to
  // GC keeps pulling mobile data for a preview nobody is watching.
  current.el.removeAttribute('src');
  current.el.load();
  current.el.remove();
  current.shot.classList.remove('scrubbing');
  // A strip is painted onto the tile itself, so the poster underneath only
  // reappears when it is taken off again.
  if (current.strip) clearFrame(current.shot, thumbCache.get(current.video.id) || '');
  const hint = current.shot.querySelector('.scrub-hint');
  if (hint) hint.textContent = 'drag to scrub';
  state.scrub = null;
}

// ------------------------------------------------------------------- player

/**
 * Where the grid was when the player opened. Restored on the way out: closing
 * is a return to what you were doing, not a fresh arrival, and both back and
 * the native fullscreen exit are happy to leave the page at the top otherwise.
 */
let playerReturn = null;

/**
 * Sound is opted into once, for the run of the app, and never by pressing play.
 *
 * The desktop learned this the hard way: taking a play as consent meant a
 * session could go loud without anyone having asked for it. The speaker in the
 * player bar is the only way in, and a reload is quiet again.
 */
let soundOn = false;

function setSoundOn(next) {
  soundOn = Boolean(next);
  const el = $('#playerVideo');
  if (el && el.controls) el.muted = !soundOn;
  syncSoundButton();
}

function syncSoundButton() {
  const btn = $('#playerSound');
  if (!btn) return;
  btn.textContent = soundOn ? '🔊' : '🔇';
  btn.title = soundOn ? 'Mute this session' : 'Turn sound on for this session';
  btn.classList.toggle('on', soundOn);
}

/**
 * The player opens on the same sampled preview the desktop shows: ten points
 * through the file, a second each, muted, with the native controls held back
 * until you commit. Scrubbing a preview is not scrubbing a playthrough, and its
 * play button would be indistinguishable from the seeking this does.
 *
 * It is the one open stream being seeked, not ten requests — the same ranged
 * URL the element is already reading.
 */
/**
 * `mode` is which preview owns the stage: 'seek' drives the video itself, while
 * 'strip' paints a picture over it and the video must be still. Nothing may play
 * while it is 'strip' -- a video moving behind a photograph is neither of the
 * two things the stage is meant to be showing.
 */
const preview = {
  timer: null, index: 0, count: 10, wanted: false,
  mode: null, onMeta: null, onPlay: null,
};

/**
 * The ten-frame preview, from the strip when there is one.
 *
 * Identical to what the seeking version showed -- the desktop cut those frames
 * at the same even divisions -- for one small image instead of ten seeks into a
 * file that may be several gigabytes.
 */
async function startStripPreview(video) {
  const strip = await stripFor(video);
  if (!strip || state.playingId !== video.id) return false;
  const frames = (state.geom && state.geom.frames) || 10;
  const el = $('#playerVideo');
  const shade = $('#playerStrip');

  preview.mode = 'strip';
  // The seeking preview may have been running while the strip was fetched, and
  // a stream reports its duration late enough to land after this. Its listener
  // comes off with its turn, and nothing may start the element while a picture
  // is over it -- buffering behind the strip is wanted, playing is not.
  dropSeekListener(el);
  el.pause();
  preview.onPlay = () => { if (preview.mode === 'strip') el.pause(); };
  el.addEventListener('play', preview.onPlay);
  // And off the stage. One or the other is showing, never both: the strip is
  // cropped to the frame it is on, so anything the crop does not cover would be
  // the video underneath it. Hidden rather than removed -- it goes on buffering
  // for the tap that is coming.
  el.style.visibility = 'hidden';

  shade.hidden = false;
  $('#playerPlay').hidden = false;
  $('#playerBadge').hidden = false;

  const show = (index) => {
    showFrame(shade, strip, index, frames);
    const at = video.duration ? (video.duration / frames) * (index + 1) : 0;
    $('#playerBadge').textContent = `${index + 1}/${frames}${at ? ` · ${fmtTime(at)}` : ''}`;
  };
  preview.index = 0;
  show(0);
  preview.timer = setInterval(() => { preview.index = (preview.index + 1) % frames; show(preview.index); }, 1000);
  return true;
}

function startPreview() {
  stopPreview();
  // The strip is the cheap answer and usually the available one; seeking the
  // stream stays as the fallback for a video the desktop has never drawn.
  const open = playerList().find((v) => v.id === state.playingId);
  if (open) {
    startStripPreview(open).then((used) => { if (!used && preview.wanted) seekPreview(); });
    preview.wanted = true;
    return;
  }
  seekPreview();
}

/** Takes the held metadata listener off, if one is waiting. */
function dropSeekListener(el) {
  if (!preview.onMeta) return;
  el.removeEventListener('loadedmetadata', preview.onMeta);
  preview.onMeta = null;
}

function seekPreview() {
  const el = $('#playerVideo');
  el.controls = false;
  el.muted = true;
  $('#playerPlay').hidden = false;
  $('#playerBadge').hidden = false;
  preview.index = 0;
  preview.mode = 'seek';

  const show = (index) => {
    // The preview is over -- the play button was pressed, or the strip took the
    // stage while this was waiting on a duration. Seeking and playing now would
    // drag a playthrough back a tenth of the way in, or set a video moving
    // behind a still picture.
    if (preview.mode !== 'seek') return;
    preview.index = index;
    const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
    if (!duration) return; // metadata still coming; the timer retries
    const at = (duration / (preview.count + 1)) * (index + 1);
    try { el.currentTime = at; } catch { return; }
    el.play().catch(() => {});
    $('#playerBadge').textContent = `${index + 1}/${preview.count} · ${fmtTime(at)}`;
  };

  // Held rather than left to `once`, which never removes a listener that never
  // fires: a stream can report its duration long after the preview is over.
  preview.onMeta = () => show(0);
  el.addEventListener('loadedmetadata', preview.onMeta);
  if (el.readyState >= 1) show(0);
  preview.timer = setInterval(() => show((preview.index + 1) % preview.count), 1000);
}

function stopPreview() {
  preview.wanted = false;
  preview.mode = null;
  const el = $('#playerVideo');
  if (el) {
    dropSeekListener(el);
    if (preview.onPlay) {
      el.removeEventListener('play', preview.onPlay);
      preview.onPlay = null;
    }
    el.style.visibility = '';   // the stage goes back to the video
  }
  const shade = $('#playerStrip');
  if (shade) { shade.hidden = true; clearFrame(shade); }
  clearInterval(preview.timer);
  preview.timer = null;
}

/** The button turns the preview into a real playthrough, from the top. */
function beginPlayback() {
  stopPreview();
  const el = $('#playerVideo');
  $('#playerPlay').hidden = true;
  $('#playerBadge').hidden = true;
  el.controls = true;
  el.muted = !soundOn;
  // From where it was left, on this phone or the desktop -- unless that is the
  // first few seconds, which is the top anyway, or the last ten, which is the
  // end: a video watched to its credits starts again rather than finishing.
  const video = playingVideo();
  const resume = video ? Number(recordFor(video).resume) || 0 : 0;
  const seekStart = () => {
    // A late metadata event for a video since swiped past is not this one's.
    if (video && state.playingId !== video.id) return;
    const length = Number.isFinite(el.duration) && el.duration > 0
      ? el.duration : (video && video.duration) || 0;
    const at = resume > 5 && length && resume < length - 10 ? resume : 0;
    try { el.currentTime = at; } catch { /* not seekable yet; it starts at 0 anyway */ }
    if (at) toast(`Resuming at ${fmtTime(at)}`, 'ok');
  };
  if (resume > 5 && el.readyState < 1) {
    el.addEventListener('loadedmetadata', seekStart, { once: true });
  } else seekStart();
  el.play().catch(() => {});
}

/** The video the player has open, as a listing entry, or null. */
function playingVideo() {
  if (!state.playingId) return null;
  return state.videos.find((v) => v.id === state.playingId) || null;
}

/**
 * Writes where the open video stands into its record's `resume`, the field the
 * desktop writes too. Only at the moments that end a viewing -- closing the
 * player, moving to another video, the app going to the background -- never
 * on a timer: every save uploads the whole library, over mobile data.
 *
 * A playthrough only (the preview's seeking is not a position anyone chose),
 * and only when it moved: past the end-credits it is cleared, so the next
 * open starts from the top.
 */
function notePlaybackPosition() {
  if (!state.libraryLoaded) return;
  const el = $('#playerVideo');
  const video = playingVideo();
  if (!el || !video || !el.controls || $('#player').hidden) return;
  const now = Number(el.currentTime) || 0;
  const length = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : video.duration || 0;
  if (!length) return;
  const next = now > 5 && now < length - 10 ? Math.round(now) : 0;
  const was = Number(recordFor(video).resume) || 0;
  if (Math.abs(next - was) < 3 && Boolean(next) === Boolean(was)) return;
  editRecord(video, { resume: next });
}

/** Everything about the open video, behind the ⓘ — there is no room for it. */
function renderPlayerDetails(video) {
  const box = $('#playerInfo');
  box.innerHTML = '';
  const bits = [
    video.duration ? fmtTime(video.duration) : '',
    video.width ? `${video.width}×${video.height}` : '',
    video.bitrate ? `${Math.round(video.bitrate / 1000)} kbps` : '',
    fmtBytes(video.size),
    video.folderName || '',
  ].filter(Boolean);
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = bits.join('  ·  ');
  box.appendChild(meta);
  box.appendChild(buildRecordRow(video, { add: true }));
  const faces = buildSuggestions(video);
  if (faces) box.appendChild(faces);
}

/**
 * Whatever the next press will most likely play, its stream URL fetched now.
 *
 * The next card in the listing.
 */
function primeNext() {
  let next = null;
  if (state.playingId) {
    const list = playerList();
    const at = list.findIndex((v) => v.id === state.playingId);
    if (at >= 0 && list.length > 1) next = list[(at + 1) % list.length];
  }
  if (next) graph.warmStream(next.driveId, next.id);
}

/**
 * The lock screen and the headset buttons, taught what is playing.
 *
 * Without this the notification says the page's address and the next-track
 * button does nothing; with it, the video's name and thumbnail ride along and
 * prev/next walk the same list the swipe does.
 */
function syncMediaSession(video) {
  if (!('mediaSession' in navigator)) return;
  try {
    const art = thumbCache.get(video.id);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: video.name.replace(/\.[^.]+$/, ''),
      artist: video.folderName || 'Video Explorer',
      artwork: art ? [{ src: art }] : [],
    });
    navigator.mediaSession.setActionHandler('previoustrack', () => playSibling(-1));
    navigator.mediaSession.setActionHandler('nexttrack', () => playSibling(1));
    navigator.mediaSession.setActionHandler('seekbackward', (d) => {
      const el = $('#playerVideo');
      el.currentTime = Math.max(0, el.currentTime - (d.seekOffset || 10));
    });
    navigator.mediaSession.setActionHandler('seekforward', (d) => {
      const el = $('#playerVideo');
      el.currentTime += d.seekOffset || 10;
    });
  } catch { /* a lock screen without artwork is not worth an error */ }
}

async function openPlayer(video) {
  const modal = $('#player');
  const el = $('#playerVideo');
  if (modal.hidden) playerReturn = pageScrollY(); // only the way in sets the mark
  // Moving on from another video ends that viewing: where it stood is kept.
  else if (state.playingId && state.playingId !== video.id) notePlaybackPosition();
  state.playingId = video.id;
  state.playingAnchor = null; // it is in the listing until an edit says otherwise

  // A <video> goes on painting its last decoded frame until a new source has
  // enough data to replace it, which over mobile data is about a second. So the
  // picture sliding in was the video being left, still there, and the strip over
  // it was that video's frames. Emptied here -- before the wait for the URL
  // rather than after it, which is what made it a visible second.
  stopPreview();
  el.pause();
  el.removeAttribute('src');
  el.load();
  $('#playerBadge').hidden = true;
  // Graph's thumbnail for the one being opened, when the grid has already
  // fetched it: then what arrives is the right video rather than black.
  const poster = thumbCache.get(video.id);
  if (poster) el.poster = poster;
  else el.removeAttribute('poster');

  syncPlayerNav();
  $('#playerName').textContent = video.name;
  renderPlayerDetails(video);
  syncSoundButton();
  modal.hidden = false;
  setBusy('Opening…');
  try {
    el.src = await graph.streamUrl(video.driveId, video.id);
    // Once you have asked for sound, opening a video means watching it.
    if (soundOn) beginPlayback();
    else startPreview();
    syncMediaSession(video);
    // And the one after this, resolved while nobody is waiting on it.
    primeNext();
  } catch (err) {
    toast(err.message, 'err');
    closePlayer();
  } finally {
    setBusy('');
  }
}

/**
 * Swipe across the video for the next one in the listing, the same order the
 * grid is showing -- filter and sort included, since that is the list you were
 * looking at. Wraps at both ends, so neither direction is ever a dead swipe.
 *
 * Left is forward, matching the way a photo gallery moves: the current item
 * leaves to the left.
 */
function playerList() {
  // The listing's own memoised answer: state.videos never holds a folder, so
  // there is nothing to take out, and a copy per swipe was the whole cost.
  return filterByName(state.videos);
}

/**
 * Moving between videos, made visible.
 *
 * A swipe that changes everything on screen without moving anything reads as a
 * glitch rather than a gesture: nothing says which way you went, or that the
 * picture now belongs to a different video. So the one being left goes out the
 * way it was pushed and the next comes in from the other side, the way a photo
 * gallery does.
 *
 * Only the picture and the details move. The bar, the arrows and the badge are
 * the player rather than the video, and chrome that slides with the content
 * looks like the whole app came loose.
 *
 * Returns the second half, to run once the next video is open: the swap happens
 * while these are off-screen, so the black frame between two sources is never
 * seen.
 */
function slidePlayer(step) {
  const nothing = () => {};
  const stage = $('#player .player-stage');
  if (!stage || typeof stage.animate !== 'function') return nothing;
  // Somebody who has asked for less movement is not asking for this.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return nothing;

  const parts = ['#playerVideo', '#playerStrip', '#playerInfo'].map($).filter(Boolean);
  if (!parts.length) return nothing;
  // Part of the width, not all of it: enough to read as a direction without the
  // picture having to cross the whole screen before anything happens.
  const span = (stage.getBoundingClientRect().width || window.innerWidth) * 0.32;

  // Held out there, so whatever happens underneath happens unseen.
  const out = parts.map((el) => el.animate(
    [{ transform: 'translateX(0)', opacity: 1 },
      { transform: `translateX(${-step * span}px)`, opacity: 0 }],
    { duration: 130, easing: 'ease-in', fill: 'forwards' },
  ));

  return () => {
    const back = parts.map((el) => el.animate(
      [{ transform: `translateX(${step * span}px)`, opacity: 0 },
        { transform: 'translateX(0)', opacity: 1 }],
      { duration: 210, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'both' },
    ));
    // The newer animation wins while it runs, so the held one is dropped only
    // once this has landed -- cancelling it first would show the old frame
    // again for a frame, which is the flicker this is meant to avoid.
    const done = () => { out.forEach((a) => a.cancel()); back.forEach((a) => a.cancel()); };
    Promise.all(back.map((a) => a.finished)).then(done, done);
  };
}

/** Opens another video in the player, with the move shown. */
async function goToVideo(video, step) {
  const arrive = slidePlayer(step);
  const opened = openPlayer(video);
  // Back on screen when the next one is ready, or shortly regardless: a stream
  // URL that takes its time must not leave the stage blank while it does.
  await Promise.race([opened, new Promise((done) => setTimeout(done, 320))]);
  arrive();
}

function playSibling(step) {
  if (playMode.random) { randomStep(step); return; }
  const list = playerList();
  if (list.length < 2 || !state.playingId) return;
  const at = list.findIndex((v) => v.id === state.playingId);
  if (at < 0) return;
  goToVideo(list[((at + step) % list.length + list.length) % list.length], step);
}

/**
 * Random and Repeat, the desktop's pair, for this time the player is open.
 * Both start off and closing the player turns them off -- they are a way of
 * watching, not a setting. `seen` is what Random has played, in order, so
 * back retraces it rather than rolling the dice again.
 *
 * Repeat here is the video itself: at its end it plays again from the top,
 * ahead of Autoplay. The listing already wraps at both ends on the phone, so
 * the desktop's "wrap the listing" meaning would have changed nothing.
 */
const playMode = { random: false, repeat: false, seen: [], at: -1 };

function resetPlayMode() {
  playMode.random = false;
  playMode.repeat = false;
  playMode.seen = [];
  playMode.at = -1;
  syncPlayMode();
}

function syncPlayMode() {
  for (const [id, on] of [['#playerRandom', playMode.random], ['#playerRepeat', playMode.repeat]]) {
    const btn = $(id);
    if (!btn) continue;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
  }
  if (!$('#player').hidden) syncPlayerNav();
}

function toggleRandom() {
  playMode.random = !playMode.random;
  // Starts from here: what is playing now is the first thing back would reach.
  playMode.seen = playMode.random && state.playingId ? [state.playingId] : [];
  playMode.at = playMode.seen.length - 1;
  syncPlayMode();
  toast(playMode.random ? 'Random on' : 'Random off', 'ok');
}

function toggleRepeat() {
  playMode.repeat = !playMode.repeat;
  syncPlayMode();
  toast(playMode.repeat ? 'Repeat on — this video plays again at its end' : 'Repeat off', 'ok');
}

/**
 * Random's next: forward through what it already played if you went back,
 * otherwise a video from the listing it has not played yet. When every one
 * has played it starts a fresh round -- the listing wraps on the phone, so
 * Random does too. Ids rather than entries: a refresh replaces the objects.
 */
function randomStep(step) {
  const list = playerList();
  const byId = new Map(list.map((v) => [v.id, v]));
  if (step < 0) {
    while (playMode.at > 0) {
      playMode.at -= 1;
      const back = byId.get(playMode.seen[playMode.at]);
      if (back) { goToVideo(back, -1); return; }
    }
    return;
  }
  while (playMode.at + 1 < playMode.seen.length) {
    playMode.at += 1;
    const again = byId.get(playMode.seen[playMode.at]);
    if (again) { goToVideo(again, 1); return; }
  }
  const played = new Set(playMode.seen);
  let pool = list.filter((v) => !played.has(v.id) && v.id !== state.playingId);
  if (!pool.length) {
    playMode.seen = state.playingId ? [state.playingId] : [];
    playMode.at = playMode.seen.length - 1;
    pool = list.filter((v) => v.id !== state.playingId);
    if (!pool.length) return;
    toast('Every video here has played — starting a new round', 'ok');
  }
  const pick = pool[Math.floor(Math.random() * pool.length)];
  playMode.seen.push(pick.id);
  playMode.at = playMode.seen.length - 1;
  goToVideo(pick, 1);
}

/** Hides the arrows when there is nowhere to go, and says where you are. */
function syncPlayerNav() {
  const list = playerList();
  const at = list.findIndex((v) => v.id === state.playingId);
  const usable = list.length > 1 && at >= 0;
  // Random goes back only as far as it has been; forward, anywhere.
  $('#playerPrev').hidden = playMode.random ? playMode.at <= 0 : !usable;
  $('#playerNext').hidden = playMode.random ? list.length < 2 : !usable;
  const pos = $('#playerPos');
  pos.hidden = at < 0;
  pos.textContent = at < 0 ? '' : `${at + 1} / ${list.length}`;
}

/**
 * Horizontal swipes only, and not from the bottom of the screen: that strip is
 * the video's own controls, where a sideways drag is a seek.
 */
/**
 * Pull down from the top of the grid to fetch the folder again.
 *
 * A PWA pinned to the home screen has no reload button, so "is this current?"
 * had no answer short of navigating away and back. The gesture everyone
 * already knows does it: only from the very top, only on the grid, and it has
 * to be a deliberate pull -- 70px -- before letting go means anything.
 */
function attachPullToRefresh() {
  const hint = $('#pullHint');
  let from = null;
  let armed = false;

  document.addEventListener('touchstart', (ev) => {
    from = null;
    armed = false;
    if (window.scrollY > 0 || overlayOpen() || ev.touches.length !== 1) return;
    from = ev.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchmove', (ev) => {
    if (from === null || !hint) return;
    const pulled = ev.touches[0].clientY - from;
    if (pulled <= 0 || window.scrollY > 0) { armed = false; hint.hidden = true; return; }
    armed = pulled > 70;
    hint.hidden = pulled < 14;
    hint.textContent = armed ? 'Release to refresh' : 'Pull to refresh';
    hint.classList.toggle('armed', armed);
  }, { passive: true });

  document.addEventListener('touchend', () => {
    if (hint) hint.hidden = true;
    if (!armed) { from = null; return; }
    armed = false;
    from = null;
    const here = state.stack[state.stack.length - 1] || null;
    openFolder(here, { push: false });
  }, { passive: true });
}

function attachPlayerSwipe() {
  const modal = $('#player');
  let from = null;
  // A vertical drag while something is playing: the right half of the picture
  // rides the volume, the left half the brightness. Brightness is a filter on
  // the element -- nothing about the file changes -- and the volume drag also
  // covers phones whose video element honours it (iOS does not, and there the
  // gesture simply does nothing, which is what iOS itself wants).
  let sliding = null; // { what: 'volume'|'bright', base }
  let bright = 1;

  const gauge = (text) => {
    const el = $('#playerGauge');
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    clearTimeout(gauge.timer);
    gauge.timer = setTimeout(() => { el.hidden = true; }, 700);
  };

  modal.addEventListener('touchstart', (ev) => {
    sliding = null;
    // The bar and the arrows are taps, not swipes.
    if (ev.touches.length !== 1 || ev.target.closest('.player-bar, .player-nav')) { from = null; return; }
    const t = ev.touches[0];
    from = t.clientY > window.innerHeight - 90 ? null : { x: t.clientX, y: t.clientY };
  }, { passive: true });

  modal.addEventListener('touchmove', (ev) => {
    if (!from || ev.touches.length !== 1) return;
    const el = $('#playerVideo');
    if (!el || !el.controls) return; // gestures belong to a playthrough, not the preview
    const t = ev.touches[0];
    const dx = t.clientX - from.x;
    const dy = t.clientY - from.y;
    if (!sliding) {
      if (Math.abs(dy) < 34 || Math.abs(dy) < Math.abs(dx) * 1.5) return;
      sliding = from.x > window.innerWidth / 2
        ? { what: 'volume', base: el.volume }
        : { what: 'bright', base: bright };
    }
    const shift = -dy / (window.innerHeight * 0.7);
    if (sliding.what === 'volume') {
      const level = Math.max(0, Math.min(1, sliding.base + shift));
      try { el.volume = level; el.muted = level === 0; } catch { /* iOS owns it */ }
      gauge(`🔊 ${Math.round(level * 100)}%`);
    } else {
      bright = Math.max(0.4, Math.min(1.8, sliding.base + shift * 1.4));
      el.style.filter = Math.abs(bright - 1) < 0.03 ? '' : `brightness(${bright.toFixed(2)})`;
      gauge(`☀ ${Math.round(bright * 100)}%`);
    }
  }, { passive: true });

  // Double-tap on the edges: ten seconds back on the left, forward on the
  // right. The middle is left to the native controls, whose single tap it is.
  let lastTap = { at: 0, x: 0 };

  modal.addEventListener('touchend', (ev) => {
    if (!from) return;
    const wasSliding = sliding;
    sliding = null;
    const t = ev.changedTouches[0];
    const dx = t.clientX - from.x;
    const dy = t.clientY - from.y;
    from = null;
    if (wasSliding) return; // a volume drag is not a swipe to the next video
    if (Math.abs(dx) >= 60 && Math.abs(dx) >= Math.abs(dy) * 1.5) {
      playSibling(dx < 0 ? 1 : -1);
      return;
    }
    // A tap, then: two of them in the same spot within 350ms is a seek.
    if (Math.abs(dx) > 12 || Math.abs(dy) > 12) return;
    const now = Date.now();
    const paired = now - lastTap.at < 350 && Math.abs(t.clientX - lastTap.x) < 60;
    lastTap = paired ? { at: 0, x: 0 } : { at: now, x: t.clientX };
    if (!paired) return;
    const el = $('#playerVideo');
    if (!el || !el.controls) return;
    const zone = t.clientX / window.innerWidth;
    if (zone > 0.35 && zone < 0.65) return; // the middle belongs to the controls
    const step = zone <= 0.35 ? -10 : 10;
    try { el.currentTime = Math.max(0, (Number(el.currentTime) || 0) + step); } catch { /* fine */ }
    gauge(step < 0 ? '⏪ 10s' : '10s ⏩');
  }, { passive: true });
}

/**
 * Autoplay: when a video ends, the listing's next one plays.
 * Remembered per device; a phone on a data plan may well want it off.
 */
let autoNext = false;
try { autoNext = localStorage.getItem('video-explorer.autonext') === '1'; } catch { /* fine */ }

function syncAutoButton() {
  const btn = $('#playerAuto');
  if (!btn) return;
  btn.classList.toggle('on', autoNext);
  btn.title = autoNext ? 'Autoplay is on — videos follow each other' : 'Autoplay the next video';
}

/**
 * The details panel, folded away in a phone held sideways: there the screen is
 * about 400px tall, and the panel's share of that was most of the picture. The
 * ⓘ in the bar brings it back over the side of the video; upright, the button
 * is not shown and the panel is always there, as it always was.
 */
function setInfoOpen(open) {
  const modal = $('#player');
  if (!modal) return;
  modal.classList.toggle('info-open', open);
  const btn = $('#playerInfoBtn');
  if (btn) {
    btn.classList.toggle('on', open);
    btn.setAttribute('aria-pressed', String(open));
  }
}

function closePlayer() {
  notePlaybackPosition(); // before the src goes, while currentTime still means something
  resetPlayMode();
  setInfoOpen(false);
  stopPreview(); // a timer left running would seek a src that has gone
  const el = $('#playerVideo');
  el.pause();
  el.removeAttribute('src');
  el.load();
  $('#player').hidden = true;
  state.playingId = null;

  if (playerReturn === null) return;
  const back = playerReturn;
  playerReturn = null;
  // Next frame, so the document is back to its full height before the scroll.
  requestAnimationFrame(() => {
    if (Math.abs(window.scrollY - back) > 2) window.scrollTo(0, back);
  });
}

// --------------------------------------------------------------------- init

/**
 * Back to the sign-in screen, with whatever was open closed first: a player
 * left running under the gate would go on streaming with a dead session.
 */
function showGate() {
  for (const { sel, close } of OVERLAYS) {
    if (!$(sel).hidden) {
      try { close(); } catch { /* closing is best effort here */ }
    }
  }
  if (state.selecting) exitSelection();
  state.load = null; // any listing still streaming belongs to the old session
  state.libraryLoaded = false;
  $('#gate').hidden = false;
  $('#main').hidden = true;
  toast('Signed out — sign in to carry on', 'err');
}

/** The sort keys sortVideos understands, as the select offers them. */
const SORT_KEY = 'video-explorer.sort';
const SORTS = ['rating', 'name', 'mtime', 'size', 'duration', 'models', 'tags', 'folder'];

function restoreSort() {
  try {
    const saved = JSON.parse(localStorage.getItem(SORT_KEY) || 'null');
    if (saved && SORTS.includes(saved.sort)) state.sort = saved.sort;
    if (saved && (saved.dir === 'asc' || saved.dir === 'desc')) state.sortDir = saved.dir;
  } catch { /* first run, or storage blocked: the default sort */ }
}

function saveSort() {
  try {
    localStorage.setItem(SORT_KEY, JSON.stringify({ sort: state.sort, dir: state.sortDir }));
  } catch { /* remembered for this run only */ }
}

function syncSortControls() {
  const sel = $('#sortSel');
  if (sel) sel.value = state.sort;
  const dir = $('#sortDir');
  if (dir) {
    dir.textContent = state.sortDir === 'asc' ? '↑' : '↓';
    dir.title = state.sortDir === 'asc' ? 'Ascending — tap to reverse' : 'Descending — tap to reverse';
  }
}

async function boot() {
  $('#signIn').addEventListener('click', () => auth.signIn().catch((e) => toast(e.message, 'err')));
  $('#playerClose').addEventListener('click', closePlayer);
  // The music-player rule, on the BUTTON only: more than fifteen seconds in,
  // back means "this one, from the top"; inside those fifteen seconds it means
  // the previous video. The swipe keeps its plain meaning.
  $('#playerPrev').addEventListener('click', () => {
    const el = $('#playerVideo');
    if (el && el.controls && (Number(el.currentTime) || 0) > 15) {
      try { el.currentTime = 0; } catch { /* not seekable */ }
      return;
    }
    playSibling(-1);
  });
  $('#playerNext').addEventListener('click', () => playSibling(1));
  $('#playerAuto').addEventListener('click', () => {
    autoNext = !autoNext;
    try { localStorage.setItem('video-explorer.autonext', autoNext ? '1' : '0'); } catch { /* fine */ }
    syncAutoButton();
    toast(autoNext ? 'Autoplay on' : 'Autoplay off', 'ok');
  });
  syncAutoButton();
  $('#playerRandom').addEventListener('click', toggleRandom);
  $('#playerRepeat').addEventListener('click', toggleRepeat);
  $('#playerInfoBtn').addEventListener('click', () => setInfoOpen(!$('#player').classList.contains('info-open')));
  $('#playerVideo').addEventListener('ended', () => {
    const el = $('#playerVideo');
    // Repeat outranks Autoplay: it means "stay on this one".
    if (playMode.repeat) {
      try { el.currentTime = 0; } catch { /* not seekable */ }
      el.play().catch(() => {});
      return;
    }
    if (autoNext) playSibling(1);
  });
  attachPlayerSwipe();
  attachPullToRefresh();
  watchOverlays();
  $('#loadMore').addEventListener('click', () => loadMore());

  // Flatten is a view you reach for rather than a mode you live in, so it is not
  // persisted -- same as the desktop, which resets it at every launch.
  $('#flatBtn').addEventListener('click', () => {
    state.flatten = !state.flatten;
    $('#flatBtn').classList.toggle('on', state.flatten);
    const here = state.stack[state.stack.length - 1] || null;
    openFolder(here, { push: false });
  });
  $('#lineupClose').addEventListener('click', closeLineup);

  $('#groupBtn').addEventListener('click', () => {
    // Off, credited, suggested, off. The plain listing is the way back from
    // either, so neither grouping is more than one tap from the default.
    state.grouped = GROUP_MODES[(GROUP_MODES.indexOf(state.grouped) + 1) % GROUP_MODES.length];
    syncGroupButton();
    gridKey = '';
    render();
    if (!state.grouped) return;
    const named = state.groups.filter((g) => !g.unnamed).length;
    if (named) {
      toast(state.grouped === 'suggested'
        ? `${named} performer${named === 1 ? '' : 's'} the faces look like`
        : `${named} performer${named === 1 ? '' : 's'}, best rated first`, 'ok');
    } else {
      toast(state.grouped === 'suggested'
        ? 'Nobody is suggested in this listing'
        : 'Nobody is named in this listing', 'err');
    }
  });

  syncGroupButton();

  $('#advBtn').addEventListener('click', () => { $('#advModelsFind').value = ''; openAdv(); });
  // Only the results redraw while typing, so the box keeps the caret.
  $('#advModelsFind').addEventListener('input', renderAdvModelsFound);
  $('#advClose').addEventListener('click', () => { $('#adv').hidden = true; });
  $('#advApply').addEventListener('click', applyAdv);
  $('#advReset').addEventListener('click', () => {
    resetAdv();
  });
  for (const [field, id] of PERSON_ROWS.map(([f, , , m]) => [f, m])
    .concat([['tags', '#advTagMode'], ['models', '#advModelMode']])) {
    $(id).addEventListener('click', () => {
      advDraft.mode[field] = advDraft.mode[field] === 'all' ? 'any' : 'all';
      renderAdv();
    });
  }

  $('#labelsClose').addEventListener('click', () => { $('#labels').hidden = true; });
  $('#labelsAdd').addEventListener('click', () => commitLabels('add'));
  $('#labelsReplace').addEventListener('click', () => commitLabels('replace'));
  for (const [field, spec] of Object.entries(LABEL_INPUTS)) {
    const box = $(spec.input);
    box.addEventListener('input', () => {
      // A comma still means "that one's done".
      if (box.value.includes(',')) {
        const parts = box.value.split(',');
        const rest = parts.pop();
        for (const part of parts) draftAdd(field, part);
        box.value = rest.trimStart();
      }
      renderLabelSuggestions();
    });
    box.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      if (draftAdd(field, box.value) || box.value.trim()) {
        box.value = '';
        renderLabelSuggestions();
      }
    });
  }
  $('#selDelete').addEventListener('click', deleteSelection);
  $('#playerPlay').addEventListener('click', beginPlayback);
  $('#playerSound').addEventListener('click', () => setSoundOn(!soundOn));
  $('#selTag').addEventListener('click', tagSelection);
  $('#selMove').addEventListener('click', openMovePicker);
  $('#pickerClose').addEventListener('click', () => { $('#picker').hidden = true; });
  $('#pickerConfirm').addEventListener('click', confirmMove);
  $('#selClear').addEventListener('click', exitSelection);
  $('#selAll').addEventListener('click', () => {
    // Everything currently listed, which with a filter active means everything
    // matching it — not the whole folder behind it.
    for (const video of filterByName(state.videos)) state.selected.add(video.id);
    for (const card of document.querySelectorAll('.card')) card.classList.add('picked');
    updateSelectionBar();
  });
  // A beat after the last key rather than on every one: each render filters
  // and sorts the whole listing, and a name typed at speed was a dozen of them.
  let searchTimer = null;
  $('#search').addEventListener('input', (ev) => {
    clearTimeout(searchTimer);
    const value = ev.target.value;
    searchTimer = setTimeout(() => {
      state.query = value.trim().toLowerCase();
      render();
    }, 150);
  });

  // The sort, chosen here and remembered per device. The keys are the ones
  // sortVideos has always understood; until now only the default was reachable.
  restoreSort();
  syncSortControls();
  $('#sortSel').addEventListener('change', (ev) => {
    state.sort = ev.target.value;
    saveSort();
    gridKey = '';
    render();
  });
  $('#sortDir').addEventListener('click', () => {
    state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    saveSort();
    syncSortControls();
    gridKey = '';
    render();
  });

  // Signing out, by choice or because the session died under a refresh: the
  // sign-in screen, rather than a grid whose every tap fails.
  auth.onSignOut(showGate);
  $('#signOut').addEventListener('click', async () => {
    if (!window.confirm('Sign out of OneDrive on this device?')) return;
    // Anything unsaved goes up first; a sign-out is not a reason to lose it.
    if (state.dirty && state.libraryLoaded) {
      clearTimeout(saveTimer);
      await saveAndAdopt().catch(() => {});
    }
    // The labels and listings this phone kept are the account's; they go too.
    await graph.kvClear();
    auth.signOut();
  });

  try {
    await auth.completeSignIn();
  } catch (err) {
    toast(err.message, 'err');
  }

  if (!auth.signedIn()) {
    $('#gate').hidden = false;
    $('#main').hidden = true;
    return;
  }

  $('#gate').hidden = true;
  $('#main').hidden = false;
  // No trap yet: at the root with nothing open, Back is free to leave. One is
  // armed by the first folder, overlay or selection that gives it a job.

  try {
    state.account = await graph.me();
  } catch (err) {
    // Offline is not signed out: the saved labels and listings still show.
    if (!graph.isOffline(err)) {
      toast(err.message, 'err');
      $('#gate').hidden = false;
      $('#main').hidden = true;
      return;
    }
  }
  const who = $('#whoami');
  if (who && state.account) who.textContent = state.account.email || state.account.name || '';

  loadSettings();
  await readLibrary();
  await openFolder(null);
}

/**
 * Everything this module holds, reachable from the console when the page is
 * opened with #debug.
 *
 * A module's scope is closed, which means the phone UI could not be driven from
 * a debugger at all — every change to it has had to be checked by hand on a
 * device. This costs one branch and makes the thing testable.
 */
if (location.hash === '#debug') {
  window.__ve = {
    state,
    get adv() { return adv; },
    set adv(next) { adv = next; },
    get advDraft() { return advDraft; },
    newAdvFilter, matchesAdv, advActive, picked, cycleIn, NOTHING,
    vocabulary, vocabularyByName, recordFor, editRecord, normaliseList,
    readLibrary,
    render, renderAdv, openAdv, applyAdv, resetAdv, filterByLabel,
    openLabels, commitLabels, renderLabelSuggestions,
    buildCard, buildRecordRow, buildFolderLine, filterByName, sortVideos,
    buildModelGroups, buildGroupHead, favouriteModels, isFavouriteModel, toggleFavouriteModel,
    facesFor, suggestionMatch, buildSuggestions, renderPlayerDetails,
    cropFor, cropName, paintCrop, openLineup, closeLineup, stripName, showFrame, clearFrame,
    get lineups() { return lineups; },
    set lineups(next) { lineups = next; },
    touchedAt, sortVideos,
    atRoot, isLibraryFolder,
    openPlayer, beginPlayback, startPreview, stopPreview, followListing,

    get soundOn() { return soundOn; }, setSoundOn, playerList,
    setFavouriteModel, favouriteTier, openTierMenu, notePlaybackPosition, playMode,
    toggleRandom, toggleRepeat, randomStep, facesFilterMatch, showGate, useSavedListing,
    get libVersion() { return libVersion; },
  };
}

if ('serviceWorker' in navigator) {
  // A new version taking over mid-session reloads once into it, so a push is
  // on screen without having to close and reopen the app. Skipped on the
  // first install, when nothing older was showing.
  if (navigator.serviceWorker.controller) {
    let reloaded = false;
    // Not straight away when it would cost something: a reload mid-video
    // stops it, and one with labels unsaved cancels the upload. Then the
    // update waits for a tap, saving first.
    const reload = async () => {
      if (reloaded) return;
      reloaded = true;
      if (state.dirty && state.libraryLoaded) {
        clearTimeout(saveTimer);
        await saveAndAdopt().catch(() => {});
      }
      location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      const busy = state.dirty || !$('#player').hidden || !$('#labels').hidden;
      if (!busy) { reload(); return; }
      toast('A new version is ready', 'ok', { label: 'Reload', run: reload, sticky: true });
    });
  }
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

boot();
