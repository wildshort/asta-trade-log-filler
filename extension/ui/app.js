// extension/ui/app.js
//
// Wizard controller: Files -> Preview -> Write -> Done.
//
// SAFETY: the Write button starts disabled and stays disabled until a
// Preview has rendered successfully with at least one strategy. There is no
// other code path that calls runJobs(). Nothing touches the live ASTA
// journal before that gate opens.

import { TradebookError } from '../src/tradebook.js';
import { classifyWorkbook, mergeSources } from '../src/sources.js';
import { buildJobs } from '../src/jobs.js';
import { AstaClient, AstaError } from '../src/asta-api.js';
import { runJobs } from '../src/runner.js';
import { ChromeStore } from '../src/checkpoint.js';

// Fixed per the task's operating settings -- not user-editable, so a slipped
// finger can't silently change what counts as "major" or how far back the
// backfill reaches.
const START_AFTER = '2020-01-01';
// 0 = log every trade, whatever its size. Do not reintroduce a cut-off: it
// silently drops the majority of trades for anyone trading smaller size.
const MAJOR_THRESHOLD = 0;

const $ = (id) => document.getElementById(id);

const STEPS = ['files', 'preview', 'write', 'done'];
const stepperItems = new Map(
  [...document.querySelectorAll('.stepper-item')].map((el) => [el.dataset.step, el])
);

function goToStep(name) {
  for (const s of STEPS) {
    $(`step-${s}`).hidden = s !== name;
    const item = stepperItems.get(s);
    const idx = STEPS.indexOf(s);
    const activeIdx = STEPS.indexOf(name);
    item.removeAttribute('aria-current');
    item.classList.remove('done');
    if (s === name) item.setAttribute('aria-current', 'step');
    else if (idx < activeIdx) item.classList.add('done');
  }
}

