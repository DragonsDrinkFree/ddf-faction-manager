import { FactionStore } from "../data/FactionStore.js";
import { FolderStore } from "../data/FolderStore.js";
import { ProjectStore } from "../data/ProjectStore.js";
import { RelationshipStore } from "../data/RelationshipStore.js";
import { FactionDetailApp } from "./FactionDetailApp.js";
import { FolderConfigApp } from "./FolderConfigApp.js";
import { GlobalRelationshipsApp } from "./GlobalRelationshipsApp.js";

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

  /** Faction ID currently being dragged (manual mode). */
  #draggedId = null;

  // ─── Context ─────────────────────────────────────────────────────────────────

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    const sortMode    = FolderStore.getSortMode(); // controls unfiled factions
    const folders     = FolderStore.getFolders();
    const membership  = FolderStore.getMembership();
    const manualOrder = FolderStore.getManualOrder();

    // getHierarchy() returns top-level roots alpha-sorted, each with .children
    const hierarchyRoots = FactionStore.getHierarchy();

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

    // ── Step 3: build sections — each folder uses its own sorting field ───────
    const sections = [];
    for (const folder of Object.values(folders).sort((a, b) => a.name.localeCompare(b.name))) {
      const raw      = folderGroups[folder.id] ?? [];
      const factions = (folder.sorting ?? "a") === "m" ? manualSort(raw) : raw;
      sections.push({
        type:      "folder",
        id:        folder.id,
        name:      folder.name,
        color:     folder.color  ?? "",
        sorting:   folder.sorting ?? "a",
        collapsed: folder.collapsed,
        factions
      });
    }

    // Unfiled factions use the global sidebar sort toggle
    const unfiledSorted = sortMode === "manual" ? manualSort(unfiledFactions) : unfiledFactions;
    sections.push({ type: "unfiled", factions: unfiledSorted });

    context.sections   = sections;
    context.sortMode   = sortMode;
    context.hasFolders = Object.keys(folders).length > 0;
    context.selectedId = null;
    return context;
  }

  // ─── Render Hook ─────────────────────────────────────────────────────────────

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    const el = this.element;

    // ── Header buttons ───────────────────────────────────────────────────────
    el.querySelector(".ddf-create-faction")?.addEventListener("click", async () => {
      const name = await this.#promptName("New Faction", "Name");
      if (!name) return;
      await FactionStore.create(name, null);
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
        if (id) FactionDetailApp.show(id);
      });
    });

    // ── Sub-faction creation ──────────────────────────────────────────────────
    el.querySelectorAll("[data-action='createSubFaction']").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const parentId = btn.closest("[data-faction-id]")?.dataset.factionId;
        if (!parentId) return;
        const parentName = FactionStore.getAll()[parentId]?.name ?? "faction";
        const name = await this.#promptName(
          `New Sub-Faction (${parentName})`,
          "Name"
        );
        if (!name) return;
        await FactionStore.create(name, parentId);
        this.render();
      });
    });

    // ── Delete faction ────────────────────────────────────────────────────────
    el.querySelectorAll("[data-action='deleteFaction']").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.closest("[data-faction-id]")?.dataset.factionId;
        if (!id) return;
        const faction  = FactionStore.getAll()[id];
        if (!faction) return;

        const children    = Object.values(FactionStore.getAll()).filter(f => f.parentId === id);
        const hasChildren = children.length > 0;
        let mode = "promote";

        if (hasChildren) {
          const n      = children.length;
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
          const deleteRecursive = async (factionId) => {
            const subs = Object.values(FactionStore.getAll()).filter(f => f.parentId === factionId);
            for (const sub of subs) await deleteRecursive(sub.id);
            await ProjectStore.deleteForFaction(factionId);
            await RelationshipStore.cleanupFaction(factionId);
            await FactionStore.delete(factionId);
          };
          await deleteRecursive(id);
        } else {
          for (const child of Object.values(FactionStore.getAll()).filter(f => f.parentId === id)) {
            await FactionStore.update(child.id, { parentId: null });
          }
          await ProjectStore.deleteForFaction(id);
          await RelationshipStore.cleanupFaction(id);
          await FactionStore.delete(id);
        }

        this.render();
      });
    });

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

    // ── Folder rename/edit ────────────────────────────────────────────────────
    el.querySelectorAll("[data-action='renameFolder']").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const folderId = btn.closest(".ddf-folder-section[data-folder-id]")?.dataset.folderId;
        if (!folderId) return;
        FolderConfigApp.openEdit(folderId, () => this.render());
      });
    });

    // ── Folder delete ─────────────────────────────────────────────────────────
    el.querySelectorAll("[data-action='deleteFolder']").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const folderId = btn.closest(".ddf-folder-section[data-folder-id]")?.dataset.folderId;
        if (!folderId) return;
        const folder    = FolderStore.getFolders()[folderId];
        const confirmed = await foundry.applications.api.DialogV2.confirm({
          window: { title: "Delete Folder" },
          content: `<p>Delete folder <strong>${folder?.name ?? ""}</strong>? Factions inside will become unfiled.</p>`
        });
        if (!confirmed) return;
        await FolderStore.deleteFolder(folderId);
        this.render();
      });
    });

    // ── Drag-drop: always set up — each section controls its own draggability ──
    this.#setupDragDrop(el);
  }

  // ─── Drag-Drop ───────────────────────────────────────────────────────────────

  #setupDragDrop(el) {
    const folders    = FolderStore.getFolders();
    const globalSort = FolderStore.getSortMode();

    // Determine which top-level items are draggable based on their section's sort mode.
    // – Folder contents: draggable when folder.sorting === "m"
    // – Unfiled: draggable when global sort mode === "manual"
    const draggableItems = [];
    el.querySelectorAll(".ddf-folder-contents > .faction-item").forEach(item => {
      const folderId = item.closest("ol[data-folder-id]")?.dataset.folderId;
      if (folderId && (folders[folderId]?.sorting ?? "a") === "m") draggableItems.push(item);
    });
    el.querySelectorAll(".ddf-unfiled-section > .faction-item").forEach(item => {
      if (globalSort === "manual") draggableItems.push(item);
    });

    draggableItems.forEach(item => {
      item.setAttribute("draggable", "true");

      item.addEventListener("dragstart", (e) => {
        this.#draggedId = item.dataset.factionId;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", this.#draggedId);
        // Slight delay so the browser grabs the un-dimmed element as drag image
        setTimeout(() => item.classList.add("ddf-drag-source"), 0);
      });

      item.addEventListener("dragend", () => {
        this.#draggedId = null;
        item.classList.remove("ddf-drag-source");
        el.querySelectorAll(".ddf-drop-above, .ddf-drop-below, .ddf-drag-over").forEach(x => {
          x.classList.remove("ddf-drop-above", "ddf-drop-below", "ddf-drag-over");
        });
      });

      item.addEventListener("dragover", (e) => {
        if (!this.#draggedId || this.#draggedId === item.dataset.factionId) return;
        e.preventDefault();
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
        e.preventDefault();
        if (!this.#draggedId || this.#draggedId === item.dataset.factionId) return;
        const targetId     = item.dataset.factionId;
        const sourceId     = this.#draggedId;
        const rect         = item.getBoundingClientRect();
        const insertBefore = e.clientY < rect.top + rect.height / 2;
        const targetList   = item.closest("ol[data-folder-id]");
        const targetFolder = targetList?.dataset.folderId ?? "";
        await this.#reorderAndMove(sourceId, targetId, insertBefore, targetFolder);
      });
    });

    // Drop onto folder headers (moves to that folder)
    el.querySelectorAll(".ddf-folder-header").forEach(header => {
      const folderId = header.closest(".ddf-folder-section[data-folder-id]")?.dataset.folderId;
      if (!folderId) return;

      header.addEventListener("dragover", (e) => {
        if (!this.#draggedId) return;
        e.preventDefault();
        header.classList.add("ddf-drag-over");
      });

      header.addEventListener("dragleave", () => {
        header.classList.remove("ddf-drag-over");
      });

      header.addEventListener("drop", async (e) => {
        e.preventDefault();
        if (!this.#draggedId) return;
        header.classList.remove("ddf-drag-over");
        await FolderStore.setFactionFolder(this.#draggedId, folderId);
        this.render();
      });
    });

    // Drop onto unfiled section empty space (removes from any folder)
    const unfiledSection = el.querySelector(".ddf-unfiled-section");
    if (unfiledSection) {
      unfiledSection.addEventListener("dragover", (e) => {
        if (!this.#draggedId) return;
        e.preventDefault();
        unfiledSection.classList.add("ddf-drag-over");
      });

      unfiledSection.addEventListener("dragleave", () => {
        unfiledSection.classList.remove("ddf-drag-over");
      });

      unfiledSection.addEventListener("drop", async (e) => {
        e.preventDefault();
        if (!this.#draggedId) return;
        unfiledSection.classList.remove("ddf-drag-over");
        await FolderStore.setFactionFolder(this.#draggedId, null);
        this.render();
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

  #promptName(title, label) {
    return new Promise(resolve => {
      foundry.applications.api.DialogV2.prompt({
        window: { title },
        content: `
          <div class="standard-form">
            <div class="form-group">
              <label>${label}</label>
              <div class="form-fields">
                <input type="text" name="name" autofocus placeholder="${label}…" />
              </div>
            </div>
          </div>`,
        ok: {
          label: "Create",
          callback: (_event, button) => resolve(button.form.elements.name.value.trim() || null)
        },
        rejectClose: false
      }).catch(() => resolve(null));
    });
  }

}
