// extension/src/sources.js
//
// Combines however many files the user hands the wizard -- Zerodha Tax P&L
// exports and/or tradebooks, any mix, any count -- into the single
// tripsBySegment shape buildJobs() consumes.
//
// The merge rule (measured against the user's real data against Zerodha
// Console's Rs 29,55,717.25 gross-realised figure):
//   tradebooks only, both years FIFO'd together : Rs 27,51,224.75  (-6.9%)
//   tax P&L to its last exit + tradebook after   : Rs 29,35,291.00  (-0.7%)
// Tax P&L is authoritative up to and including its latest exit date; the
// tradebook route only fills in what happened after that. Details that each
// move real money and must not regress:
//   1. every tradebook file of a given segment is FIFO'd TOGETHER, not file
//      by file -- a position opened in one file and closed in another must
//      still pair (worth ~Rs 1.95L on the real data).
//   2. the cutoff is STRICTLY greater-than, and it is ONE GLOBAL value across
//      every segment -- a trade that exited exactly on the tax P&L's last
//      date is already inside the tax figures and must not be counted again
//      from the tradebook. A per-segment cutoff would let a Commodity
//      tradebook trade sneak in during a gap where only F&O's tax P&L had
//      reached further, so there is exactly one taxCutoff, computed across
//      every segment's tax trips together.
//   3. duplicate records collapse to one BEFORE any of the above runs. The
//      user keeps several overlapping exports of the same period in their
//      Downloads folder (Zerodha appends " (2)", " (3)", ... to re-downloads
//      rather than replacing the file), so the same fill or the same tax
//      P&L row can easily be selected twice, or twice across two files whose
//      date ranges overlap. Filenames tell you nothing here -- the content
//      is identical or overlapping while the names differ -- so dedup runs
//      on the parsed records themselves, spanning every file of a kind.
//   4. one unusable file (wrong segment, missing columns, corrupt) must not
//      discard every other file in the selection. Each file's F&O/Commodity
//      parsing is isolated; a failure is recorded with a reason and the rest
//      of the merge proceeds without it.

import { loadTaxPnlTrips, detectTaxPnlSheet } from './taxpnl.js';
import { loadFills, detectSegment, TradebookError } from './tradebook.js';
import { fifoRoundtrips } from './roundtrips.js';

/** Turn one sheet of a SheetJS workbook into the {rows, name} shape every src/*.js module expects. */
function sheetFromWorkbook(wb, sheetName, xlsx) {
  const ws = wb.Sheets[sheetName];
  return {
    rows: xlsx.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true }),
    name: sheetName,
  };
}

/**
 * Cheap structural check mirroring the one signal loadFills() itself uses to
 * separate a tradebook from a P&L report: a header row anchored on "Symbol"
 * that also carries "Trade Date". Deliberately NOT full column validation
 * (that's REQUIRED_COLUMNS inside loadFills) -- classification only needs to
 * know which parser to hand the file to; a tradebook that's missing some
 * other required column still gets classified 'tradebook' and then fails
 * loudly, with loadFills' own actionable message, as a per-file entry in
 * summary.unusable when mergeSources actually parses it.
 */
function looksLikeTradebook(sheet) {
  for (const row of sheet.rows) {
    const first = row.find((c) => c !== null && c !== undefined);
    if (first === undefined || String(first).trim() !== 'Symbol') continue;
    const names = row.filter((c) => c !== null && c !== undefined).map((c) => String(c).trim());
    return names.includes('Trade Date');
  }
  return false;
}

/**
 * Purely for a friendlier per-file reason string when detectSegment can't
 * place a structurally-valid tradebook into F&O or Commodity: Zerodha's
 * equity tradebook export names its sheet tab "Equity" (verified against the
 * real file). Never affects classification or merge output, only the
 * message shown for an unusable file.
 */
function looksLikeEquityTradebook(sheet) {
  return String(sheet.name || '').trim().toLowerCase().includes('equity');
}

/**
 * @param {object} wb a SheetJS workbook (XLSX.read/readFile result)
 * @param {{xlsx?: object}} [opts] injectable SheetJS module; defaults to the
 *        browser global (set by the vendored extension/vendor/xlsx.full.min.js
 *        script tag) so callers in the extension UI don't need to pass it.
 * @returns {'taxpnl'|'tradebook'|null}
 */
export function classifyWorkbook(wb, { xlsx = globalThis.XLSX } = {}) {
  if (detectTaxPnlSheet(wb)) return 'taxpnl';
  const firstName = wb && wb.SheetNames && wb.SheetNames[0];
  if (!firstName) return null;
  const sheet = sheetFromWorkbook(wb, firstName, xlsx);
  return looksLikeTradebook(sheet) ? 'tradebook' : null;
}

