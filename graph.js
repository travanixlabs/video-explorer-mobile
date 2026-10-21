'use strict';

/**
 * Graph client for the phone.
 *
 * The desktop app maps a local file path onto a drive item; here there are no
 * local files at all, so items are addressed by driveId + itemId throughout and
 * paths only exist for display. That removes the whole class of "own folder vs
 * shared folder" path bugs the desktop version had to work around.
 */

import { accessToken, refreshNow } from './auth.js';

const BASE = 'https://graph.microsoft.com/v1.0';

const VIDEO_EXT = /\.(mp4|m4v|mov)$/i;

/**
 * Throttling, answered rather than reported.
 *
 * Graph says "not now" with a 429, or a 503/504 when a node is busy, and both
 * mean the same request will succeed shortly. Every call used to treat them
 * as failures: a thumbnail batch went blank, a listing stopped part-way, a
 * star press failed to save. So every request goes through here, and a
 * throttled one waits -- as long as Retry-After asks, capped, or 1s, 2s, 4s --
 * and goes again, four tries in all.
 *
 * And a 401 on a token the clock says is still good means it was revoked
 * early; one forced refresh and one more try, rather than an error that
 * would repeat until the stored expiry came round.
 */
const RETRY_STATUS = new Set([429, 503, 504]);
const TRIES = 4;
const RETRY_CAP_MS = 30000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long to wait before try `attempt + 1`, from a Retry-After value if there is one. */
function retryWait(after, attempt) {
  if (after !== null && after !== undefined && String(after).trim() !== '') {
    const seconds = Number(after);
    if (Number.isFinite(seconds)) return Math.min(Math.max(0, seconds) * 1000, RETRY_CAP_MS);
    // The other form the header may take: an HTTP date.
    const at = Date.parse(after);
    if (Number.isFinite(at)) return Math.min(Math.max(0, at - Date.now()), RETRY_CAP_MS);
  }
  return Math.min(1000 * 2 ** attempt, RETRY_CAP_MS);
}

/**
 * fetch(), with the bearer token, the throttling waits and the one 401 retry.
 * A network failure is left to throw its TypeError: that is how the callers
 * tell "offline" from "Graph said no".
 */
export async function graphFetch(url, init = {}) {
  let refreshed = false;
  for (let attempt = 0; ; attempt += 1) {
    const token = await accessToken();
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    });
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      // Throws, and signs out, when the refresh token is dead too -- which is
      // the right answer then: nothing more this request can do.
      await refreshNow(token);
      attempt -= 1; // a refused token is not a throttle; it does not use up a try
      continue;
    }
    if (RETRY_STATUS.has(res.status) && attempt < TRIES - 1) {
      await sleep(retryWait(res.headers.get('Retry-After'), attempt));
      continue;
    }
    return res;
  }
}

/** True when an error is the network being gone, rather than an answer. */
export function isOffline(err) {
  return err instanceof TypeError || Boolean(err && err.offline);
}

