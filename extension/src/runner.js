// extension/src/runner.js
//
// Orchestrates writing jobs into the live ASTA trading journal, with
// checkpointing so an interrupted run resumes instead of restarting a
// strategy from scratch.
//
// HONEST LIMITATION -- this gives AT-LEAST-ONCE semantics, not exactly-once.
// Every checkpoint write happens AFTER its client call returns successfully,
// so there is a real window, on every single write, where the network call
// has already landed on the live journal but the process dies before the
// checkpoint is persisted. A resumed run then repeats that one write
// (duplicate leg, or a second exit attempt against an already-closed
// position). See the comments at each `store.set` call below for the
// specific window. This is a known, accepted gap, not an oversight -- ASTA's
// API gives no idempotency key to close it, and per Ruling 1 the layer above
// (leg-to-position matching) already refuses to guess when it can't tell
// what's really open, which limits how far a duplicate can propagate. One
// path is worse than a crash-timing accident: if the very first leg's addLeg
// response can't be parsed for a header, the leg has still landed, but the
// checkpoint deliberately does NOT record it as done, so every retry reposts
// it deterministically. See "KNOWN DUPLICATE PATH" at the header==null check
// below for why that was chosen over the alternatives.
//
// This file deliberately departs from the naive brief implementation in two
// places, per standing review rulings that take precedence over the brief:
//
// RULING 1 (leg-to-position pairing must fail loud), REVISED: getPositions()
// row order is not verified against the live site to match the order legs
// were added, so we never rely on it. After all of a strategy's legs are
// added, positions are read ONCE, both legs and positions are grouped by the
// exact tuple (Instrument, StrikePrices, TradeDirections, EntryPrices,
// ExpiryDate, NoOfLots), and each group is paired deterministically WHEN the leg count
// and position count for that tuple agree. If they disagree for any tuple,
// the whole strategy aborts (no exits are written) and is recorded as failed
// -- never an index-order or best-guess fallback across DIFFERENT tuples.
// The original version of this ruling required exactly one candidate per
// individual leg with no exception; that blanket rule was corrected after
// review found it aborts real strategies (SILVERM 26JUL) which legitimately
// hold multiple tuple-identical legs, with legs already written live and no
// way for a re-run to repair it. See the
// SYMMETRY ARGUMENT in the comment above matchLegsToPositions() below for why
// pairing within a same-sized tuple group is safe rather than a guess.
//
// RULING 2 (jobs.js's heading normaliser is not a dedup key):
// extension/src/jobs.js's normaliseHeading() is a trivial
// trim/uppercase/collapse-whitespace normaliser, NOT the Python
// canon_heading() that collapses equivalent weekly-series spellings (e.g.
// 'NIFTY 26W407' == 'NIFTY 26W-APR07'). Using jobs.js's
// normaliseHeading() to dedup against existingViews() would create duplicate
// views in the live journal for those spellings. This file ports the real
// Python semantics locally as canonHeadingKey() (see asta_autofill.py:425-442)
// and uses THAT for dedup against ASTA's existing views. jobs.js is not
// modified.

import { normalizeExpiry } from './dates.js';

const MON = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};
const WMON = {
  1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, O: 10, N: 11, D: 12,
};

/**
 * Port of asta_autofill.py:425-442 (canon_heading), returning a string key
 * instead of a tuple. Collapses equivalent weekly-series spellings so
 * dedup against ASTA's existing views isn't fooled by formatting, e.g.
 * 'NIFTY 26W407' and 'NIFTY 26W-APR07' both key to 'NIFTY|26|W|4|07'.
 * Used ONLY for dedup -- jobs.js's normaliseHeading() is untouched and used
 * elsewhere for its own (unrelated) normalisation purpose.
 */
export function canonHeadingKey(h) {
  const s = String(h ?? '').toUpperCase().trim().split(/\s+/).join(' ');

  let m = /^(.+?)\s+(\d{2})W-?([A-Z]{3}|[1-9OND])(\d{2})$/.exec(s);
  if (m) {
    const mo = MON[m[3]] ?? WMON[m[3]];
    return `${m[1]}|${m[2]}|W|${mo ?? ''}|${m[4]}`;
  }

  m = /^(.+?)\s+(\d{2})([A-Z]{3})$/.exec(s);
  if (m && MON[m[3]]) {
    return `${m[1]}|${m[2]}|M|${MON[m[3]]}|`;
  }

  return s;
}

