const EPS = 1e-9;

/** Match buy/sell fills FIFO into completed round-trips. */
export function fifoRoundtrips(fills) {
  const bySym = new Map();
  for (const fl of fills) {
    if (!bySym.has(fl.sym)) bySym.set(fl.sym, []);
    bySym.get(fl.sym).push(fl);
  }

  const trips = [];
  for (const [sym, fs] of bySym) {
    fs.sort((a, b) => (a.tm < b.tm ? -1 : a.tm > b.tm ? 1 : 0));
    const lots = []; // open lots, FIFO: {qty, px, date, side}

    for (const fl of fs) {
      let q = fl.qty;
      const side = fl.side;

      while (q > EPS && lots.length &&
             ((lots[0].side === 'buy' && side === 'sell') ||
              (lots[0].side === 'sell' && side === 'buy'))) {
        const lot = lots[0];
        const m = Math.min(q, lot.qty);
        const direction = lot.side === 'buy' ? 'long' : 'short';
        const entry_px = lot.px;
        const exit_px = fl.px;
        const pnl = direction === 'long'
          ? (exit_px - entry_px) * m
          : (entry_px - exit_px) * m;

        trips.push({
          sym, qty: m, entry_px, exit_px,
          entry_date: lot.date, exit_date: fl.date,
          direction, pnl,
        });

        lot.qty -= m;
        q -= m;
        if (lot.qty <= EPS) lots.shift();
      }

      if (q > EPS) lots.push({ qty: q, px: fl.px, date: fl.date, side });
    }
  }
  return trips;
}
