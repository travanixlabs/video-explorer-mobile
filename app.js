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

function recordFor(video) {
  return state.library.records[graph.recordKey(video)] || { rating: 0, tags: [] };
}

function editRecord(video, patch) {
  const key = graph.recordKey(video);
  const current = state.library.records[key] || { rating: 0, tags: [], name: video.name };
  const next = { ...current, name: video.name, updated: Date.now(), ...patch };
  // An empty record is noise in a file that syncs; match the desktop and drop it.
  if (!next.rating && !(next.tags || []).length) {
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
    state.folders = folders;
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
        state.queue.push(...page.folders.map((f) => ({ driveId: f.driveId, itemId: f.id })));
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
  const picked = selectedVideos();
  if (!picked.length) return;
  const typed = window.prompt(`Tags to add to ${picked.length} video${picked.length === 1 ? '' : 's'}, comma separated`, '');
  if (typed === null) return;
  const adding = typed.split(',').map((t) => t.trim()).filter(Boolean);
  if (!adding.length) return;

  for (const video of picked) {
    const existing = recordFor(video).tags || [];
    // Merge rather than replace: tagging ten videos must not wipe what nine of
    // them already had. Case-insensitive dedupe, first spelling wins.
    const seen = new Map();
    for (const tag of [...existing, ...adding]) {
      const key = tag.toLowerCase();
      if (!seen.has(key)) seen.set(key, tag);
    }
    editRecord(video, { tags: [...seen.values()].sort((a, b) => a.localeCompare(b)) });
  }
  render();
  toast(`Tagged ${picked.length} video${picked.length === 1 ? '' : 's'}`, 'ok');
}

// -------------------------------------------------------- advanced filters

/**
 * Empty sets mean "no constraint", so a fresh filter is transparent rather than
 * matching nothing.
 */
function newAdvFilter() {
  return {
    text: '', tags: new Set(), tagMode: 'all',
    ratings: new Set(), folders: new Set(),
  };
}

let adv = newAdvFilter();
let advDraft = newAdvFilter();

function advActive(f = adv) {
  return Boolean(f.text) || f.tags.size || f.ratings.size || f.folders.size;
}

/** Everything in use for a field across the whole library, not just this folder. */
function vocabulary(field = 'tags') {
  const counts = new Map();
  for (const record of Object.values(state.library.records || {})) {
    for (const tag of record[field] || []) {
      const key = tag.toLowerCase();
      const hit = counts.get(key);
      if (hit) hit.count += 1;
      else counts.set(key, { tag, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

function matchesAdv(video) {
  if (adv.text) {
    const hay = video.name.toLowerCase();
    if (!adv.text.split(/\s+/).filter(Boolean).every((t) => hay.includes(t))) return false;
  }
  const record = recordFor(video);
  if (adv.ratings.size && !adv.ratings.has(record.rating || 0)) return false;

  if (adv.tags.size) {
    const have = new Set((record.tags || []).map((t) => t.toLowerCase()));
    const wanted = [...adv.tags].map((t) => t.toLowerCase());
    const hit = adv.tagMode === 'any' ? wanted.some((t) => have.has(t)) : wanted.every((t) => have.has(t));
    if (!hit) return false;
  }
  // Folder selection is handled by loading those folders' videos, not by
  // filtering — there is nothing to filter until they have been fetched.
  return true;
}

function openAdv() {
  advDraft = {
    ...adv,
    tags: new Set(adv.tags),
    ratings: new Set(adv.ratings),
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
      advDraft.ratings.has(value),
      () => { toggleIn(advDraft.ratings, value); renderAdv(); },
    ));
  }

  const box = $('#advTags');
  const vocab = vocabulary();
  box.innerHTML = vocab.length ? '' : '<span class="dim">No tags yet</span>';
  for (const entry of vocab) {
    box.appendChild(advChip(`${entry.tag} · ${entry.count}`, advDraft.tags.has(entry.tag), () => {
      toggleIn(advDraft.tags, entry.tag);
      renderAdv();
    }));
  }
  $('#advTagMode').textContent = advDraft.tagMode;

  const folders = $('#advFolders');
  folders.innerHTML = '';
  if (!state.folders.length) folders.innerHTML = '<span class="dim">No subfolders here</span>';
  for (const folder of state.folders) {
    folders.appendChild(advChip(folder.name, advDraft.folders.has(folder.id), () => {
      toggleIn(advDraft.folders, folder.id);
      renderAdv();
    }));
  }

  const bits = [];
  if (advDraft.folders.size) bits.push(`${advDraft.folders.size} folder${advDraft.folders.size === 1 ? '' : 's'}`);
  if (advDraft.tags.size) bits.push(`${advDraft.tags.size} tag${advDraft.tags.size === 1 ? '' : 's'}`);
  if (advDraft.ratings.size) bits.push(`${advDraft.ratings.size} rating${advDraft.ratings.size === 1 ? '' : 's'}`);
  $('#advSummary').textContent = bits.join(' · ') || 'no filters';
}

function advChip(label, on, onClick) {
  const chip = document.createElement('button');
  chip.className = 'chip' + (on ? ' on' : '');
  chip.textContent = label;
  chip.addEventListener('click', onClick);
  return chip;
}

function toggleIn(set, value) {
  if (set.has(value)) set.delete(value);
  else set.add(value);
}

async function applyAdv() {
  advDraft.text = $('#advText').value.trim().toLowerCase();
  const picked = [...advDraft.folders];
  adv = advDraft;
  $('#adv').hidden = true;
  $('#advDot').hidden = !advActive();
  $('#advBtn').classList.toggle('on', advActive());

  if (picked.length) await loadFoldersInto(picked);
  gridKey = '';
  render();
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
  return card;
}

function buildTagChips(video, row) {
  const record = recordFor(video);
  const chips = document.createElement('span');
  chips.className = 'chips';

  for (const value of record.tags || []) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = value;
    chip.addEventListener('click', (ev) => {
      ev.stopPropagation();
      $('#search').value = '#' + value;
      state.query = ('#' + value).toLowerCase();
      render();
    });
    chips.appendChild(chip);
  }

  const add = document.createElement('button');
  add.className = 'chip add';
  add.textContent = (record.tags || []).length ? '+' : '+ tag';
  add.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const typed = window.prompt('Tags, comma separated', (record.tags || []).join(', '));
    if (typed === null) return;
    editRecord(video, { tags: typed.split(',').map((t) => t.trim()).filter(Boolean) });
    row.replaceWith(buildRecordRow(video));
  });
  chips.appendChild(add);
  return chips;
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
      editRecord(video, { rating: n === record.rating ? 0 : n });
      row.replaceWith(buildRecordRow(video));
    });
    stars.appendChild(star);
  }
  row.appendChild(stars);

  row.appendChild(buildTagChips(video, row));
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

async function openPlayer(video) {
  const modal = $('#player');
  const el = $('#playerVideo');
  if (modal.hidden) playerReturn = window.scrollY; // only the way in sets the mark
  state.playingId = video.id;
  syncPlayerNav();
  $('#playerName').textContent = video.name;
  modal.hidden = false;
  setBusy('Opening…');
  try {
    el.src = await graph.streamUrl(video.driveId, video.id);
    await el.play().catch(() => {});
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
    advDraft = newAdvFilter();
    $('#advText').value = '';
    renderAdv();
  });
  $('#advTagMode').addEventListener('click', () => {
    advDraft.tagMode = advDraft.tagMode === 'all' ? 'any' : 'all';
    renderAdv();
  });
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

  state.library = await graph.loadLibrary();
  await openFolder(null);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

boot();