async function call(pathOrUrl, options = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : BASE + pathOrUrl;
  const res = await graphFetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((body.error && body.error.message) || `Graph ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// Everything the UI needs and nothing else. Notably absent:
// `$expand=thumbnails`, which was the whole performance problem — measured on a
// 236-item folder, a page of 200 costs 6.0s expanded and 0.7s plain. Thumbnails
// are fetched separately, in batches, only for cards actually on screen.
// `video` is the reason the phone needs no ffprobe: Graph hands back duration,
// resolution and bitrate with the listing, for nothing.
const SELECT = 'id,name,size,folder,lastModifiedDateTime,parentReference,remoteItem,video';

export async function me() {
  const drive = await call('/me/drive');
  const owner = (drive.owner && drive.owner.user) || {};
  return {
    email: owner.email || '',
    name: owner.displayName || '',
    driveId: drive.id,
    rootId: drive.root && drive.root.id,
    usedGB: drive.quota ? Math.round(drive.quota.used / 1e9) : null,
  };
}

function itemBase(driveId, itemId) {
  return `/drives/${driveId}/items/${itemId}`;
}

/**
 * Shared folders appear in the root listing as items with a `remoteItem`,
 * pointing at the owner's drive. Resolving that here means everything
 * downstream deals in one flat (driveId, itemId) pair.
 */
function normalise(item) {
  const remote = item.remoteItem;
  const ref = (remote ? remote.parentReference : item.parentReference) || {};
  const source = remote || item;
  return {
    id: source.id,
    driveId: ref.driveId || null,
    // Where it lives, so a move can be moved back.
    parentId: ref.id || null,
    name: item.name,
    isFolder: Boolean(source.folder),
    childCount: source.folder ? source.folder.childCount : 0,
    size: source.size || 0,
    mtime: Date.parse(source.lastModifiedDateTime || item.lastModifiedDateTime || 0) || 0,
    shared: Boolean(remote),
    video: !source.folder && VIDEO_EXT.test(item.name),
    thumb: null, // filled in later by thumbnailsFor(), per visible card
    // Free with the listing, so the phone shows real metadata without decoding
    // a single frame.
    duration: source.video ? Math.round((source.video.duration || 0) / 1000) : 0,
    width: (source.video && source.video.width) || 0,
    height: (source.video && source.video.height) || 0,
    bitrate: (source.video && source.video.bitrate) || 0,
  };
}

// Graph will serve 999 children in one reply and was being asked for 200. A
// flattened library folder of five thousand was twenty-five round trips where
// it could have been six, and the whole library a thousand where it could be
// two hundred -- each one a phone waiting on the network for nothing.
// Fixed: a per-device setting used to override it back down to 200, with no
// screen left to change it from.
const PAGE = 999;

function childrenUrl(driveId, itemId, query) {
  return driveId && itemId
    ? `${itemBase(driveId, itemId)}/children${query}`
    : `/me/drive/root/children${query}`;
}

/**
 * Every subfolder, in one or two calls.
 *
 * Graph's *default* child ordering puts folders first, contiguously — verified
 * on an own drive, a shared drive, and a 2,292-item folder. So folders can be
 * read off the front without paging the whole listing, and the only reason to
 * ask for a second page is a page that ends on a folder, meaning more may
 * follow.
 *
 * This deliberately does not use `$orderby=name`, which interleaves folders
 * with files: in a 2,292-item folder that put the second subfolder at item
 * 1,986, ten pages deep, so it simply never appeared.
 *
 * `$filter=folder ne null` also works, but still pages through the underlying
 * set and costs about the same for a worse failure mode.
 */
export async function listFolders(driveId, itemId) {
  const folders = [];
  let url = childrenUrl(driveId, itemId, `?$select=${SELECT}&$top=200`);

  while (url) {
    const page = await call(url);
    const entries = (page.value || []).map(normalise);
    folders.push(...entries.filter((e) => e.isFolder));
    const lastIsFolder = entries.length && entries[entries.length - 1].isFolder;
    url = lastIsFolder && page['@odata.nextLink'] ? page['@odata.nextLink'] : null;
  }
  return folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/**
 * Videos, one page at a time, so the first screen renders while the rest is
 * still arriving. `next` is an opaque continuation — pass it back for the page
 * after this one, or null when the folder is exhausted.
 *
 * Sorted server-side: sorting each page on the client would be wrong across
 * pages, since page 2 can hold names belonging before page 1's, and that in
 * turn is what lets the UI append new pages instead of rebuilding the grid.
 */
export async function listPage(driveId, itemId, next = null) {
  const page = await call(next
    || childrenUrl(driveId, itemId, `?$select=${SELECT}&$top=${PAGE}&$orderby=name`));

  // Folders are ignored here — listFolders() has them, and taking them from a
  // partially-loaded listing is what hid one in the first place.
  return {
    videos: (page.value || []).map(normalise).filter((e) => e.video),
    next: page['@odata.nextLink'] || null,
  };
}

/**
 * A page of children with the folders kept, for the flattened walk.
 *
 * listPage() throws folders away because it has to: taking them from a listing
 * that is still loading is what once hid a subfolder. Flattening pages through
 * every child anyway, so the subfolders arrive free with the videos and cost no
 * request of their own.
 *
 * No $orderby: the walk cannot be in global name order regardless -- it covers
 * one folder at a time -- and the default ordering is the cheaper one.
 */
export async function listChildren(driveId, itemId, next = null) {
  const page = await call(next || childrenUrl(driveId, itemId, `?$select=${SELECT}&$top=${PAGE}`));
  const entries = (page.value || []).map(normalise);
  return {
    videos: entries.filter((e) => e.video),
    folders: entries.filter((e) => e.isFolder),
    next: page['@odata.nextLink'] || null,
  };
}

/**
 * Twenty listings in one round trip.
 *
 * A walk down a tree is dominated by latency rather than by bytes: a folder of
 * fifty subfolders is fifty sequential requests, each a phone's round trip to
 * Graph, and that is a minute of nothing on a library this size. $batch is the
 * same twenty requests in one, so a level of the tree costs one wait instead of
 * twenty.
 *
 * Each spot is { driveId, itemId, next } -- `next` being a continuation from an
 * earlier page, which has to be made relative again because a batch carries
 * paths rather than URLs. The answers come back in the order they were asked
 * for, one per spot, and a spot that failed says so rather than throwing: one
 * folder Graph will not open should cost that folder, not the other nineteen.
 */
export const BATCH = 20;

/** A header out of a $batch answer, whose names arrive in whatever case. */
function headerOf(headers, name) {
  if (!headers) return null;
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === want) return value;
  }
  return null;
}

/**
 * One $batch, answered in full: Map of request id -> its response.
 *
 * Graph throttles inside a batch as well as outside it -- the POST succeeds and
 * some of the twenty come back 429 on their own. Those were simply dropped, a
 * blank tile or a folder the walk never read. Now they go round again, by
 * themselves, after the longest Retry-After any of them gave, up to the same
 * four tries as everything else. What is still throttled after that is
 * returned as it stands, for the caller to count.
 */
async function batchCall(requests) {
  const answers = new Map();
  let pending = requests;
  for (let attempt = 0; pending.length; attempt += 1) {
    const res = await graphFetch(`${BASE}/$batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: pending }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error((body.error && body.error.message) || `Graph ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const body = await res.json();
    const byId = new Map(pending.map((r) => [r.id, r]));
    const again = [];
    let wait = 0;
    for (const response of body.responses || []) {
      const id = String(response.id);
      const asked = byId.get(id);
      if (!asked) continue;
      if (RETRY_STATUS.has(response.status) && attempt < TRIES - 1) {
        again.push(asked);
        wait = Math.max(wait, retryWait(headerOf(response.headers, 'Retry-After'), attempt));
        continue;
      }
      answers.set(id, response);
    }
    pending = again;
    if (pending.length) await sleep(wait);
  }
  return answers;
}

export async function listChildrenBatch(spots) {
  const slice = spots.slice(0, BATCH);
  const answers = await batchCall(slice.map((spot, index) => ({
    id: String(index),
    method: 'GET',
    url: spot.next
      ? (spot.next.startsWith(BASE) ? spot.next.slice(BASE.length) : spot.next)
      : childrenUrl(spot.driveId, spot.itemId, `?$select=${SELECT}&$top=${PAGE}`),
  })));

  const out = slice.map(() => ({ failed: 'no answer' }));
  for (const [id, response] of answers) {
    const at = Number(id);
    if (!Number.isInteger(at) || !slice[at]) continue;
    const page = response.body || {};
    if (response.status !== 200) {
      out[at] = {
        failed: (page.error && page.error.message) || `Graph ${response.status}`,
        status: response.status,
      };
      continue;
    }
    const entries = (page.value || []).map(normalise);
    out[at] = {
      videos: entries.filter((e) => e.video),
      folders: entries.filter((e) => e.isFolder),
      next: page['@odata.nextLink'] || null,
    };
  }
  return out;
}

/**
 * Thumbnail URLs for up to 20 items in a single round trip, via Graph's $batch
 * endpoint. The URLs it returns are pre-signed, so an <img> loads them with no
 * Authorization header — which is why this is a JSON call rather than fetching
 * the image bytes through here.
 *
 * 20 is Graph's per-batch limit, and conveniently about one screen of cards.
 */
export async function thumbnailsFor(items) {
  if (!items.length) return new Map();
  const slice = items.slice(0, 20);

  let answers;
  try {
    answers = await batchCall(slice.map((item, index) => ({
      id: String(index),
      method: 'GET',
      url: `/drives/${item.driveId}/items/${item.id}/thumbnails?$select=large,medium`,
    })));
  } catch (err) {
    if (isOffline(err)) throw err;
    return new Map(); // refused outright: blank tiles, as before
  }

  const found = new Map();
  for (const [id, response] of answers) {
    if (response.status !== 200) continue;
    const set = ((response.body || {}).value || [])[0];
    const pick = set && (set.large || set.medium);
    if (pick && slice[Number(id)]) found.set(slice[Number(id)].id, pick.url);
  }
  return found;
}

/**
 * A pre-authenticated, range-capable URL for the bytes — verified to answer 206
 * to a mid-file range with no Authorization header, which is exactly what a
 * <video> element issues. Nothing is downloaded to the device beyond what is
 * being watched.
 *
 * These expire in about an hour, so they are fetched on demand rather than
 * cached with the listing.
 */
/**
 * Stream URLs, remembered and prefetchable. Opening a video used to pay a
 * Graph round trip -- most of a second of black stage -- every single time;
 * the URL it fetches is good for about an hour, so the next video's can be
 * resolved while this one is still playing and a swipe lands instantly.
 * Forty-five minutes, matching the desktop's cache of the same URLs.
 */
const STREAM_TTL_MS = 45 * 60 * 1000;
const streams = new Map(); // itemId -> { url, at }

export async function streamUrl(driveId, itemId) {
  const hit = streams.get(itemId);
  if (hit && Date.now() - hit.at < STREAM_TTL_MS) return hit.url;
  const item = await call(itemBase(driveId, itemId));
  const url = item['@microsoft.graph.downloadUrl'] || null;
  if (url) streams.set(itemId, { url, at: Date.now() });
  return url;
}

/** The same lookup, paid while nobody is waiting. Failures cost nothing. */
export function warmStream(driveId, itemId) {
  const hit = streams.get(itemId);
  if (hit && Date.now() - hit.at < STREAM_TTL_MS) return;
  streamUrl(driveId, itemId).catch(() => {});
}

/**
 * Moves an item into another folder.
 *
 * Graph does this as a PATCH of the item's parent — cheap and instant, since
 * nothing is copied. It only works *within* one drive, though: your own folders
 * and a folder shared from another account are separate drives, and Graph will
 * not re-parent across that boundary. Rather than fake it with a copy-and-delete
 * that could half-fail on a 4 GB file, that case is refused by name.
 */
export async function moveItem(item, dest) {
  if (String(item.driveId).toLowerCase() !== String(dest.driveId).toLowerCase()) {
    throw new Error('different OneDrive account — moves only work within one drive');
  }
  return call(itemBase(item.driveId, item.id), {
    method: 'PATCH',
    body: JSON.stringify({ parentReference: { id: dest.itemId } }),
  });
}

/**
 * To the recycle bin, not gone: Graph's DELETE on a drive item is a soft delete,
 * and it is the same operation the OneDrive web UI performs.
 */
export async function deleteItem(item) {
  await call(itemBase(item.driveId, item.id), { method: 'DELETE' });
}

export async function itemById(driveId, itemId) {
  return normalise(await call(`${itemBase(driveId, itemId)}?$expand=thumbnails`));
}

// ----------------------------------------------------------- a small kv store
//
// IndexedDB behind two functions, for the things worth keeping between opens:
// the labels file. localStorage is the wrong tool at
// these sizes -- the labels alone are 4MB -- and a cache that can throw on a
// private tab must never take the app down, so every path here swallows its
// own failures and answers null.

const DB = 'video-explorer';
const KV = 'kv';

function idb() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(KV);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function kvGet(key) {
  const db = await idb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(KV).objectStore(KV).get(key);
      req.onsuccess = () => resolve(req.result === undefined ? null : req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function kvSet(key, value) {
  const db = await idb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(KV, 'readwrite');
      tx.objectStore(KV).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export async function kvDel(key) {
  const db = await idb();
  if (!db) return;
  try { db.transaction(KV, 'readwrite').objectStore(KV).delete(key); } catch { /* gone is gone */ }
}

/**
 * Everything kept, gone -- for signing out, when the next person to pick the
 * phone up should not find the labels and listings still in it.
 */
export async function kvClear() {
  const db = await idb();
  if (!db) return;
  await new Promise((resolve) => {
    try {
      const tx = db.transaction(KV, 'readwrite');
      tx.objectStore(KV).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

// ------------------------------------------------------------ ratings + tags

const LIBRARY_PATH = '/me/drive/root:/.video-explorer/library.json';

/**
 * The same sidecar the desktop app writes, read straight from OneDrive. Keyed
 * by size + modified time, so the phone and the PC agree on which record
 * belongs to which video without ever comparing paths.
 *
 * A failure to read is *not* an empty library, and this used to say it was.
 * Every path out of here returned `{ records: {} }` — a flaky signal on the
 * train, an expired token, a 503 from Graph — and the next tap on a star wrote
 * that back over six thousand records. Only a genuine 404 means there is
 * nothing there yet. Everything else throws, and the caller declines to write
 * until a real load succeeds.
 */
/**
 * ...and no longer 4MB over mobile data on every open. The file's cTag -- the
 * tag Graph changes exactly when the CONTENT changes -- costs a few hundred
 * bytes to ask for; when it matches what IndexedDB holds, the held copy IS the
 * current file and is served as such, writes and all. Only a changed tag pays
 * for the download. Every save stores the tag Graph hands back with the PUT,
 * so a phone that did the writing matches on its next open too.
 */

/**
 * Three ways to one library -- what both sides started from, ours, theirs.
 * The same rules as the desktop's library.js mergeLibraries, kept in step by
 * hand: per record (and per race / trait / tier), the side that changed it
 * wins; both changed, the later `updated` wins, ours on a tie, and an edit
 * always beats a deletion. Favourites merge by name.
 */
// One copy, shared with the desktop: shared/merge.js, loaded before this
// module (see index.html) and read from the global scope here.
export const mergeLibraries = (base, ours, theirs) => globalThis.mergeLibraries(base, ours, theirs);

// The file as this phone last read or wrote it: its eTag, for a conditional
// save, and its contents, as the common ancestor of a merge.
let libHeld = { eTag: '', base: null };
const copyOf = (obj) => JSON.parse(JSON.stringify(obj));

async function downloadLibrary() {
  const res = await graphFetch(`${BASE}${LIBRARY_PATH}:/content`);
  if (res.status === 404) return { version: 1, records: {} };
  if (!res.ok) throw new Error(`Could not read your labels (${res.status})`);
  const body = await res.json();
  if (!body || typeof body !== 'object' || !body.records || typeof body.records !== 'object') {
    throw new Error('The labels file on OneDrive is not in a shape this understands');
  }
  return body;
}

/**
 * No signal at all is not the same as a refusal. The copy IndexedDB holds is
 * the file as this phone last saw it, which is a far better thing to show than
 * a grid with no ratings on it -- so it is handed back, on the error, for the
 * caller to show read-only: an offline copy must never be written over the
 * real file, which may have moved on since.
 */
async function offlineCopy(err) {
  if (!isOffline(err)) return err;
  const kept = await kvGet('library');
  const out = new Error('Offline');
  out.offline = true;
  if (kept && kept.body && kept.body.records) out.library = kept.body;
  return out;
}

export async function loadLibrary() {
  let meta;
  try {
    meta = await call(`${LIBRARY_PATH}?$select=cTag,eTag,size`);
  } catch (err) {
    if (err.status === 404) {
      kvDel('library');
      return { version: 1, records: {} };
    }
    if (isOffline(err)) throw await offlineCopy(err);
    throw new Error(`Could not read your labels (${err.status || err.message})`);
  }
  const tag = meta.cTag || '';

  const kept = await kvGet('library');
  if (kept && tag && kept.tag === tag && kept.body && kept.body.records) {
    libHeld = { eTag: meta.eTag || '', base: copyOf(kept.body) };
    return kept.body;
  }

  let body;
  try {
    body = await downloadLibrary();
  } catch (err) {
    throw await offlineCopy(err);
  }
  libHeld = { eTag: meta.eTag || '', base: copyOf(body) };
  if (tag) await kvSet('library', { tag, body });
  return body;
}

/**
 * Whether the file on OneDrive has moved on from the one this phone holds --
 * the desktop saved since. A few hundred bytes to ask.
 */
export async function libraryChanged() {
  if (!libHeld.eTag) return false;
  const meta = await call(`${LIBRARY_PATH}?$select=eTag`);
  return Boolean(meta.eTag && meta.eTag !== libHeld.eTag);
}

// What the last successful load contained, so a save can tell an edit from a
// catastrophe.
let loadedCount = null;

export function noteLoaded(library) {
  loadedCount = Object.keys((library && library.records) || {}).length;
}

/**
 * Saves, but only over the version this phone last saw. If the desktop wrote
 * in between, OneDrive answers 412: theirs is fetched, the two are merged with
 * what both started from, and the merge is saved instead -- so neither device
 * writes over the other's edits. Returns the library as saved, which may hold
 * more than was handed in.
 */
export async function saveLibrary(library) {
  let ours = library;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const count = Object.keys((ours && ours.records) || {}).length;
    // The signature of a wipe: everything, gone, from a device that deletes one
    // record at a time. Nothing legitimate on this phone produces it, so refusing
    // costs nothing and the one time it fires it saves the library.
    if (loadedCount && !count) {
      const err = new Error('Refusing to save an empty library over your labels');
      err.permanent = true; // trying again would refuse again
      throw err;
    }
    const headers = { 'Content-Type': 'application/json' };
    if (libHeld.eTag) headers['If-Match'] = libHeld.eTag;
    const res = await graphFetch(`${BASE}${LIBRARY_PATH}:/content`, {
      method: 'PUT',
      headers,
      // Compact, matching what the desktop writes: the indentation was a fifth of
      // the file, and this one goes up a phone's mobile data every time a star is
      // pressed.
      body: JSON.stringify(ours),
    });
    if (res.status === 412) {
      // Somebody else saved first. Theirs, merged with ours, then try again.
      const meta = await call(`${LIBRARY_PATH}?$select=eTag`);
      const theirs = await downloadLibrary();
      ours = mergeLibraries(libHeld.base || { records: {} }, ours, theirs);
      libHeld = { eTag: meta.eTag || '', base: copyOf(theirs) };
      continue;
    }
    if (!res.ok) throw new Error(`Could not save ratings (${res.status})`);
    loadedCount = count;
    // The PUT answers with the item as it now stands, tags included -- kept, so
    // the next save is conditional on it and the next open skips the download.
    try {
      const item = await res.json();
      libHeld = { eTag: (item && item.eTag) || '', base: copyOf(ours) };
      if (item && item.cTag) await kvSet('library', { tag: item.cTag, body: ours });
    } catch {
      libHeld = { eTag: '', base: copyOf(ours) };
    }
    return ours;
  }
  throw new Error('Could not save ratings: the file kept changing underneath');
}

const VE_PATH = '/me/drive/root:/.video-explorer';

/**
 * A file out of the app's own folder, as a URL an <img> or a background can use.
 *
 * Graph will not serve these to an <img src> — every request needs a bearer
 * token — so the bytes are fetched and handed back as an object URL. Absent is
 * an ordinary answer here, not an error: a preview strip exists only for videos
 * the desktop has actually drawn, and the caller has a fallback.
 *
 * Kept in an LRU, because these are real memory. A hundred and twenty strips at
 * ~17KB is about 2MB, which is nothing, and past that the oldest is released.
 */
const HELD = 120;
const held = new Map();

/**
 * Six of these in the air at once, at most. A lineup is forty-odd crops and
 * a row of suggestions a dozen, each its own request, and firing them all
 * together is how the account gets throttled -- which then slows the listing
 * and the thumbnails as well. A slot is handed straight to the next waiter
 * rather than freed and re-taken, so a newcomer cannot slip in between and
 * make it seven.
 */
const ASSET_SLOTS = 6;
let assetBusy = 0;
const assetQueue = [];

async function withAssetSlot(run) {
  if (assetBusy >= ASSET_SLOTS) await new Promise((resolve) => assetQueue.push(resolve));
  else assetBusy += 1;
  try {
    return await run();
  } finally {
    const next = assetQueue.shift();
    if (next) next();
    else assetBusy -= 1;
  }
}

export async function asset(rel) {
  if (held.has(rel)) {
    const hit = held.get(rel);
    // Re-inserting moves it to the end, which is what makes this an LRU rather
    // than a queue that evicts whatever happens to be oldest by arrival.
    held.delete(rel);
    held.set(rel, hit);
    return hit;
  }

  let url = null;
  try {
    url = await withAssetSlot(async () => {
      const res = await graphFetch(`${BASE}${VE_PATH}/${rel}:/content`);
      return res.ok ? URL.createObjectURL(await res.blob()) : null;
    });
  } catch {
    // Offline: the caller falls back to streaming. Not remembered as absent,
    // since it may well be there once the signal is back.
    return null;
  }
  // Another call for the same file may have landed while this one waited.
  if (held.has(rel)) {
    if (url) URL.revokeObjectURL(url);
    return held.get(rel);
  }

  held.set(rel, url);
  if (held.size > HELD) {
    const oldest = held.keys().next().value;
    const going = held.get(oldest);
    if (going) URL.revokeObjectURL(going);
    held.delete(oldest);
  }
  return url;
}

/** A small JSON file out of the same folder, or null when it is not there. */
export async function veJson(rel) {
  const res = await graphFetch(`${BASE}${VE_PATH}/${rel}:/content`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Could not read ${rel} (${res.status})`);
  return res.json();
}

