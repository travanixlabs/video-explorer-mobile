// GENERATED -- a copy of ../shared/format.js in the desktop app, made by
// tools/sync-shared.js there. Edit that file and run the tool; an edit made
// here is overwritten, and the desktop tests fail until the two agree.

'use strict';

/**
 * The small pure helpers the desktop page and the phone both need: bytes
 * and seconds as text, a rating as a number of stars, and which suggested
 * names are worth offering. Each used to exist twice -- fmtBytes differed
 * by one character, the suggestion rule by a filter -- which is exactly how
 * the two apps come to disagree about what they show.
 *
 * Loaded by the server with require() (public/filter.js uses the suggestion
 * rule), by the desktop page as a plain script, and by the phone as a plain
 * script copied in by tools/sync-shared.js (mobile/shared/format.js). Nothing
 * here touches the DOM.
 */
(function (root, build) {
  const api = build();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign(root, api);
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  /** "1.5 GB", "812 MB", "4 KB"; '' for nothing. */
  function fmtBytes(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
    return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
  }

  /** "1:02:03" past an hour, "4:05" under it; '' for nothing. */
  function fmtDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  /** A stored rating (0-10) as a number of stars, for tooltips: 7 is "3.5". */
  function starsNumber(rating) {
    return String((Math.round(Number(rating) || 0)) / 2);
  }

  const lower = (n) => String(n).trim().toLowerCase();

  /**
   * The names a video's suggestions put forward (named apart from the
   * page's own suggestedNames(file), which calls this): at or above the floor, and
   * not among `refused` (turned down on this video) or `credited` (already
   * named on it -- left out only when the caller says so, since a credited
   * name's suggestion is a confirmation worth showing in some views). Names
   * in the suggestions' own order, which is strongest first.
   */
  function offeredNames(suggested, { floor = 0, refused = [], credited = [] } = {}) {
    const out = new Set((refused || []).map(lower));
    const done = new Set((credited || []).map(lower));
    const names = [];
    for (const s of suggested || []) {
      if (!s || Number(s.score) < floor) continue;
      const key = lower(s.name);
      if (out.has(key) || done.has(key)) continue;
      names.push(s.name);
    }
    return names;
  }

  return { fmtBytes, fmtDuration, starsNumber, offeredNames };
}));
