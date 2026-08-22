# ASTA Trade-Log Filler

A Chrome extension that fills your [ASTA](https://myasta.avadhutsathe.in) trade log from
your own Zerodha exports.

It reads your files **on your own computer**. Nothing is uploaded anywhere. The only
network requests it makes are to `myasta.avadhutsathe.in`, using the session you are
already logged into — it never asks for, stores, or transmits a password or cookie.

---

## Install (Chrome or Edge — Mac and Windows both work)

1. Download **`asta-trade-log-filler.zip`** from the
   [latest release](../../releases/latest).
2. Unzip it. You get a folder called `extension`.
   **Put it somewhere permanent** — Chrome reads it from this location every time it
   starts, so don't leave it in Downloads or it will break when you clear that folder.
3. Open `chrome://extensions` (or `edge://extensions`).
4. Turn on **Developer mode** (top-right toggle).
5. Click **Load unpacked** and select the `extension` folder.

That's it. No Python, no installers, no admin rights.

Chrome may occasionally show a "Disable developer mode extensions" prompt on startup.
Dismissing it is fine — the extension keeps working.

---

## What to download from Zerodha

Go to [console.zerodha.com](https://console.zerodha.com) → **Reports**.

| Report | Which years | Filename starts with |
|---|---|---|
| **Tax P&L** | every financial year you want logged | `taxpnl-` |
| **Tradebook** | current financial year only, F&O and Commodity separately | `tradebook-` |

**Watch out:** Reports → **P&L** produces files named `pnl-`. They look right but contain
no dates, so no journal entry can be built from them. If the filename doesn't start with
`taxpnl-` or `tradebook-`, it's the wrong report.

Why both: the Tax P&L already pairs each buy with its sell, so nothing is lost. But
there's no Tax P&L for the year in progress, so tradebooks cover the recent months.
The extension works out which file is which and handles the cutover itself.

---

## Before you run it — log in to ASTA

**Open `myasta.avadhutsathe.in` in a tab and log in. Leave that tab open while the
extension runs.**

The extension has no password of its own — it works through the session you are already
logged into, which is why it never asks you for one. If you are not logged in, or that tab
is closed, it cannot reach ASTA and will stop.

Keep it in a **separate tab in the same Chrome window**. The extension opens in its own
tab; both need to be open at the same time.

## Using it

1. Log in to ASTA (above) and leave that tab open.
2. Click the extension icon.
3. Select all your downloaded files at once.
4. **Preview** — check the strategy count and net P&L before writing anything.
5. **Write to ASTA.**

**Nothing is written until you have seen a preview and clicked Write.**

### Things worth knowing

- **Your ASTA session expires after about 35 minutes.** A long run may outlive it. If it
  does, you'll get a Resume button — log back in, click Resume, and it continues from
  where it stopped without rewriting anything.
- **Running it twice is safe.** Strategies already in your journal are recognised and
  skipped.
- **Duplicate or overlapping files are safe.** If you select the same export twice, or
  two exports covering overlapping periods, it collapses the duplicates and tells you
  how many.
- **Some contracts can't be logged** — ASTA has no scrip code for a few (NICKEL, for
  example). The preview lists anything it had to skip.
- It fills **F&O and Commodity**. Equity is not supported.

---

## If something goes wrong

The preview and the final screen say what happened in plain language. The one to act on
is **"Needs checking"** — those strategies have legs in your journal but not their exits,
so open them in ASTA and either complete or delete them.

---

MIT licensed. Built for personal use by ASTA members on their own accounts.
