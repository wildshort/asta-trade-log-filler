// extension/src/checkpoint.js

/** Backed by chrome.storage.local in the extension. */
export class ChromeStore {
  constructor(prefix = 'asta:') { this.prefix = prefix; }
  async get(key) {
    const k = this.prefix + key;
    const out = await chrome.storage.local.get(k);
    return out[k] ?? null;
  }
  async set(key, value) {
    await chrome.storage.local.set({ [this.prefix + key]: value });
  }
  /**
   * Removes only the keys this store owns -- the ones carrying its prefix.
   *
   * This used to call chrome.storage.local.clear(), which wipes the ENTIRE
   * extension-local storage area: not just backfill checkpoints but anything
   * else the extension keeps there, now or later. A store that namespaces
   * every read and write behind a prefix has no business deleting data outside
   * that namespace.
   *
   * Nothing in the extension currently calls this -- there is deliberately no
   * "reset checkpoints" control in the UI, because discarding checkpoints in
   * front of a live journal is how a run comes to write everything twice. It
   * is kept for tests and for the MemoryStore interface contract.
   */
  async clear() {
    const all = await chrome.storage.local.get(null);
    const mine = Object.keys(all).filter((k) => k.startsWith(this.prefix));
    if (mine.length) await chrome.storage.local.remove(mine);
  }
}
