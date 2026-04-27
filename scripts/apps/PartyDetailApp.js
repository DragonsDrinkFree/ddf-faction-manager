import { FactionStore } from "../data/FactionStore.js";
import { ProjectStore } from "../data/ProjectStore.js";
import { RelationshipStore } from "../data/RelationshipStore.js";
import { EventLogStore } from "../data/EventLogStore.js";
import { tryAddSessionNote, syncSandboxPartyMembers } from "../utils/SandboxIntegration.js";
import {
  getConnectionTypes,
  connectionTypePickerHTML,
  connectionDirectionPickerHTML,
  readSelectedDirection,
  readSelectedType,
  bindPanelDismiss,
  positionPanelBesideApp
} from "../utils/ConnectionPanelHelpers.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class PartyDetailApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @type {Map<string, PartyDetailApp>} factionId → open instance */
  static #instances = new Map();

  #selectedFactionId  = null;
  #selectedProjectId  = null;
  /** ID of the currently selected party-member or retainer entry. */
  #selectedPersonId   = null;
  /** "member" | "retainer" — discriminates which array to read from. */
  #selectedPersonKind = null;
  #activeTab = "overview";
  #editingOverview = false;
  #editingNoteId = null;

  /**
   * @param {string} factionId
   */
  constructor(factionId) {
    super({ id: `ddf-party-detail-${factionId}` });
    this.#selectedFactionId = factionId;
  }

  static DEFAULT_OPTIONS = {
    id: "ddf-party-detail",
    classes: ["ddf-faction-detail", "ddf-party-detail"],
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
      switchTab:         PartyDetailApp.#onSwitchTab,
      createProject:     PartyDetailApp.#onCreateProject,
      selectProject:     PartyDetailApp.#onSelectProject,
      editOverview:      PartyDetailApp.#onEditOverview,
      saveOverview:      PartyDetailApp.#onSaveOverview,
      cancelOverview:    PartyDetailApp.#onCancelOverview,
      saveInlineNote:    PartyDetailApp.#onSaveInlineNote,
      cancelNoteEdit:    PartyDetailApp.#onCancelNoteEdit,
      finishProject:     PartyDetailApp.#onFinishProject,
      reactivateProject: PartyDetailApp.#onReactivateProject,
      deleteProject:     PartyDetailApp.#onDeleteProject,
      editNote:          PartyDetailApp.#onEditNote,
      deleteNote:        PartyDetailApp.#onDeleteNote,
      deleteConnection:  PartyDetailApp.#onDeleteConnection,
      addConnection:     PartyDetailApp.#onAddConnection,
      openConnection:    PartyDetailApp.#onOpenConnection,
      addMember:         PartyDetailApp.#onAddMember,
      addRetainer:       PartyDetailApp.#onAddRetainer,
      selectPerson:      PartyDetailApp.#onSelectPerson,
      deletePerson:      PartyDetailApp.#onDeletePerson,
      openPersonActor:   PartyDetailApp.#onOpenPersonActor,
      unlinkPersonActor: PartyDetailApp.#onUnlinkPersonActor,
      linkPersonActor:   PartyDetailApp.#onLinkPersonActor,
      setLoyalty:        PartyDetailApp.#onSetLoyalty,
      saveMemberNote:    PartyDetailApp.#onSaveMemberNote,
      deleteMemberNote:  PartyDetailApp.#onDeleteMemberNote,
      editObjective:     PartyDetailApp.#onEditObjective,
      addTag:            PartyDetailApp.#onAddTag,
      deleteTag:         PartyDetailApp.#onDeleteTag
    }
  };

  static PARTS = {
    content: {
      template: "modules/ddf-faction-manager/templates/party-detail.hbs",
      scrollable: [
        ".faction-journal-body",
        ".faction-connections-body",
        ".project-notes-log",
        ".project-items",
        ".event-log-list"
      ]
    }
  };

  get title() {
    return FactionStore.getAll()[this.#selectedFactionId]?.name ?? "Party";
  }

  /**
   * Open a detail window for the given faction.
   * If a window for that faction is already open, bring it to front.
   * @param {string} factionId
   */
  static async show(factionId) {
    if (!game.user.isGM) return;

    // Reconcile sandbox-managed members before rendering, so the open sheet
    // reflects the current Sandbox party roster (no-op if SCM is absent or the
    // party has no sandboxPartyId).
    await syncSandboxPartyMembers(factionId);

    // Reuse an already-open window for this faction
    const existing = PartyDetailApp.#instances.get(factionId);
    if (existing?.element?.isConnected) {
      existing.render({ force: true });
      return;
    }

    const app = new PartyDetailApp(factionId);
    PartyDetailApp.#instances.set(factionId, app);
    app.render({ force: true });
  }

  // ─── Context ─────────────────────────────────────────────────────────────────

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.activeTab = this.#activeTab;
    context.tabs = [
      { id: "overview",    label: "Overview",    icon: "fa-solid fa-scroll",            cssClass: this.#activeTab === "overview"    ? "active" : "" },
      { id: "projects",    label: "Objectives",  icon: "fa-solid fa-list-check",        cssClass: this.#activeTab === "projects"    ? "active" : "" },
      { id: "connections", label: "Connections", icon: "fa-solid fa-circle-nodes",      cssClass: this.#activeTab === "connections" ? "active" : "" },
      { id: "eventlog",    label: "Event Log",   icon: "fa-solid fa-clock-rotate-left", cssClass: this.#activeTab === "eventlog"    ? "active" : "" }
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

    // Overview: GM quick note + connections list
    context.partyNote         = context.selectedFaction?.partyNote ?? "";
    context.connectionTypes   = getConnectionTypes();
    context.relationshipItems = this.#selectedFactionId
      ? this.#buildRelationshipItems()
      : [];

    // Objectives tab
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

    // Party members + retainers (Phase 3: two sections)
    const sfRecord    = context.selectedFaction;
    const rawMembers  = sfRecord?.members   ?? [];
    const rawRetainers = sfRecord?.retainers ?? [];

    const decoratePerson = async (p, kind) => {
      const actorName = p.actorUuid ? (await this.#resolveActorName(p.actorUuid)) : null;
      return {
        ...p,
        kind,
        actorName,
        // Linked persons display the actor's live name; unlinked use the stored name
        displayName: actorName ?? p.name,
        isSelected:  kind === this.#selectedPersonKind && p.id === this.#selectedPersonId
      };
    };

    context.partyMembers     = await Promise.all(rawMembers.map(m => decoratePerson(m, "member")));
    context.retainers        = await Promise.all(rawRetainers.map(r => decoratePerson(r, "retainer")));
    context.selectedPersonId   = this.#selectedPersonId;
    context.selectedPersonKind = this.#selectedPersonKind;
    context.selectedPerson     = await this.#buildSelectedPersonContext();

    // Tags (Overview tab)
    const sf = context.selectedFaction;
    context.factionTags = sf?.tags ?? [];
    context.allTags     = FactionStore.getAllTags();

    // Event Log tab
    context.eventLogEntries = this.#selectedFactionId
      ? EventLogStore.getForFaction(this.#selectedFactionId).map(e => ({
          ...e,
          formattedTime: new Date(e.timestamp).toLocaleString()
        }))
      : [];

    return context;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  /** Log an event for the current faction and optionally push to Sandbox. */
  async #logEvent(category, text, settingKey = null) {
    if (!this.#selectedFactionId) return;
    const factionName = FactionStore.getAll()[this.#selectedFactionId]?.name ?? "Faction";
    await EventLogStore.addEntry(this.#selectedFactionId, category, text);
    await tryAddSessionNote(text, factionName, settingKey);
  }

  // ─── Relationship Items (read-only list for Overview pane) ────────────────────

  #buildRelationshipItems() {
    const allFactions = FactionStore.getAll();
    const storedEdges = RelationshipStore.getEdgesForFaction(this.#selectedFactionId);

    const ICON = {
      Actor:        "fa-solid fa-user",
      JournalEntry: "fa-solid fa-book",
      Item:         "fa-solid fa-suitcase",
      Scene:        "fa-solid fa-map"
    };

    // Parties have no parents and no sub-factions — only stored connection edges
    const storedItems = storedEdges
      .map(edge => {
        let name            = "";
        let icon            = "fa-solid fa-circle-nodes";
        let targetFactionId = null;
        let documentUuid    = null;

        if (edge.type === "faction") {
          const targetId  = edge._reversed ? edge.fromFactionId : edge.toFactionId;
          name            = allFactions[targetId]?.name ?? "Unknown Faction";
          icon            = "";
          targetFactionId = targetId;
        } else if (edge.type === "document") {
          name         = edge.documentName ?? "Document";
          icon         = ICON[edge.documentType] ?? "fa-solid fa-file";
          documentUuid = edge.documentUuid ?? null;
        } else {
          name = edge.label ?? "Simple Node";
          icon = "fa-solid fa-circle-nodes";
        }

        const directionSymbol = edge.direction === "two-way" ? "↔"
          : edge._reversed ? "←" : "→";

        return {
          id:               edge.id,
          name,
          icon,
          direction:        edge.direction,
          directionSymbol,
          isReversed:       edge._reversed ?? false,
          isAuto:           false,
          relationLabel:    edge.relationLabel ?? "",
          connectionTypeId: edge.connectionTypeId ?? null,
          targetFactionId,
          documentUuid
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    return storedItems;
  }

  // ─── Render Hook ─────────────────────────────────────────────────────────────

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);

    // ── GM Quick Note: auto-save on blur or Enter (does not re-render) ───────
    const quickNote = this.element.querySelector(".party-quick-note-textarea");
    if (quickNote && this.#selectedFactionId) {
      quickNote.addEventListener("blur", async () => {
        const note = quickNote.value;
        const faction = FactionStore.getAll()[this.#selectedFactionId];
        if (!faction) return;
        if ((faction.partyNote ?? "") === note) return;  // no-op when unchanged
        await FactionStore.update(this.#selectedFactionId, { partyNote: note });
      });
    }

    // Wire connection-type dropdowns in the connections pane (overview tab)
    this.element.querySelectorAll(".rel-type-select").forEach(select => {
      select.addEventListener("change", async (e) => {
        const edgeId = e.target.dataset.edgeId;
        const typeId = e.target.value || null;
        await RelationshipStore.updateEdgeConnectionType(edgeId, typeId);
        const typeName = typeId
          ? (getConnectionTypes().find(t => t.id === typeId)?.name ?? typeId)
          : "none";
        await this.#logEvent("connection", `Connection type changed to: ${typeName}`, "scmConnectionTypeChanged");
        this.render({ parts: ["content"] });
      });
    });

    // Wire direction toggle buttons
    this.element.querySelectorAll(".rel-dir-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const edgeId     = btn.dataset.edgeId;
        const current    = btn.dataset.direction;
        const isReversed = btn.dataset.reversed === "true";
        const next       = current === "two-way" ? "one-way" : "two-way";
        const swapParties = isReversed && next === "one-way";
        await RelationshipStore.updateEdgeDirection(edgeId, next, { swapParties });
        await this.#logEvent("connection", `Connection direction changed to: ${next}`, "scmConnectionDirectionChanged");
        this.render({ parts: ["content"] });
      });
    });

    // ── Inline note editor (objectives tab) ─────────────────────────────────
    const presetRadios = this.element.querySelectorAll('input[name="note_preset"]');
    const customInput  = this.element.querySelector('input[name="note_custom"]');
    const textarea     = this.element.querySelector(".note-draft-textarea");

    if (textarea) {
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

      presetRadios.forEach(radio => {
        radio.addEventListener("change", () => { if (customInput) customInput.value = ""; });
      });
      customInput?.addEventListener("input", () => {
        presetRadios.forEach(r => { r.checked = false; });
      });
      textarea.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          this.element.querySelector("[data-action='saveInlineNote']")?.click();
        }
      });
    }

    // ── Person detail wiring (party member or retainer) ──────────────────────
    if (this.#selectedPersonId && this.#selectedPersonKind) {
      // Display name: auto-save on blur or Enter
      const nameInput = this.element.querySelector(".member-name-input");
      if (nameInput) {
        const saveName = async () => {
          const name = nameInput.value.trim();
          if (!name) return;
          const person = this.#findPerson(this.#selectedPersonKind, this.#selectedPersonId);
          if (!person || person.name === name) return;
          await this.#updatePerson(this.#selectedPersonKind, this.#selectedPersonId, { name });
          this.render({ parts: ["content"] });
        };
        nameInput.addEventListener("blur", saveName);
        nameInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); saveName(); }
        });
      }

      // Wages inputs (retainer-only): auto-save on change/blur
      this.element.querySelectorAll(".retainer-wages-input").forEach(input => {
        input.addEventListener("change", async (e) => {
          if (this.#selectedPersonKind !== "retainer") return;
          const field = e.target.dataset.wageField;
          const value = parseInt(e.target.value, 10) || 0;
          const person = this.#findPerson("retainer", this.#selectedPersonId);
          if (!person) return;
          const wages = { ...(person.wages ?? { treasureShare: 0, weeklyWages: 0 }), [field]: value };
          await this.#updatePerson("retainer", this.#selectedPersonId, { wages });
        });
      });

      // Note textarea: Enter to save, Shift+Enter for newline
      const noteTextarea = this.element.querySelector(".member-note-textarea");
      if (noteTextarea) {
        noteTextarea.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            this.element.querySelector("[data-action='saveMemberNote']")?.click();
          }
        });
      }
    }

  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  /** Convert filled/sections into 4 quarter-bar descriptors for list display. */
  static #quarterBars(filled, sections) {
    const pct = sections > 0 ? (filled / sections) * 100 : 0;
    return [0, 1, 2, 3].map(i => {
      const low  = i * 25;
      const high = low + 25;
      if (pct >= high) return { filled: true,  partial: 100 };
      if (pct <= low)  return { filled: false, partial: 0 };
      return { filled: false, partial: Math.round((pct - low) / 25 * 100) };
    });
  }

  #buildProjectContext() {
    if (!this.#selectedFactionId) return { active: [], finished: [] };
    const all = ProjectStore.getForFaction(this.#selectedFactionId);
    const decorate = p => {
      // Legacy support: projects with old progress (0-100) field treated as 4-pip tracks
      const sections = p.sections ?? 4;
      const filled   = p.filled   ?? Math.round((p.progress ?? 0) / 25);
      return { ...p, sections, filled, quarterBars: PartyDetailApp.#quarterBars(filled, sections) };
    };
    const sort = arr => arr.sort((a, b) => a.name.localeCompare(b.name)).map(decorate);
    return {
      active:   sort(all.filter(p => p.status === "active")),
      finished: sort(all.filter(p => p.status === "finished"))
    };
  }

  #buildSelectedProjectContext() {
    if (!this.#selectedProjectId) return null;
    const project = ProjectStore.getAll()[this.#selectedProjectId];
    if (!project) return null;

    const sections = project.sections ?? 4;
    const filled   = project.filled   ?? Math.round((project.progress ?? 0) / 25);

    const notes = [...project.notes].reverse().map(n => ({
      ...n,
      formattedDate:  new Date(n.timestamp).toLocaleString(),
      formattedDelta: n.progressDelta !== 0
        ? `${n.progressDelta > 0 ? "+" : ""}${n.progressDelta}`
        : "—",
      deltaClass: n.progressDelta > 0 ? "positive" : n.progressDelta < 0 ? "negative" : "neutral"
    }));

    return { ...project, sections, filled, notes };
  }

  // ─── Party Member / Retainer Helpers ─────────────────────────────────────────

  /** Resolve an actor UUID to a display name; null if missing or stale. */
  async #resolveActorName(uuid) {
    try {
      const actor = await fromUuid(uuid);
      return actor?.name ?? null;
    } catch { return null; }
  }

  /** Returns the array name on the party record for a given kind. */
  #arrayKey(kind) { return kind === "retainer" ? "retainers" : "members"; }

  /** Returns a clone of the party's member or retainer array. */
  #getPersonList(kind) {
    const sf = FactionStore.getAll()[this.#selectedFactionId];
    return [...(sf?.[this.#arrayKey(kind)] ?? [])];
  }

  /** Lookup a single person by id within the given list. */
  #findPerson(kind, id) {
    return this.#getPersonList(kind).find(p => p.id === id) ?? null;
  }

  /** Persist a partial update to a single person; reads-modify-writes the array. */
  async #updatePerson(kind, id, updates) {
    const list = this.#getPersonList(kind);
    const idx  = list.findIndex(p => p.id === id);
    if (idx === -1) return null;
    list[idx] = { ...list[idx], ...updates };
    await FactionStore.update(this.#selectedFactionId, { [this.#arrayKey(kind)]: list });
    return list[idx];
  }

  /** Append a new person to the appropriate array. */
  async #appendPerson(kind, person) {
    const list = this.#getPersonList(kind);
    list.push(person);
    await FactionStore.update(this.#selectedFactionId, { [this.#arrayKey(kind)]: list });
    return person;
  }

  /** Remove a person by id. */
  async #removePerson(kind, id) {
    const list = this.#getPersonList(kind).filter(p => p.id !== id);
    await FactionStore.update(this.#selectedFactionId, { [this.#arrayKey(kind)]: list });
  }

  /** Build the selected-person view, decorated with derived display fields. */
  async #buildSelectedPersonContext() {
    if (!this.#selectedPersonId || !this.#selectedPersonKind) return null;
    const person = this.#findPerson(this.#selectedPersonKind, this.#selectedPersonId);
    if (!person) return null;

    const actorName = person.actorUuid ? await this.#resolveActorName(person.actorUuid) : null;
    const isRetainer = this.#selectedPersonKind === "retainer";

    // 12 loyalty boxes (1..12), filled up to current value
    const loyaltyBoxes = isRetainer
      ? Array.from({ length: 12 }, (_, i) => ({
          value:  i + 1,
          filled: (i + 1) <= (person.loyalty ?? 0)
        }))
      : null;

    // Notes sorted newest-first for display
    const notes = (person.notes ?? [])
      .map(n => ({ ...n, formattedTime: new Date(n.timestamp).toLocaleString() }))
      .sort((a, b) => b.timestamp - a.timestamp);

    return {
      ...person,
      kind: this.#selectedPersonKind,
      isRetainer,
      actorName,
      displayName: actorName ?? person.name,
      loyaltyBoxes,
      wages: person.wages ?? { treasureShare: 0, weeklyWages: 0 },
      notes
    };
  }

  static #promptName(title, label) {
    return new Promise(resolve => {
      foundry.applications.api.DialogV2.prompt({
        window: { title },
        content: `<div class="standard-form"><div class="form-group"><label>${label}</label><div class="form-fields"><input type="text" name="name" autofocus placeholder="${label}…" /></div></div></div>`,
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

  static #promptObjective(title, existing = null) {
    return new Promise(resolve => {
      const defaultSections = existing?.sections ?? 8;
      foundry.applications.api.DialogV2.prompt({
        window: { title },
        content: `
          <div class="standard-form">
            <div class="form-group">
              <label>Name</label>
              <div class="form-fields">
                <input type="text" name="obj_name" autofocus
                       value="${foundry.utils.escapeHTML(existing?.name ?? "")}"
                       placeholder="Objective name…" />
              </div>
            </div>
            <div class="form-group">
              <label>Required Progress</label>
              <div class="form-fields">
                <input type="number" name="obj_sections"
                       value="${defaultSections}" min="1" max="99" style="width:80px;" />
              </div>
            </div>
          </div>`,
        ok: {
          label: existing ? "Save" : "Create",
          callback: (_event, button) => {
            const name     = button.form.elements.obj_name.value.trim();
            const sections = parseInt(button.form.elements.obj_sections.value) || 8;
            resolve(name ? { name, sections } : null);
          }
        },
        rejectClose: false
      }).catch(() => resolve(null));
    });
  }

  // ─── Action Handlers ─────────────────────────────────────────────────────────

  static #onSwitchTab(_event, target) {
    const tabId = target.dataset.tab;
    if (!tabId || tabId === this.#activeTab) return;
    this.#activeTab = tabId;
    this.render();
  }

  static async #onCreateProject(_event, _target) {
    if (!this.#selectedFactionId) return;
    const result = await PartyDetailApp.#promptObjective("New Objective");
    if (!result) return;
    const project = await ProjectStore.create(this.#selectedFactionId, result.name, result.sections);
    this.#selectedProjectId = project.id;
    await this.#logEvent("objective", `Objective created: ${project.name}`, "scmObjectiveCreated");
    this.render();
  }

  static async #onEditObjective(_event, _target) {
    if (!this.#selectedProjectId) return;
    const project = ProjectStore.getAll()[this.#selectedProjectId];
    if (!project) return;
    const result = await PartyDetailApp.#promptObjective("Edit Objective", project);
    if (!result) return;
    const newFilled = Math.min(project.filled ?? 0, result.sections);
    await ProjectStore.update(this.#selectedProjectId, { name: result.name, sections: result.sections, filled: newFilled });
    this.render({ parts: ["content"] });
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
      const projectName = ProjectStore.getAll()[this.#selectedProjectId]?.name ?? "Objective";
      const progressStr = delta ? ` (${delta > 0 ? "+" : ""}${delta}%)` : "";
      await this.#logEvent("objective", `Progress note on "${projectName}"${progressStr}: ${text}`, "scmProgressNote");
    }

    this.render({ parts: ["content"] });
  }

  static async #onFinishProject(_event, _target) {
    if (!this.#selectedProjectId) return;
    const projectName = ProjectStore.getAll()[this.#selectedProjectId]?.name ?? "Objective";
    await ProjectStore.update(this.#selectedProjectId, { status: "finished" });
    await this.#logEvent("objective", `Objective completed: ${projectName}`, "scmObjectiveFinished");
    this.render({ parts: ["content"] });
  }

  static async #onReactivateProject(_event, _target) {
    if (!this.#selectedProjectId) return;
    const projectName = ProjectStore.getAll()[this.#selectedProjectId]?.name ?? "Objective";
    await ProjectStore.update(this.#selectedProjectId, { status: "active" });
    await this.#logEvent("objective", `Objective reactivated: ${projectName}`, "scmObjectiveFinished");
    this.render({ parts: ["content"] });
  }

  static async #onDeleteProject(_event, _target) {
    if (!this.#selectedProjectId) return;
    const project = ProjectStore.getAll()[this.#selectedProjectId];
    if (!project) return;

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Delete Objective" },
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

  static async #onOpenConnection(_event, target) {
    const factionId = target.dataset.targetFactionId;
    const uuid      = target.dataset.documentUuid;
    if (factionId) {
      PartyDetailApp.show(factionId);
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

  // ─── Add Connection Panel ─────────────────────────────────────────────────────

  static #onAddConnection(_event, target) {
    this.#closeConnPanel();
    if (!this.#selectedFactionId) return;

    const fromFactionId = this.#selectedFactionId;

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

    panel.querySelector('[data-mode="faction"]').addEventListener("click",   () => this.#showConnFactionSearch(panel, fromFactionId));
    panel.querySelector('[data-mode="document"]').addEventListener("click",  () => this.#showConnDocumentSearch(panel, fromFactionId));

    // Attach to body so it can appear outside the faction window bounds
    document.body.appendChild(panel);
    bindPanelDismiss(panel);
  }

  #showConnFactionSearch(panel, fromFactionId) {
    const allFactions  = FactionStore.getAll();
    const liveEdges    = RelationshipStore.getEdgesForFaction(fromFactionId);
    const connectedIds = new Set(
      liveEdges.filter(e => e.type === "faction")
               .map(e => e._reversed ? e.fromFactionId : e.toFactionId)
    );
    connectedIds.add(fromFactionId);
    // Also exclude factions already linked via parent/child hierarchy
    const faction = allFactions[fromFactionId];
    if (faction?.parentId) connectedIds.add(faction.parentId);
    Object.values(allFactions).filter(f => f.parentId === fromFactionId).forEach(f => connectedIds.add(f.id));

    const candidates = Object.values(allFactions).filter(f => !connectedIds.has(f.id));

    panel.innerHTML = `
      <div class="mm-panel-title">Link Faction</div>
      <input type="text" class="mm-search-input" placeholder="Filter factions…" autofocus />
      <div class="mm-search-results ddf-conn-faction-list">
        ${candidates.length
          ? candidates.map(f => `
              <div class="mm-search-result" data-id="${f.id}">
                <i class="fa-solid fa-link ddf-link-icon"></i>
                <span>${foundry.utils.escapeHTML(f.name)}</span>
              </div>`).join("")
          : "<div class='mm-search-empty'>No factions available</div>"
        }
      </div>
      ${connectionTypePickerHTML()}
      ${connectionDirectionPickerHTML()}
      <div class="mm-panel-actions"><button class="mm-btn-cancel">Cancel</button></div>
    `;

    const input   = panel.querySelector(".mm-search-input");
    const results = panel.querySelector(".mm-search-results");

    input.addEventListener("input", () => {
      const q = input.value.toLowerCase();
      results.querySelectorAll(".mm-search-result").forEach(el => {
        el.style.display = el.textContent.toLowerCase().includes(q) ? "" : "none";
      });
    });

    results.addEventListener("click", async (e) => {
      const el = e.target.closest(".mm-search-result");
      if (!el) return;
      const toFactionId      = el.dataset.id;
      const direction        = readSelectedDirection(panel);
      const connectionTypeId = readSelectedType(panel);
      const opts             = { toFactionId };
      if (connectionTypeId) opts.connectionTypeId = connectionTypeId;
      await RelationshipStore.createEdge(fromFactionId, "faction", direction, opts);
      const fromName   = FactionStore.getAll()[fromFactionId]?.name ?? "Faction";
      const toName     = FactionStore.getAll()[toFactionId]?.name   ?? "Faction";
      const typeName   = connectionTypeId
        ? (getConnectionTypes().find(t => t.id === connectionTypeId)?.name ?? "")
        : "";
      const dirArrow   = direction === "two-way" ? "↔" : "→";
      await this.#logEvent("connection",
        `Connection established: ${fromName} ${dirArrow} ${toName}${typeName ? ` (${typeName})` : ""}`,
        "scmConnectionEstablished");
      this.#closeConnPanel();
      this.render({ parts: ["content"] });
    });

    panel.querySelector(".mm-btn-cancel").addEventListener("click", () => this.#closeConnPanel());
    input.focus();
  }

  #showConnDocumentSearch(panel, fromFactionId) {
    const collections = [
      { type: "Actor",        icon: "fa-user",     col: game.actors  },
      { type: "JournalEntry", icon: "fa-book",     col: game.journal },
      { type: "Item",         icon: "fa-suitcase", col: game.items   },
      { type: "Scene",        icon: "fa-map",      col: game.scenes  }
    ];

    const docs = [];
    for (const { type, icon, col } of collections) {
      for (const doc of col) docs.push({ uuid: doc.uuid, name: doc.name, type, icon });
    }

    panel.innerHTML = `
      <div class="mm-panel-title">Link Document</div>
      <input type="text" class="mm-search-input" placeholder="Filter documents…" autofocus />
      <div class="mm-search-results">
        ${docs.length
          ? docs.map(d => `
            <div class="mm-search-result" data-uuid="${d.uuid}" data-type="${d.type}" data-name="${foundry.utils.escapeHTML(d.name)}">
              <i class="fa-solid ${d.icon}"></i> ${foundry.utils.escapeHTML(d.name)}
              <span class="mm-result-type">${d.type}</span>
            </div>`).join("")
          : "<div class='mm-search-empty'>No documents found</div>"
        }
      </div>
      ${connectionTypePickerHTML()}
      ${connectionDirectionPickerHTML()}
      <div class="mm-panel-actions"><button class="mm-btn-cancel">Cancel</button></div>
    `;

    const input   = panel.querySelector(".mm-search-input");
    const results = panel.querySelector(".mm-search-results");

    input.addEventListener("input", () => {
      const q = input.value.toLowerCase();
      results.querySelectorAll(".mm-search-result").forEach(el => {
        el.style.display = el.dataset.name.toLowerCase().includes(q) ? "" : "none";
      });
    });

    results.addEventListener("click", async (e) => {
      const el = e.target.closest(".mm-search-result");
      if (!el) return;
      const direction        = readSelectedDirection(panel);
      const connectionTypeId = readSelectedType(panel);
      const opts = { documentUuid: el.dataset.uuid, documentType: el.dataset.type, documentName: el.dataset.name };
      if (connectionTypeId) opts.connectionTypeId = connectionTypeId;
      await RelationshipStore.createEdge(fromFactionId, "document", direction, opts);
      const typeName = connectionTypeId
        ? (getConnectionTypes().find(t => t.id === connectionTypeId)?.name ?? "")
        : "";
      const dirArrow = direction === "two-way" ? "↔" : "→";
      await this.#logEvent("connection",
        `Document linked: ${el.dataset.name} ${dirArrow}${typeName ? ` (${typeName})` : ""}`,
        "scmConnectionEstablished");
      this.#closeConnPanel();
      this.render({ parts: ["content"] });
    });

    panel.querySelector(".mm-btn-cancel").addEventListener("click", () => this.#closeConnPanel());
    input.focus();
  }

  #closeConnPanel() {
    document.querySelectorAll(".ddf-conn-panel").forEach(el => el.remove());
  }

  // ─── Member / Retainer Actions ───────────────────────────────────────────────

  /** Add a player-driven party member — actor link required. */
  static #onAddMember(_event, target) {
    if (!this.#selectedFactionId) return;
    this.#showActorPicker(target, "Add Party Member", async (actor) => {
      const person = {
        id:        foundry.utils.randomID(),
        name:      actor.name,
        actorUuid: actor.uuid,
        notes:     []
      };
      await this.#appendPerson("member", person);
      this.#selectedPersonId   = person.id;
      this.#selectedPersonKind = "member";
      await this.#logEvent("member", `Party member added: ${person.name}`, "scmMemberAdded");
      this.render({ parts: ["content"] });
    });
  }

  /** Add a retainer/hireling — name only at create-time; actor optional later. */
  static async #onAddRetainer(_event, _target) {
    if (!this.#selectedFactionId) return;
    const name = await PartyDetailApp.#promptName("New Retainer", "Name");
    if (!name) return;
    const person = {
      id:        foundry.utils.randomID(),
      name,
      actorUuid: null,
      notes:     [],
      wages:     { treasureShare: 0, weeklyWages: 0 },
      loyalty:   6
    };
    await this.#appendPerson("retainer", person);
    this.#selectedPersonId   = person.id;
    this.#selectedPersonKind = "retainer";
    await this.#logEvent("member", `Retainer added: ${person.name}`, "scmMemberAdded");
    this.render({ parts: ["content"] });
  }

  static #onSelectPerson(_event, target) {
    const row = target.closest("[data-person-id]");
    if (!row) return;
    const id   = row.dataset.personId;
    const kind = row.dataset.kind;
    if (!id || !kind) return;
    if (id === this.#selectedPersonId && kind === this.#selectedPersonKind) return;
    this.#selectedPersonId   = id;
    this.#selectedPersonKind = kind;
    this.render({ parts: ["content"] });
  }

  static async #onDeletePerson(_event, _target) {
    if (!this.#selectedPersonId || !this.#selectedPersonKind) return;
    const person = this.#findPerson(this.#selectedPersonKind, this.#selectedPersonId);
    if (!person) return;

    const label = this.#selectedPersonKind === "retainer" ? "retainer" : "party member";
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: `Remove ${label}` },
      content: `<p>Remove <strong>${foundry.utils.escapeHTML(person.name)}</strong> from this party?</p>`
    });
    if (!confirmed) return;

    await this.#logEvent("member", `${label.charAt(0).toUpperCase() + label.slice(1)} removed: ${person.name}`, "scmMemberRemoved");
    await this.#removePerson(this.#selectedPersonKind, this.#selectedPersonId);
    this.#selectedPersonId   = null;
    this.#selectedPersonKind = null;
    this.render({ parts: ["content"] });
  }

  static async #onOpenPersonActor(_event, _target) {
    const person = this.#findPerson(this.#selectedPersonKind, this.#selectedPersonId);
    if (!person?.actorUuid) return;
    try {
      const actor = await fromUuid(person.actorUuid);
      actor?.sheet?.render({ force: true });
    } catch { /* stale uuid */ }
  }

  static async #onUnlinkPersonActor(_event, _target) {
    if (!this.#selectedPersonId || !this.#selectedPersonKind) return;
    await this.#updatePerson(this.#selectedPersonKind, this.#selectedPersonId, { actorUuid: null });
    this.render({ parts: ["content"] });
  }

  static #onLinkPersonActor(_event, target) {
    if (!this.#selectedPersonId || !this.#selectedPersonKind) return;
    const kind = this.#selectedPersonKind;
    const id   = this.#selectedPersonId;
    this.#showActorPicker(target, "Link Actor", async (actor) => {
      // For player members, also sync the display name to the actor's name
      const updates = { actorUuid: actor.uuid };
      if (kind === "member") updates.name = actor.name;
      await this.#updatePerson(kind, id, updates);
      this.render({ parts: ["content"] });
    });
  }

  /** Set retainer loyalty by clicking a box. Clicking the current value lowers by 1. */
  static async #onSetLoyalty(_event, target) {
    if (this.#selectedPersonKind !== "retainer") return;
    const value   = parseInt(target.dataset.loyalty ?? "0", 10);
    const person  = this.#findPerson("retainer", this.#selectedPersonId);
    if (!person) return;
    // Click current value to dial down by one (so clicking the rightmost filled box decrements)
    const next = (person.loyalty ?? 0) === value ? value - 1 : value;
    const clamped = Math.max(0, Math.min(12, next));
    await this.#updatePerson("retainer", this.#selectedPersonId, { loyalty: clamped });
    this.render({ parts: ["content"] });
  }

  /** Save a new note to the selected person. Reads the textarea, appends, and logs to the event log. */
  static async #onSaveMemberNote(_event, _target) {
    if (!this.#selectedPersonId || !this.#selectedPersonKind) return;
    const textarea = this.element.querySelector(".member-note-textarea");
    const text     = textarea?.value.trim();
    if (!text) return;
    const person = this.#findPerson(this.#selectedPersonKind, this.#selectedPersonId);
    if (!person) return;

    const note = { id: foundry.utils.randomID(), timestamp: Date.now(), text };
    const notes = [...(person.notes ?? []), note];
    await this.#updatePerson(this.#selectedPersonKind, this.#selectedPersonId, { notes });
    await this.#logEvent("member", `${person.name}: ${text}`, null);
    this.render({ parts: ["content"] });
  }

  static async #onDeleteMemberNote(_event, target) {
    if (!this.#selectedPersonId || !this.#selectedPersonKind) return;
    const noteId = target.closest("[data-note-id]")?.dataset.noteId;
    if (!noteId) return;
    const person = this.#findPerson(this.#selectedPersonKind, this.#selectedPersonId);
    if (!person) return;
    const notes = (person.notes ?? []).filter(n => n.id !== noteId);
    await this.#updatePerson(this.#selectedPersonKind, this.#selectedPersonId, { notes });
    this.render({ parts: ["content"] });
  }

  /**
   * Generic actor picker panel. Lists world actors with live-filter; the supplied
   * `onPick` callback runs when an actor is chosen and is responsible for closing
   * any required state.
   */
  #showActorPicker(triggerEl, title, onPick) {
    document.querySelectorAll(".ddf-actor-search-panel").forEach(el => el.remove());

    const panel = document.createElement("div");
    panel.className = "mm-search-panel ddf-actor-search-panel";
    panel.style.position = "fixed";
    panel.style.zIndex   = "10000";
    positionPanelBesideApp(panel, this.element, triggerEl, 260);

    const actors = [...game.actors].sort((a, b) => a.name.localeCompare(b.name));
    panel.innerHTML = `
      <div class="mm-panel-title">${foundry.utils.escapeHTML(title)}</div>
      <input type="text" class="mm-search-input" placeholder="Filter actors…" autofocus />
      <div class="mm-search-results ddf-conn-faction-list">
        ${actors.length
          ? actors.map(a => `
              <div class="mm-search-result" data-uuid="${a.uuid}">
                <i class="fa-solid fa-user ddf-link-icon"></i>
                <span>${foundry.utils.escapeHTML(a.name)}</span>
              </div>`).join("")
          : "<div class='mm-search-empty'>No actors found</div>"
        }
      </div>
      <div class="mm-panel-actions"><button class="mm-btn-cancel">Cancel</button></div>
    `;

    const input   = panel.querySelector(".mm-search-input");
    const results = panel.querySelector(".mm-search-results");

    input.addEventListener("input", () => {
      const q = input.value.toLowerCase();
      results.querySelectorAll(".mm-search-result").forEach(el => {
        el.style.display = el.textContent.toLowerCase().includes(q) ? "" : "none";
      });
    });

    results.addEventListener("click", async (e) => {
      const el = e.target.closest(".mm-search-result");
      if (!el) return;
      const actor = await fromUuid(el.dataset.uuid);
      if (!actor) return;
      panel.remove();
      await onPick(actor);
    });

    panel.querySelector(".mm-btn-cancel").addEventListener("click", () => panel.remove());
    document.body.appendChild(panel);

    const handler = (e) => {
      if (!panel.contains(e.target)) {
        panel.remove();
        document.removeEventListener("mousedown", handler, true);
      }
    };
    setTimeout(() => document.addEventListener("mousedown", handler, true), 50);

    input.focus();
  }

  // ─── Tag Actions ─────────────────────────────────────────────────────────────

  static #onAddTag(_event, target) {
    if (!this.#selectedFactionId) return;
    this.#showTagAddPanel(target);
  }

  static async #onDeleteTag(_event, target) {
    const tag = target.dataset.tag;
    if (!tag || !this.#selectedFactionId) return;
    const faction = FactionStore.getAll()[this.#selectedFactionId];
    if (!faction) return;
    const tags = (faction.tags ?? []).filter(t => t !== tag);
    await FactionStore.update(this.#selectedFactionId, { tags });
    this.render({ parts: ["content"] });
  }

  #showTagAddPanel(triggerEl) {
    document.querySelectorAll(".ddf-tag-panel").forEach(el => el.remove());

    const factionId   = this.#selectedFactionId;
    const faction     = FactionStore.getAll()[factionId];
    const currentTags = new Set(faction?.tags ?? []);
    const allTags     = FactionStore.getAllTags().filter(t => !currentTags.has(t));

    const btnRect  = triggerEl.getBoundingClientRect();
    const PANEL_W  = 220;
    const GAP      = 6;

    const panel = document.createElement("div");
    panel.className      = "mm-search-panel ddf-tag-panel";
    panel.style.position = "fixed";
    panel.style.zIndex   = "10000";
    panel.style.left     = `${Math.min(btnRect.left, window.innerWidth - PANEL_W - GAP)}px`;
    panel.style.top      = `${btnRect.bottom + GAP}px`;

    panel.innerHTML = `
      <div class="mm-panel-title">Add Tag</div>
      <input type="text" class="mm-search-input ddf-tag-input" placeholder="Type or search tags…" autofocus />
      <div class="mm-search-results ddf-tag-list">
        ${allTags.length
          ? allTags.map(t => `<div class="mm-search-result" data-tag="${foundry.utils.escapeHTML(t)}">${foundry.utils.escapeHTML(t)}</div>`).join("")
          : "<div class='mm-search-empty'>No existing tags — type to create one</div>"
        }
      </div>
    `;

    const input   = panel.querySelector(".mm-search-input");
    const results = panel.querySelector(".mm-search-results");

    input.addEventListener("input", () => {
      const q = input.value.toLowerCase();
      results.querySelectorAll(".mm-search-result").forEach(el => {
        el.style.display = el.dataset.tag.toLowerCase().includes(q) ? "" : "none";
      });
    });

    const addTag = async (tag) => {
      tag = tag.trim();
      if (!tag) return;
      const f = FactionStore.getAll()[factionId];
      if (!f) return;
      const tags = [...new Set([...(f.tags ?? []), tag])];
      await FactionStore.update(factionId, { tags });
      panel.remove();
      this.render({ parts: ["content"] });
    };

    results.addEventListener("click", async (e) => {
      const el = e.target.closest(".mm-search-result");
      if (el) await addTag(el.dataset.tag);
    });

    input.addEventListener("keydown", async (e) => {
      if (e.key === "Enter") { e.preventDefault(); await addTag(input.value); }
      if (e.key === "Escape") panel.remove();
    });

    document.body.appendChild(panel);

    const handler = (e) => {
      if (!panel.contains(e.target)) {
        panel.remove();
        document.removeEventListener("mousedown", handler, true);
      }
    };
    setTimeout(() => document.addEventListener("mousedown", handler, true), 50);
    input.focus();
  }

}
