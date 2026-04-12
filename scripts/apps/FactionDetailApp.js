import { FactionStore } from "../data/FactionStore.js";
import { ProjectStore } from "../data/ProjectStore.js";
import { RelationshipStore } from "../data/RelationshipStore.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class FactionDetailApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @type {FactionDetailApp|null} */
  static #instance = null;

  #selectedFactionId = null;
  #selectedProjectId = null;
  #activeTab = "overview";
  #editingOverview = false;
  #editingNoteId = null;

  static DEFAULT_OPTIONS = {
    id: "ddf-faction-detail",
    classes: ["ddf-faction-detail"],
    tag: "div",
    window: {
      resizable: true,
      minimizable: true
    },
    position: {
      width: 720,
      height: 520
    },
    actions: {
      openJournal:       FactionDetailApp.#onOpenJournal,
      switchTab:         FactionDetailApp.#onSwitchTab,
      createProject:     FactionDetailApp.#onCreateProject,
      selectProject:     FactionDetailApp.#onSelectProject,
      editOverview:      FactionDetailApp.#onEditOverview,
      saveOverview:      FactionDetailApp.#onSaveOverview,
      cancelOverview:    FactionDetailApp.#onCancelOverview,
      saveInlineNote:    FactionDetailApp.#onSaveInlineNote,
      cancelNoteEdit:    FactionDetailApp.#onCancelNoteEdit,
      finishProject:     FactionDetailApp.#onFinishProject,
      reactivateProject: FactionDetailApp.#onReactivateProject,
      deleteProject:     FactionDetailApp.#onDeleteProject,
      editNote:          FactionDetailApp.#onEditNote,
      deleteNote:        FactionDetailApp.#onDeleteNote,
      breakParentLink:   FactionDetailApp.#onBreakParentLink
    }
  };

  static PARTS = {
    content: {
      template: "modules/ddf-faction-manager/templates/faction-detail.hbs",
      scrollable: [
        ".faction-journal-body",
        ".faction-connections-body",
        ".project-notes-log",
        ".project-items"
      ]
    }
  };

  get title() {
    return FactionStore.getAll()[this.#selectedFactionId]?.name ?? "Faction";
  }

  /**
   * Open (or switch) the singleton detail window to the given faction.
   * @param {string} factionId
   */
  static show(factionId) {
    if (!game.user.isGM) return;
    if (!FactionDetailApp.#instance) {
      FactionDetailApp.#instance = new FactionDetailApp();
    }
    const app = FactionDetailApp.#instance;
    if (app.#selectedFactionId !== factionId) {
      app.#selectedFactionId = factionId;
      app.#selectedProjectId = null;
      app.#editingOverview = false;
      app.#editingNoteId = null;
      app.#activeTab = "overview";
    }
    app.render({ force: true });
  }

  // ─── Context ─────────────────────────────────────────────────────────────────

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.activeTab = this.#activeTab;
    context.tabs = [
      { id: "overview", label: "Overview", icon: "fa-solid fa-scroll",     cssClass: this.#activeTab === "overview" ? "active" : "" },
      { id: "projects", label: "Projects", icon: "fa-solid fa-list-check", cssClass: this.#activeTab === "projects" ? "active" : "" }
    ];
    return context;
  }

  /** @override */
  async _preparePartContext(partId, context, options) {
    context = await super._preparePartContext(partId, context, options);

    if (partId !== "content") return context;

    context.selectedFaction = this.#selectedFactionId
      ? FactionStore.getAll()[this.#selectedFactionId] ?? null
      : null;

    // Auto-select first active project when switching to the Projects tab
    if (this.#activeTab === "projects" && this.#selectedFactionId && !this.#selectedProjectId) {
      const all = ProjectStore.getForFaction(this.#selectedFactionId);
      const sorted = all.sort((a, b) => a.name.localeCompare(b.name));
      const first = sorted.find(p => p.status === "active") ?? sorted[0];
      if (first) this.#selectedProjectId = first.id;
    }

    // Overview: header stats + journal body + connections list
    const rawStats = game.settings.get("ddf-faction-manager", "statDefinitions");
    context.statDefinitions = (() => {
      try { return typeof rawStats === "string" ? JSON.parse(rawStats) : (rawStats ?? []); }
      catch { return []; }
    })();
    context.factionStats = context.selectedFaction?.stats ?? {};
    context.journalContent   = await this.#getJournalContent();
    context.relationshipItems = this.#selectedFactionId
      ? this.#buildRelationshipItems()
      : [];

    // Projects tab
    context.selectedProjectId = this.#selectedProjectId;
    context.projects           = this.#buildProjectContext();
    context.selectedProject    = this.#buildSelectedProjectContext();
    context.editingOverview    = this.#editingOverview;
    context.editingNoteId      = this.#editingNoteId;

    if (context.selectedProject && !this.#editingOverview) {
      context.selectedProject.enrichedDescription =
        await foundry.applications.ux.TextEditor.implementation.enrichHTML(
          context.selectedProject.description ?? "", { async: true }
        );
    }

    return context;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  #getConnectionTypes() {
    try {
      const raw = game.settings.get("ddf-faction-manager", "connectionTypes");
      return typeof raw === "string" ? JSON.parse(raw) : (raw ?? []);
    } catch { return []; }
  }

  // ─── Relationship Items (read-only list for Overview pane) ────────────────────

  #buildRelationshipItems() {
    const allFactions = FactionStore.getAll();
    const faction     = allFactions[this.#selectedFactionId];
    const storedEdges = RelationshipStore.getEdgesForFaction(this.#selectedFactionId);

    const ICON = {
      Actor:        "fa-solid fa-user",
      JournalEntry: "fa-solid fa-book",
      Item:         "fa-solid fa-suitcase",
      Scene:        "fa-solid fa-map"
    };

    // Parent connection — shown at top in gold when this faction is a sub-faction
    const parentItems = [];
    if (faction?.parentId && allFactions[faction.parentId]) {
      parentItems.push({
        id:             `parent_${faction.parentId}`,
        name:           allFactions[faction.parentId].name,
        icon:           "fa-solid fa-shield-halved",
        directionSymbol: "↑",
        isAuto:         true,
        isParentLink:   true,
        parentFactionId: faction.parentId,
        color:          ""
      });
    }

    // Sub-faction auto-connections (derived from hierarchy, not stored)
    const subItems = Object.values(allFactions)
      .filter(f => f.parentId === this.#selectedFactionId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(f => ({
        id:              `sub_${f.id}`,
        name:            f.name,
        icon:            "fa-solid fa-shield-halved",
        directionSymbol: "↕",
        isAuto:          true,
        color:           ""
      }));

    // Stored relationship edges
    const connectionTypes = this.#getConnectionTypes();

    const storedItems = storedEdges
      .map(edge => {
        let name = "";
        let icon = "fa-solid fa-circle-nodes";

        if (edge.type === "faction") {
          const targetId = edge._reversed ? edge.fromFactionId : edge.toFactionId;
          name = allFactions[targetId]?.name ?? "Unknown Faction";
          icon = "fa-solid fa-shield-halved";
        } else if (edge.type === "document") {
          name = edge.documentName ?? "Document";
          icon = ICON[edge.documentType] ?? "fa-solid fa-file";
        } else {
          name = edge.label ?? "Simple Node";
          icon = "fa-solid fa-circle-nodes";
        }

        const directionSymbol = edge.direction === "two-way" ? "↔"
          : edge._reversed ? "←" : "→";

        const connType = connectionTypes.find(t => t.id === edge.connectionTypeId);

        return {
          id:                  edge.id,
          name,
          icon,
          directionSymbol,
          isAuto:              false,
          color:               edge.color ?? "",
          relationLabel:       edge.relationLabel ?? "",
          connectionTypeId:    edge.connectionTypeId ?? null,
          connectionTypeName:  connType?.name ?? null,
          connectionTypeColor: connType?.color ?? null
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    return [...parentItems, ...subItems, ...storedItems];
  }

  // ─── Render Hook ─────────────────────────────────────────────────────────────

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);

    // ── Stat inputs: auto-save on change (blur after edit) ───────────────────
    this.element.querySelectorAll(".faction-stat-input").forEach(input => {
      input.addEventListener("change", async (e) => {
        if (!this.#selectedFactionId) return;
        const statId  = e.target.dataset.statId;
        const value   = e.target.value.trim();
        const faction = FactionStore.getAll()[this.#selectedFactionId];
        if (!faction) return;
        const stats = { ...(faction.stats ?? {}), [statId]: value };
        await FactionStore.update(this.#selectedFactionId, { stats });
      });
    });

    // Wire color swatches in the connections pane (overview tab)
    this.element.querySelectorAll(".rel-color-input").forEach(input => {
      input.addEventListener("change", async (e) => {
        const edgeId = e.target.dataset.edgeId;
        await RelationshipStore.updateEdgeColor(edgeId, e.target.value);
        e.target.closest(".rel-color-swatch").style.background = e.target.value;
        this.render({ parts: ["content"] });
      });
    });

    // ── Inline note editor (projects tab) ────────────────────────────────────
    const presetRadios = this.element.querySelectorAll('input[name="note_preset"]');
    const customInput  = this.element.querySelector('input[name="note_custom"]');
    const textarea     = this.element.querySelector(".note-draft-textarea");

    if (!textarea) return;

    // Pre-fill editor when editing an existing note
    if (this.#editingNoteId && this.#selectedProjectId) {
      const project = ProjectStore.getAll()[this.#selectedProjectId];
      const note    = project?.notes.find(n => n.id === this.#editingNoteId);
      if (note) {
        textarea.value = note.text;
        textarea.focus();
        textarea.setSelectionRange(note.text.length, note.text.length);

        const presetValues = [10, 25, 50];
        if (presetValues.includes(note.progressDelta)) {
          const radio = this.element.querySelector(`input[name="note_preset"][value="${note.progressDelta}"]`);
          if (radio) radio.checked = true;
        } else if (note.progressDelta !== 0) {
          if (customInput) customInput.value = note.progressDelta;
        }
      }
    }

    // Preset selected → clear custom
    presetRadios.forEach(radio => {
      radio.addEventListener("change", () => { if (customInput) customInput.value = ""; });
    });

    // Custom typed → uncheck all presets
    customInput?.addEventListener("input", () => {
      presetRadios.forEach(r => { r.checked = false; });
    });

    // Enter saves; Shift+Enter inserts newline
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.element.querySelector("[data-action='saveInlineNote']")?.click();
      }
    });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  async #getJournalContent() {
    if (!this.#selectedFactionId) return null;
    const faction = FactionStore.getAll()[this.#selectedFactionId];
    if (!faction) return null;

    const journal = FactionStore.getFactionJournal();
    if (!journal) {
      return `<p class="notification warning">No faction journal configured. Create a faction to auto-configure one, or set it in <strong>Game Settings → Faction Manager → Configure</strong>.</p>`;
    }

    if (!faction.pageId) {
      return `<p class="notification warning">This faction has no journal page — it may have been created before the shared-journal update.</p>`;
    }

    const page = journal.pages.get(faction.pageId);
    if (!page) {
      return `<p class="notification warning">Journal page not found. It may have been deleted from the journal directly.</p>`;
    }

    return foundry.applications.ux.TextEditor.implementation.enrichHTML(
      page.text?.content ?? "", {
        relativeTo: page,
        secrets: game.user.isGM,
        async: true
      }
    );
  }

  static #quarterBars(progress) {
    return [0, 1, 2, 3].map(i => {
      const low  = i * 25;
      const high = low + 25;
      if (progress >= high) return { filled: true,  partial: 100 };
      if (progress <= low)  return { filled: false, partial: 0 };
      return { filled: false, partial: Math.round((progress - low) / 25 * 100) };
    });
  }

  #buildProjectContext() {
    if (!this.#selectedFactionId) return { active: [], finished: [] };
    const all      = ProjectStore.getForFaction(this.#selectedFactionId);
    const decorate = p => ({ ...p, quarterBars: FactionDetailApp.#quarterBars(p.progress) });
    const sort     = arr => arr.sort((a, b) => a.name.localeCompare(b.name)).map(decorate);
    return {
      active:   sort(all.filter(p => p.status === "active")),
      finished: sort(all.filter(p => p.status === "finished"))
    };
  }

  #buildSelectedProjectContext() {
    if (!this.#selectedProjectId) return null;
    const project = ProjectStore.getAll()[this.#selectedProjectId];
    if (!project) return null;

    const notes = [...project.notes].reverse().map(n => ({
      ...n,
      formattedDate:  new Date(n.timestamp).toLocaleString(),
      formattedDelta: n.progressDelta > 0 ? `+${n.progressDelta}%` : `${n.progressDelta}%`,
      deltaClass:     n.progressDelta > 0 ? "positive" : n.progressDelta < 0 ? "negative" : "neutral"
    }));

    return { ...project, notes };
  }

  static #promptName(title, label) {
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

  // ─── Action Handlers ─────────────────────────────────────────────────────────

  static #onOpenJournal(_event, _target) {
    const journal = FactionStore.getFactionJournal();
    if (!journal) return;
    journal.sheet.render({ force: true });
  }

  static #onSwitchTab(_event, target) {
    const tabId = target.dataset.tab;
    if (!tabId || tabId === this.#activeTab) return;
    this.#activeTab = tabId;
    this.render();
  }

  static async #onCreateProject(_event, _target) {
    if (!this.#selectedFactionId) return;
    const name = await FactionDetailApp.#promptName("New Project", "Enter project name:");
    if (!name) return;
    const project = await ProjectStore.create(this.#selectedFactionId, name);
    this.#selectedProjectId = project.id;
    this.render();
  }

  static #onSelectProject(_event, target) {
    const id = target.closest("[data-project-id]")?.dataset.projectId;
    if (!id || id === this.#selectedProjectId) return;
    this.#selectedProjectId = id;
    this.#editingOverview   = false;
    this.#editingNoteId     = null;
    this.render({ parts: ["content"] });
  }

  static #onEditOverview(_event, _target) {
    if (!this.#selectedProjectId) return;
    this.#editingOverview = true;
    this.render({ parts: ["content"] });
  }

  static async #onSaveOverview(_event, _target) {
    if (!this.#selectedProjectId) return;
    const textarea    = this.element.querySelector(".project-overview-textarea");
    const description = textarea?.value ?? "";
    await ProjectStore.update(this.#selectedProjectId, { description });
    this.#editingOverview = false;
    this.render({ parts: ["content"] });
  }

  static #onCancelOverview(_event, _target) {
    this.#editingOverview = false;
    this.render({ parts: ["content"] });
  }

  static async #onSaveInlineNote(_event, _target) {
    if (!this.#selectedProjectId) return;

    const textarea    = this.element.querySelector(".note-draft-textarea");
    const customInput = this.element.querySelector('input[name="note_custom"]');
    const presetEl    = this.element.querySelector('input[name="note_preset"]:checked');

    const text = textarea?.value.trim();
    if (!text) return;

    const delta = customInput?.value !== ""
      ? Number(customInput.value) || 0
      : presetEl ? Number(presetEl.value) : 0;

    if (this.#editingNoteId) {
      await ProjectStore.editNote(this.#selectedProjectId, this.#editingNoteId, text, delta);
      this.#editingNoteId = null;
    } else {
      await ProjectStore.addNote(this.#selectedProjectId, text, delta);
    }

    this.render({ parts: ["content"] });
  }

  static async #onFinishProject(_event, _target) {
    if (!this.#selectedProjectId) return;
    await ProjectStore.update(this.#selectedProjectId, { status: "finished" });
    this.render({ parts: ["content"] });
  }

  static async #onReactivateProject(_event, _target) {
    if (!this.#selectedProjectId) return;
    await ProjectStore.update(this.#selectedProjectId, { status: "active" });
    this.render({ parts: ["content"] });
  }

  static async #onDeleteProject(_event, _target) {
    if (!this.#selectedProjectId) return;
    const project = ProjectStore.getAll()[this.#selectedProjectId];
    if (!project) return;

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Delete Project" },
      content: `<p>Delete <strong>${project.name}</strong> and all its notes? This cannot be undone.</p>`
    });
    if (!confirmed) return;

    await ProjectStore.delete(this.#selectedProjectId);
    this.#selectedProjectId = null;
    this.render({ parts: ["content"] });
  }

  static #onEditNote(_event, target) {
    if (!this.#selectedProjectId) return;
    const noteId = target.closest("[data-note-id]")?.dataset.noteId;
    if (!noteId) return;
    this.#editingNoteId = noteId;
    this.render({ parts: ["content"] });
  }

  static #onCancelNoteEdit(_event, _target) {
    this.#editingNoteId = null;
    this.render({ parts: ["content"] });
  }

  static async #onDeleteNote(_event, target) {
    if (!this.#selectedProjectId) return;
    const noteId = target.closest("[data-note-id]")?.dataset.noteId;
    if (!noteId) return;

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Delete Note" },
      content: "<p>Delete this note? Progress will be recalculated.</p>"
    });
    if (!confirmed) return;

    await ProjectStore.deleteNote(this.#selectedProjectId, noteId);
    this.render({ parts: ["content"] });
  }

  /**
   * Offer the GM a choice when breaking the parent-faction link:
   *   • Break completely  — removes parentId, no replacement edge
   *   • Keep as connection — removes parentId, adds a two-way faction edge
   */
  static async #onBreakParentLink(_event, target) {
    const factionId = this.#selectedFactionId;
    if (!factionId) return;

    const allFactions  = FactionStore.getAll();
    const faction      = allFactions[factionId];
    if (!faction?.parentId) return;

    const parentId     = faction.parentId;
    const parentName   = allFactions[parentId]?.name ?? "parent faction";

    const choice = await foundry.applications.api.DialogV2.wait({
      window: { title: "Break Parent Link" },
      content: `<p>Remove <strong>${faction.name}</strong>'s sub-faction relationship with <strong>${parentName}</strong>?</p>`,
      buttons: [
        {
          label: "Break Completely",
          action: "break",
          icon: "fa-solid fa-link-slash"
        },
        {
          label: "Keep as Connection",
          action: "keep",
          icon: "fa-solid fa-link",
          default: true
        },
        {
          label: "Cancel",
          action: "cancel"
        }
      ],
      rejectClose: false
    }).catch(() => "cancel");

    if (!choice || choice === "cancel") return;

    await FactionStore.update(factionId, { parentId: null });

    if (choice === "keep") {
      await RelationshipStore.createEdge(parentId, "faction", "two-way", {
        toFactionId: factionId
      });
    }

    this.render({ force: true });
  }
}
