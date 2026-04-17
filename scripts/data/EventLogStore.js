const MODULE_ID  = "ddf-faction-manager";
const SETTING_KEY = "eventLog";
const MAX_ENTRIES = 300; // per faction

/**
 * Persists a chronological log of notable faction events.
 *
 * Data shape:
 * {
 *   [factionId]: Array<{
 *     id:        string,
 *     timestamp: number,       // Date.now()
 *     category:  "member" | "objective" | "connection",
 *     text:      string
 *   }>
 * }
 */
export class EventLogStore {
  static register() {
    game.settings.register(MODULE_ID, SETTING_KEY, {
      name:   "Event Log",
      scope:  "world",
      config: false,
      type:   Object,
      default: {}
    });
  }

  static getAll() {
    return game.settings.get(MODULE_ID, SETTING_KEY) ?? {};
  }

  /** Returns entries for a faction, newest first. */
  static getForFaction(factionId) {
    return (this.getAll()[factionId] ?? []).slice().reverse();
  }

  /**
   * @param {string} factionId
   * @param {"member"|"objective"|"connection"} category
   * @param {string} text
   */
  static async addEntry(factionId, category, text) {
    const all = this.getAll();
    if (!all[factionId]) all[factionId] = [];
    all[factionId].push({
      id:        foundry.utils.randomID(),
      timestamp: Date.now(),
      category,
      text
    });
    if (all[factionId].length > MAX_ENTRIES) {
      all[factionId] = all[factionId].slice(-MAX_ENTRIES);
    }
    await game.settings.set(MODULE_ID, SETTING_KEY, all);
    Hooks.callAll("ddf-eventlog-changed", factionId);
  }

  /** Remove all log entries for a deleted faction. */
  static async cleanupFaction(factionId) {
    const all = this.getAll();
    if (!all[factionId]) return;
    delete all[factionId];
    await game.settings.set(MODULE_ID, SETTING_KEY, all);
  }
}
