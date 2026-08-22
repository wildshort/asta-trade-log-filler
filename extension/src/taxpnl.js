// extension/src/taxpnl.js
//
// Reads Zerodha's Tax P&L export ("Tradewise Exits from <date>" sheet). Unlike
// the tradebook route (tradebook.js + roundtrips.js), which reconstructs
// round-trips from raw fills and structurally loses any trade whose buy and
// sell fall in different files, this file already has the pairing done: each
// row is one finished trade with both dates and the profit already computed.
//
// The sheet is a series of sections (Equity - Intraday, Equity - Short Term,
// F&O, Commodity, ...). A section is a row with exactly one non-empty cell
// naming it, followed two rows later by a header row, then data rows. Only
// F&O and Commodity are in scope; everything else (explicitly Equity) is
// ignored by product decision, same as last year's backfill.

import { TradebookError } from './tradebook.js';
import { pyRound } from './jobs.js';

const IN_SCOPE_SECTIONS = new Set(['F&O', 'Commodity']);

/** Columns loadTaxPnlTrips depends on; a silently-missing one produces NaN/undefined data. */
const REQUIRED_COLUMNS = ['Symbol', 'Entry Date', 'Exit Date', 'Quantity', 'Buy Value', 'Sell Value', 'Profit'];

function populatedCells(row) {
  return row.filter((c) => c !== null && c !== undefined && c !== '');
}

function firstPopulatedCell(row) {
  for (const c of row) {
    if (c !== null && c !== undefined && c !== '') return c;
  }
  return undefined;
}

/** A section-title row: exactly one populated cell, and it's text naming the section. */
function isSectionTitleRow(row) {
  const cells = populatedCells(row);
  return cells.length === 1 && typeof cells[0] === 'string';
}

/** Same header-detection strategy as tradebook.js: "Symbol" is always the left-most populated cell. */
function isHeaderRow(row) {
  const first = firstPopulatedCell(row);
  return first !== undefined && String(first).trim() === 'Symbol';
}

/**
 * Build a header-name -> column-index map from a header row, so every
 * subsequent row is read by column NAME rather than by a fixed position.
 * This matters here specifically because the Equity sections carry an ISIN
 * column that F&O/Commodity do not, so a fixed index would silently read the
 * wrong field the moment a section without ISIN is parsed.
 */
function buildColumnMap(row) {
  const map = new Map();
  row.forEach((cell, i) => {
    if (cell === null || cell === undefined) return;
    const name = String(cell).trim();
    if (name && !map.has(name)) map.set(name, i);
  });
  return map;
}

/** Date -> 'YYYY-MM-DD' (UTC); string cells (ISO-ordered, with or without a time suffix) pass through. */
function asIsoDate(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return s.slice(0, 10);
}

/**
 * The sheet carries BOTH F&O and Commodity in a single tab, unlike the
 * tradebook route where each segment comes from its own file (and the
 * caller already knows the segment). So the shape here must carry the
 * segment itself: buildJobs (jobs.js) uses it to pick the scrip list
 * (mcxCodes vs nseCodes) and the ASTA segment/exchange (COMMODITY/MCX vs
 * EQUITY/NSE). A flat trip list with the segment discarded would make every
 * trip resolve against the wrong exchange or drop as unmapped.
 *
 * @param {{rows: any[][]}} sheet rows from SheetJS sheet_to_json(header:1, defval:null, raw:true)
 * @returns {Array<{segment:'F&O'|'Commodity', trips: Array<{sym:string, qty:number,
 *          entry_px:number, exit_px:number, entry_date:string, exit_date:string,
 *          direction:'long', pnl:number}>}>} one entry per segment that had
 *          at least one row; a segment with zero rows is omitted entirely.
 */
export function loadTaxPnlTrips(sheet) {
  const rows = sheet.rows;
  let currentSection = null;
  let colMap = null;
  const bySegment = new Map(); // segment name -> trips[], insertion-ordered by first row seen

  for (const row of rows) {
    if (isSectionTitleRow(row)) {
      currentSection = String(firstPopulatedCell(row)).trim();
      colMap = null;
      continue;
    }

    if (!currentSection || !IN_SCOPE_SECTIONS.has(currentSection)) continue;

    if (populatedCells(row).length === 0) continue; // blank spacer row between title and header, or trailing blank

    if (!colMap) {
      if (!isHeaderRow(row)) continue;
      colMap = buildColumnMap(row);
      const missing = REQUIRED_COLUMNS.filter((c) => !colMap.has(c));
      if (missing.length > 0) {
        throw new TradebookError(
          `The Tax P&L "${currentSection}" section is missing the required column` +
          `${missing.length > 1 ? 's' : ''}: ${missing.map((c) => `"${c}"`).join(', ')}.\n\n` +
          'Zerodha may have renamed a header, or the file was edited after export. ' +
          'Re-download the Tax P&L report from Zerodha Console without modifying it.');
      }
      continue;
    }

    const sym = row[colMap.get('Symbol')];
    if (sym === null || sym === undefined) continue;

    const qty = Number(row[colMap.get('Quantity')]);
    const buyValue = Number(row[colMap.get('Buy Value')]);
    const sellValue = Number(row[colMap.get('Sell Value')]);
    const profit = Number(row[colMap.get('Profit')]);

    const trip = {
      sym: String(sym),
      qty,
      // direction is always 'long': the source records only Buy Value/Sell
      // Value, not which leg came first, so true long/short is not
      // recoverable. Using direction='long' with entry=avg_buy, exit=avg_sell
      // makes downstream sell_value - buy_value equal the source Profit
      // exactly; only the buy/sell narrative on genuinely short legs displays
      // inverted. Deliberate, matches HANDOFF.md:56-60. Do not infer direction.
      direction: 'long',
      entry_px: pyRound(buyValue / qty, 2),
      exit_px: pyRound(sellValue / qty, 2),
      entry_date: asIsoDate(row[colMap.get('Entry Date')]),
      exit_date: asIsoDate(row[colMap.get('Exit Date')]),
      // Taken verbatim from the file's Profit column -- never recomputed --
      // because the source's Profit may reflect adjustments not visible in
      // Buy Value/Sell Value alone.
      pnl: profit,
    };

    if (!bySegment.has(currentSection)) bySegment.set(currentSection, []);
    bySegment.get(currentSection).push(trip);
  }

  return [...bySegment.entries()].map(([segment, trips]) => ({ segment, trips }));
}

/** Finds the sheet whose name starts with "Tradewise Exits" in a SheetJS workbook. */
export function detectTaxPnlSheet(workbook) {
  const names = (workbook && workbook.SheetNames) || [];
  for (const n of names) {
    if (String(n).trim().startsWith('Tradewise Exits')) return n;
  }
  return null;
}