function normStr(v) {
  return String(v ?? '').trim().toUpperCase();
}

/**
 * THE FIX for the 402134-402137 live incident: this used to be a bare
 * `.slice(0, 10)`, which silently assumed getPositions() echoes ExpiryDate
 * back in the same 'DD-MM-YYYY' shape our legs carry. It does not -- ASTA
 * returns an ISO datetime ('2026-01-06T00:00:00'), so slicing the leg's
 * '06-01-2026' and the position's '2026-01-06' to their first 10 characters
 * produced two different strings that never compared equal. Every leg
 * matched 0 positions and the strategy aborted with legs already written and
 * no exits. See extension/src/dates.js's normalizeExpiry() for the full
 * writeup and tests/fixtures/live-positions.json for the real response that
 * exposed this.
 */
function normExpiry(v) {
  return normalizeExpiry(v);
}

/**
 * The exact match tuple per Ruling 1: (Instrument, StrikePrices,
 * TradeDirections, EntryPrices, ExpiryDate, NoOfLots). No tolerance, no
 * partial match. Used to group both legs and positions into buckets of "these
 * are the same contract, entered the same way, in the same size" -- see
 * matchLegsToPositions() below.
 *
 * LOT SIZE IS PART OF THE TUPLE, and that is load-bearing rather than
 * belt-and-braces. The symmetry argument below only licenses pairing within a
 * group when the grouped positions are genuinely indistinguishable, and lot
 * count is precisely what can distinguish two otherwise-identical positions:
 * exitLeg() posts NoOfLots from the POSITION but AmountEarned, ExitPrices and
 * FormEntryDate from the LEG (asta-api.js), and ASTA derives a position's P&L
 * as (exit - entry) * NoOfLots. So pairing a 2500-lot leg's exit onto a
 * 3750-lot position writes a wrong financial record -- wrong AmountEarned on
 * that row and a wrong strategy total -- and does it silently, reported as a
 * success. The real NATURALGAS 26MAY strategy in the golden fixture holds
 * exactly this shape (tuple-identical groups of 2500 and 3750 lots), which is
 * how the defect was found.
 *
 * Adding lots is strictly a TIGHTENING, not a return to the blanket
 * one-position-per-leg rule that was rejected: verified against the real
 * golden data, it splits both asymmetric NATURALGAS groups into exact
 * singletons while leaving SILVERM 26JUL (5 lots and 5 lots, genuinely
 * symmetric) as a valid pair.
 */
function legTupleKey(leg) {
  return [normStr(leg.inst), Number(leg.strike), normStr(leg.dir),
    Number(leg.entry), normExpiry(leg.exp), Number(leg.lots)].join('|');
}
function positionTupleKey(position) {
  return [normStr(position.Instrument), Number(position.StrikePrices), normStr(position.TradeDirections),
    Number(position.EntryPrices), normExpiry(position.ExpiryDate), Number(position.NoOfLots)].join('|');
}

