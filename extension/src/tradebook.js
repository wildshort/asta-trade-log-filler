// extension/src/tradebook.js

export class TradebookError extends Error {
  constructor(userMessage) {
    super(userMessage);
    this.name = 'TradebookError';
    this.userMessage = userMessage;
  }
}

function asIso(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  // Already ISO-ordered (YYYY-MM-DD, optionally with a time suffix).
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // Zerodha/Excel text cells commonly use DD-MM-YYYY or DD/MM/YYYY.
  m = s.match(/^(\d{2})[-/](\d{2})[-/](\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return s.slice(0, 10);
}

function asStamp(v) {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/**
 * The first populated (non-null, non-undefined) cell in a row. SheetJS and
 * openpyxl disagree on whether an entirely-empty leading column A is padded
 * into the row array or omitted from it, so column position is not a
 * reliable way to find the header row -- but "Symbol" is always the
 * left-most populated cell of a genuine header row in either shape.
 */
function firstPopulatedCell(row) {
  for (const c of row) {
    if (c !== null && c !== undefined) return c;
  }
  return undefined;
}

/**
 * Build a header-name -> column-index map from a header row, so every
 * subsequent row is read by column NAME rather than by a fixed position.
 * This is what makes loadFills/detectSegment shape-independent: it works
 * identically whether or not the sheet has a padded leading column.
 */
function buildColumnMap(row) {
  const map = new Map();
  row.forEach((cell, i) => {
    if (cell === null || cell === undefined) return;
    const name = String(cell).trim();
    if (name && !map.has(name)) {
      map.set(name, i);
    }
  });
  return map;
}

function isHeaderRow(row) {
  const first = firstPopulatedCell(row);
  return first !== undefined && String(first).trim() === 'Symbol';
}

/** Columns loadFills depends on; a silently-missing one produces NaN/undefined data. */
const REQUIRED_COLUMNS = ['Symbol', 'Trade Date', 'Trade Type', 'Quantity', 'Price', 'Order Execution Time'];

/**
 * @param {{rows: any[][]}} sheet rows from SheetJS sheet_to_json(header:1, cellDates:true)
 */
export function loadFills(sheet) {
  const rows = sheet.rows;
  let colMap = null;
  let headerNames = null;
  const fills = [];

  for (const row of rows) {
    // Matches the Python port's semantics exactly: every row is checked for a
    // header, unconditionally, and the last one wins (a later, genuine header
    // overwrites an earlier incomplete one). A matched header row is never
    // treated as a fill row.
    if (isHeaderRow(row)) {
      colMap = buildColumnMap(row);
      headerNames = [...colMap.keys()];
      continue;
    }
    if (!colMap) continue;

    const symIdx = colMap.get('Symbol');
    const sym = symIdx === undefined ? undefined : row[symIdx];
    if (sym === null || sym === undefined) continue;

    const sideIdx = colMap.get('Trade Type');
    const side = sideIdx === undefined ? undefined : String(row[sideIdx]);
    if (side !== 'buy' && side !== 'sell') continue;

    // Trade ID is the broker's own unique id for the fill -- not in
    // REQUIRED_COLUMNS (older exports may lack it), captured verbatim so
    // callers merging multiple files can dedup on it rather than guessing
    // from symbol/date/qty/price. null (not the raw '' Zerodha sometimes
    // leaves) when the column is absent or the cell is blank.
    const tradeIdIdx = colMap.get('Trade ID');
    const rawTradeId = tradeIdIdx === undefined ? null : row[tradeIdIdx];
    const tradeId = rawTradeId === null || rawTradeId === undefined || String(rawTradeId).trim() === ''
      ? null
      : String(rawTradeId).trim();

    fills.push({
      sym: String(sym),
      date: asIso(row[colMap.get('Trade Date')]),
      side,
      qty: Number(row[colMap.get('Quantity')]),
      px: Number(row[colMap.get('Price')]),
      tm: asStamp(row[colMap.get('Order Execution Time')]),
      tradeId,
    });
  }

  if (!headerNames || !headerNames.includes('Trade Date')) {
    throw new TradebookError(
      'That file does not look like a Zerodha TRADEBOOK.\n\n' +
      'You have probably downloaded the P&L report, which has symbol-wise totals and no dates. ' +
      'This tool needs the TRADEBOOK, which lists every individual fill with a date.\n\n' +
      'Zerodha Console -> Reports -> Tradebook (NOT "P&L", NOT "Tax P&L")\n' +
      '  - run it once with Segment = F&O\n' +
      '  - run it again with Segment = Commodity\n\n' +
      'The correct file has columns: Symbol | Trade Date | Trade Type | Quantity | Price');
  }
  const missing = REQUIRED_COLUMNS.filter((c) => !colMap.has(c));
  if (missing.length > 0) {
    throw new TradebookError(
      `That tradebook is missing the required column${missing.length > 1 ? 's' : ''}: ` +
      `${missing.map((c) => `"${c}"`).join(', ')}.\n\n` +
      'Zerodha may have renamed a header, or the file was edited after export. ' +
      'Re-download the TRADEBOOK from Zerodha Console (Reports -> Tradebook) without modifying it.');
  }
  if (fills.length === 0) {
    throw new TradebookError(
      'That file is a tradebook, but it contains no buy or sell fills. ' +
      'Re-download it from Zerodha Console with the dates you actually traded.');
  }
  return fills;
}

/**
 * Mirrors the Python's detect_segment (asta_autofill.py:225-249): reads the
 * Segment column (not Exchange) and accumulates the distinct values seen
 * across every row, rather than returning on the first recognised row. A
 * mixed sheet (e.g. an NSE row before an MCX row) is decided by preferring
 * 'Commodity' whenever both appear, exactly like the Python -- because a
 * strategy is booked to whichever box the trader dropped the file in, and a
 * single stray commodity fill must not be silently dropped as F&O. Falls
 * back to the sheet name when the Segment column doesn't disambiguate.
 */
export function detectSegment(sheet) {
  let colMap = null;
  const segs = new Set();
  for (const row of sheet.rows) {
    if (isHeaderRow(row)) {
      colMap = buildColumnMap(row);
      continue;
    }
    if (!colMap) continue;
    const segIdx = colMap.get('Segment');
    if (segIdx === undefined) continue;
    const seg = row[segIdx];
    if (seg === null || seg === undefined) continue;
    segs.add(String(seg).trim().toUpperCase());
    if (segs.size > 2) break;
  }
  const sheetName = String(sheet.name || '').trim().toLowerCase();
  if (segs.has('COM') || segs.has('MCX') || sheetName.includes('commodity')) return 'Commodity';
  if (segs.has('FO') || sheetName.includes('f&o') || sheetName === 'fo') return 'F&O';
  return null;
}
