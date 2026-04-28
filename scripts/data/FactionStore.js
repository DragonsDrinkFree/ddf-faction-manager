const MODULE_ID = "ddf-faction-manager";
const SETTING_KEY = "factions";

/**
 * Manages faction data stored in a world-level game setting.
 *
 * Data shape:
 * {
 *   [id: string]: {
 *     id: string,
 *     name: string,
 *     parentId: string | null,
 *     pageId: string   // page ID within the shared faction journal
 *   }
 * }
 *
 * All faction notes live as pages inside a single shared JournalEntry
 * (configured via module settings; auto-created as "Faction Details" on first use).
 */
export class FactionStore {
  static register() {
    game.settings.register(MODULE_ID, SETTING_KEY, {
      name: "Faction Data",
      scope: "world",
      config: false,
      type: Object,
      default: {}
    });
  }

  static getAll() {
    const raw = game.settings.get(MODULE_ID, SETTING_KEY) ?? {};
    // Backfill discriminator for legacy records — parties were introduced later
    for (const f of Object.values(raw)) if (!f.kind) f.kind = "faction";
    return raw;
  }

  static async _save(data) {
    await game.settings.set(MODULE_ID, SETTING_KEY, data);
    Hooks.callAll("ddf-factions-changed");
  }

  // ─── Journal Helpers ─────────────────────────────────────────────────────────

  /**
   * Returns the configured faction journal synchronously (for reads).
   * Falls back to searching by name if the stored ID is stale.
   * Returns null if no journal can be found.
   * @returns {JournalEntry|null}
   */
  static getFactionJournal() {
    const id = game.settings.get(MODULE_ID, "factionJournalId") ?? "";
    if (id) {
      const journal = game.journal.get(id);
      if (journal) return journal;
    }
    return game.journal.find(j => j.name === "Faction Details") ?? null;
  }

  /**
   * Returns the configured faction journal, creating it if none exists.
   * Persists the journal ID to module settings so future calls resolve quickly.
   * @returns {Promise<JournalEntry>}
   */
  static async ensureFactionJournal() {
    const found = FactionStore.getFactionJournal();
    if (found) {
      // Persist discovered ID if it wasn't already saved
      const storedId = game.settings.get(MODULE_ID, "factionJournalId") ?? "";
      if (storedId !== found.id) {
        await game.settings.set(MODULE_ID, "factionJournalId", found.id);
      }
      return found;
    }

    // Create the default shared journal
    const journal = await JournalEntry.create({ name: "Faction Details", folder: null });
    await game.settings.set(MODULE_ID, "factionJournalId", journal.id);
    return journal;
  }

  /**
   * Returns every unique tag used across all factions, sorted alphabetically.
   * @returns {string[]}
   */
  static getAllTags() {
    const tagSet = new Set();
    for (const faction of Object.values(this.getAll())) {
      for (const tag of (faction.tags ?? [])) tagSet.add(tag);
    }
    return [...tagSet].sort((a, b) => a.localeCompare(b));
  }

  // ─── Hierarchy ───────────────────────────────────────────────────────────────

  /**
   * Returns factions as a nested array for rendering.
   * Top-level factions have parentId === null.
   * Each entry: { ...factionData, children: [...] }
   */
  static getHierarchy() {
    const all = this.getAll();
    const map = {};

    for (const id in all) {
      map[id] = { ...all[id], children: [] };
    }

    const roots = [];
    for (const id in map) {
      const faction = map[id];
      if (faction.parentId && map[faction.parentId]) {
        map[faction.parentId].children.push(faction);
      } else {
        roots.push(faction);
      }
    }

    const sort = (arr) => {
      arr.sort((a, b) => a.name.localeCompare(b.name));
      arr.forEach(f => sort(f.children));
    };
    sort(roots);

    return roots;
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────────────

  /**
   * Creates a new faction and adds a page to the shared faction journal.
   * @param {string} name
   * @param {string|null} parentId
   * @returns {Promise<object>} the new faction data
   */
  static async create(name, parentId = null, opts = {}) {
    const id      = foundry.utils.randomID();
    const kind    = opts.kind === "party" ? "party" : "faction";
    // Parties are top-level only — never inherit a parentId
    const effectiveParent = kind === "party" ? null : parentId;
    const journal = await FactionStore.ensureFactionJournal();

    const pages = await journal.createEmbeddedDocuments("JournalEntryPage", [{
      name,
      type: "text",
      text: { content: `<p>@Faction[${id}]{${name}}</p>`, format: 1 }
    }]);

    // Seed stats from the current stat definition defaults
    let stats = {};
    try {
      const raw  = game.settings.get(MODULE_ID, "statDefinitions");
      const defs = typeof raw === "string" ? JSON.parse(raw) : (raw ?? []);
      for (const def of defs) {
        if (def.id) stats[def.id] = def.default ?? 0;
      }
    } catch { /* leave stats empty */ }

    const faction = {
      id, name,
      parentId: effectiveParent,
      pageId: pages[0].id,
      stats, tags: [], secrets: [], rumors: [],
      kind,
      sandboxPartyId: opts.sandboxPartyId ?? null,
      color: opts.color ?? ""
    };
    const all = this.getAll();
    all[id] = faction;
    await this._save(all);

    return faction;
  }

  /**
   * Updates a faction's data (partial merge).
   * If the name changes, the linked journal page title is updated to match.
   * @param {string} id
   * @param {object} updates
   */
  static async update(id, updates) {
    const all = this.getAll();
    if (!all[id]) throw new Error(`Faction ${id} not found`);

    // Parties are top-level only — silently drop attempts to give them a parent
    if (all[id].kind === "party" && "parentId" in updates) delete updates.parentId;

    // Keep the journal page title in sync when the faction is renamed
    if (updates.name && updates.name !== all[id].name && all[id].pageId) {
      const journal = FactionStore.getFactionJournal();
      const page    = journal?.pages.get(all[id].pageId);
      if (page) await page.update({ name: updates.name });
    }

    all[id] = { ...all[id], ...updates, id };
    await this._save(all);
    return all[id];
  }

  /**
   * Deletes a faction and its linked journal page.
   * Child factions are re-parented to the deleted faction's parent.
   * @param {string} id
   */
  static async delete(id) {
    const all     = this.getAll();
    const faction = all[id];
    if (!faction) return;

    // Re-parent children to this faction's parent
    for (const fid in all) {
      if (all[fid].parentId === id) {
        all[fid].parentId = faction.parentId;
      }
    }

    // Delete only the faction's page, not the whole journal
    if (faction.pageId) {
      const journal = FactionStore.getFactionJournal();
      const page    = journal?.pages.get(faction.pageId);
      if (page) await page.delete();
    }

    delete all[id];
    await this._save(all);
  }
}
