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
      if (url && el.isConnected) el.style.backgroundImage = `url("${url}")`;
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
  if (!next.rating && !(next.tags || []).length) delete state.library.records[key];
  else state.library.records[key] = next;
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
  if (!terms.length) return list;
  return list.filter((item) => {
    const tags = (recordFor(item).tags || []).join(' ').toLowerCase();
    const hay = item.name.toLowerCase();
    return terms.every((term) => (term.startsWith('#')
      ? tags.includes(term.slice(1))
      : hay.includes(term) || tags.includes(term)));
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
  const key = state.stack.map((s) => s.itemId).join('/') + '|' + state.query;

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
  thumbObserver.observe(shot);

  const scrubHint = document.createElement('div');
  scrubHint.className = 'scrub-hint';
  scrubHint.textContent = 'drag to scrub';
  shot.appendChild(scrubHint);

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = fmtBytes(video.size);
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

  card.appendChild(buildRecordRow(video));
  return card;
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

  const chips = document.createElement('span');
  chips.className = 'chips';
  for (const tag of record.tags || []) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = tag;
    chip.addEventListener('click', (ev) => {
      ev.stopPropagation();
      $('#search').value = '#' + tag;
      state.query = ('#' + tag).toLowerCase();
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
    const tags = typed.split(',').map((t) => t.trim()).filter(Boolean);
    editRecord(video, { tags });
    row.replaceWith(buildRecordRow(video));
  });
  chips.appendChild(add);

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

  const begin = async (ev) => {
    if (ev.button !== undefined && ev.button !== 0) return; // left / primary only
    if (ev.target.closest('.play')) return;                 // ▶ is not a scrub handle
    if (state.selecting) return;                            // selection mode owns taps
    ev.preventDefault();
    if (state.scrub) endScrub();

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

  shot.addEventListener('pointerdown', begin);
  shot.addEventListener('pointermove', move);
  shot.addEventListener('pointerup', endScrub);
  shot.addEventListener('pointercancel', endScrub);
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
