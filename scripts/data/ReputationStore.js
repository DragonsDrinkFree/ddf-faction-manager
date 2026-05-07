const MODULE_ID  = "ddf-faction-manager";
const SETTING_KEY = "partyReputations";

/**
 * Persists reputation tracks for each party → faction pairing.
 *
 * Data shape:
 * {
 *   [partyId]: {
 *     [targetFactionId]: {
 *       factionId:   string,
 *       current:     number,
 *       maxOverride: number|null,
 *       entries: [{
 *         id:        string,
 *         timestamp: number,
 *         delta:     number,
 *         note:      string
 *       }]
 *     }
 *   }
 * }
 */
export class ReputationStore {
  static register() {
    game.settings.register(MODULE_ID, "reputationTrackMax", {
      name: "Reputation Track Maximum",
      hint: "Default maximum value for reputation tracks on Adventuring Party sheets. Can be overridden per faction.",
      scope: "world",
      config: true,
      type: Number,
      default: 12
    });

    game.settings.register(MODULE_ID, SETTING_KEY, {
      name: "Party Reputations",
      scope: "world",
      config: false,
      type: Object,
      default: {}
    });
  }

  static getAll() {
    return game.settings.get(MODULE_ID, SETTING_KEY) ?? {};
  }

  static async _save(data) {
    await game.settings.set(MODULE_ID, SETTING_KEY, data);
    Hooks.callAll("ddf-reputation-changed");
  }

  /** Returns { [factionId]: entry } map for one party (or {}). */
  static getForParty(partyId) {
    return this.getAll()[partyId] ?? {};
  }

  /** Returns single entry or null. */
  static getEntry(partyId, factionId) {
    return this.getAll()[partyId]?.[factionId] ?? null;
  }

  /** Returns the effective max for an entry; falls back to the global setting. */
  static getEffectiveMax(entry) {
    if (entry?.maxOverride != null) return entry.maxOverride;
    try { return game.settings.get(MODULE_ID, "reputationTrackMax") ?? 12; }
    catch { return 12; }
  }

  /** Create an empty reputation entry for a faction in a party. No-op if already exists. */
  static async addFaction(partyId, factionId) {
    const all = this.getAll();
    if (!all[partyId]) all[partyId] = {};
    if (all[partyId][factionId]) return;
    all[partyId][factionId] = { factionId, current: 0, maxOverride: null, entries: [] };
    await this._save(all);
  }

  /** Remove a faction's reputation entry from a party. */
  static async removeFaction(partyId, factionId) {
    const all = this.getAll();
    if (!all[partyId]?.[factionId]) return;
    delete all[partyId][factionId];
    await this._save(all);
  }

  /**
   * Record a reputation change. Pushes an entry, recomputes `current` from
   * all entry deltas, and clamps 0..max.
   */
  static async recordChange(partyId, factionId, delta, note) {
    if (!delta) return;
    const all = this.getAll();
    if (!all[partyId]?.[factionId]) return;
    const entry = all[partyId][factionId];
    entry.entries.push({
      id:        foundry.utils.randomID(),
      timestamp: Date.now(),
      delta,
      note:      note ?? ""
    });
    const max     = this.getEffectiveMax(entry);
    const rawSum  = entry.entries.reduce((s, e) => s + e.delta, 0);
    entry.current = Math.max(0, Math.min(max, rawSum));
    await this._save(all);
  }

  /** Set a per-faction max override, then re-clamp current. */
  static async setMaxOverride(partyId, factionId, maxOverride) {
    const all = this.getAll();
    if (!all[partyId]?.[factionId]) return;
    const entry = all[partyId][factionId];
    entry.maxOverride = maxOverride;
    entry.current     = Math.max(0, Math.min(maxOverride, entry.current));
    await this._save(all);
  }

  /**
   * Archive all entries: clears the log, inserts one summary entry,
   * and preserves the current value with a delta=0 placeholder.
   */
  static async archiveEntries(partyId, factionId) {
    const all = this.getAll();
    if (!all[partyId]?.[factionId]) return;
    const entry = all[partyId][factionId];
    const date  = new Date().toLocaleDateString();
    const saved = entry.current;
    entry.entries = [{
      id:        foundry.utils.randomID(),
      timestamp: Date.now(),
      delta:     0,
      note:      `Archived ${date} (was ${saved})`
    }];
    await this._save(all);
  }

  /** Remove all reputation data for a deleted party. */
  static async cleanupParty(partyId) {
    const all = this.getAll();
    if (!all[partyId]) return;
    delete all[partyId];
    await this._save(all);
  }
}
