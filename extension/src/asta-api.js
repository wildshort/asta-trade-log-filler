import { shiftWeekday } from './dates.js';

const BASE = 'https://myasta.avadhutsathe.in';

export class AstaError extends Error {
  constructor(userMessage, { retryable = false, sessionExpired = false } = {}) {
    super(userMessage);
    this.name = 'AstaError';
    this.userMessage = userMessage;
    this.retryable = retryable;
    // Set when the failure is specifically an expired/invalid ASTA session --
    // as opposed to any other rejection -- so callers (runner.js, the UI) can
    // react differently: stop instead of treating it as a per-strategy
    // failure, and point the user at the Resume flow instead of a generic
    // error. See #request()'s 401 branch and getToken()/getAccountCode()'s
    // login-page sniffing below, which are the two places this gets set.
    this.sessionExpired = sessionExpired;
  }
}

const SESSION_EXPIRED_MESSAGE =
  'Your ASTA session has expired. Open myasta.avadhutsathe.in in this browser, ' +
  'log in, then come back and click Resume.';

const NOT_LOGGED_IN = new AstaError(SESSION_EXPIRED_MESSAGE, { retryable: false, sessionExpired: true });

export class AstaClient {
  constructor({ fetchImpl = globalThis.fetch.bind(globalThis), backoffMs = 500, maxAttempts = 4 } = {}) {
    this.fetchImpl = fetchImpl;
    this.backoffMs = backoffMs;
    this.maxAttempts = maxAttempts;
  }

  // `retry: false` is for non-idempotent writes (createView, addLeg, exitLeg): a POST that
  // landed on the server but whose response was lost to a network error or a 500 must NOT
  // be retried here, because retrying re-sends the same write and can duplicate a leg or an
  // exit in the live journal. Those calls instead throw immediately on the first failure,
  // which the runner's per-strategy try/catch turns into a safe, resumable abort. Reads
  // (getToken, getAccountCode, loadScrips, existingViews, getPositions) keep the default
  // `retry: true` -- re-fetching a GET or a grid read cannot corrupt anything.
  async #request(path, { method = 'GET', body = null, retry = true } = {}) {
    let lastErr = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let res;
      try {
        // Note: Python's post_form (asta_autofill.py:202-212) also sets a Referer header,
        // but that isn't ported here on purpose -- Referer is a Fetch-spec forbidden
        // header name, so a browser silently drops it when set via `headers` from
        // extension code; it never reaches the wire. ASTA's __RequestVerificationToken
        // check is a cookie+form-field comparison and doesn't inspect Referer (Python's
        // own comment only justifies avoiding X-Requested-With, which causes a 401 -- it
        // never claims Referer is required). Do not re-add it.
        res = await this.fetchImpl(BASE + path, {
          method,
          credentials: 'include',
          headers: body
            ? { 'Content-Type': 'application/x-www-form-urlencoded' }
            : {},
          body,
        });
      } catch (networkErr) {
        lastErr = new AstaError(
          'Could not reach ASTA. Check your internet connection.', { retryable: true });
        lastErr.cause = networkErr;
        if (!retry) throw lastErr;
        // No backoff before giving up: sleeping after the final attempt just
        // delays the error the caller is already getting.
        if (attempt === this.maxAttempts) break;
        await this.#sleep(attempt);
        continue;
      }

