'use strict';

/* Video Explorer for phones: browses OneDrive through Graph, no PC involved. */

import * as auth from './auth.js';
import * as graph from './graph.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  account: null,
  stack: [],          // [{ driveId, itemId, name }] — the trail from the root
  folders: [],
  videos: [],
  library: { version: 1, records: {} },
  dirty: false,       // library edits waiting to be written back
  query: '',
  sort: 'rating',     // matches the desktop default: highest rated first
  sortDir: 'desc',
  scrub: null,        // { card, video, url } while a finger is down
  load: null,         // token identifying the in-flight folder load
  next: null,
  flatten: false,     // every video below here, not just this folder
  walk: null,         // { driveId, itemId, next } — where the flattened walk is
  queue: [],          // folders the walk has seen but not visited yet
  playingId: null,    // which video the player has open, for swipe-to-next
  selecting: false,   // selection mode: taps toggle instead of scrubbing
  cardWidth: 320,     // per-device, not a judgement about a video; the CSS default
  pageSize: 200,
  selected: new Set(), // item ids
};

/**
 * Thumbnails are fetched for cards you can actually see, 20 per Graph $batch
 * call. Expanding them into the listing instead cost 6s per page against 0.7s
 * plain, on every page whether or not you scrolled that far.
 */
const wanted = new Map(); // item id -> the .shot element waiting for a URL
// Client-side sorting means the grid gets rebuilt rather than appended to, so
// URLs already fetched are kept — a rebuild must not re-hit Graph.
const thumbCache = new Map(); // item id -> url
let thumbTimer = null;

const thumbObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    thumbObserver.unobserve(entry.target);
    wanted.set(entry.target.dataset.id, entry.target);
  }
  // Coalesce a burst of intersections from one scroll into a single batch.
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(flushThumbs, 120);
}, { rootMargin: '600px 0px' });

async function flushThumbs() {
  if (!wanted.size) return;
  const batch = [...wanted.entries()].slice(0, 20);
  for (const [id] of batch) wanted.delete(id);

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

  if (wanted.size) flushThumbs();
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

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function setBusy(text) {
  $('#status').textContent = text || '';
  $('#status').hidden = !text;
}

// ------------------------------------------------------------------ library

const EMPTY_RECORD = { rating: 0, tags: [], models: [], studio: '', url: '' };

function recordFor(video) {
  const record = state.library.records[graph.recordKey(video)];
  if (!record) return EMPTY_RECORD;
  return {
    rating: record.rating || 0,
    tags: record.tags || [],
    models: record.models || [],
    studio: record.studio || '',
    url: record.url || '',
  };
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
  const key = graph.recordKey(video);
  const current = state.library.records[key]
    || { rating: 0, tags: [], models: [], name: video.name };
  const next = { ...current, name: video.name, updated: Date.now(), ...patch };

  // The desktop's shapes, so a record written here reads the same there: lists
  // deduped and sorted, the studio a single trimmed string, a url only if it is
  // one the app would be willing to open.
  for (const field of ['tags', 'models']) {
    if (Array.isArray(next[field])) next[field] = normaliseList(next[field]);
  }
  if (next.studio !== undefined) {
    next.studio = String(next.studio || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  }
  if (next.url !== undefined) {
    next.url = /^https?:\/\//i.test(String(next.url || '').trim()) ? String(next.url).trim() : '';
  }

  // An empty record is noise in a file that syncs; match the desktop and drop it.
  if (!next.rating && !(next.tags || []).length && !(next.models || []).length
    && !next.studio && !next.url) {
    delete state.library.records[key];
  } else state.library.records[key] = next;
  state.dirty = true;
  scheduleSave();
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  // Batched: rating five videos in a row is one upload, not five, and each
  // upload replaces the whole file so the last write has to be the winner.
  saveTimer = setTimeout(async () => {
    try {
      await graph.saveLibrary(state.library);
      state.dirty = false;
    } catch (err) {
      toast(err.message, 'err');
    }
  }, 1200);
}

// A pending edit must not be lost to a backgrounded tab.
window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && state.dirty) {
    clearTimeout(saveTimer);
    graph.saveLibrary(state.library).then(() => { state.dirty = false; }).catch(() => {});
  }
});

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
  state.folders = [];
  state.videos = [];
  state.next = null;
  state.queue = [];
  state.walk = null;
  render();
  window.scrollTo(0, 0);
  setBusy('Loading…');

  const driveId = entry ? entry.driveId : null;
  const itemId = entry ? entry.itemId : null;
  state.source = { driveId, itemId, run };
  // Flattened, the listing is a walk that starts here and works downwards.
  if (state.flatten) state.walk = { driveId, itemId, next: null };

  // Folders and videos are separate queries with different orderings, so they
  // run side by side rather than one behind the other.
  graph.listFolders(driveId, itemId).then((folders) => {
    if (state.load !== run) return;
    state.folders = atRoot() ? folders.filter(isLibraryFolder) : folders;
    renderFolders();
  }).catch((err) => {
    if (state.load === run) toast(err.message, 'err');
  });

  await loadMore(state.flatten ? FLAT_PAGES : AUTO_PAGES);
}

// Pages pulled without being asked. Three is roughly 600 videos — enough that
// most folders finish on their own, while the 5,000-video ones stop before
// they have put that many cards into a phone's DOM.
const AUTO_PAGES = 3;
// Flattened, a page is one folder's worth rather than 200 videos, and a folder
// of a dozen clips is common — three of those would barely fill a screen.
const FLAT_PAGES = 10;

/** Whether anything is left to load, in either mode. */
function moreToLoad() {
  return state.flatten ? Boolean(state.walk) : Boolean(state.next);
}