/**
 * Identity key for a fill.
 *
 * Trade ID was tried first as the sole key -- it's the column that looks
 * like a broker-assigned unique id, and was the obvious choice. Verified
 * against real tradebook exports, it is NOT reliably unique: the same ID
 * appeared on two entirely unrelated fills, and one file carried several such
 * collisions of its own. Keying on Trade ID alone would have silently merged
 * distinct real trades and dropped one of them -- the same class of bug
 * this task exists to prevent, just pointed the other way.
 *
 * So identity is the full recorded tuple, whose execution timestamp is
 * precise to the second: two genuinely different fills sharing symbol,
 * date, side, quantity, price AND the same second of execution is not
 * realistic. Trade ID is folded in as an extra, non-load-bearing
 * distinguisher -- harmless when it agrees, and it can only ever narrow a
 * match, never widen one into a false merge the way using it alone did.
 */
function fillKey(f) {
  return `${f.sym}|${f.date}|${f.side}|${f.qty}|${f.px}|${f.tm}|${f.tradeId ?? ''}`;
}

/**
 * Identity key for a Tax P&L trip. taxpnl.js is out of scope to modify, so
 * this can't dedup on the source file's raw Buy Value/Sell Value columns --
 * it uses the equivalent fields the trip shape already carries (entry_px,
 * exit_px are pyRound(buyValue/qty,2) / pyRound(sellValue/qty,2)). Two
 * genuinely duplicate source rows -- the same trade appearing twice because
 * an overlapping Tax P&L export was also selected -- produce identical
 * values on every one of these fields, so this is equivalent to keying on
 * (Symbol, Entry Date, Exit Date, Quantity, Buy Value, Sell Value, Profit)
 * for that purpose.
 */
function taxTripKey(t) {
  return `${t.sym}|${t.entry_date}|${t.exit_date}|${t.qty}|${t.entry_px}|${t.exit_px}|${t.pnl}`;
}

/**
 * Collapses duplicate records across FILES without discarding legitimate
 * repeats WITHIN one file.
 *
 * Content alone can't distinguish "the same broker record, seen twice
 * because its file was selected twice" from "a real trader genuinely
 * executed this same symbol/qty/price/date round-trip more than once" --
 * and on the user's actual Tax P&L exports the second case is common, not
 * rare: a single file can carry hundreds of rows sharing an identical
 * (Symbol, Entry Date, Exit Date, Quantity, Buy Value, Sell Value, Profit)
 * tuple, verified against the real files (up to several hundred per file).
 * A naive "seen this key before anywhere -> drop it" pass was tried first
 * and silently deleted about a quarter of the user's real trips, moving net
 * P&L by several lakh rupees -- exactly the kind of wrong number this task
 * exists to prevent.
 *
 * The fix: count each key's occurrences PER FILE, then keep, across all
 * files combined, the MAXIMUM single-file count for that key -- not the
 * sum. Two files that are identical or overlap (a duplicate selection, or a
 * re-export of an overlapping period) share the same per-key counts, so the
 * max equals what either file alone already has -- nothing new is added.
 * Two files that are genuinely different periods share no keys with equal,
 * non-independent counts by coincidence in practice (their dates alone
 * differ), so every real row from both survives untouched.
 *
 * @param {Array<Array>} perFileGroups one array of records per source file
 * @param {(record: any) => string} keyFn
 * @returns {{kept: Array, duplicates: number}}
 */
function dedupAcrossFiles(perFileGroups, keyFn) {
  const maxCountByKey = new Map();
  for (const group of perFileGroups) {
    const countInThisFile = new Map();
    for (const item of group) {
      const k = keyFn(item);
      countInThisFile.set(k, (countInThisFile.get(k) || 0) + 1);
    }
    for (const [k, c] of countInThisFile) {
      if (c > (maxCountByKey.get(k) || 0)) maxCountByKey.set(k, c);
    }
  }

  const remaining = new Map(maxCountByKey);
  const kept = [];
  let totalRaw = 0;
  for (const group of perFileGroups) {
    for (const item of group) {
      totalRaw++;
      const k = keyFn(item);
      const left = remaining.get(k) || 0;
      if (left > 0) {
        kept.push(item);
        remaining.set(k, left - 1);
      }
    }
  }
  return { kept, duplicates: totalRaw - kept.length };
}

function reasonFor(e) {
  return e instanceof TradebookError ? e.userMessage : `Unexpected error: ${e.message}`;
}

/**
 * @param {Array<{name:string, kind:'taxpnl'|'tradebook'|null, wb:object}>} parsedFiles
 * @param {{xlsx?: object}} [opts]
 * @returns {{tripsBySegment: Array<{segment:'F&O'|'Commodity', trips:Array}>,
 *            summary: {taxFiles:string[], tradebookFiles:string[], unrecognised:string[],
 *                      unusable:Array<{name:string, reason:string}>,
 *                      taxCutoff:string|null, taxTripCount:number, taxDuplicatesDropped:number,
 *                      tradebookTripCount:number, tradebookTripsDropped:number,
 *                      tradebookDuplicatesDropped:number}}}
 */