function inr(n) {
  const v = Math.round(n * 100) / 100;
  const sign = v < 0 ? '-' : '';
  return `${sign}₹${Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function textEl(tag, text, className) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = text;
  return el;
}

// ---------------------------------------------------------------------------
// Step 1: Files
// ---------------------------------------------------------------------------

let client = null; // shared AstaClient, created lazily so tests / cold loads don't need chrome APIs

function getClient() {
  if (!client) client = new AstaClient();
  return client;
}

// mergeSources' output for the CURRENT file selection -- null until a
// selection has been classified and merged without error. This is what
// gates Preview: there is no other path that enables the button.
let mergeResult = null;

function updateSourcesLabel(files) {
  const nameEl = $('sources-name');
  if (files.length === 0) nameEl.textContent = 'No files chosen';
  else if (files.length === 1) nameEl.textContent = files[0].name;
  else nameEl.textContent = `${files.length} files selected`;
  $('sources-drop').classList.toggle('has-file', files.length > 0);
}

function refreshPreviewEnabled() {
  $('preview').disabled = !mergeResult || mergeResult.tripsBySegment.length === 0;
}

async function workbookFromFile(file) {
  const buf = await file.arrayBuffer();
  // cellDates:true is load-bearing -- without it every date cell comes back
  // as an Excel serial number instead of a Date, and every downstream date
  // is wrong.
  return XLSX.read(buf, { type: 'array', cellDates: true });
}

function showFilesError(message) {
  const el = $('files-error');
  el.textContent = message;
  el.hidden = false;
}
function hideFilesError() {
  $('files-error').hidden = true;
}

function prettyDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d))
    .toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function plural(n, noun) {
  return `${n.toLocaleString('en-IN')} ${noun}${n === 1 ? '' : 's'}`;
}

function resetFilesSummary() {
  $('files-summary').hidden = true;
  $('files-summary-line').textContent = '';
  $('files-summary-line').hidden = false;
  $('unrecognised-files').hidden = true;
  $('unusable-files').hidden = true;
  clearChildren($('unusable-list'));
}

function renderUnusableList(container, entries) {
  clearChildren(container);
  for (const u of entries) {
    const li = document.createElement('li');
    li.appendChild(textEl('span', u.name, 'fail-heading'));
    li.appendChild(textEl('span', u.reason, 'fail-msg'));
    container.appendChild(li);
  }
}

// Turns mergeSources' summary into the plain-language line the brief asks
// for -- built entirely from summary's own fields so the merge maths itself
// stays in sources.js and this function only formats what it's told.
function renderFilesSummary(summary) {
  const parts = [];

  if (summary.taxFiles.length) {
    let cutoffText = summary.taxCutoff
      ? `complete through ${prettyDate(summary.taxCutoff)}, ${plural(summary.taxTripCount, 'trade')}`
      : 'no F&O/Commodity trades in scope';
    if (summary.taxDuplicatesDropped > 0) cutoffText += `, ${plural(summary.taxDuplicatesDropped, 'duplicate')} collapsed`;
    parts.push(`${plural(summary.taxFiles.length, 'Tax P&L file')} (${cutoffText})`);
  }

  if (summary.tradebookFiles.length) {
    let detail = `${plural(summary.tradebookTripCount, 'trade')}`;
    if (summary.taxCutoff) {
      detail += summary.tradebookTripsDropped > 0
        ? ` kept, ${plural(summary.tradebookTripsDropped, 'trade')} already covered by Tax P&L`
        : ' kept';
    }
    if (summary.tradebookDuplicatesDropped > 0) detail += `, ${plural(summary.tradebookDuplicatesDropped, 'duplicate')} collapsed`;
    parts.push(`${plural(summary.tradebookFiles.length, 'tradebook')} (${detail})`);
  }

  const hasRecognisedFile = summary.taxFiles.length > 0 || summary.tradebookFiles.length > 0;
  const lineEl = $('files-summary-line');
  if (parts.length) {
    lineEl.textContent = `${parts.join(' + ')}.`;
    lineEl.hidden = false;
  } else if (hasRecognisedFile) {
    lineEl.textContent = 'These files were recognised but contain no F&O or Commodity trades in scope.';
    lineEl.hidden = false;
  } else {
    lineEl.textContent = '';
    lineEl.hidden = true;
  }

  const unrecEl = $('unrecognised-files');
  unrecEl.hidden = summary.unrecognised.length === 0;
  if (summary.unrecognised.length) renderChips($('unrecognised-chip-list'), summary.unrecognised);

  const unusableEl = $('unusable-files');
  unusableEl.hidden = summary.unusable.length === 0;
  if (summary.unusable.length) renderUnusableList($('unusable-list'), summary.unusable);

  $('files-summary').hidden = false;
}

$('sources').addEventListener('change', () => {
  processSelectedFiles();
});

async function processSelectedFiles() {
  hideFilesError();
  const files = [...$('sources').files];
  updateSourcesLabel(files);
  mergeResult = null;
  // A new selection invalidates anything built from the old one -- Write's
  // gate is layout-enforced (unreachable while step-preview is hidden), but
  // that invariant should also hold in code, not only in the DOM.
  pendingJobs = null;
  $('write').disabled = true;
  resetFilesSummary();
  refreshPreviewEnabled();

  if (files.length === 0) return;

  // allSettled, not all: one file that can't even be read as an .xlsx
  // workbook (corrupted download, wrong file type) must not discard every
  // other file in the selection -- it's folded into summary.unusable below,
  // same as a file mergeSources itself couldn't use.
  const settled = await Promise.allSettled(files.map(async (file) => {
    const wb = await workbookFromFile(file);
    return { name: file.name, kind: classifyWorkbook(wb), wb };
  }));

  const parsedFiles = [];
  const unreadable = [];
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') parsedFiles.push(result.value);
    else unreadable.push({ name: files[i].name, reason: `Could not read this as an .xlsx file: ${result.reason.message}` });
  });

  try {
    const merged = mergeSources(parsedFiles);
    mergeResult = {
      ...merged,
      summary: { ...merged.summary, unusable: [...unreadable, ...merged.summary.unusable] },
    };
    renderFilesSummary(mergeResult.summary);
    if (mergeResult.summary.taxFiles.length === 0 && mergeResult.summary.tradebookFiles.length === 0) {
      showFilesError(
        'None of these files were recognised.\n\n' +
        'Choose a Zerodha Tax P&L export or Tradebook (.xlsx) -- Zerodha Console -> Reports.');
    }
  } catch (e) {
    mergeResult = null;
    resetFilesSummary();
    showFilesError(e instanceof TradebookError ? e.userMessage : `Unexpected error: ${e.message}`);
  } finally {
    refreshPreviewEnabled();
  }
}

function setPreviewButtonBusy(busy) {
  const btn = $('preview');
  btn.querySelector('.spinner').hidden = !busy;
  btn.disabled = busy || !mergeResult || mergeResult.tripsBySegment.length === 0;
}

// ---------------------------------------------------------------------------
// Step 2: Preview
// ---------------------------------------------------------------------------

let pendingJobs = null; // { jobs, acct, client } -- set only on a successful preview

function renderStrategyRow(job) {
  const tr = document.createElement('tr');

  tr.appendChild(textEl('td', job.heading));

  const segTd = document.createElement('td');
  segTd.appendChild(textEl('span', job.segment, 'segment-tag'));
  tr.appendChild(segTd);

  tr.appendChild(textEl('td', String(job.legs.length), 'num'));

  const pnlTd = textEl('td', inr(job.pnl), `num ${job.pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}`);
  tr.appendChild(pnlTd);

  return tr;
}

function renderChips(container, values) {
  clearChildren(container);
  for (const v of values) container.appendChild(textEl('span', v, 'chip'));
}

// Shows the cutover date actually used and how many tradebook trades it
// dropped, so de-duplication between the two sources is visible rather than
// silent. Hidden entirely when there was no Tax P&L file (nothing to cut over from).
function renderMergeNote(summary) {
  const el = $('merge-note');
  if (!summary || !summary.taxCutoff) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  clearChildren(el);
  el.append(
    'Tax P&L used through ',
    textEl('strong', prettyDate(summary.taxCutoff)),
    `. ${plural(summary.tradebookTripsDropped, 'tradebook trade')} on or before that date ` +
    `${summary.tradebookTripsDropped === 1 ? 'was' : 'were'} already counted there, so ${summary.tradebookTripsDropped === 1 ? 'it was' : 'they were'} dropped here.`);
}

function renderPreview({ jobs, skipped, unmapped, mergeSummary }) {
  $('preview-error').hidden = true;
  $('preview-body').hidden = false;
  renderMergeNote(mergeSummary);

  const totalLegs = jobs.reduce((s, j) => s + j.legs.length, 0);
  const net = jobs.reduce((s, j) => s + j.pnl, 0);

  $('stat-count').textContent = String(jobs.length);
  $('stat-pnl').textContent = inr(net);
  $('stat-pnl').className = `stat-value ${net >= 0 ? 'pnl-pos' : 'pnl-neg'}`;
  $('stat-legs').textContent = String(totalLegs);

  const tbody = $('strategy-tbody');
  clearChildren(tbody);
  const sorted = [...jobs].sort((a, b) => (a.heading < b.heading ? -1 : a.heading > b.heading ? 1 : 0));
  for (const job of sorted) tbody.appendChild(renderStrategyRow(job));
  if (jobs.length === 0) {
    const tr = document.createElement('tr');
    const td = textEl('td', 'No strategies exceed the ₹10,000 threshold in these files.');
    td.colSpan = 4;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  const hasIssues = skipped.size > 0 || unmapped.size > 0;
  $('issues').hidden = !hasIssues;

  $('issue-skipped').hidden = skipped.size === 0;
  if (skipped.size) {
    $('skipped-count').textContent = String(skipped.size);
    renderChips($('skipped-list'), [...skipped].sort());
  }

  $('issue-unmapped').hidden = unmapped.size === 0;
  if (unmapped.size) {
    $('unmapped-count').textContent = String(unmapped.size);
    renderChips($('unmapped-list'), [...unmapped].sort());
  }
}

function previewFailed(message) {
  $('preview-body').hidden = true;
  const el = $('preview-error');
  el.textContent = message;
  el.hidden = false;
  $('write').disabled = true;
  goToStep('preview');
}

$('preview').addEventListener('click', async () => {
  hideFilesError();
  if (!mergeResult || mergeResult.tripsBySegment.length === 0) return; // gate, belt-and-braces
  setPreviewButtonBusy(true);
  try {
    const c = getClient();
    const acct = await c.getAccountCode();
    const scrips = await c.loadScrips();

    const { jobs, skipped, unmapped } = buildJobs({
      tripsBySegment: mergeResult.tripsBySegment,
      nseCodes: scrips.nse,
      mcxCodes: scrips.mcx,
      startAfter: START_AFTER,
      majorThreshold: MAJOR_THRESHOLD,
    });

    pendingJobs = { jobs, acct, client: c };
    renderPreview({ jobs, skipped, unmapped, mergeSummary: mergeResult.summary });
    // The one and only place the Write gate opens: a successful preview
    // with at least one strategy to write.
    $('write').disabled = jobs.length === 0;
    goToStep('preview');
  } catch (e) {
    pendingJobs = null;
    if (e instanceof TradebookError || e instanceof AstaError) {
      previewFailed(e.userMessage);
    } else {
      previewFailed(`Unexpected error: ${e.message}`);
    }
  } finally {
    setPreviewButtonBusy(false);
  }
});

$('back-to-files').addEventListener('click', () => {
  goToStep('files');
});

// ---------------------------------------------------------------------------
// Step 3: Write
// ---------------------------------------------------------------------------

function appendLogLine(text, statusClass) {
  const li = document.createElement('li');
  li.appendChild(textEl('span', text));
  if (statusClass) li.appendChild(textEl('span', statusClass.replace('-', ' '), `log-status log-status-${statusClass}`));
  $('log').appendChild(li);
  $('log').scrollTop = $('log').scrollHeight;
  return li;
}

function showSessionExpired(message, detail) {
  $('session-expired-text').textContent = detail ? `${message}\n\n${detail}` : message;
  $('session-expired').hidden = false;
}
function hideSessionExpired() {
  $('session-expired').hidden = true;
}

async function runWrite() {
  if (!pendingJobs || pendingJobs.jobs.length === 0) return; // gate, belt-and-braces
  goToStep('write');
  hideSessionExpired();
  $('resume').disabled = true;

  const { jobs, acct, client: c } = pendingJobs;

  try {
    const token = await c.getToken();
    const r = await runJobs({
      jobs,
      client: c,
      store: new ChromeStore(),
      acct,
      token,
      onProgress: (p) => {
        $('bar').max = p.total;
        $('bar').value = p.done;
        $('progress-count').textContent = `${p.done} / ${p.total}`;
        appendLogLine(p.heading, p.status);
      },
    });
    if (r.sessionExpired) {
      // runJobs() stopped the run itself rather than turning the rest of the
      // jobs into a wall of identical "(401)" failures -- r.failed is empty
      // for this cause and r.notAttempted lists what's left. Stay on the
      // Write step and show the same Resume path as a thrown expiry below:
      // everything up to this point is checkpointed, so Resume continues
      // rather than restarts.
      const attempted = r.written + r.skipped + r.failed.length;
      appendLogLine(
        `Stopped: session expired after ${attempted} of ${jobs.length} strategies. ` +
        `${r.notAttempted.length} not yet attempted -- nothing already written was lost.`,
        null);
      showSessionExpired(r.sessionExpired,
        `${r.written} written, ${r.skipped} skipped, ${r.notAttempted.length} not yet attempted. ` +
        `Log in, then click Resume to continue exactly where this stopped.`);
    } else {
      showDone(r);
    }
  } catch (e) {
    // getToken() (or an unexpected throw from runJobs itself) failed before
    // or during the run -- this is the expired-session path. Both
    // TradebookError and AstaError carry .userMessage written for a human;
    // surface it verbatim, never a raw stack.
    const message = (e instanceof AstaError || e instanceof TradebookError)
      ? e.userMessage
      : `Unexpected error: ${e.message}. Log in again and click Resume.`;
    showSessionExpired(message);
  } finally {
    $('resume').disabled = false;
  }
}

$('write').addEventListener('click', () => {
  clearChildren($('log'));
  $('bar').value = 0;
  runWrite();
});

$('resume').addEventListener('click', () => {
  // Nothing special about resuming: the checkpoint store is durable
  // (chrome.storage.local), so simply re-running write picks up exactly
  // where it left off -- already-written strategies report "skipped".
  runWrite();
});

// ---------------------------------------------------------------------------
// Step 4: Done
// ---------------------------------------------------------------------------

function renderFailureList(listEl, entries, describe) {
  clearChildren(listEl);
  for (const f of entries) {
    const li = document.createElement('li');
    li.appendChild(textEl('span', f.segment ? `${f.heading} (${f.segment})` : f.heading, 'fail-heading'));
    const detail = describe(f);
    li.appendChild(textEl('span', detail ? `${detail}\n${f.error}` : f.error, 'fail-msg'));
    listEl.appendChild(li);
  }
}

function showDone(r) {
  goToStep('done');
  $('done-written').textContent = String(r.written);
  $('done-skipped').textContent = String(r.skipped);

  // A failure is not one thing. Some strategies never reached the journal at
  // all -- retry and forget. Others have legs already written with some or all
  // of their exits missing, which is an OPEN POSITION with no P&L sitting in a
  // live trading journal and skewing its totals. Listing both under "Failed"
  // reads as "nothing happened" for the case that actually needs a human, so
  // the two are counted and explained separately. runJobs() tells us which is
  // which via failed[].partiallyWritten.
  const partial = r.failed.filter((f) => f.partiallyWritten);
  const notWritten = r.failed.filter((f) => !f.partiallyWritten);

  $('done-partial-card').hidden = partial.length === 0;
  $('done-partial').textContent = String(partial.length);
  $('partial-list-wrap').hidden = partial.length === 0;
  renderFailureList($('partial-list'), partial, (f) => {
    const legs = `${f.legsWritten} leg${f.legsWritten === 1 ? '' : 's'} written`;
    const exits = f.exitsWritten === 0
      ? 'no exits written'
      : `only ${f.exitsWritten} of ${f.legsWritten} exits written`;
    return `${legs}, ${exits} — open in ASTA and check this strategy.`;
  });

  $('done-failed-card').hidden = notWritten.length === 0;
  $('done-failed').textContent = String(notWritten.length);
  $('failed-list-wrap').hidden = notWritten.length === 0;
  renderFailureList($('failed-list'), notWritten, () => 'Nothing was written for this strategy.');
}

$('restart').addEventListener('click', () => {
  pendingJobs = null;
  mergeResult = null;
  $('sources').value = '';
  updateSourcesLabel([]);
  resetFilesSummary();
  refreshPreviewEnabled();
  $('write').disabled = true;
  hideFilesError();
  goToStep('files');
});


// Initial state.
refreshPreviewEnabled();
goToStep('files');
