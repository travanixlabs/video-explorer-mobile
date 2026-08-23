'use strict';

/**
 * Graph client for the phone.
 *
 * The desktop app maps a local file path onto a drive item; here there are no
 * local files at all, so items are addressed by driveId + itemId throughout and
 * paths only exist for display. That removes the whole class of "own folder vs
 * shared folder" path bugs the desktop version had to work around.
 */

import { accessToken } from './auth.js';

const BASE = 'https://graph.microsoft.com/v1.0';

const VIDEO_EXT = /\.(mp4|m4v|mov)$/i;

async function call(pathOrUrl, options = {}) {
  const token = await accessToken();
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : BASE + pathOrUrl;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
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

let PAGE = 200;

/** How many items a listing call asks for. Clamped to what Graph will serve. */
export function setPageSize(size) {
  PAGE = Math.max(20, Math.min(999, Number(size) || 200));
}

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
 * Thumbnail URLs for up to 20 items in a single round trip, via Graph's $batch
 * endpoint. The URLs it returns are pre-signed, so an <img> loads them with no
 * Authorization header — which is why this is a JSON call rather than fetching
 * the image bytes through here.
 *
 * 20 is Graph's per-batch limit, and conveniently about one screen of cards.
 */
export async function thumbnailsFor(items) {
  if (!items.length) return new Map();
  const token = await accessToken();
  const slice = items.slice(0, 20);

  const res = await fetch(`${BASE}/$batch`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: slice.map((item, index) => ({
        id: String(index),
        method: 'GET',
        url: `/drives/${item.driveId}/items/${item.id}/thumbnails?$select=large,medium`,
      })),
    }),
  });
  if (!res.ok) return new Map();

  const body = await res.json();
  const found = new Map();
  for (const response of body.responses || []) {
    if (response.status !== 200) continue;
    const set = ((response.body || {}).value || [])[0];
    const pick = set && (set.large || set.medium);
    if (pick) found.set(slice[Number(response.id)].id, pick.url);
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
export async function streamUrl(driveId, itemId) {
  const item = await call(itemBase(driveId, itemId));
  return item['@microsoft.graph.downloadUrl'] || null;
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

// ------------------------------------------------------------ ratings + tags

const LIBRARY_PATH = '/me/drive/root:/.video-explorer/library.json';

/**
 * The same sidecar the desktop app writes, read straight from OneDrive. Keyed
 * by size + modified time, so the phone and the PC agree on which record
 * belongs to which video without ever comparing paths.
 */
export async function loadLibrary() {
  try {
    const token = await accessToken();
    const res = await fetch(`${BASE}${LIBRARY_PATH}:/content`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) return { version: 1, records: {} };
    if (!res.ok) throw new Error(`library ${res.status}`);
    return await res.json();
  } catch {
    // A missing or unreadable sidecar must not stop you browsing.
    return { version: 1, records: {} };
  }
}

export async function saveLibrary(library) {
  const token = await accessToken();
  const res = await fetch(`${BASE}${LIBRARY_PATH}:/content`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(library, null, 1),
  });
  if (!res.ok) throw new Error(`Could not save ratings (${res.status})`);
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

  const token = await accessToken();
  for (let at = 0; at < todo.length; at += 20) {
    const slice = todo.slice(at, at + 20);
    let body;
    try {
      const res = await fetch(`${BASE}/$batch`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: slice.map((item, index) => ({
            id: String(index),
            method: 'GET',
            // Doubled apostrophes: an OData string literal escapes them that
            // way, and plenty of these names have one in them.
            url: `/me/drive/root/search(q='${encodeURIComponent(item.name.replace(/'/g, "''"))}')`
              + `?$select=${SELECT}&$top=12`,
          })),
        }),
      });
      if (!res.ok) return answers;
      body = await res.json();
    } catch {
      return answers; // no stills is a lesser failure than no list
    }

    for (const response of body.responses || []) {
      const asked = slice[Number(response.id)];
      if (!asked) continue;
      const hits = response.status === 200 ? ((response.body || {}).value || []) : [];
      const match = hits.map(normalise).find((candidate) => candidate.size === asked.size
        && Math.round(candidate.mtime) === Math.round(asked.mtime));
      foundItems.set(asked.key, match || null);
      if (match) answers.set(asked.key, match);
    }
  }
  return answers;
}

export function recordKey(video) {
  return `${video.size}:${Math.round(video.mtime)}`;
}
