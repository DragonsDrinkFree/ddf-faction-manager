const MODULE_ID = "ddf-faction-manager";

/**
 * Manages purely-organisational folder data for the faction sidebar.
 * Folders have no mechanical impact on faction data.
 *
 * Settings:
 *   factionFolders          — { [id]: { id, name, collapsed } }
 *   factionFolderMembership — { [factionId]: folderId }  (absent = unfiled)
 *   factionSortMode         — "alpha" | "manual"
 *   factionManualOrder      — string[]  (ordered top-level faction IDs)
 */
export class FolderStore {
  static register() {
    game.settings.register(MODULE_ID, "factionFolders", {
      scope: "world", config: false, type: Object, default: {}
    });
    game.settings.register(MODULE_ID, "factionFolderMembership", {
      scope: "world", config: false, type: Object, default: {}
    });
    game.settings.register(MODULE_ID, "factionSortMode", {
      scope: "world", config: false, type: String, default: "alpha"
    });
    game.settings.register(MODULE_ID, "factionManualOrder", {
      scope: "world", config: false, type: Object, default: []
    });
  }

  static getFolders() {
    return game.settings.get(MODULE_ID, "factionFolders") ?? {};
  }

  static getMembership() {
    return game.settings.get(MODULE_ID, "factionFolderMembership") ?? {};
  }

  static getSortMode() {
    return game.settings.get(MODULE_ID, "factionSortMode") ?? "alpha";
  }

  static getManualOrder() {
    const v = game.settings.get(MODULE_ID, "factionManualOrder");
    return Array.isArray(v) ? v : [];
  }

  // ─── Folder CRUD ──────────────────────────────────────────────────────────────

  static async createFolder(name, { color = "", sorting = "a", parentFolderId = null } = {}) {
    const id      = foundry.utils.randomID();
    const folders = { ...this.getFolders() };
    folders[id]   = { id, name, collapsed: false, color, sorting, parentFolderId: parentFolderId ?? null };
    await game.settings.set(MODULE_ID, "factionFolders", folders);
    return folders[id];
  }

  static async setFolderParent(folderId, parentFolderId) {
    const folders = { ...this.getFolders() };
    if (!folders[folderId]) return;
    folders[folderId] = { ...folders[folderId], parentFolderId: parentFolderId ?? null };
    await game.settings.set(MODULE_ID, "factionFolders", folders);
  }

  static async updateFolder(id, { name, color, sorting } = {}) {
    const folders = { ...this.getFolders() };
    if (!folders[id]) return;
    folders[id] = {
      ...folders[id],
      ...(name    !== undefined ? { name }    : {}),
      ...(color   !== undefined ? { color }   : {}),
      ...(sorting !== undefined ? { sorting } : {})
    };
    await game.settings.set(MODULE_ID, "factionFolders", folders);
    return folders[id];
  }

  static async deleteFolder(id) {
    const folders = { ...this.getFolders() };
    if (!folders[id]) return;

    // Promote direct child folders to this folder's parent before deleting
    const parentFolderId = folders[id].parentFolderId ?? null;
    for (const f of Object.values(folders)) {
      if ((f.parentFolderId ?? null) === id) {
        folders[f.id] = { ...folders[f.id], parentFolderId: parentFolderId };
      }
    }

    delete folders[id];
    await game.settings.set(MODULE_ID, "factionFolders", folders);

    // Release all factions that were in this folder (they become unfiled)
    const membership = { ...this.getMembership() };
    for (const fid of Object.keys(membership)) {
      if (membership[fid] === id) delete membership[fid];
    }
    await game.settings.set(MODULE_ID, "factionFolderMembership", membership);
  }

  static async renameFolder(id, name) {
    const folders = { ...this.getFolders() };
    if (!folders[id]) return;
    folders[id] = { ...folders[id], name };
    await game.settings.set(MODULE_ID, "factionFolders", folders);
  }

  static async setCollapsed(id, collapsed) {
    const folders = { ...this.getFolders() };
    if (!folders[id]) return;
    folders[id] = { ...folders[id], collapsed };
    await game.settings.set(MODULE_ID, "factionFolders", folders);
  }

  // ─── Membership ───────────────────────────────────────────────────────────────

  static async setFactionFolder(factionId, folderId) {
    const membership = { ...this.getMembership() };
    if (folderId) membership[factionId] = folderId;
    else delete membership[factionId];
    await game.settings.set(MODULE_ID, "factionFolderMembership", membership);
  }

  // ─── Sort ─────────────────────────────────────────────────────────────────────

  static async setSortMode(mode) {
    await game.settings.set(MODULE_ID, "factionSortMode", mode);
  }

  static async setManualOrder(ids) {
    await game.settings.set(MODULE_ID, "factionManualOrder", ids);
  }
}