async function loadMore(pages = 1) {
  const { driveId, itemId, run } = state.source;
  let remaining = pages;

  try {
    do {
      if (state.flatten && !state.walk) return; // the walk finished
      const page = state.flatten
        ? await graph.listChildren(state.walk.driveId, state.walk.itemId, state.walk.next)
        : await graph.listPage(driveId, itemId, state.next);
      // A folder tapped while this one was still streaming wins; anything this
      // loop produces from here belongs to a screen the user has left.
      if (state.load !== run) return;

      state.videos.push(...page.videos);
      if (state.flatten) {
        // Breadth-first: finish the folder in hand, then take the next off the
        // queue. Subfolders join the queue as they are seen, which is why the
        // walk needs no extra request per folder.
        for (const video of page.videos) video.folderName = state.walk.name || '';
        state.queue.push(...page.folders.map((f) => ({
          driveId: f.driveId, itemId: f.id, name: f.name,
        })));
        state.walk = page.next
          ? { ...state.walk, next: page.next }
          : (state.queue.shift() || null);
        if (state.walk && !('next' in state.walk)) state.walk.next = null;
      } else {
        state.next = page.next;
      }
      remaining -= 1;
      render();
      setBusy(moreToLoad() && remaining > 0 ? 'Loading more…' : '');
    } while (moreToLoad() && remaining > 0);
  } catch (err) {
    if (state.load === run) {
      toast(err.message, 'err');
      setBusy('');
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

async function goUp() {
  if (!state.stack.length) return;
  state.stack.pop();
  const parent = state.stack[state.stack.length - 1] || null;
  await openFolder(parent, { push: false });
}

// Android's back button should walk the folder trail, not leave the app.
window.addEventListener('popstate', () => {
  // Unwind one layer at a time, innermost first — the same order Escape uses on
  // the desktop, so back never leaves the app while something is still open.
  pushTrap();
  if (!$('#adv').hidden) { $('#adv').hidden = true; return; }
  if (!$('#picker').hidden) { $('#picker').hidden = true; return; }
  if (!$('#player').hidden) { closePlayer(); return; }
  if (state.selecting) { exitSelection(); return; }
  if (state.stack.length) goUp();
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

function filterByName(list) {
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
  return sortVideos(out);
}

/**
 * Sorts videos, leaving folders where they are — they render in their own
 * section, so ordering them by rating would be meaningless.
 */
/** Which label a sort key reads, and what it reads out of it. */
const LABEL_SORTS = {
  studio: (v) => (recordFor(v).studio || '').trim(),
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
    if (!best || value.localeCompare(best, undefined, { sensitivity: 'base' }) < 0) best = value;
  }
  return best;
}

function sortVideos(list) {
  const dir = state.sortDir === 'asc' ? 1 : -1;
  const key = state.sort;
  return list.slice().sort((a, b) => {
    if (a.isFolder || b.isFolder) return 0;
    let cmp;
    if (key === 'name') {
      cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    } else if (key === 'rating') {
      cmp = (recordFor(a).rating || 0) - (recordFor(b).rating || 0);
      // Returned unflipped: within one rating band names should read A→Z
      // whichever way the ratings point, or the unrated bulk comes out backwards.
      if (cmp === 0) return a.name.localeCompare(b.name, undefined, { numeric: true });
    } else if (LABEL_SORTS[key]) {
      // By a label: its first value, since a video has one studio but any
      // number of performers. Unlabelled last whichever way the arrow points,
      // like the unrated — reversing should bring the labelled tail up, not a
      // wall of blanks.
      const av = LABEL_SORTS[key](a);
      const bv = LABEL_SORTS[key](b);
      if (!av && !bv) return a.name.localeCompare(b.name, undefined, { numeric: true });
      if (!av) return 1;
      if (!bv) return -1;
      cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
      if (cmp === 0) return a.name.localeCompare(b.name, undefined, { numeric: true });
    } else if (key === 'folder') {
      // Only meaningful flattened, which is the only time a listing mixes
      // folders — and within one folder it falls back to the name.
      cmp = String(a.folderName || '').localeCompare(String(b.folderName || ''),
        undefined, { numeric: true, sensitivity: 'base' });
      if (cmp === 0) return a.name.localeCompare(b.name, undefined, { numeric: true });
    } else {
      cmp = (Number(a[key]) || 0) - (Number(b[key]) || 0);
    }
    return cmp * dir;
  });
}

// Which folder + filter the grid currently shows, so an extra page can be
// appended instead of rebuilding thousands of cards and re-fetching their
// thumbnails on every arrival.
let gridKey = '';
let gridCount = 0;
let gridTail = ''; // id of the last card appended, so a reorder is noticed

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
    + '|' + state.query + '|' + state.sort + state.sortDir + '|' + state.flatten;
  const tailMoved = gridCount > 0 && (list[gridCount - 1] || {}).id !== gridTail;

  if (key !== gridKey || tailMoved) {
    wrap.innerHTML = '';
    wanted.clear();
    gridKey = key;
    gridCount = 0;
  }
  for (let i = gridCount; i < list.length; i += 1) wrap.appendChild(buildCard(list[i]));
  gridCount = list.length;
  gridTail = gridCount ? list[gridCount - 1].id : '';

  $('#videoCount').textContent = list.length
    ? `${list.length} video${list.length === 1 ? '' : 's'}${moreToLoad() ? ' so far' : ''}`
    : (moreToLoad() ? 'Loading…' : 'No videos here');

  const more = $('#loadMore');
  more.hidden = !moreToLoad();
  more.textContent = `Load more (${state.videos.length} loaded)`;
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
  for (let n = 1; n <= 5; n += 1) {
    const star = document.createElement('button');
    star.className = 'star' + (uniform && n <= first ? ' on' : '');
    star.textContent = uniform && n <= first ? '★' : '☆';
    star.addEventListener('click', () => {
      const rating = (uniform && n === first) ? 0 : n;
      for (const video of picked) editRecord(video, { rating });
      render();
      updateSelectionBar();
    });
    stars.appendChild(star);
  }
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
 * How wide a card is, and how much a "load more" fetches. Both are per-device
 * rather than shared through the sidecar: a phone and a desktop browser want
 * different answers, and the sidecar is for judgements about videos.
 */
const SETTINGS_KEY = 've.settings';

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (Number(saved.cardWidth)) state.cardWidth = Number(saved.cardWidth);
    if (Number(saved.pageSize)) state.pageSize = Number(saved.pageSize);
  } catch { /* first run, or storage blocked */ }
  applyCardWidth();
  graph.setPageSize(state.pageSize);
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      cardWidth: state.cardWidth, pageSize: state.pageSize,
    }));
  } catch { /* private mode: the setting just does not outlive the tab */ }
}

