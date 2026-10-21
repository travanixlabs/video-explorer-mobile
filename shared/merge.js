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
 * The rules, per record and per race / trait / tier: the side that changed it
 * wins; both changed, the later `updated` wins, ours on a tie; an edit always
 * beats a deletion. Favourites merge by name. Nothing in here touches the DOM,
 * the disk or anybody's state.
 */
(function (root, build) {
  const api = build();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign(root, api);
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  function mergeLibraries(base, ours, theirs) {
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const pick = (b, o, t, both) => {
      const oc = !same(o, b);
      const tc = !same(t, b);
      if (oc && !tc) return o;
      if (tc && !oc) return t;
      if (!oc) return o;
      if (o === undefined) return t;
      if (t === undefined) return o;
      return both(o, t);
    };
    const newer = (o, t) => ((Number(t.updated) || 0) > (Number(o.updated) || 0) ? t : o);
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
    favourites.sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' }));
    return {
      ...theirs,
      ...ours,
      records: mergeMap(base.records, ours.records, theirs.records, newer),
      races: mergeMap(base.races, ours.races, theirs.races, mine),
      traits: mergeMap(base.traits, ours.traits, theirs.traits, mine),
      favouriteTiers: mergeMap(base.favouriteTiers, ours.favouriteTiers, theirs.favouriteTiers, mine),
      favourites,
    };
  }

  return { mergeLibraries };
}));
