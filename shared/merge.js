// GENERATED -- a copy of ../shared/merge.js in the desktop app, made by
// tools/sync-shared.js there. Edit that file and run the tool; an edit made
// here is overwritten, and the desktop tests fail until the two agree.

'use strict';

/**
 * Three ways to one library: what both sides started from, ours, theirs.
 *
 * The one function the desktop and the phone must agree on exactly -- they
 * resolve the same conflicts in the same file, and two copies that drifted
 * would ping-pong edits through OneDrive for ever. It was two byte-identical
 * copies "kept in step by hand"; now it is this file, required by the server
 * and loaded as a plain script by the phone (mobile/shared/merge.js, written
 * by tools/sync-shared.js, with a test that fails when the copy drifts).
 *
 * The rules. Per record, and per race / trait / tier: the side that changed
 * it wins; an edit always beats a deletion. A record changed on BOTH sides is
 * merged field by field rather than taken whole from one of them -- a tag
 * added here while a rating was set on the phone used to lose the tag:
 *
 *   lists      tags, models, turned-down names, bookmarks: everything both
 *              sides hold, plus what either added, minus what either removed
 *   scalars    the rating, the studio, the link...: from the side whose
 *              `updated` is later, ours on a tie
 *   resume     from whichever side moved it; both did, the one further along
 *   updated    the later of the two
 *
 * Favourites merge by name. Nothing in here touches the DOM, the disk or
 * anybody's state.
 */
(function (root, build) {
  const api = build();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign(root, api);
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const stamp = (r) => Number(r && r.updated) || 0;

  // Case does not make two tags: "Solo" and "solo" are one, under the first
  // spelling seen. The label store sorts them the same way.
  const lower = (s) => String(s).trim().replace(/\s+/g, ' ').toLowerCase();
  const sortNames = (list) => list.sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' }));

  /**
   * A list on both sides: what both still hold, plus what either side added
   * since the base, minus what either side removed. Keyed by `keyOf` so a
   * name is one entry whatever its case and a bookmark is one entry per time.
   */
  function mergeList(b, o, t, keyOf) {
    const index = (list) => new Map((Array.isArray(list) ? list : []).map((x) => [keyOf(x), x]));
    const bm = index(b);
    const om = index(o);
    const tm = index(t);
    const out = new Map();
    for (const [k, v] of om) {
      // Held by us: kept unless they removed it from what we both had.
      if (tm.has(k) || !bm.has(k)) out.set(k, v);
    }
    for (const [k, v] of tm) {
      if (out.has(k)) continue;
      // Held by them only: kept if they added it, dropped if we removed it.
      if (!bm.has(k)) out.set(k, v);
    }
    return [...out.values()];
  }

  /** One record changed on both sides, field by field. */
  function mergeRecord(b, o, t) {
    b = b || {};
    const lead = stamp(t) > stamp(o) ? t : o;
    const trail = lead === o ? t : o;
    // Scalars from the later side; a field only one side carries is kept.
    const out = { ...trail, ...lead };
    for (const field of ['tags', 'models', 'notModels']) {
      if (!(field in o) && !(field in t)) continue;
      out[field] = sortNames(mergeList(b[field], o[field], t[field], lower));
    }
    if ('marks' in o || 'marks' in t) {
      out.marks = mergeList(b.marks, o.marks, t.marks, (m) => Number(m && m.t))
        .sort((x, y) => Number(x.t) - Number(y.t));
    }
    if ('aliases' in o || 'aliases' in t) {
      out.aliases = mergeList(b.aliases, o.aliases, t.aliases, String).slice(0, 20);
    }
    // The resume point carries no stamp of its own (saving it does not move
    // `updated`), so: the side that moved it, or the one further along.
    const oMoved = !same(o.resume, b.resume);
    const tMoved = !same(t.resume, b.resume);
    if (oMoved && !tMoved) out.resume = o.resume;
    else if (tMoved && !oMoved) out.resume = t.resume;
    else if (oMoved && tMoved) out.resume = Math.max(Number(o.resume) || 0, Number(t.resume) || 0);
    if (!out.resume) delete out.resume;
    const updated = Math.max(stamp(o), stamp(t));
    if (updated) out.updated = updated;
    return out;
  }

  function mergeLibraries(base, ours, theirs) {
    const pick = (b, o, t, both) => {
      const oc = !same(o, b);
      const tc = !same(t, b);
      if (oc && !tc) return o;
      if (tc && !oc) return t;
      if (!oc) return o;
      if (o === undefined) return t;
      if (t === undefined) return o;
      return both(o, t, b);
    };
    const record = (o, t, b) => mergeRecord(b, o, t);
    const mine = (o) => o;
    const mergeMap = (bm, om, tm, both) => {
      bm = bm || {}; om = om || {}; tm = tm || {};
      const out = {};
      for (const k of new Set([...Object.keys(bm), ...Object.keys(om), ...Object.keys(tm)])) {
        const v = pick(bm[k], om[k], tm[k], both);
        if (v !== undefined) out[k] = v;
      }
      return out;
    };
    const names = (list) => new Map((Array.isArray(list) ? list : []).map((n) => [String(n).toLowerCase(), n]));
    const bf = names(base.favourites);
    const of = names(ours.favourites);
    const tf = names(theirs.favourites);
    const favourites = [];
    for (const k of new Set([...bf.keys(), ...of.keys(), ...tf.keys()])) {
      const keep = of.has(k) !== bf.has(k) ? of.has(k) : tf.has(k);
      if (keep) favourites.push(of.get(k) || tf.get(k));
    }
    sortNames(favourites);
    return {
      ...theirs,
      ...ours,
      records: mergeMap(base.records, ours.records, theirs.records, record),
      races: mergeMap(base.races, ours.races, theirs.races, mine),
      traits: mergeMap(base.traits, ours.traits, theirs.traits, mine),
      favouriteTiers: mergeMap(base.favouriteTiers, ours.favouriteTiers, theirs.favouriteTiers, mine),
      favourites,
    };
  }

  return { mergeLibraries, mergeRecord, mergeList };
}));