      if (res.status >= 500) {
        lastErr = new AstaError(
          `ASTA returned a server error (${res.status}).`, { retryable: true });
        if (!retry) throw lastErr;
        // No backoff before giving up: sleeping after the final attempt just
        // delays the error the caller is already getting.
        if (attempt === this.maxAttempts) break;
        await this.#sleep(attempt);
        continue;
      }
      // 401 specifically means the session cookie is no longer valid -- this is
      // the single most likely failure in a real run (sessions last ~30-45
      // minutes, a full backfill run is dozens of strategies). Distinguishing
      // it from a generic 4xx via `sessionExpired` lets runJobs() stop the run
      // instead of burning through every remaining strategy as an identical,
      // uninformative failure, and lets the UI show the Resume flow instead of
      // a wall of "(401)" entries. Never retried, same as any other 4xx.
      if (res.status === 401) {
        throw new AstaError(SESSION_EXPIRED_MESSAGE, { retryable: false, sessionExpired: true });
      }
      if (res.status >= 400) {
        // Never retry: writes are not idempotent and a retry can duplicate a leg.
        throw new AstaError(
          `ASTA rejected the request (${res.status}). Nothing further was written.`,
          { retryable: false });
      }
      return res;
    }
    throw lastErr;
  }

  #sleep(attempt) {
    const ms = this.backoffMs * Math.pow(2, attempt - 1);
    return new Promise((r) => setTimeout(r, ms));
  }

  async getToken() {
    const res = await this.#request('/tradelog/viewbuilder/addoreditnewview');
    const html = await res.text();
    if (!html.trim() || html.includes('Forgot your password')) throw NOT_LOGGED_IN;
    const m = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/.exec(html);
    if (!m) throw NOT_LOGGED_IN;
    return m[1];
  }

  async getAccountCode() {
    const res = await this.#request('/TradeLog/UserDashboard');
    const html = await res.text();
    if (!html.trim() || html.includes('Forgot your password')) throw NOT_LOGGED_IN;
    let m = /AccountCode=(\d{6,})/.exec(html) ||
            /hdAccountCode"[^>]*value="(\d{6,})"/.exec(html);
    if (!m) {
      throw new AstaError(
        'Logged in, but your ASTA account code was not on the dashboard. ' +
        'Open your ASTA dashboard once, then click Resume.', { retryable: false });
    }
    return m[1];
  }

  // Port of asta_autofill.py:484-499 (add_leg). ASTA only tells you the strategy's header
  // SeqNo on the FIRST leg of a view (header passed in as 0) -- it's embedded in the
  // response's redirect URL as .../Strategy/Index/<seqno>, exactly like createView's SeqNo.
  // Every leg after that reuses the already-known header and its response carries no such
  // URL, so the Python only parses when `header == "0"` and otherwise returns the header it
  // was given, unchanged. If the FIRST call's URL doesn't match, there is no header to add
  // subsequent legs under, so this returns null rather than the raw Response (which is
  // truthy and would otherwise get silently persisted into the checkpoint by the caller).
  // The runner treats a null header as a strategy-level abort.
  async addLeg(acct, viewSeq, header, job, leg, token) {
    const body = new URLSearchParams({
      __RequestVerificationToken: token,
      SaveStatus: '',
      SeqNoHeader: String(header),
      ScriptAnalysisSeqNo: String(viewSeq),
      AccountCode: acct,
      StrategyName: job.heading,
      SpotPrice: String(job.spot),
      TradeSetup: '21',
      TradeCharges: '0',
      ISPaperTrade: 'false',
      // shift_weekday, per asta_autofill.py:488. ASTA rejects weekend dates, so
      // a Saturday moves back to the Friday and a Sunday forward to the Monday.
      // Expiry below is deliberately NOT shifted -- the Python does not shift it
      // either, and a contract expiry is a real exchange date, not an entry we
      // are free to nudge.
      EntryDate: shiftWeekday(leg.entryDate),
      Instruments: leg.inst,
      TradeDirection: leg.dir,
      StrikePrice: String(leg.strike),
      EntryPrice: String(leg.entry),
      Expiry: leg.exp,
      NoOfLot: String(leg.lots),
      EstimatedMargin: '0',
      ExchangeCode: job.exchange,
      ScriptCode: job.scrip,
      TradeView: job.view || 'BULLISH',
      ReferenceCode: 'Self',
      SegmentCode: job.segment,
      LotSize: '1', // load-bearing: with NoOfLot=qty this makes ASTA's P&L equal source
    });
    const res = await this.#request('/TradeLog/Strategy', { method: 'POST', body, retry: false });
    if (Number(header) === 0) {
      const m = /Strategy\/Index\/(\d+)/.exec(res.url || '');
      return m ? Number(m[1]) : null;
    }
    return header;
  }

  // Port of asta_autofill.py:213-224 (load_scrips)
  async loadScrips() {
    const read = async (seg, exch) => {
      const res = await this.#request(
        `/TradeLog/Preset/ScriptRead?SegmentCode=${seg}&ExchangeCode=${exch}`);
      try {
        const data = await res.json();
        return new Set(data.map((x) => x.Code));
      } catch {
        return new Set();
      }
    };
    const [nse, mcx] = await Promise.all([
      read('EQUITY', 'NSE'),
      read('COMMODITY', 'MCX'),
    ]);
    return { nse, mcx };
  }

  // Port of asta_autofill.py:445-460 (existing_views)
  //
  // Never degrades an unreadable response into an empty list. This call is the
  // ONLY thing standing between a run and writing every strategy a second time
  // when the local checkpoint store is empty -- a fresh browser profile,
  // cleared extension storage, or a different machine. If a shape change, or a
  // 200 carrying a login page instead of JSON, quietly produced [], dedup would
  // switch itself off and the run would duplicate the entire journal while
  // reporting complete success. "There are no views yet" and "I could not read
  // the views" must not look the same to the caller, so the first returns []
  // and the second throws.
  async existingViews() {
    const body = new URLSearchParams({ sort: '', page: '1', pageSize: '500', group: '', filter: '' });
    const res = await this.#request(
      '/TradeLog/ViewBuilder/ViewBuilderRead?IsPaperTrade=False&IsViewAll=False',
      { method: 'POST', body });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null; // not JSON at all -- handled by the shape check below
    }
    // An empty Data array is a real, valid answer: no strategies logged yet.
    // Anything else -- unparseable body, missing Data, Data that is not a list
    // -- means we do not know what is in the journal.
    if (!json || !Array.isArray(json.Data)) {
      throw new AstaError(
        'Could not read the list of strategies already in your ASTA journal, so the ' +
        'extension cannot tell which ones were logged before and would risk writing ' +
        'every strategy twice. Nothing was written. Open myasta.avadhutsathe.in, check ' +
        'you are logged in and that your Trade Log page loads, then click Resume.',
        { retryable: false });
    }
    return json.Data.map((d) => [d.ScriptHeading || '', Number(d.NoOfTrades || 0)]);
  }

  // Port of asta_autofill.py:467-483 (create_view)
  async createView(acct, job, token) {
    const sp = Number(job.spot) || 100;
    const ep = Math.round(sp * 100) / 100;
    const sl = Math.round(sp * 90) / 100;
    const t1 = Math.round(sp * 110) / 100;
    const body = new URLSearchParams({
      __RequestVerificationToken: token,
      SaveStatus: '',
      SeqNo: '0',
      AccountCode: acct,
      ScriptHeading: job.heading,
      ScriptSegment: job.segment,
      ExchangeCode: job.exchange,
      ScriptCode: job.scrip,
      TradeSetup: '21',
      TradeView: job.view || 'BULLISH',
      TradeRefrence: 'Self',
      TradeDirections: '',
      EntryPrice: String(ep),
      StopLoss: String(sl),
      InvestmentAmount: String(Math.round(sp * 1000)),
      Qty: '1',
      YNJLowerlimit: '',
      YNJHigherlimit: '',
      TargetPrice1: String(t1),
      TargetPrice2: String(t1),
      TargetPrice3: String(t1),
      MaxSharesToBuySell: '0',
      RiskInvolved: '0',
      MinProfitPotential: '0',
      MaxProfitPotential: '0',
      MINROI: '0',
      MAXROI: '0',
      MinReward: '0',
      MaxReward: '0',
      TotalRisk: '0',
      MINRR: '0',
      MAXRR: '0',
    });
    const res = await this.#request('/TradeLog/ViewBuilder/AddOrEditNewView', { method: 'POST', body, retry: false });
    const m = /AddOrEditNewView\/(\d+)/.exec(res.url || '');
    return m ? Number(m[1]) : null;
  }

  // Port of asta_autofill.py:501-504 (get_positions). Returns the position-grid rows for
  // a header -- each row carries its own SeqNo, which is required to exit that specific
  // leg (see exitLeg below). Per HANDOFF.md:126, this must be called after legs are
  // created and before exiting any of them.
  async getPositions(header) {
    const body = new URLSearchParams({
      sort: '',
      page: '1',
      pageSize: '800',
      group: '',
      filter: '',
      SeqNoHeader: String(header),
      filtervalue: 'ALL',
    });
    const res = await this.#request('/TradeLog/Strategy/GetPositions', { method: 'POST', body });
    try {
      const json = await res.json();
      return json.Data || [];
    } catch {
      return [];
    }
  }

  // Port of asta_autofill.py:507-522 (exit_leg), corrected to match the exact captured
  // payload in HANDOFF.md:116-126 (field names AND order). `positionModel` is one element
  // of getPositions(header)'s result -- it supplies the row's own SeqNo plus the other
  // fields ASTA echoes back (AccountCode, StrikePrices, Instrument, InstrumentName,
  // TradeDirections, TradeDirectionName, NoOfLots, EntryPrices, TradeView). SeqNo is
  // load-bearing: without the position's own SeqNo (not the header id), ASTA cannot tell
  // which open leg to close. `leg` supplies the exit-time fields (ExpiryDate, ExitDate,
  // ReasonForExit, FormEntryDate, ExitPrices, AmountEarned, GainCategoryCode). Note: like
  // the Python original, this POST does not carry __RequestVerificationToken -- `token`
  // is accepted for signature symmetry with createView/addLeg but unused here.
  async exitLeg(header, positionModel, leg, token) {
    const body = new URLSearchParams({
      sort: '',
      group: '',
      filter: '',
      SeqNo: String(positionModel.SeqNo),
      AccountCode: positionModel.AccountCode ?? '',
      Notes: '',
      SeqNoHeader: String(header),
      StrikePrices: String(positionModel.StrikePrices ?? ''),
      Instrument: positionModel.Instrument ?? '',
      InstrumentName: positionModel.InstrumentName ?? '',
      TradeDirections: positionModel.TradeDirections ?? '',
      TradeDirectionName: positionModel.TradeDirectionName ?? '',
      NoOfLots: String(positionModel.NoOfLots ?? ''),
      ExpiryDate: `${leg.exp} 00:00:00`,
      // shift_weekday, per asta_autofill.py:513 -- see addLeg's EntryDate above.
      ExitDate: `${shiftWeekday(leg.exitDate)} 00:00:00`,
      ReasonForExit: leg.reason,
      ExitDayLow: '0',
      ExitDayHigh: '0',
      // shift_weekday, per asta_autofill.py:515. Must apply the same shift as
      // addLeg's EntryDate, or the leg and its exit disagree about the entry day.
      FormEntryDate: `${shiftWeekday(leg.entryDate)} 00:00:00`,
      EntryPrices: String(positionModel.EntryPrices ?? ''),
      ExitPrices: String(leg.exit),
      CurrentPrice: '0',
      AmountEarned: String(leg.amount),
      ROI: '',
      YNJLowerlimit: '0',
      YNJHigherlimit: '0',
      TradeView: positionModel.TradeView || 'BULLISH',
      EntryDayLow: '0',
      EntryDayHigh: '0',
      GainCategoryCode: leg.gain,
      TradeSetupCode: '21',
      TradeSetupName: 'Trend line BD/BO with BB challenge.',
      TradeSetup: '21',
    });
    await this.#request('/TradeLog/Strategy/UpdatePositions', { method: 'POST', body, retry: false });
  }
}