function applyCardWidth() {
  document.documentElement.style.setProperty('--card-width', state.cardWidth + 'px');
}

function openSettings() {
  $('#setCardWidth').value = String(state.cardWidth);
  $('#setCardWidthLabel').textContent = state.cardWidth + 'px';
  $('#setPageSize').value = String(state.pageSize);
  $('#settings').hidden = false;
}

// -------------------------------------------------------------- favourites

/**
 * What a rating is worth to a performer's standing. Each step up the scale is an
 * order of magnitude — a five is worth ten fours, a four ten threes — so no pile
 * of threes adds up to one good video. A two or a one is a verdict against and
 * scores nothing, same as never having rated it.
 */
const STAR_POINTS = [0, 0, 0, 10, 100, 1000];

/**
 * The twenty performers with the best-rated work, by points — the desktop's
 * ranking, from the same sidecar.
 *
 * Ties go to whoever has more well-rated videos, since ten fours and one five
 * score alike, and then alphabetically.
 */
function topModels(limit = 20) {
  const tally = new Map();
  for (const record of Object.values(state.library.records || {})) {
    const rating = Math.max(0, Math.min(5, Math.round(Number(record.rating) || 0)));
    for (const raw of record.models || []) {
      const name = String(raw).trim();
      if (!name) continue;
      const key = name.toLowerCase();
      let entry = tally.get(key);
      if (!entry) {
        entry = { name, counts: [0, 0, 0, 0, 0, 0], videos: 0, points: 0 };
        tally.set(key, entry);
      }
      entry.counts[rating] += 1;
      entry.videos += 1;
      entry.points += STAR_POINTS[rating];
    }
  }

  const good = (entry) => entry.counts[5] + entry.counts[4];
  return [...tally.values()]
    .filter((entry) => entry.points > 0)
    .sort((a, b) => b.points - a.points || good(b) - good(a) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * Every video that earned a performer their score: fives, then fours, then
 * threes, biggest file first within a rating. Read straight out of the sidecar, so the list
 * costs no network — the size and modified time come from the record's own key,
 * which is what lets the still be looked up later.
 */
function videosForModel(name) {
  const wanted = name.toLowerCase();
  const found = [];
  for (const [key, record] of Object.entries(state.library.records || {})) {
    const rating = record.rating || 0;
    if (rating < 3) continue; // a two or a one scored nothing, so it shows nothing
    if (!(record.models || []).some((m) => String(m).toLowerCase() === wanted)) continue;
    const [size, mtime] = key.split(':').map(Number);
    found.push({ key, name: record.name || '', size: size || 0, mtime: mtime || 0, rating });
  }
  found.sort((a, b) => b.rating - a.rating || b.size - a.size || a.name.localeCompare(b.name));
  return found;
}

/**
 * Stills arrive in two hops — search for the item, then batch its thumbnail —
 * so they load as a row scrolls into view rather than all at once. Thirty
 * performers would otherwise be a hundred and fifty searches for a panel
 * showing three rows.
 */
const favObserver = new IntersectionObserver((entries) => {
  const rows = entries.filter((e) => e.isIntersecting).map((e) => e.target);
  for (const row of rows) favObserver.unobserve(row);
  if (rows.length) fillStills(rows);
}, { rootMargin: '200px 0px' });

async function fillStills(rows) {
  // Only the stills within a screen's width of the visible strip: a row can now
  // hold thirty of them, and each one costs a search.
  const shots = rows.flatMap((row) => {
    const strip = row.querySelector('.fav-shots');
    if (!strip) return [];
    const reach = strip.scrollLeft + strip.clientWidth * 2;
    return [...row.querySelectorAll('.fav-shot')]
      .filter((shot) => !shot.dataset.id && shot.offsetLeft < reach);
  });
  const wanted = shots.map((shot) => ({
    name: shot.dataset.name, size: Number(shot.dataset.size), mtime: Number(shot.dataset.mtime),
  })).filter((w) => w.name);
  if (!wanted.length) return;

  let items;
  try {
    items = await graph.findVideos(wanted);
  } catch {
    return;
  }

  const byShot = new Map();
  for (const shot of shots) {
    const item = items.get(`${shot.dataset.size}:${Math.round(Number(shot.dataset.mtime))}`);
    if (item) byShot.set(shot, item);
  }
  if (!byShot.size) return;

  // The item is kept on the element: tapping the still has to open that video,
  // and this is the only place its id is known.
  for (const [shot, item] of byShot) {
    shot.dataset.id = item.id;
    shot.dataset.drive = item.driveId;
    favItems.set(item.id, item);
  }

  try {
    const thumbs = await graph.thumbnailsFor([...byShot.values()]);
    for (const [shot, item] of byShot) {
      const url = thumbs.get(item.id);
      if (url) shot.style.backgroundImage = `url("${url}")`;
    }
  } catch { /* the tile stays blank */ }
}

const favItems = new Map();

function openFavourites() {
  const list = $('#favList');
  list.innerHTML = '';
  $('#fav').hidden = false;

  const models = topModels(20);
  $('#favHint').textContent = models.length
    ? 'A five-star video is worth a thousand points, a four-star a hundred, a three-star ten, everything else nothing. Tap a name for everything of theirs, or a still to play it.'
    : 'Nothing to rank yet — rate a few videos three stars or better and name who is in them.';

  for (const [index, entry] of models.entries()) {
    const row = document.createElement('div');
    row.className = 'fav-row';

    const line = document.createElement('div');
    line.className = 'fav-line';
    line.innerHTML = '<span class="fav-rank"></span><span class="fav-name"></span>'
      + '<span class="fav-score"></span><span class="fav-counts dim"></span>'
      + '<span class="fav-total dim"></span>';
    line.querySelector('.fav-rank').textContent = String(index + 1);
    line.querySelector('.fav-name').textContent = entry.name;
    line.querySelector('.fav-score').textContent = entry.points.toLocaleString();
    line.querySelector('.fav-counts').textContent = [5, 4, 3]
      .filter((star) => entry.counts[star])
      .map((star) => entry.counts[star] + '×' + '★'.repeat(star))
      .join('  ');
    line.querySelector('.fav-total').textContent = entry.videos
      + (entry.videos === 1 ? ' video' : ' videos');
    line.addEventListener('click', () => showModel(entry.name));
    row.appendChild(line);

    row.appendChild(buildStrip(videosForModel(entry.name), entry.name));
    favObserver.observe(row);
    list.appendChild(row);
  }
}

/**
 * A performer's stills, with arrows when there are more than fit.
 *
 * Someone with thirty four-star videos gets thirty stills, so the row scrolls.
 * A finger can swipe it directly; the arrows are for a mouse, and for saying
 * that there is more to the right at all.
 */
function buildStrip(videos, modelName) {
  const wrap = document.createElement('div');
  wrap.className = 'fav-strip';

  const strip = document.createElement('div');
  strip.className = 'fav-shots';
  for (const video of videos) {
    const shot = document.createElement('div');
    shot.className = 'fav-shot';
    shot.dataset.name = video.name;
    shot.dataset.size = String(video.size);
    shot.dataset.mtime = String(video.mtime);
    shot.title = video.name;
    shot.innerHTML = `<span class="fav-shot-rating">${video.rating}</span>`;
    shot.addEventListener('click', (ev) => {
      ev.stopPropagation();
      playFromStill(shot, modelName);
    });
    strip.appendChild(shot);
  }
  wrap.appendChild(strip);

  const arrow = (where, glyph) => {
    const btn = document.createElement('button');
    btn.className = `fav-arrow ${where}`;
    btn.textContent = glyph;
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const step = Math.max(120, strip.clientWidth * 0.8);
      strip.scrollBy({ left: where === 'next' ? step : -step, behavior: 'smooth' });
    });
    wrap.appendChild(btn);
    return btn;
  };
  const back = arrow('prev', '‹');
  const on = arrow('next', '›');

  // An arrow with nowhere to go invites a press that does nothing, so both stay
  // hidden until the strip has actually overflowed, and are rechecked as it
  // moves since either end can run out.
  const sync = () => {
    const room = strip.scrollWidth - strip.clientWidth;
    back.hidden = strip.scrollLeft < 4;
    on.hidden = room < 4 || strip.scrollLeft > room - 4;
  };
  strip.addEventListener('scroll', sync);
  requestAnimationFrame(sync);

  return wrap;
}