/**
 * Match every leg of a strategy to exactly one position, grouped by the exact
 * tuple, then pair within each group. One real strategy in the golden fixture
 * (SILVERM 26JUL) legitimately holds multiple legs that are tuple-identical --
 * the same contract, same size, entered at the same price and closed on
 * different days. A blanket "must match exactly one position" rule aborts such
 * a strategy with legs already written and no exits -- unrepairable by
 * re-running, since the checkpoint just replays the same abort.
 *
 * THE SYMMETRY ARGUMENT (why pairing within a same-sized group is safe, not a
 * guess): when K legs and K positions all share one tuple, every field ASTA's
 * journal records about those K positions is identical to every other one in
 * the group -- same instrument, strike, direction, entry price, expiry, AND
 * lot count. There is no journal-visible difference between "leg A's exit went
 * to position 3" and "leg A's exit went to position 7" when position 3 and
 * position 7 are themselves indistinguishable on every field that matters. The
 * resulting journal content is the same either way, so any deterministic,
 * stable pairing within the group is as correct as any other -- it is a genuine
 * symmetry, not a best-guess.
 *
 * That argument depends ENTIRELY on the tuple covering every field that
 * changes what gets written. It did not, at first: lot count was omitted, and
 * because exitLeg() takes NoOfLots from the position but AmountEarned from the
 * leg, two "identical" positions of 2500 and 3750 lots were being paired
 * arbitrarily -- writing a wrong AmountEarned and a wrong P&L, reported as a
 * success. See legTupleKey() above. If a field is ever added to exitLeg's
 * payload that comes from the POSITION, check whether it belongs in the tuple
 * too.
 *
 * DO NOT loosen this into "any group of the same size pairs" without that
 * check, and DO NOT tighten it back into a blanket one-position-per-leg abort:
 * the latter was tried and it fails SILVERM 26JUL for no safety gain.
 *
 * What remains a hard abort, unchanged: if a tuple group's leg count and
 * position count DIFFER (more legs than positions, or vice versa), something
 * is genuinely missing or unexpected -- that is real ambiguity, not symmetry,
 * and the strategy still aborts with no exits written. Pairing NEVER crosses
 * tuple groups, and never falls back to global index order.
 */
function matchLegsToPositions(job, positions) {
  const legGroups = new Map(); // tupleKey -> [{ leg, idx }], idx = original leg index
  job.legs.forEach((leg, idx) => {
    const k = legTupleKey(leg);
    if (!legGroups.has(k)) legGroups.set(k, []);
    legGroups.get(k).push({ leg, idx });
  });

  const posGroups = new Map(); // tupleKey -> [position]
  for (const p of positions) {
    const k = positionTupleKey(p);
    if (!posGroups.has(k)) posGroups.set(k, []);
    posGroups.get(k).push(p);
  }

  const matches = new Array(job.legs.length);
  for (const [tupleKey, legEntries] of legGroups) {
    const posEntries = posGroups.get(tupleKey) || [];
    if (posEntries.length !== legEntries.length) {
      const sample = legEntries[0].leg;
      const desc = `${sample.inst} ${sample.strike} ${sample.dir} @ ${sample.entry} ` +
        `exp ${sample.exp}, ${sample.lots} lots`;
      throw new Error(
        `${job.heading}: ${legEntries.length} leg(s) (${desc}) matched ${posEntries.length} open position(s); ` +
        `expected the leg count and position count for this contract to match exactly. ` +
        `Aborting strategy -- no exits were written.`);
    }
    // Deterministic pairing within the group -- see the symmetry argument above.
    // Sort positions by their own SeqNo and legs by original index so the same
    // input always produces the same pairing (reproducible across a resume,
    // never dependent on getPositions()'s row order).
    const sortedPositions = [...posEntries].sort((a, b) => Number(a.SeqNo) - Number(b.SeqNo));
    const sortedLegs = [...legEntries].sort((a, b) => a.idx - b.idx);
    for (let i = 0; i < sortedLegs.length; i++) {
      matches[sortedLegs[i].idx] = sortedPositions[i];
    }
  }
  return matches;
}

/**
 * The per-job checkpoint key. MUST identify a job as precisely as the job
 * itself is identified, which means including segment.
 *
 * job.heading is only underlying+series, while the group key buildJobs() uses
 * is underlying|series|segment (jobs.js). The same underlying and series
 * traded in both F&O and Commodity therefore produces two DIFFERENT jobs whose
 * headings are identical. Keyed on heading alone they shared one checkpoint:
 * the first was written and checkpointed done:true, then the second read that
 * checkpoint, reported "skipped", and was never written -- a whole strategy
 * silently missing from the journal while the run reported success.
 *
 * This key format is deliberately different from the one earlier builds wrote
 * (a bare heading). Old checkpoints therefore do not match; see the legacy
 * lookup in runJobs() for how that is handled without either crashing or
 * re-writing completed work.
 */
export function checkpointKey(job) {
  return `${job.heading}|${job.segment}`;
}

/** The pre-segment key format, kept only to migrate checkpoints written by earlier builds. */
function legacyCheckpointKey(job) {
  return job.heading;
}

