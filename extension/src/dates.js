// extension/src/dates.js

/** 'YYYY-MM-DD' -> 'DD-MM-YYYY' */
export function isoToAsta(iso) {
  return String(iso).slice(0, 10).split('-').reverse().join('-');
}

/** Date -> 'YYYY-MM-DD' (UTC) */
export function toIsoDate(d) {
  return d.toISOString().slice(0, 10);
}

/** 'DD-MM-YYYY' -> Date (UTC midnight) */
function astaToDate(dmy) {
  const [d, m, y] = dmy.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** ASTA rejects weekend dates: Sat -> Fri, Sun -> Mon. Input and output 'DD-MM-YYYY'. */
export function shiftWeekday(dmy) {
  const dt = astaToDate(dmy);
  const day = dt.getUTCDay(); // 0 = Sunday, 6 = Saturday
  if (day === 6) dt.setUTCDate(dt.getUTCDate() - 1);
  else if (day === 0) dt.setUTCDate(dt.getUTCDate() + 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(dt.getUTCDate())}-${p(dt.getUTCMonth() + 1)}-${dt.getUTCFullYear()}`;
}

/** Last Thursday of the given month. month is 1-12. */
export function lastThursday(year, month) {
  const d = new Date(Date.UTC(year, month, 0)); // day 0 of next month = last day of this one
  const back = (d.getUTCDay() - 4 + 7) % 7;     // 4 = Thursday
  d.setUTCDate(d.getUTCDate() - back);
  return d;
}

/**
 * Sentinel returned by normalizeExpiry() for a null/undefined/empty expiry.
 * Deliberately NOT a valid 'YYYY-MM-DD' string, and not the empty string
 * either (which slicing bugs love to produce by accident) -- so a leg or
 * position with no expiry can only ever tuple-match another record that ALSO
 * normalizes to this exact sentinel, never a record carrying a real date.
 * See normalizeExpiry() below for the full reasoning.
 */
export const NULL_EXPIRY = '__NULL_EXPIRY__';

/**
 * Canonicalise an expiry value -- from either our own leg (which writes and
 * reads 'DD-MM-YYYY') or ASTA's live getPositions() response -- to a single
 * 'YYYY-MM-DD' string so the two sides of runner.js's leg/position tuple
 * match compare as the same calendar day regardless of which shape wrote it.
 *
 * THE BUG THIS FIXES: ASTA's getPositions() does NOT echo ExpiryDate back in
 * the 'DD-MM-YYYY' shape we write -- it returns an ISO datetime, e.g.
 * '2026-01-06T00:00:00'. The previous implementation (a bare
 * `.slice(0, 10)`) assumed both sides were already 'DD-MM-YYYY' and just
 * compared the first 10 characters verbatim: '06-01-2026' vs '2026-01-06'.
 * Those are never equal as strings, so every leg matched 0 positions and the
 * strategy aborted -- with its legs already written live and no exits (the
 * 402134-402137 incident). Every existing test fixture had, coincidentally,
 * hand-written ExpiryDate as 'DD-MM-YYYY[ HH:MM:SS]' (ASTA's WRITE format),
 * which slice(0,10) handles by accident -- which is exactly why 173 passing
 * tests never caught this. See tests/fixtures/live-positions.json for the
 * real captured response.
 *
 * Recognised shapes (both compared as a UTC calendar date, never through the
 * host timezone -- constructed via Date.UTC and read back with toIsoDate()):
 *   'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM:SS...'  (ISO -- what getPositions() returns)
 *   'DD-MM-YYYY' or 'DD-MM-YYYY HH:MM:SS'     (ASTA's own write format --
 *                                               both what our legs carry and
 *                                               what captured write-traffic
 *                                               echoes back; see HANDOFF.md)
 *
 * null / undefined / '' (whitespace-only counts as empty) normalise to
 * NULL_EXPIRY. This is a deliberate decision, not an omission: a missing
 * expiry must NEVER act as a wildcard that silently matches a leg or
 * position that DOES carry a real date -- that would be worse than the bug
 * being fixed, silently pairing unrelated contracts. Two missing expiries
 * still normalise to the same sentinel and CAN pair with each other, which
 * is consistent with how every other tuple field already works: "both sides
 * agree this field is absent" is itself a shared fact, exactly the same
 * symmetry argument runner.js already makes for tuple-identical positions.
 *
 * Any other shape is unrecognised and throws, rather than silently falling
 * through to a coincidental (non-)match -- consistent with this project's
 * fail-loud stance on leg/position matching (see runner.js's Ruling 1: an
 * uninterpretable field is real ambiguity, not something to guess through).
 */
export function normalizeExpiry(v) {
  if (v === null || v === undefined) return NULL_EXPIRY;
  const s = String(v).trim();
  if (s === '') return NULL_EXPIRY;

  let m = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(s);
  if (m) {
    return toIsoDate(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))));
  }

  m = /^(\d{2})-(\d{2})-(\d{4})(?:\s+\d{2}:\d{2}:\d{2})?$/.exec(s);
  if (m) {
    return toIsoDate(new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]))));
  }

  throw new Error(`normalizeExpiry: unrecognised expiry format: ${JSON.stringify(v)}`);
}