export function mergeSources(parsedFiles, { xlsx = globalThis.XLSX } = {}) {
  const taxFiles = [];
  const tradebookFiles = [];
  const unrecognised = [];
  const unusable = []; // {name, reason} -- structurally the right kind, but this file specifically couldn't be used

  // segment -> array of per-FILE trip arrays (one entry per taxpnl file that
  // contributed to that segment), kept file-separated so dedupAcrossFiles
  // can tell a within-file repeat from a cross-file duplicate.
  const taxTripsRawBySegment = new Map();
  // segment -> array of per-FILE fill arrays, same shape and same reason,
  // and BEFORE fifoRoundtrips runs -- this is what lets a position opened in
  // one file and closed in another still pair once deduped and flattened.
  const fillsRawBySegment = new Map();

  for (const f of parsedFiles) {
    if (f.kind === 'taxpnl') {
      try {
        const sheetName = detectTaxPnlSheet(f.wb);
        if (!sheetName) throw new TradebookError(`Could not find the Tax P&L sheet in "${f.name}".`);
        const sheet = sheetFromWorkbook(f.wb, sheetName, xlsx);
        const groups = loadTaxPnlTrips(sheet); // may throw TradebookError for a missing column
        taxFiles.push(f.name);
        for (const { segment, trips } of groups) {
          if (!taxTripsRawBySegment.has(segment)) taxTripsRawBySegment.set(segment, []);
          taxTripsRawBySegment.get(segment).push(trips); // this FILE's trips as one group
        }
      } catch (e) {
        unusable.push({ name: f.name, reason: reasonFor(e) });
      }
    } else if (f.kind === 'tradebook') {
      try {
        const firstName = f.wb.SheetNames[0];
        const sheet = sheetFromWorkbook(f.wb, firstName, xlsx);
        const segment = detectSegment(sheet);
        if (!segment) {
          throw new TradebookError(
            looksLikeEquityTradebook(sheet)
              ? 'This is an Equity tradebook. Equity trades are not supported here -- only F&O and Commodity are read.'
              : `Could not tell whether "${f.name}" is an F&O or Commodity tradebook.\n\n` +
                'Re-download it from Zerodha Console (Reports -> Tradebook) without renaming or editing it.');
        }
        const fills = loadFills(sheet); // may throw TradebookError for a missing column or zero fills
        tradebookFiles.push(f.name);
        if (!fillsRawBySegment.has(segment)) fillsRawBySegment.set(segment, []);
        fillsRawBySegment.get(segment).push(fills); // this FILE's fills as one group
      } catch (e) {
        unusable.push({ name: f.name, reason: reasonFor(e) });
      }
    } else {
      unrecognised.push(f.name);
    }
  }

  // --- Tax P&L: dedup within each segment, across every file, THEN compute
  // the one global cutoff from what's left. ---
  const taxTripsBySegment = new Map();
  let taxCutoff = null;
  let taxTripCount = 0;
  let taxDuplicatesDropped = 0;
  for (const [segment, perFileTrips] of taxTripsRawBySegment) {
    const { kept, duplicates } = dedupAcrossFiles(perFileTrips, taxTripKey);
    taxTripsBySegment.set(segment, kept);
    taxTripCount += kept.length;
    taxDuplicatesDropped += duplicates;
  }
  // Deliberately a second pass over every segment's kept trips, not folded
  // into the loop above: the cutoff must be the single latest exit_date
  // across ALL segments together, not per segment (see file header, rule 2).
  for (const kept of taxTripsBySegment.values()) {
    for (const t of kept) {
      if (taxCutoff === null || t.exit_date > taxCutoff) taxCutoff = t.exit_date;
    }
  }

  // --- Tradebook: dedup fills within each segment, across every file, THEN
  // FIFO the deduped set, THEN apply the strictly-greater-than cutoff. ---
  let tradebookTripCount = 0;
  let tradebookTripsDropped = 0;
  let tradebookDuplicatesDropped = 0;
  const tradebookTripsBySegment = new Map();
  for (const [segment, perFileFills] of fillsRawBySegment) {
    const { kept: dedupedFills, duplicates } = dedupAcrossFiles(perFileFills, fillKey);
    tradebookDuplicatesDropped += duplicates;

    const trips = fifoRoundtrips(dedupedFills);
    const kept = [];
    for (const t of trips) {
      if (taxCutoff === null || t.exit_date > taxCutoff) kept.push(t);
      else tradebookTripsDropped++;
    }
    tradebookTripCount += kept.length;
    tradebookTripsBySegment.set(segment, kept);
  }

  const segments = new Set([...taxTripsBySegment.keys(), ...tradebookTripsBySegment.keys()]);
  const tripsBySegment = [];
  for (const segment of segments) {
    const trips = [...(taxTripsBySegment.get(segment) || []), ...(tradebookTripsBySegment.get(segment) || [])];
    if (trips.length > 0) tripsBySegment.push({ segment, trips });
  }

  return {
    tripsBySegment,
    summary: {
      taxFiles,
      tradebookFiles,
      unrecognised,
      unusable,
      taxCutoff,
      taxTripCount,
      taxDuplicatesDropped,
      tradebookTripCount,
      tradebookTripsDropped,
      tradebookDuplicatesDropped,
    },
  };
}
