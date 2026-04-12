import { FactionStore } from "../data/FactionStore.js";
import { ProjectStore } from "../data/ProjectStore.js";
import { RelationshipStore } from "../data/RelationshipStore.js";
import { FactionDetailApp } from "./FactionDetailApp.js";
import { GlobalRelationshipsApp } from "./GlobalRelationshipsApp.js";

const { HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Custom Foundry V14 sidebar tab for the Faction Manager.
 *
 * Registration (in module.js init hook):
 *   Sidebar.TABS.ddfFactions = { tooltip: "Factions", icon: "...", gmOnly: true };
 *   CONFIG.ui.ddfFactions = FactionsSidebarTab;
 *
 * Foundry will instantiate CONFIG.ui entries into ui[key] and
 * the sidebar renders them if they appear in Sidebar.TABS.
 */
export class FactionsSidebarTab extends HandlebarsApplicationMixin(
  foundry.applications.sidebar.AbstractSidebarTab
) {
  /** Must match the key used in Sidebar.TABS and CONFIG.ui. */
  static tabName = "ddfFactions";

  static DEFAULT_OPTIONS = {
    // Inherits: tag="section", window.frame=false, window.positioned=false
    // from AbstractSidebarTab.DEFAULT_OPTIONS
  };

  static PARTS = {
    tab: {
      template: "modules/ddf-faction-manager/templates/sidebar-tab.hbs",
      scrollable: [".ddf-sidebar-list"],
      root: true
    }
  };

  // ─── Context ─────────────────────────────────────────────────────────────────

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.factions  = FactionStore.getHierarchy();
    context.selectedId = null;
    return context;
  }

  // ─── Render Hook ─────────────────────────────────────────────────────────────

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    const el = this.element;

    // Create Faction
    el.querySelector(".ddf-create-faction")?.addEventListener("click", async () => {
      const name = await this.#promptName("New Faction", "Enter faction name:");
      if (!name) return;
      await FactionStore.create(name, null);
      this.render();
    });

    // Create Folder (stub)
    el.querySelector(".ddf-create-folder")?.addEventListener("click", () => {
      ui.notifications.info("Folders are coming soon!");
    });

    // Faction Relationships global map
    el.querySelector(".ddf-relationships-btn")?.addEventListener("click", () => {
      GlobalRelationshipsApp.show();
    });

    // Live search filter
    el.querySelector(".ddf-faction-search")?.addEventListener("input", (e) => {
      const q = e.target.value.toLowerCase();
      el.querySelectorAll(".faction-item").forEach(item => {
        const name = item.querySelector(".faction-name")?.textContent?.toLowerCase() ?? "";
        item.style.display = name.includes(q) ? "" : "none";
      });
    });

    // Select faction → open FactionDetailApp
    el.querySelectorAll("[data-action='selectFaction']").forEach(row => {
      row.addEventListener("click", () => {
        const id = row.closest("[data-faction-id]")?.dataset.factionId;
        if (id) FactionDetailApp.show(id);
      });
    });

    // Create sub-faction
    el.querySelectorAll("[data-action='createSubFaction']").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const parentId = btn.closest("[data-faction-id]")?.dataset.factionId;
        if (!parentId) return;
        const parentName = FactionStore.getAll()[parentId]?.name ?? "faction";
        const name = await this.#promptName(
          "New Sub-Faction",
          `Enter sub-faction name (under ${parentName}):`
        );
        if (!name) return;
        await FactionStore.create(name, parentId);
        this.render();
      });
    });

    // Delete faction
    el.querySelectorAll("[data-action='deleteFaction']").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id      = btn.closest("[data-faction-id]")?.dataset.factionId;
        if (!id) return;
        const faction = FactionStore.getAll()[id];
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
              {
                label:  "Delete Sub-factions",
                action: "cascade",
                icon:   "fa-solid fa-trash"
              },
              {
                label:   "Promote Sub-factions",
                action:  "promote",
                icon:    "fa-solid fa-arrow-up",
                default: true
              },
              {
                label:  "Cancel",
                action: "cancel"
              }
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
          // Recursively delete all descendants (deepest first), then the faction itself
          const deleteRecursive = async (factionId) => {
            const subs = Object.values(FactionStore.getAll()).filter(f => f.parentId === factionId);
            for (const sub of subs) await deleteRecursive(sub.id);
            await ProjectStore.deleteForFaction(factionId);
            await RelationshipStore.cleanupFaction(factionId);
            await FactionStore.delete(factionId);
          };
          await deleteRecursive(id);
        } else {
          // Promote: elevate direct children to top-level before deleting parent
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
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  #promptName(title, label) {
    return new Promise(resolve => {
      foundry.applications.api.DialogV2.prompt({
        window: { title },
        content: `<div class="form-group"><label>${label}</label><input type="text" name="name" autofocus /></div>`,
        ok: {
          label: "Create",
          callback: (_event, button) => {
            const value = button.form.elements.name.value.trim();
            resolve(value || null);
          }
        },
        rejectClose: false
      }).catch(() => resolve(null));
    });
  }
}
