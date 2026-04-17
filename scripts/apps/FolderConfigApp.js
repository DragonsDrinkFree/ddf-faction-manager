import { FolderStore } from "../data/FolderStore.js";

/**
 * A thin subclass of Foundry's native FolderConfig that redirects the save
 * operation to FolderStore (game settings) rather than creating a real Folder
 * document in the world database.
 *
 * The native dialog chrome, styling, and field rendering are inherited 100%.
 * Only `_processSubmitData` is overridden to swap the persistence target.
 *
 * Usage:
 *   FolderConfigApp.openCreate(() => sidebarTab.render());
 *   FolderConfigApp.openEdit(folderId, () => sidebarTab.render());
 */
export class FolderConfigApp extends foundry.applications.sheets.FolderConfig {

  /** @type {string|null} — null means "create new", string = existing folder id */
  #settingsFolderId = null;

  /** Callback invoked after a successful save. */
  #onSave = null;

  // ─── Factory helpers ─────────────────────────────────────────────────────────

  /**
   * Open the native folder creation dialog, storing the result in FolderStore.
   * @param {Function} [onSave]  Called after the folder is created.
   */
  static openCreate(onSave = null) {
    new FolderConfigApp({ settingsFolderId: null, onSave }).render({ force: true });
  }

  /**
   * Open the native folder edit dialog pre-filled with existing data.
   * @param {string}   folderId  ID of the folder in FolderStore.
   * @param {Function} [onSave]  Called after the folder is updated.
   */
  static openEdit(folderId, onSave = null) {
    new FolderConfigApp({ settingsFolderId: folderId, onSave }).render({ force: true });
  }

  // ─── Constructor ─────────────────────────────────────────────────────────────

  constructor({ settingsFolderId = null, onSave = null } = {}) {
    // Build the synthetic Folder document that FolderConfig needs.
    // Pre-populate with existing data when editing so the fields are filled.
    const existing = settingsFolderId ? (FolderStore.getFolders()[settingsFolderId] ?? null) : null;
    const folderDoc = new Folder.implementation({
      name:    existing?.name    ?? Folder.implementation.defaultName?.() ?? "New Folder",
      type:    "JournalEntry",         // required by Folder schema; not shown to user
      color:   existing?.color   ?? "",
      sorting: existing?.sorting ?? "a"
    });

    super({ document: folderDoc });

    this.#settingsFolderId = settingsFolderId;
    this.#onSave           = onSave;
  }

  // ─── Context ─────────────────────────────────────────────────────────────────

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    if (this.#settingsFolderId) {
      // Edit mode: override the name/placeholder and button text to match
      // what Foundry would show for an existing folder.
      const existing = FolderStore.getFolders()[this.#settingsFolderId];
      if (existing) {
        context.name            = existing.name;
        context.namePlaceholder = existing.name;
        context.buttons         = [{
          type:  "submit",
          icon:  "fa-solid fa-floppy-disk",
          label: "FOLDER.Update"
        }];
      }
    }

    return context;
  }

  // ─── Submit override ─────────────────────────────────────────────────────────

  /**
   * Intercepts the save so the folder is persisted to FolderStore (game settings)
   * instead of creating a real Folder document in the world database.
   * @override
   */
  async _processSubmitData(event, form, submitData, options) {
    const name    = (submitData.name?.trim()) || form.name.placeholder || "New Folder";
    const color   = submitData.color   ?? "";
    const sorting = submitData.sorting ?? "a";

    if (this.#settingsFolderId) {
      await FolderStore.updateFolder(this.#settingsFolderId, { name, color, sorting });
    } else {
      await FolderStore.createFolder(name, { color, sorting });
    }

    this.#onSave?.();
    // FolderConfig uses resolve for its promise-based creation API; fulfil it.
    this.options.resolve?.(null);
  }
}
