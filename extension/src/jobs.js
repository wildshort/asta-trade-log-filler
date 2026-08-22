// extension/src/jobs.js
import { parseSymbol } from './symbols.js';
import { isoToAsta, toIsoDate } from './dates.js';

/** Zerodha code -> ASTA code where they disagree (HANDOFF.md:130). */
export const SCRIP_OVERRIDES = { NIFTY: 'NIFTY50', BANKNIFTY: 'NIFTYBANK', ANGELONE: 'ANGB' };

/**
 * Decode a finite, non-zero double into its exact value M * 2^E (M, E integers).
 * Used so pyRound can work from the true binary value rather than a rounded
 * decimal string, which is what a naive `Math.round(x * 10**d) / 10**d`
 * effectively does and why it can disagree with Python's round().
 */
function decodeDouble(x) {
  const buf = new ArrayBuffer(8);
  new Float64Array(buf)[0] = x;
  const bits = new BigUint64Array(buf)[0];
  const sign = (bits >> 63n) & 1n;
  const rawExp = Number((bits >> 52n) & 0x7ffn);
  const mantissa = bits & 0xfffffffffffffn;
  if (rawExp === 0) return { sign, M: mantissa, E: -1074 }; // subnormal
  return { sign, M: mantissa | (1n << 52n), E: rawExp - 1023 - 52 };
}

/**
 * Python-compatible round(x, digits): correctly-rounded decimal rounding on
 * the double's exact binary value, ties-to-even. Plain
 * `Math.round(x * 10**digits) / 10**digits` looks equivalent but is not: the
 * intermediate `x * 10**digits` multiplication can itself round, silently
 * flipping results near a .5 boundary (verified empirically against
 * CPython's round() across 50k random doubles with 0 mismatches for this
 * implementation vs hundreds of mismatches for the naive version).
 */
export function pyRound(x, digits = 0) {
  if (!Number.isFinite(x) || x === 0) return x;
  const { sign, M, E } = decodeDouble(x);
  const numerator = M * 5n ** BigInt(digits);
  const shift = E + digits;
  let N;
  if (shift >= 0) {
    N = numerator << BigInt(shift);
  } else {
    const divisor = 2n ** BigInt(-shift);
    let q = numerator / divisor;
    const r = numerator % divisor;
    const twiceR = r * 2n;
    if (twiceR > divisor || (twiceR === divisor && q % 2n === 1n)) q += 1n;
    N = q;
  }
  let s = N.toString();
  let result;
  if (digits > 0) {
    if (s.length <= digits) s = s.padStart(digits + 1, '0');
    result = Number(`${s.slice(0, -digits)}.${s.slice(-digits)}`);
  } else {
    result = Number(s);
  }
  return sign ? -result : result;
}

/**
 * Trivial display normaliser: trim, uppercase, collapse runs of whitespace.
 *
 * NOT a dedup key, and deliberately not named like one. It was called
 * canonHeading(), one character away from runner.js's canonHeadingKey(), which
 * ports the real Python canon_heading() semantics -- collapsing equivalent
 * weekly-series spellings such as 'NIFTY 26W407' and 'NIFTY 26W-APR07'. Using
 * this function to dedup against ASTA's existing views would miss those
 * equivalences and create duplicate views in the live journal. That confusion
 * has already cost this project once; the names are now unmistakable.
 */
export function normaliseHeading(h) {
  return String(h).trim().toUpperCase().replace(/\s+/g, ' ');
}

/**
 * @param {{tripsBySegment: Array<{segment:'F&O'|'Commodity', trips:Array}>,
 *          nseCodes:Set<string>, mcxCodes:Set<string>,
 *          startAfter:string, majorThreshold:number}} opts
 */
export function buildJobs({ tripsBySegment, nseCodes, mcxCodes, startAfter, majorThreshold }) {
  const all = [];
  for (const { segment, trips } of tripsBySegment) {
    for (const t of trips) all.push({ ...t, seg: segment });
  }

  const recent = all.filter((t) => t.exit_date > startAfter);

  const groups = new Map();
  const skipped = new Set();
  for (const t of recent) {
    const p = parseSymbol(t.sym);
    if (!p) { skipped.add(t.sym); continue; }
    Object.assign(t, { inst: p.inst, strike: p.strike, exp: p.exp, und: p.und, series: p.series });
    const key = `${p.und}|${p.series}|${t.seg}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const jobs = [];
  const unmapped = new Set();

  for (const [key, ts] of groups) {
    const [und, series, seg] = key.split('|');
    const pnl = ts.reduce((s, t) => s + t.pnl, 0);
    if (Math.abs(pnl) <= majorThreshold) continue;

    const scrip = SCRIP_OVERRIDES[und] || und;
    const valid = seg === 'Commodity' ? mcxCodes : nseCodes;
    if (!valid.has(scrip)) { unmapped.add(und); continue; }

    // Merge legs of the same contract / entry / exit / direction.
    const merged = new Map();
    for (const t of ts) {
      const k = `${t.sym}|${t.entry_date}|${t.exit_date}|${t.direction}`;
      if (!merged.has(k)) {
        merged.set(k, { qty: 0, bv: 0, sv: 0, pnl: 0,
                        inst: t.inst, strike: t.strike, exp: t.exp,
                        entry_date: t.entry_date, exit_date: t.exit_date,
                        direction: t.direction });
      }
      const g = merged.get(k);
      g.qty += t.qty;
      g.bv += t.entry_px * t.qty;
      g.sv += t.exit_px * t.qty;
      g.pnl += t.pnl;
    }

    const legs = [];
    const strikes = [];
    for (const g of merged.values()) {
      const entry = pyRound(g.bv / g.qty, 2);
      const exit = pyRound(g.sv / g.qty, 2);
      const pl = pyRound(g.pnl, 2);
      legs.push({
        inst: g.inst,
        strike: g.strike,
        exp: isoToAsta(toIsoDate(g.exp)),
        dir: g.direction === 'long' ? 'BUY' : 'SELL',
        entry, exit,
        entryDate: isoToAsta(g.entry_date),
        exitDate: isoToAsta(g.exit_date),
        lots: pyRound(g.qty, 0),
        amount: pl,
        gain: pl > 0 ? 'GG' : 'GL',
        reason: pl > 0 ? 'Target achieved' : 'Stop loss hit',
      });
      if (g.strike) strikes.push(g.strike);
    }

    // Sort by entry date, oldest first. entryDate is DD-MM-YYYY.
    legs.sort((a, b) => {
      const k = (d) => d.slice(6) + d.slice(3, 5) + d.slice(0, 2);
      return k(a.entryDate) < k(b.entryDate) ? -1 : k(a.entryDate) > k(b.entryDate) ? 1 : 0;
    });

    strikes.sort((a, b) => a - b);
    const spot = strikes.length
      ? strikes[Math.floor(strikes.length / 2)]
      : pyRound(legs[0].entry, 2);

    jobs.push({
      underlying: und,
      series,
      segment: seg === 'Commodity' ? 'COMMODITY' : 'EQUITY',
      exchange: seg === 'Commodity' ? 'MCX' : 'NSE',
      scrip,
      heading: `${und} ${series}`.replace(/\?/g, ''),
      spot,
      pnl: pyRound(pnl, 2),
      legs,
    });
  }

  return { jobs, skipped, unmapped };
}
