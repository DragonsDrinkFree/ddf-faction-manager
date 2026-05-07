import { FactionStore } from "../data/FactionStore.js";
import { ProjectStore } from "../data/ProjectStore.js";
import { RelationshipStore } from "../data/RelationshipStore.js";
import { promptObjective, logEvent } from "../utils/AppHelpers.js";
import {
  showConnFactionSearch,
  showConnDocumentSearch,
  closeConnPanel
} from "../utils/RelationshipPanels.js";
import { bindPanelDismiss, positionPanelBesideApp } from "../utils/ConnectionPanelHelpers.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Shared base class for FactionDetailApp and PartyDetailApp.
 *
 * Holds the state and behavior these two sheets have in common: the selected
 * faction/project, the active tab, the inline overview/note edit toggles, and
 * the action handlers driving the Objectives tab and connection list.
 *
 * Subclasses must declare:
 *   static idPrefix      — used for window ID, e.g. "ddf-faction-detail"
 *   static fallbackTitle — shown when the faction record is missing
 *   static get instances() — returns a Map<factionId, instance>
 *
 * Conventions:
 *   _selectedFactionId, _selectedProjectId, _activeTab, _editingOverview,
 *   _editingNoteId, _logEvent are "protected" — base class and subclasses
 *   read/write them freely. JS private (#) fields are not inherited, hence the
 *   underscore convention for shared state.
 */
export class BaseDetailApp extends HandlebarsApplicationMixin(ApplicationV2) {
  // ── Shared state (protected, accessible to subclasses) ──────────────────────
  _selectedFactionId = null;
  _selectedProjectId = null;
  _activeTab         = "overview";
  _editingOverview   = false;
  _editingNoteId     = null;

  /** @param {string} factionId */
  constructor(factionId) {
    super({ id: `${new.target.idPrefix}-${factionId}` });
    this._selectedFactionId = factionId;
  }

  // ── Subclass contract (must be overridden) ──────────────────────────────────
  static idPrefix     = "ddf-detail";
  static fallbackTitle = "Faction";
  /** Subclasses override with `static get instances() { return SubclassApp.#instances; }` */
  static get instances() {
    throw new Error(`${this.name} must define a static 'instances' Map`);
  }

  get title() {
    return FactionStore.getAll()[this._selectedFactionId]?.name ?? this.constructor.fallbackTitle;
  }

  /**
   * Open a detail window for the given faction. Reuses an already-open window
   * for the same faction id. Subclasses can override with extra preflight
   * (e.g. PartyDetailApp syncs sandbox members) and then call super.show().
   */
  static show(factionId) {
    if (!game.user.isGM) return;
    const existing = this.instances.get(factionId);
    if (existing?.element?.isConnected) {
      existing.render({ force: true });
      return;
    }
    const app = new this(factionId);
    this.instances.set(factionId, app);
    app.render({ force: true });
  }

  /** Append a faction event log entry and (when enabled) post a session note. */
  async _logEvent(category, text, settingKey = null) {
    await logEvent(this._selectedFactionId, category, text, settingKey);
  }

  // ── Shared action handlers ──────────────────────────────────────────────────
  // Foundry binds `this` to the application instance. Each handler is exposed
  // via `BaseDetailApp.SHARED_ACTIONS` so subclasses can spread it into their
  // own `static DEFAULT_OPTIONS.actions`.

  static #onSwitchTab(_event, target) {
    const tabId = target.dataset.tab;
    if (!tabId || tabId === this._activeTab) return;
    this._activeTab = tabId;
    this.render();
  }

  static async #onCreateProject(_event, _target) {
    if (!this._selectedFactionId) return;
    const result = await promptObjective("New Objective");
    if (!result) return;
    const project = await ProjectStore.create(this._selectedFactionId, result.name, result.sections);
    this._selectedProjectId = project.id;
    await this._logEvent("objective", `Objective created: ${project.name}`, "scmObjectiveCreated");
    this.render();
  }

  static async #onEditObjective(_event, _target) {
    if (!this._selectedProjectId) return;
    const project = ProjectStore.getAll()[this._selectedProjectId];
    if (!project) return;
    const result = await promptObjective("Edit Objective", project);
    if (!result) return;
    const newFilled = Math.min(project.filled ?? 0, result.sections);
    await ProjectStore.update(this._selectedProjectId, { name: result.name, sections: result.sections, filled: newFilled });
    this.render({ parts: ["content"] });
  }

  static #onSelectProject(_event, target) {
    const id = target.closest("[data-project-id]")?.dataset.projectId;
    if (!id || id === this._selectedProjectId) return;
    this._selectedProjectId = id;
    this._editingOverview   = false;
    this._editingNoteId     = null;
    this.render({ parts: ["content"] });
  }

  static #onEditOverview(_event, _target) {
    if (!this._selectedProjectId) return;
    this._editingOverview = true;
    this.render({ parts: ["content"] });
  }

  static async #onSaveOverview(_event, _target) {
    if (!this._selectedProjectId) return;
    const textarea    = this.element.querySelector(".project-overview-textarea");
    const description = textarea?.value ?? "";
    await ProjectStore.update(this._selectedProjectId, { description });
    this._editingOverview = false;
    this.render({ parts: ["content"] });
  }

  static #onCancelOverview(_event, _target) {
    this._editingOverview = false;
    this.render({ parts: ["content"] });
  }

  static async #onSaveInlineNote(_event, _target) {
    if (!this._selectedProjectId) return;

    const textarea    = this.element.querySelector(".note-draft-textarea");
    const customInput = this.element.querySelector('input[name="note_custom"]');
    const presetEl    = this.element.querySelector('input[name="note_preset"]:checked');

    const text = textarea?.value.trim();
    if (!text) return;

    const delta = customInput?.value !== ""
      ? Number(customInput.value) || 0
      : presetEl ? Number(presetEl.value) : 0;

    if (this._editingNoteId) {
      await ProjectStore.editNote(this._selectedProjectId, this._editingNoteId, text, delta);
      this._editingNoteId = null;
    } else {
      await ProjectStore.addNote(this._selectedProjectId, text, delta);
      const projectName = ProjectStore.getAll()[this._selectedProjectId]?.name ?? "Objective";
      const progressStr = delta ? ` (${delta > 0 ? "+" : ""}${delta}%)` : "";
      await this._logEvent("objective", `Progress note on "${projectName}"${progressStr}: ${text}`, "scmProgressNote");
    }

    this.render({ parts: ["content"] });
  }

  static async #onFinishProject(_event, _target) {
    if (!this._selectedProjectId) return;
    const projectName = ProjectStore.getAll()[this._selectedProjectId]?.name ?? "Objective";
    await ProjectStore.update(this._selectedProjectId, { status: "finished" });
    await this._logEvent("objective", `Objective completed: ${projectName}`, "scmObjectiveFinished");
    this.render({ parts: ["content"] });
  }

  static async #onReactivateProject(_event, _target) {
    if (!this._selectedProjectId) return;
    const projectName = ProjectStore.getAll()[this._selectedProjectId]?.name ?? "Objective";
    await ProjectStore.update(this._selectedProjectId, { status: "active" });
    await this._logEvent("objective", `Objective reactivated: ${projectName}`, "scmObjectiveFinished");
    this.render({ parts: ["content"] });
  }

  static async #onDeleteProject(_event, _target) {
    if (!this._selectedProjectId) return;
    const project = ProjectStore.getAll()[this._selectedProjectId];
    if (!project) return;

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Delete Objective" },
      content: `<p>Delete <strong>${project.name}</strong> and all its notes? This cannot be undone.</p>`
    });
    if (!confirmed) return;

    await ProjectStore.delete(this._selectedProjectId);
    this._selectedProjectId = null;
    this.render({ parts: ["content"] });
  }

  static #onEditNote(_event, target) {
    if (!this._selectedProjectId) return;
    const noteId = target.closest("[data-note-id]")?.dataset.noteId;
    if (!noteId) return;
    this._editingNoteId = noteId;
    this.render({ parts: ["content"] });
  }

  static #onCancelNoteEdit(_event, _target) {
    this._editingNoteId = null;
    this.render({ parts: ["content"] });
  }

  static async #onDeleteNote(_event, target) {
    if (!this._selectedProjectId) return;
    const noteId = target.closest("[data-note-id]")?.dataset.noteId;
    if (!noteId) return;

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Delete Note" },
      content: "<p>Delete this note? Progress will be recalculated.</p>"
    });
    if (!confirmed) return;

    await ProjectStore.deleteNote(this._selectedProjectId, noteId);
    this.render({ parts: ["content"] });
  }

  /** Open the connected target in the same kind of detail app the user is currently on. */
  static async #onOpenConnection(_event, target) {
    const factionId = target.dataset.targetFactionId;
    const uuid      = target.dataset.documentUuid;
    if (factionId) {
      this.constructor.show(factionId);
    } else if (uuid) {
      const doc = await fromUuid(uuid);
      doc?.sheet?.render({ force: true });
    }
  }

  static async #onDeleteConnection(_event, target) {
    const edgeId = target.closest("[data-edge-id]")?.dataset.edgeId;
    if (!edgeId) return;

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Remove Connection" },
      content: "<p>Remove this connection? This cannot be undone.</p>"
    });
    if (!confirmed) return;

    await RelationshipStore.deleteEdge(edgeId);
    this.render({ parts: ["content"] });
  }

  static #onAddConnection(_event, target) {
    closeConnPanel();
    if (!this._selectedFactionId) return;

    const fromFactionId = this._selectedFactionId;
    const onComplete    = () => this.render({ parts: ["content"] });

    const panel = document.createElement("div");
    panel.className = "mm-search-panel ddf-conn-panel";
    positionPanelBesideApp(panel, this.element, target, 260);

    panel.innerHTML = `
      <div class="mm-panel-title">Add Connection</div>
      <div class="mm-panel-options">
        <button class="mm-option" data-mode="faction">
          <i class="fa-solid fa-shield-halved"></i> Faction
        </button>
        <button class="mm-option" data-mode="document">
          <i class="fa-solid fa-file"></i> Document
        </button>
      </div>
    `;

    panel.querySelector('[data-mode="faction"]').addEventListener("click",  () => showConnFactionSearch(panel, fromFactionId, onComplete));
    panel.querySelector('[data-mode="document"]').addEventListener("click", () => showConnDocumentSearch(panel, fromFactionId, onComplete));

    document.body.appendChild(panel);
    bindPanelDismiss(panel);
  }

  /**
   * Action map exposed for subclasses. Spread into a subclass's
   * `DEFAULT_OPTIONS.actions` to wire all the shared handlers in one go.
   */
  static SHARED_ACTIONS = {
    switchTab:         BaseDetailApp.#onSwitchTab,
    createProject:     BaseDetailApp.#onCreateProject,
    selectProject:     BaseDetailApp.#onSelectProject,
    editOverview:      BaseDetailApp.#onEditOverview,
    saveOverview:      BaseDetailApp.#onSaveOverview,
    cancelOverview:    BaseDetailApp.#onCancelOverview,
    saveInlineNote:    BaseDetailApp.#onSaveInlineNote,
    cancelNoteEdit:    BaseDetailApp.#onCancelNoteEdit,
    finishProject:     BaseDetailApp.#onFinishProject,
    reactivateProject: BaseDetailApp.#onReactivateProject,
    deleteProject:     BaseDetailApp.#onDeleteProject,
    editNote:          BaseDetailApp.#onEditNote,
    deleteNote:        BaseDetailApp.#onDeleteNote,
    editObjective:     BaseDetailApp.#onEditObjective,
    deleteConnection:  BaseDetailApp.#onDeleteConnection,
    addConnection:     BaseDetailApp.#onAddConnection,
    openConnection:    BaseDetailApp.#onOpenConnection
  };
}
