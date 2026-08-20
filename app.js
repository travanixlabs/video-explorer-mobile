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
  return state.library.records[graph.recordKey(video)] || { rating: 0, tags: [], models: [] };
}

function editRecord(video, patch) {
  const key = graph.recordKey(video);
  const current = state.library.records[key] || { rating: 0, tags: [], models: [], name: video.name };
  const next = { ...current, name: video.name, updated: Date.now(), ...patch };
  // An empty record is noise in a file that syncs; match the desktop and drop it.
  if (!next.rating && !(next.tags || []).length && !(next.models || []).length) {
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
  render();
  window.scrollTo(0, 0);
  setBusy('Loading…');

  const driveId = entry ? entry.driveId : null;
  const itemId = entry ? entry.itemId : null;
  state.source = { driveId, itemId, run };

  // Folders and videos are separate queries with different orderings, so they
  // run side by side rather than one behind the other.
  graph.listFolders(driveId, itemId).then((folders) => {
    if (state.load !== run) return;
    state.folders = folders;
    renderFolders();
  }).catch((err) => {
    if (state.load === run) toast(err.message, 'err');
  });

  await loadMore(AUTO_PAGES);
}

// Pages pulled without being asked. Three is roughly 600 videos — enough that
// most folders finish on their own, while the 5,000-video ones stop before
// they have put that many cards into a phone's DOM.
const AUTO_PAGES = 3;

async function loadMore(pages = 1) {
  const { driveId, itemId, run } = state.source;
  let remaining = pages;

  try {
    do {
      const page = await graph.listPage(driveId, itemId, state.next);
      // A folder tapped while this one was still streaming wins; anything this
      // loop produces from here belongs to a screen the user has left.
      if (state.load !== run) return;

      state.videos.push(...page.videos);
      state.next = page.next;
      remaining -= 1;
      render();
      setBusy(state.next && remaining > 0 ? 'Loading more…' : '');
    } while (state.next && remaining > 0);
  } catch (err) {
    if (state.load === run) {
      toast(err.message, 'err');
      setBusy('');
    }
  }
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
  history.pushState(null, '');
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
      const models = (record.models || []).join(' ').toLowerCase();
      const hay = item.name.toLowerCase();
      return terms.every((term) => {
        if (term.startsWith('#')) return tags.includes(term.slice(1));
        if (term.startsWith('@')) return models.includes(term.slice(1));
        // A bare term searches everything: name, tags and models.
        return hay.includes(term) || tags.includes(term) || models.includes(term);
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

function renderVideos() {
  const wrap = $('#videos');
  const list = filterByName(state.videos);
  // Sort belongs in the key: pages arrive in the server's name order, so any
  // other ordering means a new page can belong anywhere and appending is wrong.
  const key = state.stack.map((s) => s.itemId).join('/')
    + '|' + state.query + '|' + state.sort + state.sortDir + '|' + list.length;

  if (key !== gridKey) {
    wrap.innerHTML = '';
    wanted.clear();
    gridKey = key;
    gridCount = 0;
  }
  for (let i = gridCount; i < list.length; i += 1) wrap.appendChild(buildCard(list[i]));
  gridCount = list.length;

  $('#videoCount').textContent = list.length
    ? `${list.length} video${list.length === 1 ? '' : 's'}${state.next ? ' so far' : ''}`
    : (state.next ? 'Loading…' : 'No videos here');

  const more = $('#loadMore');
  more.hidden = !state.next;
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
    text: '', tags: new Set(), models: new Set(), tagMode: 'all',
    ratings: new Set(), folders: new Set(),
  };
}

let adv = newAdvFilter();
let advDraft = newAdvFilter();

function advActive(f = adv) {
  return Boolean(f.text) || f.tags.size || f.models.size || f.ratings.size || f.folders.size;
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

  // Each facet is checked on its own: two models and one tag means "those
  // models AND that tag", not one merged pool.
  for (const field of ['tags', 'models']) {
    if (!adv[field].size) continue;
    const have = new Set((record[field] || []).map((t) => t.toLowerCase()));
    const wanted = [...adv[field]].map((t) => t.toLowerCase());
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
    models: new Set(adv.models),
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

  for (const [field, el, empty] of [
    ['models', '#advModels', 'No models yet'],
    ['tags', '#advTags', 'No tags yet'],
  ]) {
    const box = $(el);
    const vocab = vocabulary(field);
    box.innerHTML = vocab.length ? '' : `<span class="dim">${empty}</span>`;
    for (const entry of vocab) {
      box.appendChild(advChip(`${entry.tag} · ${entry.count}`, advDraft[field].has(entry.tag), () => {
        toggleIn(advDraft[field], entry.tag);
        renderAdv();
      }));
    }
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
  if (advDraft.models.size) bits.push(`${advDraft.models.size} model${advDraft.models.size === 1 ? '' : 's'}`);
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

/**
 * Models and tags are the same shape, so one builder covers both — mirroring the
 * desktop, where they stay separate fields rather than a tag naming convention.
 */
function buildLabelChips(video, field, row) {
  const record = recordFor(video);
  const prefix = field === 'models' ? '@' : '#';
  const chips = document.createElement('span');
  chips.className = 'chips';

  for (const value of record[field] || []) {
    const chip = document.createElement('button');
    chip.className = 'chip' + (field === 'models' ? ' chip-model' : '');
    chip.textContent = value;
    chip.addEventListener('click', (ev) => {
      ev.stopPropagation();
      $('#search').value = prefix + value;
      state.query = (prefix + value).toLowerCase();
      render();
    });
    chips.appendChild(chip);
  }

  const add = document.createElement('button');
  add.className = 'chip add' + (field === 'models' ? ' chip-model' : '');
  add.textContent = (record[field] || []).length ? '+' : (field === 'models' ? '+ model' : '+ tag');
  add.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const typed = window.prompt(
      field === 'models' ? 'Models, comma separated' : 'Tags, comma separated',
      (record[field] || []).join(', '),
    );
    if (typed === null) return;
    editRecord(video, { [field]: typed.split(',').map((t) => t.trim()).filter(Boolean) });
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

  row.appendChild(buildLabelChips(video, 'models', row));
  row.appendChild(buildLabelChips(video, 'tags', row));
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

async function openPlayer(video) {
  const modal = $('#player');
  const el = $('#playerVideo');
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

function closePlayer() {
  const el = $('#playerVideo');
  el.pause();
  el.removeAttribute('src');
  el.load();
  $('#player').hidden = true;
}

// --------------------------------------------------------------------- init

async function boot() {
  $('#signIn').addEventListener('click', () => auth.signIn().catch((e) => toast(e.message, 'err')));
  $('#signOut').addEventListener('click', () => { auth.signOut(); location.reload(); });
  $('#playerClose').addEventListener('click', closePlayer);
  $('#loadMore').addEventListener('click', () => loadMore(AUTO_PAGES));
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
  history.pushState(null, ''); // gives the Android back button something to pop

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
