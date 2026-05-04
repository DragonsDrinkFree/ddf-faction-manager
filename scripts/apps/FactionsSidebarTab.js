import { FactionStore } from "../data/FactionStore.js";
import { FolderStore } from "../data/FolderStore.js";
import { ProjectStore } from "../data/ProjectStore.js";
import { RelationshipStore } from "../data/RelationshipStore.js";
import { MemberStore } from "../data/MemberStore.js";
import { FactionDetailApp } from "./FactionDetailApp.js";
import { PartyDetailApp } from "./PartyDetailApp.js";
import { FolderConfigApp } from "./FolderConfigApp.js";
import { GlobalRelationshipsApp } from "./GlobalRelationshipsApp.js";
import {
  getActiveSandboxPartyId,
  getMissingSandboxParties,
  importSandboxParty,
  syncAllSandboxPartyMembers
} from "../utils/SandboxIntegration.js";
import { promptName } from "../utils/AppHelpers.js";

const { HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Custom Foundry V14 sidebar tab for the Faction Manager.
 *
 * Displays factions organised into optional folders with alpha/manual sort.
 * Folders are purely organisational; they have no impact on faction data.
 */
export class FactionsSidebarTab extends HandlebarsApplicationMixin(
  foundry.applications.sidebar.AbstractSidebarTab
) {
  static tabName = "ddfFactions";

  static DEFAULT_OPTIONS = {};

  static PARTS = {
    tab: {
      template: "modules/ddf-faction-manager/templates/sidebar-tab.hbs",
      scrollable: [".ddf-sidebar-list"],
      root: true
    }
  };

  /** Faction ID currently being dragged. */
  #draggedId = null;

  /** Folder ID currently being dragged. Set when the drag source is a folder header. */
  #draggedFolderId = null;

  /**
   * Comma-joined sorted list of sandbox party IDs the user has dismissed this
   * session. The prompt re-fires whenever the current missing-set differs from
   * this signature — so newly-appeared SCM parties still surface for import.
   */
  #sandboxDismissedIds = null;

  /** Set true while the import dialog is open, to prevent duplicates on re-render. */
  #sandboxPromptOpen = false;

  // ─── Context ─────────────────────────────────────────────────────────────────

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    const sortMode    = FolderStore.getSortMode(); // controls unfiled factions
    const folders     = FolderStore.getFolders();
    const membership  = FolderStore.getMembership();
    const manualOrder = FolderStore.getManualOrder();

    // Identify the active sandbox party (matches a stored faction by sandboxPartyId)
    const activeSandboxPartyId = getActiveSandboxPartyId();
    const activeFactionId = activeSandboxPartyId
      ? Object.values(FactionStore.getAll())
          .find(f => f.kind === "party" && f.sandboxPartyId === activeSandboxPartyId)?.id ?? null
      : null;

    // Decorator added to every faction record before it goes to the template
    const decorate = (f) => ({
      ...f,
      isParty:        f.kind === "party",
      isActiveParty:  f.id   === activeFactionId,
      children:       (f.children ?? []).map(decorate)
    });

    // getHierarchy() returns top-level roots alpha-sorted, each with .children
    const hierarchyRoots = FactionStore.getHierarchy().map(decorate);

    // ── Step 1: group top-level factions by folder (preserving alpha order from getHierarchy) ──
    const folderGroups   = {};
    const unfiledFactions = [];
    for (const faction of hierarchyRoots) {
      const folderId = membership[faction.id];
      if (folderId && folders[folderId]) {
        (folderGroups[folderId] ??= []).push(faction);
      } else {
        unfiledFactions.push(faction);
      }
    }

    // ── Step 2: build a helper that re-sorts a list by manual order ──────────
    const manualSort = (arr) => {
      const orderMap = new Map(manualOrder.map((id, i) => [id, i]));
      return [...arr].sort((a, b) => {
        const ia = orderMap.has(a.id) ? orderMap.get(a.id) : 999999;
        const ib = orderMap.has(b.id) ? orderMap.get(b.id) : 999999;
        return ia - ib || a.name.localeCompare(b.name);
      });
    };

    // ── Step 3: build recursive folder tree — each folder knows its children ──
    const buildFolderTree = (parentFolderId) => {
      return Object.values(folders)
        .filter(f => (f.parentFolderId ?? null) === parentFolderId)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(f => {
          const raw = folderGroups[f.id] ?? [];
          return {
            type:         "folder",
            id:           f.id,
            name:         f.name,
            color:        f.color    ?? "",
            sorting:      f.sorting  ?? "a",
            collapsed:    f.collapsed,
            factions:     (f.sorting ?? "a") === "m" ? manualSort(raw) : raw,
            childFolders: buildFolderTree(f.id)
          };
        });
    };

    const sections = buildFolderTree(null);

    // Unfiled factions use the global sidebar sort toggle
    let unfiledSorted = sortMode === "manual" ? manualSort(unfiledFactions) : unfiledFactions;
    // Hoist the active sandbox party to the top regardless of sort mode
    if (activeFactionId) {
      const idx = unfiledSorted.findIndex(f => f.id === activeFactionId);
      if (idx > 0) unfiledSorted = [unfiledSorted[idx], ...unfiledSorted.slice(0, idx), ...unfiledSorted.slice(idx + 1)];
    }
    sections.push({ type: "unfiled", factions: unfiledSorted });

    context.sections   = sections;
    context.sortMode   = sortMode;
    context.hasFolders = Object.keys(folders).length > 0;
    context.selectedId = null;
    return context;
  }

  // ─── Activation Lifecycle ────────────────────────────────────────────────────
  // V14's AbstractSidebarTab may call any of these when the user activates the
  // tab. Override all candidates and force a re-render so the sandbox-import
  // check + active-party styling refresh on every click.

  /** @override */
  _onActivate(...args) {
    super._onActivate?.(...args);
    if (this.rendered) this.render({ force: true });
  }

  /** Possible alternate V14 lifecycle name — harmless if not invoked. */
  activate(...args) {
    const result = super.activate?.(...args);
    if (this.rendered) this.render({ force: true });
    return result;
  }

  // ─── Render Hook ─────────────────────────────────────────────────────────────

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    const el = this.element;

    // ── Header buttons ───────────────────────────────────────────────────────
    el.querySelector(".ddf-create-faction")?.addEventListener("click", async () => {
      const result = await this.#promptCreateOrganization();
      if (!result) return;
      await FactionStore.create(result.name, null, { kind: result.kind });
      this.render();
    });

    el.querySelector(".ddf-create-folder")?.addEventListener("click", () => {
      FolderConfigApp.openCreate(() => this.render());
    });

    el.querySelector(".ddf-relationships-btn")?.addEventListener("click", () => {
      GlobalRelationshipsApp.show();
    });

    // ── Sort toggle ───────────────────────────────────────────────────────────
    el.querySelector(".ddf-sort-toggle")?.addEventListener("click", async () => {
      const current = FolderStore.getSortMode();
      const next    = current === "alpha" ? "manual" : "alpha";
      await FolderStore.setSortMode(next);
      this.render();
    });

    // ── Search filter ─────────────────────────────────────────────────────────
    el.querySelector(".ddf-faction-search")?.addEventListener("input", (e) => {
      const q = e.target.value.toLowerCase();
      el.querySelectorAll(".faction-item").forEach(item => {
        const name = item.querySelector(".faction-name")?.textContent?.toLowerCase() ?? "";
        item.style.display = name.includes(q) ? "" : "none";
      });
      // Show folders that have visible children
      el.querySelectorAll(".ddf-folder-section").forEach(section => {
        const hasVisible = [...section.querySelectorAll(".faction-item")]
          .some(i => i.style.display !== "none");
        section.style.display = (q && !hasVisible) ? "none" : "";
      });
    });

    // ── Faction clicks ────────────────────────────────────────────────────────
    el.querySelectorAll("[data-action='selectFaction']").forEach(row => {
      row.addEventListener("click", () => {
        const id = row.closest("[data-faction-id]")?.dataset.factionId;
        if (!id) return;
        const record = FactionStore.getAll()[id];
        if (record?.kind === "party") PartyDetailApp.show(id);
        else                          FactionDetailApp.show(id);
      });
    });

    // ── Sub-faction creation ──────────────────────────────────────────────────
    el.querySelectorAll("[data-action='createSubFaction']").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const parentId = btn.closest("[data-faction-id]")?.dataset.factionId;
        if (!parentId) return;
        const parentName = FactionStore.getAll()[parentId]?.name ?? "faction";
        const name = await promptName(`New Sub-Faction (${parentName})`, "Name");
        if (!name) return;
        await FactionStore.create(name, parentId);
        this.render();
      });
    });

    // ── Delete faction (wired up via context menu now — no inline button) ─────

    // ── Folder collapse/expand ────────────────────────────────────────────────
    el.querySelectorAll(".ddf-folder-header").forEach(header => {
      header.addEventListener("click", async (e) => {
        // Ignore clicks on the control buttons inside the header
        if (e.target.closest(".ddf-folder-controls")) return;
        const section  = header.closest(".ddf-folder-section[data-folder-id]");
        const folderId = section?.dataset.folderId;
        if (!folderId) return;
        const folders  = FolderStore.getFolders();
        const collapsed = !folders[folderId]?.collapsed;
        await FolderStore.setCollapsed(folderId, collapsed);
        this.render();
      });
    });

    // ── Create faction inside folder ──────────────────────────────────────────
    el.querySelectorAll("[data-action='createFactionInFolder']").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const folderId = btn.closest(".ddf-folder-section[data-folder-id]")?.dataset.folderId;
        if (!folderId) return;
        const folderName = FolderStore.getFolders()[folderId]?.name ?? "folder";
        const name = await promptName(`New Faction in ${folderName}`, "Name");
        if (!name) return;
        const faction = await FactionStore.create(name, null);
        await FolderStore.setFactionFolder(faction.id, folderId);
        this.render();
      });
    });

    // ── Create sub-folder ─────────────────────────────────────────────────────
    el.querySelectorAll("[data-action='createSubFolder']").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const folderId = btn.closest(".ddf-folder-section[data-folder-id]")?.dataset.folderId;
        if (!folderId) return;
        const folderName = FolderStore.getFolders()[folderId]?.name ?? "folder";
        const name = await promptName(`New Sub-folder in "${folderName}"`, "Name");
        if (!name) return;
        await FolderStore.createFolder(name, { parentFolderId: folderId });
        this.render();
      });
    });

    // ── Folder rename/edit ────────────────────────────────────────────────────
    el.querySelectorAll("[data-action='renameFolder']").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const folderId = btn.closest(".ddf-folder-section[data-folder-id]")?.dataset.folderId;
        if (!folderId) return;
        FolderConfigApp.openEdit(folderId, () => this.render());
      });
    });

    // ── Folder delete (wired up via context menu now — no inline button) ──────

    // ── Right-click context menus on folders + factions ───────────────────────
    this.#setupContextMenus(el);

    // ── Drag-drop: always set up — each section controls its own draggability ──
    this.#setupDragDrop(el);

    // ── Sandbox Campaign Manager sync ─────────────────────────────────────────
    // Reconcile rosters of any sandbox-linked parties, then prompt to import
    // any sandbox parties that don't yet exist in our store.
    this.#runSandboxCheck();
  }

  /**
   * Fire-and-forget: sync existing sandbox-linked parties, then offer to
   * import any new ones. Silent when SCM is unavailable or there's nothing to do.
   */
  async #runSandboxCheck() {
    try {
      await syncAllSandboxPartyMembers();
      if (this.#sandboxPromptOpen) return;
      const missing = getMissingSandboxParties();
      if (!missing.length) return;
      const signature = missing.map(p => p.id).sort().join(",");
      if (this.#sandboxDismissedIds === signature) return;
      this.#showSandboxImportDialog(missing, signature);
    } catch (err) {
      console.warn("ddf-faction-manager | Sandbox sync failed", err);
    }
  }

  #showSandboxImportDialog(missingParties, signature) {
    const rows = missingParties.map(p => {
      const memberCount = Array.isArray(p.members) ? p.members.length : 0;
      const memberWord  = memberCount === 1 ? "member" : "members";
      return `
        <label class="ddf-import-party-row">
          <input type="checkbox" name="sbp_${p.id}" value="${p.id}" checked />
          <strong>${foundry.utils.escapeHTML(p.name)}</strong>
          <span class="hint">— ${memberCount} ${memberWord}</span>
        </label>`;
    }).join("");

    this.#sandboxPromptOpen = true;
    foundry.applications.api.DialogV2.wait({
      window: { title: "Import Sandbox Parties" },
      content: `
        <div class="standard-form">
          <p>Sandbox Campaign Manager has parties that don't exist in your faction manager. Select which to import — members will be auto-linked to actors.</p>
          <div class="ddf-import-party-list">${rows}</div>
        </div>`,
      buttons: [
        {
          label: "Import Selected",
          action: "import",
          icon: "fa-solid fa-download",
          default: true,
          callback: (_event, button) => {
            const ids = [];
            button.form.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => ids.push(cb.value));
            return ids;
          }
        },
        { label: "Skip", action: "skip" }
      ],
      rejectClose: false
    }).then(async (result) => {
      this.#sandboxPromptOpen = false;
      if (!Array.isArray(result) || !result.length) {
        this.#sandboxDismissedIds = signature;
        return;
      }
      const byId = new Map(missingParties.map(p => [p.id, p]));
      for (const id of result) {
        const sandboxParty = byId.get(id);
        if (sandboxParty) await importSandboxParty(sandboxParty);
      }
      this.render();
    }).catch(() => {
      this.#sandboxPromptOpen   = false;
      this.#sandboxDismissedIds = signature;
    });
  }

  // ─── Drag-Drop ───────────────────────────────────────────────────────────────

  /**
   * Returns the set of folder IDs that descend from `folderId` (children, grandchildren, …),
   * NOT including `folderId` itself. Used to prevent cycles when nesting folders.
   */
  #getFolderDescendants(folderId) {
    const folders = FolderStore.getFolders();
    const result = new Set();
    const walk = (parentId) => {
      for (const f of Object.values(folders)) {
        if ((f.parentFolderId ?? null) === parentId && !result.has(f.id)) {
          result.add(f.id);
          walk(f.id);
        }
      }
    };
    walk(folderId);
    return result;
  }

  /** True when a drop of the currently-dragged folder onto `targetFolderId` would create a cycle. */
  #wouldCreateFolderCycle(targetFolderId) {
    if (!this.#draggedFolderId) return false;
    if (this.#draggedFolderId === targetFolderId) return true;
    return this.#getFolderDescendants(this.#draggedFolderId).has(targetFolderId);
  }

  // ─── Context Menus ───────────────────────────────────────────────────────────

  #setupContextMenus(el) {
    const ContextMenu = foundry.applications.ux.ContextMenu;

    // fixed: true renders via popover on document.body — escapes sidebar overflow clipping
    new ContextMenu(el, ".ddf-folder-header", this.#folderMenuEntries(), { jQuery: false, fixed: true });
    new ContextMenu(el, ".faction-item",       this.#factionMenuEntries(), { jQuery: false, fixed: true });
  }

  #folderMenuEntries() {
    const folderIdFrom = (header) =>
      header.closest(".ddf-folder-section[data-folder-id]")?.dataset.folderId;

    return [
      {
        name: "Edit Folder",
        icon: '<i class="fa-solid fa-pen-to-square"></i>',
        callback: (header) => {
          const folderId = folderIdFrom(header);
          if (folderId) FolderConfigApp.openEdit(folderId, () => this.render());
        }
      },
      {
        name: "Create Faction",
        icon: '<i class="fa-solid fa-plus"></i>',
        callback: async (header) => {
          const folderId = folderIdFrom(header);
          if (!folderId) return;
          const folderName = FolderStore.getFolders()[folderId]?.name ?? "folder";
          const name = await promptName(`New Faction in ${folderName}`, "Name");
          if (!name) return;
          const faction = await FactionStore.create(name, null);
          await FolderStore.setFactionFolder(faction.id, folderId);
          this.render();
        }
      },
      {
        name: "Remove Folder",
        icon: '<i class="fa-solid fa-folder-minus"></i>',
        callback: async (header) => {
          const folderId = folderIdFrom(header);
          if (!folderId) return;
          const folder = FolderStore.getFolders()[folderId];
          if (!folder) return;
          const confirmed = await foundry.applications.api.DialogV2.confirm({
            window: { title: "Remove Folder" },
            content: `<p>Remove folder <strong>${foundry.utils.escapeHTML(folder.name)}</strong>?</p>
              <p>Its contents will be promoted to ${folder.parentFolderId ? "the parent folder" : "the root level"}.</p>`
          });
          if (!confirmed) return;
          await FolderStore.deleteFolder(folderId);
          this.render();
        }
      },
      {
        name: "Delete All",
        icon: '<i class="fa-solid fa-trash"></i>',
        callback: async (header) => {
          const folderId = folderIdFrom(header);
          if (!folderId) return;
          const folder = FolderStore.getFolders()[folderId];
          if (!folder) return;
          const factionIds = this.#getAllFactionIdsInFolderTree(folderId);
          const subFolderIds = this.#getAllSubFolderIds(folderId);
          const fc = factionIds.length, sc = subFolderIds.length;
          const confirmed = await foundry.applications.api.DialogV2.confirm({
            window: { title: "Delete Folder + All Contents" },
            content: `
              <p>Permanently delete folder <strong>${foundry.utils.escapeHTML(folder.name)}</strong> and everything inside?</p>
              <ul>
                <li><strong>${fc}</strong> faction${fc !== 1 ? "s" : ""} (with all journal pages, projects, members, and connections)</li>
                <li><strong>${sc}</strong> sub-folder${sc !== 1 ? "s" : ""}</li>
              </ul>
              <p><strong>This cannot be undone.</strong></p>`
          });
          if (!confirmed) return;
          await this.#deleteFolderAndContents(folderId);
          this.render();
        }
      }
    ];
  }

  #factionMenuEntries() {
    return [
      {
        name: "Create Sub-Faction",
        icon: '<i class="fa-solid fa-plus"></i>',
        condition: (item) => {
          const faction = FactionStore.getAll()[item.dataset.factionId];
          return faction && faction.kind !== "party";
        },
        callback: async (item) => {
          const parentId = item.dataset.factionId;
          if (!parentId) return;
          const parentName = FactionStore.getAll()[parentId]?.name ?? "faction";
          const name = await promptName(`New Sub-Faction (${parentName})`, "Name");
          if (!name) return;
          await FactionStore.create(name, parentId);
          this.render();
        }
      },
      {
        name: "Promote Faction",
        icon: '<i class="fa-solid fa-arrow-up"></i>',
        condition: (item) => !!FactionStore.getAll()[item.dataset.factionId]?.parentId,
        callback: async (item) => {
          const factionId = item.dataset.factionId;
          if (!factionId) return;
          await FactionStore.update(factionId, { parentId: null });
          this.render();
        }
      },
      {
        name: "Delete",
        icon: '<i class="fa-solid fa-trash"></i>',
        callback: async (item) => {
          const factionId = item.dataset.factionId;
          if (factionId) await this.#deleteFactionWithConfirm(factionId);
        }
      }
    ];
  }

  // ─── Recursive Delete Helpers ────────────────────────────────────────────────

  /** Returns descendant folder IDs (excluding `folderId` itself). */
  #getAllSubFolderIds(folderId) {
    return [...this.#getFolderDescendants(folderId)];
  }

  /** Returns every faction ID filed in `folderId` or any of its descendant folders. */
  #getAllFactionIdsInFolderTree(folderId) {
    const folderIds = new Set([folderId, ...this.#getAllSubFolderIds(folderId)]);
    const membership = FolderStore.getMembership();
    const result = [];
    for (const [factionId, fid] of Object.entries(membership)) {
      if (folderIds.has(fid)) result.push(factionId);
    }
    return result;
  }

  /**
   * Recursively delete a folder, every faction it contains (with their sub-factions
   * and per-faction store cleanup), and every descendant folder.
   */
  async #deleteFolderAndContents(folderId) {
    const subFolders = Object.values(FolderStore.getFolders())
      .filter(f => (f.parentFolderId ?? null) === folderId);
    for (const sub of subFolders) {
      await this.#deleteFolderAndContents(sub.id);
    }
    const factionsInFolder = Object.entries(FolderStore.getMembership())
      .filter(([_, fid]) => fid === folderId)
      .map(([fid]) => fid);
    for (const fid of factionsInFolder) {
      await this.#deleteFactionDeep(fid);
    }
    await FolderStore.deleteFolder(folderId);
  }

  /** Cascade-delete a faction with all its sub-factions and per-faction store cleanup. */
  async #deleteFactionDeep(factionId) {
    const subs = Object.values(FactionStore.getAll()).filter(f => f.parentId === factionId);
    for (const sub of subs) await this.#deleteFactionDeep(sub.id);
    await ProjectStore.deleteForFaction(factionId);
    await RelationshipStore.cleanupFaction(factionId);
    await MemberStore.cleanupFaction(factionId);
    await FactionStore.delete(factionId);
  }

  /**
   * Confirm-and-delete one faction. When the faction has sub-factions the user
   * is offered Cascade / Promote / Cancel; otherwise a plain confirm.
   */
  async #deleteFactionWithConfirm(factionId) {
    const faction = FactionStore.getAll()[factionId];
    if (!faction) return;

    const children = Object.values(FactionStore.getAll()).filter(f => f.parentId === factionId);
    let mode = "promote";

    if (children.length) {
      const n = children.length;
      const choice = await foundry.applications.api.DialogV2.wait({
        window: { title: "Delete Faction" },
        content: `<p>Delete <strong>${faction.name}</strong>?</p>
          <p><strong>${n}</strong> sub-faction${n !== 1 ? "s" : ""} will be affected.</p>`,
        buttons: [
          { label: "Delete Sub-factions", action: "cascade", icon: "fa-solid fa-trash" },
          { label: "Promote Sub-factions", action: "promote", icon: "fa-solid fa-arrow-up", default: true },
          { label: "Cancel", action: "cancel" }
        ],
        rejectClose: false
      }).catch(() => "cancel");
      if (!choice || choice === "cancel") return;
      mode = choice;
    } else {
      const confirmed = await foundry.applications.api.DialogV2.confirm({
        window: { title: "Delete Faction" },
        content: `<p>Delete <strong>${faction.name}</strong>? This will also delete the faction's journal page and all projects.</p>`
      });
      if (!confirmed) return;
    }

    if (mode === "cascade") {
      await this.#deleteFactionDeep(factionId);
    } else {
      for (const child of Object.values(FactionStore.getAll()).filter(f => f.parentId === factionId)) {
        await FactionStore.update(child.id, { parentId: null });
      }
      await ProjectStore.deleteForFaction(factionId);
      await RelationshipStore.cleanupFaction(factionId);
      await MemberStore.cleanupFaction(factionId);
      await FactionStore.delete(factionId);
    }

    this.render();
  }

  /** Clear all transient drag-feedback classes from the sidebar tree. */
  #clearDragFeedback(el) {
    el.querySelectorAll(".ddf-drop-above, .ddf-drop-below, .ddf-drag-over, .ddf-drag-source").forEach(x => {
      x.classList.remove("ddf-drop-above", "ddf-drop-below", "ddf-drag-over", "ddf-drag-source");
    });
  }

  #setupDragDrop(el) {
    // ── Faction items: always draggable so users can move them between folders ──
    // (Manual reorder still only takes effect when the section's sort mode is "m";
    //  in alpha mode the manual order is updated but ignored at render time.)
    el.querySelectorAll(".faction-item[data-faction-id]").forEach(item => {
      item.setAttribute("draggable", "true");

      item.addEventListener("dragstart", (e) => {
        e.stopPropagation();
        this.#draggedId       = item.dataset.factionId;
        this.#draggedFolderId = null;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", this.#draggedId);
        setTimeout(() => item.classList.add("ddf-drag-source"), 0);
      });

      item.addEventListener("dragend", () => {
        this.#draggedId = null;
        this.#clearDragFeedback(el);
      });

      item.addEventListener("dragover", (e) => {
        if (!this.#draggedId || this.#draggedId === item.dataset.factionId) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        el.querySelectorAll(".ddf-drop-above, .ddf-drop-below").forEach(x => {
          x.classList.remove("ddf-drop-above", "ddf-drop-below");
        });
        const rect = item.getBoundingClientRect();
        item.classList.add(e.clientY < rect.top + rect.height / 2 ? "ddf-drop-above" : "ddf-drop-below");
      });

      item.addEventListener("dragleave", () => {
        item.classList.remove("ddf-drop-above", "ddf-drop-below");
      });

      item.addEventListener("drop", async (e) => {
        if (!this.#draggedId || this.#draggedId === item.dataset.factionId) return;
        e.preventDefault();
        e.stopPropagation();
        const targetId     = item.dataset.factionId;
        const sourceId     = this.#draggedId;
        const rect         = item.getBoundingClientRect();
        const insertBefore = e.clientY < rect.top + rect.height / 2;
        const targetList   = item.closest("ol[data-folder-id]");
        const targetFolder = targetList?.dataset.folderId ?? "";
        await this.#reorderAndMove(sourceId, targetId, insertBefore, targetFolder);
      });
    });

    // ── Folder sections: draggable from the header; can be nested or un-nested ──
    el.querySelectorAll(".ddf-folder-section[data-folder-id]").forEach(section => {
      const folderId = section.dataset.folderId;
      const header   = section.querySelector(".ddf-folder-header");
      if (!folderId || !header) return;

      header.setAttribute("draggable", "true");

      header.addEventListener("dragstart", (e) => {
        // Don't bubble — child folders' headers would otherwise also fire
        e.stopPropagation();
        this.#draggedFolderId = folderId;
        this.#draggedId       = null;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", `folder:${folderId}`);
        setTimeout(() => section.classList.add("ddf-drag-source"), 0);
      });

      header.addEventListener("dragend", () => {
        this.#draggedFolderId = null;
        this.#clearDragFeedback(el);
      });

      header.addEventListener("dragover", (e) => {
        // Folder being dragged onto another folder header → check for cycles
        if (this.#draggedFolderId) {
          if (this.#wouldCreateFolderCycle(folderId)) return;
          e.preventDefault();
          e.stopPropagation();
          header.classList.add("ddf-drag-over");
          return;
        }
        // Faction being dragged onto a folder header → allow
        if (this.#draggedId) {
          e.preventDefault();
          e.stopPropagation();
          header.classList.add("ddf-drag-over");
        }
      });

      header.addEventListener("dragleave", () => {
        header.classList.remove("ddf-drag-over");
      });

      header.addEventListener("drop", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        header.classList.remove("ddf-drag-over");

        if (this.#draggedFolderId) {
          if (this.#wouldCreateFolderCycle(folderId)) return;
          if (this.#draggedFolderId === folderId) return;
          await FolderStore.setFolderParent(this.#draggedFolderId, folderId);
          this.render();
          return;
        }
        if (this.#draggedId) {
          await FolderStore.setFactionFolder(this.#draggedId, folderId);
          this.render();
        }
      });
    });

    // ── Unfiled section: drop here to un-file (faction) or un-nest (folder) ──
    const unfiledSection = el.querySelector(".ddf-unfiled-section");
    if (unfiledSection) {
      unfiledSection.addEventListener("dragover", (e) => {
        if (!this.#draggedId && !this.#draggedFolderId) return;
        e.preventDefault();
        e.stopPropagation();
        unfiledSection.classList.add("ddf-drag-over");
      });

      unfiledSection.addEventListener("dragleave", () => {
        unfiledSection.classList.remove("ddf-drag-over");
      });

      unfiledSection.addEventListener("drop", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        unfiledSection.classList.remove("ddf-drag-over");

        if (this.#draggedFolderId) {
          await FolderStore.setFolderParent(this.#draggedFolderId, null);
          this.render();
          return;
        }
        if (this.#draggedId) {
          await FolderStore.setFactionFolder(this.#draggedId, null);
          this.render();
        }
      });
    }

    // ── Sidebar list itself: fallback drop zone for empty space ──
    // Lets users drop a faction OR folder onto the bare sidebar to un-file/un-nest,
    // even when no unfiled section is rendered (e.g. all factions are in folders).
    const sidebarList = el.querySelector(".ddf-sidebar-list");
    if (sidebarList) {
      sidebarList.addEventListener("dragover", (e) => {
        if (!this.#draggedId && !this.#draggedFolderId) return;
        e.preventDefault();
      });

      // Child handlers (faction-item, folder-header, unfiled-section) call
      // stopPropagation, so this listener only fires when the drop lands on
      // bare sidebar space outside any specific drop target.
      sidebarList.addEventListener("drop", async (e) => {
        e.preventDefault();

        if (this.#draggedFolderId) {
          await FolderStore.setFolderParent(this.#draggedFolderId, null);
          this.render();
          return;
        }
        if (this.#draggedId) {
          await FolderStore.setFactionFolder(this.#draggedId, null);
          this.render();
        }
      });
    }
  }

  /**
   * Reorders the manual order list and optionally changes a faction's folder membership.
   * @param {string} sourceId  — the faction being moved
   * @param {string} targetId  — the faction we're dropping relative to
   * @param {boolean} insertBefore — insert before (true) or after (false) target
   * @param {string} targetFolder  — folder ID of the drop target (empty = unfiled)
   */
  async #reorderAndMove(sourceId, targetId, insertBefore, targetFolder) {
    const allFactions = FactionStore.getAll();

    // Ensure all top-level IDs are represented in the order array
    const topLevelIds = Object.keys(allFactions).filter(id => {
      const f = allFactions[id];
      return !f.parentId || !allFactions[f.parentId];
    });

    let order = [...FolderStore.getManualOrder()];
    for (const id of topLevelIds) {
      if (!order.includes(id)) order.push(id);
    }

    // Remove source from its current position
    order = order.filter(id => id !== sourceId);

    // Insert relative to target
    const targetIdx = order.indexOf(targetId);
    if (targetIdx === -1) {
      order.push(sourceId);
    } else {
      order.splice(insertBefore ? targetIdx : targetIdx + 1, 0, sourceId);
    }

    await FolderStore.setManualOrder(order);

    // Update folder membership if the target section is different from the source
    const currentFolder = FolderStore.getMembership()[sourceId] ?? "";
    if (currentFolder !== targetFolder) {
      await FolderStore.setFactionFolder(sourceId, targetFolder || null);
    }

    this.render();
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  #promptCreateOrganization() {
    return new Promise(resolve => {
      foundry.applications.api.DialogV2.prompt({
        window: { title: "New Organization" },
        content: `
          <div class="standard-form">
            <div class="form-group">
              <label>Type</label>
              <div class="form-fields">
                <select name="kind">
                  <option value="faction" selected>Faction</option>
                  <option value="party">Adventuring Party</option>
                </select>
              </div>
            </div>
            <div class="form-group">
              <label>Name</label>
              <div class="form-fields">
                <input type="text" name="name" autofocus placeholder="Name…" />
              </div>
            </div>
          </div>`,
        ok: {
          label: "Create",
          callback: (_event, button) => {
            const name = button.form.elements.name.value.trim();
            const kind = button.form.elements.kind.value;
            resolve(name ? { name, kind } : null);
          }
        },
        rejectClose: false
      }).catch(() => resolve(null));
    });
  }

}