/**
 * Everything by one performer: the drive root with the subfolders flattened,
 * because their videos are spread across studio folders and the answer is never
 * inside the folder you happen to be standing in.
 */
async function showModel(name) {
  $('#fav').hidden = true;
  adv = newAdvFilter();
  adv.models.set(name, 'in');
  advDraft = newAdvFilter();
  $('#search').value = '';
  state.query = '';
  $('#advDot').hidden = false;
  $('#advBtn').classList.add('on');
  state.sort = 'rating';
  state.sortDir = 'desc';
  $('#sortSelect').value = 'rating';
  state.flatten = true;
  $('#flatBtn').classList.add('on');
  toast(`Looking for ${name} across everything…`, 'ok');
  await openFolder(null);
}

/** A still is a video, so tapping one plays it. */
async function playFromStill(shot, name) {
  const item = shot.dataset.id ? favItems.get(shot.dataset.id) : null;
  if (!item) {
    toast('Still finding that one — try again in a moment', 'err');
    return;
  }
  $('#fav').hidden = true;
  // The player walks whatever is listed, so put their videos behind it first.
  if (!state.videos.some((v) => v.id === item.id)) state.videos.unshift(item);
  await openPlayer(item);
}

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
    text: '',
    tags: new Map(),
    models: new Map(),
    studio: new Map(),
    ratings: new Map(),
    // Per facet: "all of these tags" and "any of these performers" is a
    // reasonable pair to ask for. Exclusions are always all-of, since "not
    // this" means not this either way. The studio has none — one studio per
    // video makes all-of empty by construction.
    mode: { tags: 'all', models: 'all' },
    link: 'all',          // 'all' | 'yes' | 'no'
    folders: new Set(),   // still a Set: these load videos rather than filter them
  };
}

/**
 * The "no tags" / "no models" chip lives in the same map as the values, under a
 * key no label can have — so it copies, clears and counts for free.
 */
const NOTHING = '\u0000';

const FACETS = ['tags', 'models', 'studio', 'ratings'];

let adv = newAdvFilter();
let advDraft = newAdvFilter();

