// GENERATED -- a copy of ../shared/facets.js in the desktop app, made by
// tools/sync-shared.js there. Edit that file and run the tool; an edit made
// here is overwritten, and the desktop tests fail until the two agree.

'use strict';

/**
 * The fixed vocabularies, in one place for every side that needs them.
 *
 * The four races, the trait answers, the favourite tiers, the rating scale, the
 * suggestion floor and the points a rating is worth were each written out in
 * three or four files -- the label store, the face index, the page, the phone --
 * and two lists that must agree agree exactly until somebody adds an answer to
 * one of them. So they live here, and nothing in here touches the DOM, the disk
 * or anybody's state: they are numbers and lists.
 *
 * Loaded the way public/filter.js is: required by the server, and a plain
 * script on a page, where its names become globals. The phone carries a copy
 * (mobile/shared/facets.js, written by tools/sync-shared.js), because it is
 * served from somewhere else and cannot reach this folder; a test fails when
 * the copy drifts.
 */
(function (root, build) {
  const api = build();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign(root, api);
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  /**
   * Race, as labelled per performer -- four answers and no more. Given by hand
   * and never inferred.
   */
  const RACES = ['Asian', 'Black', 'White', 'Other'];

  /**
   * Height, bust and body, per performer. Height and bust are one answer each;
   * body can be several. In the order the dialog shows them.
   */
  const TRAITS = {
    height: ['Tall', 'Average', 'Small'],
    bust: ['Massive', 'Big', 'Average', 'Small'],
    body: ['Athletic', 'Tattoos', 'Curvy', 'Average', 'Petite'],
  };

  /**
   * How much of a favourite somebody is: tier 1 the most. A favourite with no
   * tier recorded -- marked before tiers existed, or on the phone -- is a 3.
   */
  const TIERS = [1, 2, 3, 4, 5];
  const DEFAULT_TIER = 3;

  /**
   * What belongs to a performer rather than a file, as the filter offers it.
   * Built from the lists above rather than written out a second time.
   */
  const PERSON_FACETS = {
    height: TRAITS.height,
    bust: TRAITS.bust,
    body: TRAITS.body,
    race: RACES,
    favourites: TIERS.map((tier) => `Tier ${tier}`),
  };

  /** Ratings run 0 (unrated) to 10. They ran to 5 until 2026-10-05. */
  const RATING_MAX = 10;

  /**
   * Nothing under a fifth is offered as a suggestion. Half and up is credited
   * on its own when a video is first profiled -- see AUTO_CREDIT in faces.js.
   */
  const FACE_FLOOR = 0.20;

  /**
   * Points per rating, unrated to ten stars: what ranks a performer by how good
   * her videos are rather than how many of them there happen to be.
   */
  const STAR_POINTS = [0, 50, 75, 100, 250, 500, 1000, 2500, 5000, 7500, 10000];

  /**
   * A video's identity everywhere: size and modified time, never its path, so a
   * rename, a move or OneDrive freeing the bytes keeps everything known about it.
   */
  function keyFor(stat) {
    return `${stat.size}:${Math.round(stat.mtimeMs)}`;
  }

  return {
    RACES,
    TRAITS,
    TIERS,
    DEFAULT_TIER,
    PERSON_FACETS,
    RATING_MAX,
    FACE_FLOOR,
    STAR_POINTS,
    keyFor,
  };
}));