/** In-memory store used by tests and as the ChromeStore interface contract. */
export class MemoryStore {
  constructor() { this.data = new Map(); }
  async get(key) { return this.data.get(key) ?? null; }
  async set(key, value) { this.data.set(key, value); }
  async clear() { this.data.clear(); }
}

/**
 * Write each job to ASTA, checkpointing before and after every mutation so an
 * interrupted run resumes instead of duplicating work.
 *
 * Checkpoint shape (per job, keyed by checkpointKey(job) -- heading AND segment):
 *   { viewSeq, header, legsDone, legMatches, exitedIdx, done }
 * - viewSeq is persisted the INSTANT it is created, before any leg is added.
 * - legMatches (the leg -> position mapping from Ruling 1) is persisted the
 *   instant matching succeeds, before any exit is written. This matters
 *   because once a leg is exited its position closes and disappears from a
 *   later getPositions() call -- re-matching on resume would then wrongly
 *   look like a leg failed to match. Persisting the mapping up front makes
 *   resume just replay exits, never re-derive matches from a partially
 *   closed position list.
 *
 * Return shape: { written, skipped, failed, notAttempted, sessionExpired }.
 * Each `failed` entry is
 *   { heading, segment, error, partiallyWritten, legsWritten, exitsWritten }.
 * `partiallyWritten` is true when legs for this strategy have landed in the
 * live journal but not all of their exits have -- open positions carrying no
 * P&L. That is a materially different outcome from a strategy that failed
 * before writing anything, and the UI must not flatten the two into one
 * "Failed" count: only the partial one needs a human to open ASTA and look.
 * `sessionExpired` is null on a normal completion, or the AstaError's
 * human-readable .userMessage if the run stopped early because the ASTA
 * session expired (AstaError#sessionExpired -- see asta-api.js). When that
 * happens, `notAttempted` lists the headings of every job the run did not
 * reach (including the one in progress when the 401 arrived) -- these are
 * NOT added to `failed`, since nothing about them failed; the run simply
 * stopped. Calling runJobs() again with the same jobs/store resumes exactly
 * where it stopped.
 */