function advActive(f = adv) {
  return Boolean(f.text) || f.link !== 'all' || f.folders.size
    || FACETS.some((name) => f[name].size > 0);
}

/** The values a facet requires, or excludes. The emptiness chip is not a value. */
function picked(facet, want) {
  return [...facet].filter(([value, mode]) => mode === want && value !== NOTHING)
    .map(([value]) => value);
}

/** Everything in use for a field across the whole library, not just this folder. */
function vocabulary(field = 'tags') {
  const counts = new Map();
  for (const record of Object.values(state.library.records || {})) {
    const values = field === 'studio'
      ? (record.studio ? [record.studio] : [])
      : (record[field] || []);
    for (const tag of values) {
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
  return vocabulary(field).sort((a, b) =>
    a.tag.localeCompare(b.tag, undefined, { numeric: true, sensitivity: 'base' }));
}

function matchesAdv(video) {
  if (adv.text) {
    const hay = video.name.toLowerCase();
    if (!adv.text.split(/\s+/).filter(Boolean).every((t) => hay.includes(t))) return false;
  }

  const record = recordFor(video);

  if (adv.ratings.size) {
    const rating = record.rating || 0;
    const wanted = picked(adv.ratings, 'in');
    const barred = picked(adv.ratings, 'out');
    if (wanted.length && !wanted.includes(rating)) return false;
    if (barred.includes(rating)) return false;
  }

  if (adv.link === 'yes' && !record.url) return false;
  if (adv.link === 'no' && record.url) return false;

  for (const field of ['tags', 'models', 'studio']) {
    if (!adv[field].size) continue;
    const held = field === 'studio'
      ? (record.studio ? [record.studio] : [])
      : (record[field] || []);
    const have = new Set(held.map((t) => String(t).toLowerCase()));

    // "Has none at all" is its own question, asked before any value is compared.
    const nothing = adv[field].get(NOTHING);
    if (nothing === 'in' && have.size) return false;
    if (nothing === 'out' && !have.size) return false;

    const wanted = picked(adv[field], 'in').map((t) => t.toLowerCase());
    const barred = picked(adv[field], 'out').map((t) => t.toLowerCase());
    const mode = adv.mode[field] || 'all';
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

function openAdv() {
  advDraft = {
    ...adv,
    tags: new Map(adv.tags),
    models: new Map(adv.models),
    studio: new Map(adv.studio),
    ratings: new Map(adv.ratings),
    mode: { ...adv.mode },
    folders: new Set(adv.folders),
  };
  $('#advText').value = advDraft.text;
  $('#adv').hidden = false;
  renderAdv();
}

function renderAdv() {
  const ratings = $('#advRating');
  ratings.innerHTML = '';
  for (const value of [0, 1, 2, 3, 4, 5]) {
    ratings.appendChild(advChip(
      value === 0 ? 'unrated' : '★'.repeat(value),
      advDraft.ratings.get(value),
      () => { cycleIn(advDraft.ratings, value); renderAdv(); },
    ));
  }

  // No studio green or model gold in here: this panel paints green for
  // "required" and red for "excluded", so an unselected studio chip in its own
  // colour reads as one that has been chosen. The label colours belong on a
  // card, where nothing else is coloured.
  for (const [field, box, none] of [
    ['studio', '#advStudio', 'no studio'],
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

  const link = $('#advLink');
  link.innerHTML = '';
  for (const [value, label] of [['all', 'everything'], ['yes', 'has a link'], ['no', 'no link']]) {
    const chip = advChip(label, advDraft.link === value ? 'in' : undefined, () => {
      advDraft.link = value;
      renderAdv();
    });
    link.appendChild(chip);
  }

  $('#advTagMode').textContent = advDraft.mode.tags;
  $('#advModelMode').textContent = advDraft.mode.models;

  const folders = $('#advFolders');
  folders.innerHTML = '';
  if (!state.folders.length) folders.innerHTML = '<span class="dim">No subfolders here</span>';
  for (const folder of state.folders) {
    folders.appendChild(advChip(folder.name, advDraft.folders.has(folder.id) ? 'in' : undefined, () => {
      toggleIn(advDraft.folders, folder.id);
      renderAdv();
    }));
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
  if (advDraft.folders.size) bits.push(`${advDraft.folders.size} folder${advDraft.folders.size === 1 ? '' : 's'}`);
  say('studio', 'studio', 'studios');
  say('models', 'model');
  say('tags', 'tag');
  say('ratings', 'rating');
  if (advDraft.link === 'yes') bits.push('linked');
  if (advDraft.link === 'no') bits.push('unlinked');
  $('#advSummary').textContent = bits.join(' · ') || 'no filters';
}

function advChip(label, mode, onClick) {
  const chip = document.createElement('button');
  chip.className = 'chip tri' + (mode === 'in' ? ' in' : mode === 'out' ? ' out' : '');
  chip.textContent = label;
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

function toggleIn(set, value) {
  if (set.has(value)) set.delete(value);
  else set.add(value);
}

async function applyAdv() {
  advDraft.text = $('#advText').value.trim().toLowerCase();
  const folders = [...advDraft.folders];
  adv = advDraft;
  $('#adv').hidden = true;
  $('#advDot').hidden = !advActive();
  $('#advBtn').classList.toggle('on', advActive());

  if (folders.length) await loadFoldersInto(folders);
  gridKey = '';
  render();
}

/**
 * Clears every facet and means it, rather than leaving Apply to be pressed —
 * which is what the desktop does, and for the same reason: saying "show me
 * everything" should not take two taps.
 */
async function resetAdv() {
  advDraft = newAdvFilter();
  $('#advText').value = '';
  renderAdv();
  await applyAdv();
}

/**
 * Tapping a pill on a card is a filter, not a search: exactly that one value in
 * its own facet, with everything else cleared. It used to type `#tag` into the
 * search box, which left the filter panel describing something else.
 */
function filterByLabel(field, value) {
  adv = newAdvFilter();
  adv[field].set(value, 'in');
  advDraft = newAdvFilter();
  $('#search').value = '';
  state.query = '';
  $('#advText').value = '';
  $('#advDot').hidden = !advActive();
  $('#advBtn').classList.toggle('on', advActive());
  gridKey = '';
  render();
  toast(`${value} — ${filterByName(state.videos).length} here`, 'ok');
}

/**
 * Pulls every video below each chosen folder into the current view.
 *
 * This is the "including sub-directories" part, and on Graph it is a real walk:
 * one listing per folder, depth-first. It reports progress and stops at a depth
 * limit, because a careless tap at the drive root would otherwise enumerate the
 * entire library.
 */
async function loadFoldersInto(folderIds) {
  const run = state.load;
  const queue = state.folders.filter((f) => folderIds.includes(f.id))
    .map((f) => ({ driveId: f.driveId, itemId: f.id, name: f.name, depth: 0 }));
  const MAX_DEPTH = 4;
  let scanned = 0;

  while (queue.length) {
    const folder = queue.shift();
    if (state.load !== run) return; // navigated away
    setBusy(`Searching ${folder.name}… ${state.videos.length} found`);
    try {
      let next = null;
      do {
        const page = await graph.listPage(folder.driveId, folder.itemId, next);
        state.videos.push(...page.videos);
        next = page.next;
      } while (next);

      if (folder.depth < MAX_DEPTH) {
        const subs = await graph.listFolders(folder.driveId, folder.itemId);
        for (const sub of subs) {
          queue.push({ driveId: sub.driveId, itemId: sub.id, name: sub.name, depth: folder.depth + 1 });
        }
      }
    } catch (err) {
      toast(`${folder.name}: ${err.message}`, 'err');
    }
    scanned += 1;
    if (scanned % 3 === 0) { gridKey = ''; render(); }
  }
  setBusy('');
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

  if (moved) toast(`Moved ${moved} to ${dest.name}`, 'ok');
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
  else thumbObserver.observe(shot);

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
  card.appendChild(buildFolderLine(video));
  return card;
}

/**
 * The three kinds of label, in the order the desktop shows them: the studio
 * first — the one there can only be one of — then the performers, then the
 * tags. Only tags carry the "+" here; the editor it opens covers all three, so
 * three buttons would have opened the same sheet.
 */
const LABEL_FIELDS = [
  { field: 'studio', chip: 'chip studio', values: (r) => (r.studio ? [r.studio] : []) },
  { field: 'models', chip: 'chip model', values: (r) => r.models || [] },
  { field: 'tags', chip: 'chip', values: (r) => r.tags || [] },
];

function buildLabelChips(video, row) {
  const record = recordFor(video);
  const chips = document.createElement('span');
  chips.className = 'chips';

  for (const spec of LABEL_FIELDS) {
    for (const value of spec.values(record)) {
      const chip = document.createElement('button');
      chip.className = spec.chip;
      chip.textContent = value;
      chip.title = value;
      chip.addEventListener('click', (ev) => {
        ev.stopPropagation();
        filterByLabel(spec.field, value);
      });
      chips.appendChild(chip);
    }
  }

  const add = document.createElement('button');
  add.className = 'chip add';
  add.textContent = (record.tags || []).length ? '+' : '+ tag';
  add.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openLabels([video]);
  });
  chips.appendChild(add);
  return chips;
}

/**
 * Date, folder, and the source page when the record carries one — the same line
 * the desktop puts under a card. The folder matters most with the subfolders
 * flattened, which is the only time a listing mixes them.
 */
function buildFolderLine(video) {
  const record = recordFor(video);
  const line = document.createElement('div');
  line.className = 'folder-line';

  const where = document.createElement('span');
  where.className = 'folder-where';
  const when = video.mtime ? new Date(video.mtime).toLocaleDateString() : '';
  where.textContent = [when, video.folderName || ''].filter(Boolean).join('  •  ');
  line.appendChild(where);

  if (record.url) {
    const link = document.createElement('a');
    link.className = 'source-link';
    link.href = record.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    let host = 'source';
    try { host = new URL(record.url).hostname.replace(/^www\./, ''); } catch { /* keep the fallback */ }
    link.textContent = host + ' \u2197';
    link.addEventListener('click', (ev) => ev.stopPropagation());
    line.appendChild(link);
  }

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

function openLabels(videos) {
  if (!videos.length) return;
  labelTargets = videos;
  const single = videos.length === 1;

  $('#labelsTitle').textContent = single ? videos[0].name : `${videos.length} videos`;
  $('#labelsHint').textContent = single
    ? 'Add appends, Replace overwrites.'
    : `Add appends to each. Replace overwrites all ${videos.length}.`;
  $('#labelsReplace').textContent = single ? 'Replace' : `Replace on ${videos.length}`;

  // One video's values make Replace a sensible edit; across several there is no
  // shared starting point unless they already agree.
  const first = recordFor(videos[0]);
  $('#labelTags').value = single ? (first.tags || []).join(', ') : '';
  $('#labelModels').value = single ? (first.models || []).join(', ') : '';
  const studios = new Set(videos.map((v) => recordFor(v).studio || ''));
  $('#labelStudio').value = studios.size === 1 ? [...studios][0] : '';

  renderLabelSuggestions();
  $('#labels').hidden = false;
}

const LABEL_INPUTS = {
  studio: { input: '#labelStudio', suggest: '#labelStudioSuggest', chip: 'chip studio', single: true },
  models: { input: '#labelModels', suggest: '#labelModelsSuggest', chip: 'chip model' },
  tags: { input: '#labelTags', suggest: '#labelTagsSuggest', chip: 'chip' },
};

function parseList(text) {
  return text.split(',').map((t) => t.trim()).filter(Boolean);
}

/** The vocabulary as taps, which beats typing a name on a phone. */
function renderLabelSuggestions() {
  for (const [field, spec] of Object.entries(LABEL_INPUTS)) {
    const box = $(spec.suggest);
    box.innerHTML = '';
    const vocab = vocabularyByName(field);
    if (!vocab.length) {
      box.innerHTML = '<span class="dim">nothing yet</span>';
      continue;
    }
    const used = new Set(parseList($(spec.input).value).map((t) => t.toLowerCase()));
    for (const entry of vocab.slice(0, 60)) {
      const chip = document.createElement('button');
      chip.className = spec.chip + (used.has(entry.tag.toLowerCase()) ? ' on' : '');
      chip.textContent = `${entry.tag} · ${entry.count}`;
      chip.addEventListener('click', () => {
        if (spec.single) {
          // One value: a second tap swaps it, tapping the current one clears it.
          const now = $(spec.input).value.trim().toLowerCase();
          $(spec.input).value = now === entry.tag.toLowerCase() ? '' : entry.tag;
        } else {
          const current = parseList($(spec.input).value);
          const at = current.findIndex((t) => t.toLowerCase() === entry.tag.toLowerCase());
          if (at >= 0) current.splice(at, 1);
          else current.push(entry.tag);
          $(spec.input).value = current.join(', ');
        }
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
  openPlayer(list[Math.min(at < 0 ? 0 : at, list.length - 1)]);
}

function commitLabels(mode) {
  const tags = parseList($('#labelTags').value);
  const models = parseList($('#labelModels').value);
  const studio = $('#labelStudio').value.trim();
  const videos = labelTargets;
  $('#labels').hidden = true;

  for (const video of videos) {
    const record = recordFor(video);
    const patch = mode === 'replace'
      ? { tags, models, studio }
      : {
        tags: [...(record.tags || []), ...tags],
        models: [...(record.models || []), ...models],
        ...(studio ? { studio } : {}),
      };
    editRecord(video, patch);
  }

  const before = playerList();
  render();
  followListing(before);
  const n = videos.length;
  toast(mode === 'replace'
    ? `Labels set on ${n} video${n === 1 ? '' : 's'}`
    : `Added to ${n} video${n === 1 ? '' : 's'}`, 'ok');
}

function buildRecordRow(video) {
  const record = recordFor(video);
  const row = document.createElement('div');
  row.className = 'record';

  const stars = document.createElement('span');
  stars.className = 'stars';
  for (let n = 1; n <= 5; n += 1) {
    const star = document.createElement('button');
    star.className = 'star' + (n <= (record.rating || 0) ? ' on' : '');
    star.textContent = n <= (record.rating || 0) ? '★' : '☆';
    star.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const before = playerList();
      editRecord(video, { rating: n === record.rating ? 0 : n });
      row.replaceWith(buildRecordRow(video));
      if (advActive()) { render(); followListing(before); }
    });
    stars.appendChild(star);
  }
  row.appendChild(stars);

  row.appendChild(buildLabelChips(video, row));
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
    if (!session.ready) { session.pending = fraction; return; }
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
const preview = { timer: null, index: 0, count: 10 };

function startPreview() {
  stopPreview();
  const el = $('#playerVideo');
  el.controls = false;
  el.muted = true;
  $('#playerPlay').hidden = false;
  $('#playerBadge').hidden = false;
  preview.index = 0;

  const show = (index) => {
    preview.index = index;
    const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
    if (!duration) return; // metadata still coming; the timer retries
    const at = (duration / (preview.count + 1)) * (index + 1);
    try { el.currentTime = at; } catch { return; }
    el.play().catch(() => {});
    $('#playerBadge').textContent = `${index + 1}/${preview.count} · ${fmtTime(at)}`;
  };

  el.addEventListener('loadedmetadata', () => show(0), { once: true });
  if (el.readyState >= 1) show(0);
  preview.timer = setInterval(() => show((preview.index + 1) % preview.count), 1000);
}

function stopPreview() {
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
  try { el.currentTime = 0; } catch { /* not seekable yet; it starts at 0 anyway */ }
  el.play().catch(() => {});
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
  box.appendChild(buildRecordRow(video));
  box.appendChild(buildFolderLine(video));
}

async function openPlayer(video) {
  const modal = $('#player');
  const el = $('#playerVideo');
  if (modal.hidden) playerReturn = window.scrollY; // only the way in sets the mark
  state.playingId = video.id;
  state.playingAnchor = null; // it is in the listing until an edit says otherwise
  syncPlayerNav();
  $('#playerName').textContent = video.name;
  renderPlayerDetails(video);
  $('#playerInfo').hidden = true;
  syncSoundButton();
  modal.hidden = false;
  setBusy('Opening…');
  try {
    el.src = await graph.streamUrl(video.driveId, video.id);
    // Once you have asked for sound, opening a video means watching it.
    if (soundOn) beginPlayback();
    else startPreview();
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
  return filterByName(state.videos).filter((v) => !v.isFolder);
}

function playSibling(step) {
  const list = playerList();
  if (list.length < 2 || !state.playingId) return;
  const at = list.findIndex((v) => v.id === state.playingId);
  if (at < 0) return;
  openPlayer(list[((at + step) % list.length + list.length) % list.length]);
}

/** Hides the arrows when there is nowhere to go, and says where you are. */
function syncPlayerNav() {
  const list = playerList();
  const at = list.findIndex((v) => v.id === state.playingId);
  const usable = list.length > 1 && at >= 0;
  $('#playerPrev').hidden = !usable;
  $('#playerNext').hidden = !usable;
  const pos = $('#playerPos');
  pos.hidden = at < 0;
  pos.textContent = at < 0 ? '' : `${at + 1} / ${list.length}`;
}

/**
 * Horizontal swipes only, and not from the bottom of the screen: that strip is
 * the video's own controls, where a sideways drag is a seek.
 */
function attachPlayerSwipe() {
  const modal = $('#player');
  let from = null;

  modal.addEventListener('touchstart', (ev) => {
    // The bar and the arrows are taps, not swipes.
    if (ev.touches.length !== 1 || ev.target.closest('.player-bar, .player-nav')) { from = null; return; }
    const t = ev.touches[0];
    from = t.clientY > window.innerHeight - 90 ? null : { x: t.clientX, y: t.clientY };
  }, { passive: true });

  modal.addEventListener('touchend', (ev) => {
    if (!from) return;
    const t = ev.changedTouches[0];
    const dx = t.clientX - from.x;
    const dy = t.clientY - from.y;
    from = null;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    playSibling(dx < 0 ? 1 : -1);
  }, { passive: true });
}

function closePlayer() {
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

async function boot() {
  $('#signIn').addEventListener('click', () => auth.signIn().catch((e) => toast(e.message, 'err')));
  $('#signOut').addEventListener('click', () => { auth.signOut(); location.reload(); });
  $('#playerClose').addEventListener('click', closePlayer);
  $('#playerPrev').addEventListener('click', () => playSibling(-1));
  $('#playerNext').addEventListener('click', () => playSibling(1));
  attachPlayerSwipe();
  $('#loadMore').addEventListener('click', () => loadMore(state.flatten ? FLAT_PAGES : AUTO_PAGES));

  // Flatten is a view you reach for rather than a mode you live in, so it is not
  // persisted -- same as the desktop, which resets it at every launch.
  $('#flatBtn').addEventListener('click', () => {
    state.flatten = !state.flatten;
    $('#flatBtn').classList.toggle('on', state.flatten);
    const here = state.stack[state.stack.length - 1] || null;
    openFolder(here, { push: false });
  });
  $('#sortSelect').value = state.sort;
  $('#sortDir').textContent = state.sortDir === 'desc' ? '↓' : '↑';
  $('#sortSelect').addEventListener('change', (ev) => {
    state.sort = ev.target.value;
    gridKey = ''; // the order changed, so the grid has to be rebuilt
    render();
  });
  $('#sortDir').addEventListener('click', () => {
    state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
    $('#sortDir').textContent = state.sortDir === 'desc' ? '↓' : '↑';
    gridKey = '';
    render();
  });

  $('#advBtn').addEventListener('click', openAdv);
  $('#advClose').addEventListener('click', () => { $('#adv').hidden = true; });
  $('#advApply').addEventListener('click', applyAdv);
  $('#advReset').addEventListener('click', () => {
    resetAdv();
  });
  for (const [field, id] of [['tags', '#advTagMode'], ['models', '#advModelMode']]) {
    $(id).addEventListener('click', () => {
      advDraft.mode[field] = advDraft.mode[field] === 'all' ? 'any' : 'all';
      renderAdv();
    });
  }
  $('#labelsClose').addEventListener('click', () => { $('#labels').hidden = true; });
  $('#labelsAdd').addEventListener('click', () => commitLabels('add'));
  $('#labelsReplace').addEventListener('click', () => commitLabels('replace'));
  for (const spec of Object.values(LABEL_INPUTS)) {
    $(spec.input).addEventListener('input', renderLabelSuggestions);
  }
  $('#selDelete').addEventListener('click', deleteSelection);
  $('#setBtn').addEventListener('click', openSettings);
  $('#settingsClose').addEventListener('click', () => { $('#settings').hidden = true; });
  $('#setCardWidth').addEventListener('input', (ev) => {
    state.cardWidth = Number(ev.target.value) || 460;
    $('#setCardWidthLabel').textContent = state.cardWidth + 'px';
    applyCardWidth();
    saveSettings();
  });
  $('#setPageSize').addEventListener('change', (ev) => {
    state.pageSize = Number(ev.target.value) || 200;
    graph.setPageSize(state.pageSize);
    saveSettings();
  });
  $('#playerPlay').addEventListener('click', beginPlayback);
  $('#playerSound').addEventListener('click', () => setSoundOn(!soundOn));
  $('#playerInfoBtn').addEventListener('click', () => {
    const box = $('#playerInfo');
    box.hidden = !box.hidden;
  });
  $('#favBtn').addEventListener('click', openFavourites);
  $('#favClose').addEventListener('click', () => { $('#fav').hidden = true; });
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
  $('#search').addEventListener('input', (ev) => {
    state.query = ev.target.value.trim().toLowerCase();
    render();
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
  pushTrap(); // gives the Android back button something to pop

  try {
    state.account = await graph.me();
    $('#account').textContent = state.account.email || state.account.name;
  } catch (err) {
    toast(err.message, 'err');
    $('#gate').hidden = false;
    $('#main').hidden = true;
    return;
  }

  loadSettings();
  state.library = await graph.loadLibrary();
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
    render, renderAdv, openAdv, applyAdv, resetAdv, filterByLabel,
    openLabels, commitLabels, renderLabelSuggestions,
    buildCard, buildRecordRow, buildFolderLine, filterByName, sortVideos,
    topModels, videosForModel, openFavourites, showModel, buildStrip,
    atRoot, isLibraryFolder,
    openPlayer, beginPlayback, startPreview, stopPreview, followListing,
    deleteSelection, openSettings, loadSettings, applyCardWidth,
    get soundOn() { return soundOn; }, setSoundOn, playerList,
  };
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

boot();