const FACES_PATH = '/me/drive/root:/.video-explorer/faces/suggestions.json';

/**
 * What the desktop's face recognition has worked out, as one small file.
 *
 * The profiles behind it are a thousand files of packed vectors, and the
 * suggestions are not in them anyway — they come from averaging every performer
 * across the whole library. The phone reads the conclusion instead: a name, a
 * score and a band per video, keyed the same way the labels are.
 *
 * Absent is the normal state on a library where the feature has never run, so a
 * 404 is null rather than an error. Anything else throws, and the caller decides
 * whether that is worth a message.
 */
export async function loadSuggestions() {
  const res = await graphFetch(`${BASE}${FACES_PATH}:/content`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Could not read the face suggestions (${res.status})`);
  const body = await res.json();
  if (!body || typeof body !== 'object' || !body.videos) return null;
  return body;
}

const BACKUPS_PATH = '/me/drive/root:/.video-explorer/backups';

/**
 * One copy of the sidecar a day, into the same `backups/` folder the desktop
 * writes to.
 *
 * The desktop takes its own at startup, so on any day the PC has been on there
 * is nothing to do here — which is the common case, and it costs one small
 * listing to find out. On the days it has not, the phone is the only thing
 * touching the library and the only thing that can protect it. Never blocks
 * anything: a backup that cannot be taken is worth strictly less than being
 * able to use the app.
 */
export async function dailyBackup(library) {
  const today = new Date().toISOString().slice(0, 10);
  let names = [];
  try {
    const body = await call(`${BACKUPS_PATH}:/children?$select=name&$top=200`);
    names = (body.value || []).map((child) => child.name);
  } catch (err) {
    // No backups folder yet is the one error worth continuing past: the PUT
    // below creates it.
    if (err.status !== 404) return false;
  }
  if (names.some((name) => name.startsWith(`library-${today}`))) return false;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const res = await graphFetch(`${BASE}${BACKUPS_PATH}/library-${stamp}.json:/content`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(library, null, 1),
  });
  return res.ok;
}

/** Must match library.js on the desktop exactly, or records will not line up. */
/**
 * Finds the items behind a set of sidecar records.
 *
 * The sidecar is keyed by size and modified time, deliberately — that survives a
 * rename, which an item id would too but a path would not. The cost is that a
 * record on its own cannot be turned back into something Graph will serve, and
 * the favourites list is exactly that: names and ratings with no items.
 *
 * So each one is searched for by filename and then confirmed on size and
 * modified time, which is what makes a common name safe. Searches go up in
 * batches of twenty, and a hit is worth caching for the session: the answer
 * cannot change unless the file does, and if the file changes its key changes
 * with it.
 *
 * Shared-with-me items are not in this index. Those simply come back unfound,
 * which costs a blank tile rather than a wrong one.
 */
const foundItems = new Map();

export async function findVideos(wanted) {
  const answers = new Map();
  const todo = [];
  for (const item of wanted) {
    const key = `${item.size}:${Math.round(item.mtime)}`;
    if (foundItems.has(key)) {
      const hit = foundItems.get(key);
      if (hit) answers.set(key, hit);
    } else todo.push({ ...item, key });
  }
  if (!todo.length) return answers;

  for (let at = 0; at < todo.length; at += 20) {
    const slice = todo.slice(at, at + 20);
    let replies;
    try {
      replies = await batchCall(slice.map((item, index) => ({
        id: String(index),
        method: 'GET',
        // Doubled apostrophes: an OData string literal escapes them that
        // way, and plenty of these names have one in them.
        url: `/me/drive/root/search(q='${encodeURIComponent(item.name.replace(/'/g, "''"))}')`
          + `?$select=${SELECT}&$top=12`,
      })));
    } catch {
      return answers; // no stills is a lesser failure than no list
    }

    for (const [id, response] of replies) {
      const asked = slice[Number(id)];
      if (!asked) continue;
      // Still throttled after every retry is not "not found", and must not be
      // remembered as it for the session.
      if (RETRY_STATUS.has(response.status)) continue;
      const hits = response.status === 200 ? ((response.body || {}).value || []) : [];
      const match = hits.map(normalise).find((candidate) => candidate.size === asked.size
        && Math.round(candidate.mtime) === Math.round(asked.mtime));
      foundItems.set(asked.key, match || null);
      if (match) answers.set(asked.key, match);
    }
  }
  return answers;
}

// The desktop's keyFor (shared/facets.js), on a Graph item's size and modified time.
export function recordKey(video) {
  return globalThis.keyFor({ size: video.size, mtimeMs: video.mtime });
}