export async function runJobs({ jobs, client, store, acct, token, onProgress = () => {} }) {
  let written = 0;
  let skipped = 0;
  const failed = [];
  // Strategies never attempted because the run stopped early on a session
  // expiry -- distinct from `failed`: nothing is wrong with these strategies,
  // the run just didn't get to them. Everything already checkpointed for
  // earlier strategies (and any partial progress on the one that was running
  // when the session expired) is untouched, so a later runJobs() call with
  // the same jobs/store picks up exactly where this one stopped.
  const notAttempted = [];
  let sessionExpired = null;

  const existing = await client.existingViews();
  const existingKeys = new Set(
    existing.filter(([, n]) => n > 0).map(([heading]) => canonHeadingKey(heading)));

  // How many jobs in THIS run share each heading. A legacy (pre-segment)
  // checkpoint is keyed on the bare heading, so it can only be safely adopted
  // when exactly one job in the run could have written it -- if two jobs share
  // the heading, the legacy checkpoint cannot say which of them it belongs to,
  // and guessing would reinstate exactly the collision this key change fixes.
  const headingCounts = new Map();
  for (const j of jobs) headingCounts.set(j.heading, (headingCounts.get(j.heading) ?? 0) + 1);

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const cpKey = checkpointKey(job);

    // What has actually LANDED on the live journal for this strategy, counted
    // across resumes rather than just this pass. A failure is not one thing:
    // failing before any leg is posted leaves the journal untouched, while
    // failing after the legs are posted -- which is exactly what a matching
    // abort does, since matching happens only once every addLeg has returned
    // 2xx -- leaves open positions carrying no P&L. Reporting both as plain
    // "Failed" tells the user "nothing happened" in the one case where they
    // must go and look. See the failed.push() in the catch below.
    let legsPosted = 0;
    let exitsPosted = 0;

    try {
      let cp = await store.get(cpKey);

      // Adopt a checkpoint written under the old bare-heading key format, but
      // only when this run holds exactly one job with that heading, so the
      // adoption is unambiguous. Migrate it to the new key so this lookup is
      // needed once and not on every future run. When it is ambiguous, both
      // jobs simply start fresh -- the existingViews() dedup above still stops
      // an already-logged strategy from being written twice.
      if (!cp && headingCounts.get(job.heading) === 1) {
        const legacy = await store.get(legacyCheckpointKey(job));
        if (legacy) {
          cp = legacy;
          await store.set(cpKey, cp);
        }
      }

      if (cp && cp.done) {
        skipped++;
        onProgress({ done: i + 1, total: jobs.length, heading: job.heading, segment: job.segment, status: 'skipped' });
        continue;
      }

      // Dedup against ASTA's live journal using the REAL canon_heading
      // semantics (Ruling 2), not jobs.js's trivial normaliseHeading(). Only
      // applies when we have no local checkpoint for this job -- a local
      // checkpoint always takes precedence since it's known-accurate.
      if (!cp && existingKeys.has(canonHeadingKey(job.heading))) {
        skipped++;
        onProgress({ done: i + 1, total: jobs.length, heading: job.heading, segment: job.segment, status: 'skipped-duplicate' });
        continue;
      }

      if (!cp || !cp.viewSeq) {
        const viewSeq = await client.createView(acct, job, token);
        // A null viewSeq means the response carried no AddOrEditNewView/<id>
        // redirect (see AstaClient.createView) -- exactly the same shape as the
        // null header from addLeg handled below, and treated exactly the same
        // way: a hard, strategy-level abort with NO checkpoint written.
        //
        // Storing it would be silently destructive rather than merely useless:
        // every leg would be posted with ScriptAnalysisSeqNo=null (a strategy
        // attached to no view), the exits would follow, and the strategy would
        // be reported written and checkpointed done:true. Worse, on a resume
        // the `!cp.viewSeq` test above is true for a null, so the strategy
        // would get a SECOND view. Throwing here leaves nothing persisted, so a
        // retry starts this strategy cleanly. The view itself may or may not
        // exist on ASTA's side (the POST landed, only its id was unreadable) --
        // if it does, it is an empty shell with no legs, which existingViews()
        // deliberately does not treat as already-logged (NoOfTrades == 0), so a
        // later run still writes this strategy properly.
        if (viewSeq == null) {
          throw new Error(`${job.heading}: createView did not return a view SeqNo, so there is ` +
            `no view to attach this strategy's legs to; aborting strategy. Nothing was written ` +
            `beyond a possible empty view shell, which a re-run will replace.`);
        }
        cp = { viewSeq, header: 0, legsDone: 0, legMatches: null, exitedIdx: [], done: false };
        // Persist BEFORE any leg is added. An interrupt after this point resumes
        // into the same view rather than leaving an orphan and creating another.
        await store.set(cpKey, cp);
      }
      if (!cp.exitedIdx) cp.exitedIdx = [];

      // Seeded from the checkpoint, not from zero: legs posted by an EARLIER
      // run are still sitting in the journal, so a resume that aborts is just
      // as partially-written as a first attempt that aborts.
      legsPosted = cp.legsDone ?? 0;
      exitsPosted = cp.exitedIdx.length;

      for (let li = cp.legsDone; li < job.legs.length; li++) {
        const leg = job.legs[li];
        const header = await client.addLeg(acct, cp.viewSeq, cp.header, job, leg, token);
        // Counted the moment addLeg returns, BEFORE the header check below:
        // the POST has landed on the live journal either way, and whether its
        // response happened to carry a parseable header does not change that.
        legsPosted = li + 1;
        // A null header means the FIRST leg's response didn't carry the
        // expected Strategy/Index/<seqno> redirect (see AstaClient.addLeg).
        // There is then no header to add further legs under or to read
        // positions with, so this is a hard, strategy-level abort -- never
        // silently fall back to the placeholder 0.
        //
        // KNOWN DUPLICATE PATH (distinct from the generic AT-LEAST-ONCE window
        // below -- this one is DETERMINISTIC, not a crash-timing accident):
        // by the time we're here, this leg's POST has already landed on ASTA
        // (the response came back 2xx, just without a parseable header), yet
        // cp.legsDone is deliberately NOT advanced before this throw. That
        // means a resumed run will call addLeg() for this exact leg again with
        // header still 0, guaranteeing a second copy of it in the journal --
        // every single retry, not just an unlucky one.
        //
        // This was a deliberate choice, not an oversight: the alternative --
        // bumping cp.legsDone here so the resume "skips" this leg -- was
        // rejected because we still don't know this leg's header. The next
        // leg's addLeg() would then need cp.header, which is still 0, so it
        // would be posted as if IT were the first leg of a brand new strategy
        // under the same view -- splitting one strategy's legs across two
        // unrelated headers, which getPositions()/exitLeg() can never
        // reconcile. That state is strictly worse and permanently unrepairable,
        // whereas the deterministic repost above is at least a known, bounded,
        // honestly-documented failure this comment describes plainly. ASTA's
        // API exposes no way to look up "what header did that already-landed
        // leg get" after the fact, so there is no safe repair available here
        // with the current client surface -- only the choice between two
        // unsafe ones, and this is the less-bad one.
        if (header == null) {
          throw new Error(`${job.heading}: addLeg did not return a strategy header ` +
            `(leg ${li + 1}/${job.legs.length}); aborting strategy.`);
        }
        cp.header = header;
        cp.legsDone = li + 1;
        // AT-LEAST-ONCE WINDOW: client.addLeg() has already posted the leg to the
        // live journal by the time we reach this line. If the process dies between
        // that POST landing and this store.set() completing, a resumed run does not
        // know the leg was added and will call addLeg() again for it -- duplicating
        // the leg. There is no cheaper way to close this window without an
        // idempotency key from ASTA's API, which does not exist.
        await store.set(cpKey, cp);
      }

      if (!cp.legMatches) {
        const positions = await client.getPositions(cp.header);
        const matches = matchLegsToPositions(job, positions);
        cp.legMatches = matches;
        // Persisted before any exit is written -- see class doc above. This one
        // does NOT have an at-least-once window of its own: getPositions() is a
        // read, matching is pure, and nothing external happens until exitLeg().
        await store.set(cpKey, cp);
      }

      for (let li = 0; li < job.legs.length; li++) {
        if (cp.exitedIdx.includes(li)) continue;
        const leg = job.legs[li];
        const positionModel = cp.legMatches[li];
        await client.exitLeg(cp.header, positionModel, leg, token);
        exitsPosted++;
        cp.exitedIdx.push(li);
        // AT-LEAST-ONCE WINDOW: same shape as the addLeg one above. client.exitLeg()
        // has already posted the exit by the time we reach this line; a crash before
        // store.set() completes means a resumed run repeats the exit call for a
        // position that may already be closed on ASTA's side.
        await store.set(cpKey, cp);
      }

      cp.done = true;
      await store.set(cpKey, cp);
      written++;
      onProgress({ done: i + 1, total: jobs.length, heading: job.heading, segment: job.segment, status: 'written' });
    } catch (err) {
      if (err && err.sessionExpired) {
        // Every remaining ASTA call will fail the exact same way, so stop now
        // instead of turning the rest of the run into a wall of identical,
        // uninformative "(401)" failures. This job -- whatever progress it
        // made before the 401 (view created, some legs added, matches found)
        // -- is already checkpointed by the store.set() calls above; it and
        // every job after it go into `notAttempted`, not `failed`, since none
        // of them were actually tried to a real conclusion. A later call to
        // runJobs() with the same store resumes from here: completed jobs
        // report `skipped`, this one continues from its checkpoint.
        sessionExpired = err.userMessage;
        for (let j = i; j < jobs.length; j++) notAttempted.push(jobs[j].heading);
        break;
      }
      // partiallyWritten is the difference between "this strategy is simply not
      // in your journal, retry it" and "this strategy is in your journal with
      // open positions and no P&L, go and look at it". Only the second needs a
      // human. Legs with fewer exits than legs is exactly that state.
      const partiallyWritten = legsPosted > 0 && exitsPosted < legsPosted;
      failed.push({
        heading: job.heading,
        segment: job.segment,
        error: err.userMessage || err.message,
        partiallyWritten,
        legsWritten: legsPosted,
        exitsWritten: exitsPosted,
      });
      onProgress({
        done: i + 1, total: jobs.length, heading: job.heading, segment: job.segment,
        status: partiallyWritten ? 'failed-partial' : 'failed',
      });
    }
  }

  return { written, skipped, failed, notAttempted, sessionExpired };
}
