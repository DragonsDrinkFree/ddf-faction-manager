import { FactionStore } from "../data/FactionStore.js";
import { ProjectStore } from "../data/ProjectStore.js";
import { RelationshipStore } from "../data/RelationshipStore.js";
import { EventLogStore } from "../data/EventLogStore.js";
import { ReputationStore } from "../data/ReputationStore.js";
import { ReputationLogApp } from "./ReputationLogApp.js";
import { BaseDetailApp } from "./BaseDetailApp.js";
import { syncSandboxPartyMembers } from "../utils/SandboxIntegration.js";
import {
  getConnectionTypes,
  positionPanelBesideApp,
  wireActorSearchList
} from "../utils/ConnectionPanelHelpers.js";
import { promptName } from "../utils/AppHelpers.js";
import { buildProjectContext, buildSelectedProjectContext } from "../utils/ProjectContext.js";

export class PartyDetailApp extends BaseDetailApp {
  /** @type {Map<string, PartyDetailApp>} factionId → open instance */
  static #instances = new Map();
  static get instances() { return PartyDetailApp.#instances; }
  static idPrefix      = "ddf-party-detail";
  static fallbackTitle = "Party";

  /** ID of the currently selected party-member or retainer entry. */
  #selectedPersonId   = null;
  /** "member" | "retainer" — discriminates which array to read from. */
  #selectedPersonKind = null;
  #noteExpanded = false;
  /** ID of the faction currently selected in the Reputation tab. */
  #selectedRepFactionId = null;

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
      ...BaseDetailApp.SHARED_ACTIONS,
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
      toggleNote:        PartyDetailApp.#onToggleNote
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
        ".event-log-list",
        ".ddf-rep-list-pane",
        ".ddf-rep-detail-pane"
      ]
    }
  };

  /**
   * Override of BaseDetailApp.show — reconciles sandbox-managed members
   * before rendering, so the open sheet reflects the current Sandbox party
   * roster (no-op if SCM is absent or the party has no sandboxPartyId).
   */
  static async show(factionId) {
    if (!game.user.isGM) return;
    await syncSandboxPartyMembers(factionId);
    super.show(factionId);
  }

  // ─── Context ─────────────────────────────────────────────────────────────────

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.activeTab = this._activeTab;
    context.tabs = [
      { id: "overview",    label: "Overview",    icon: "fa-solid fa-scroll",            cssClass: this._activeTab === "overview"    ? "active" : "" },
      { id: "projects",    label: "Objectives",  icon: "fa-solid fa-list-check",        cssClass: this._activeTab === "projects"    ? "active" : "" },
      { id: "reputation",  label: "Reputation",  icon: "fa-solid fa-handshake",         cssClass: this._activeTab === "reputation"  ? "active" : "" },
      { id: "connections", label: "Connections", icon: "fa-solid fa-circle-nodes",      cssClass: this._activeTab === "connections" ? "active" : "" },
      { id: "eventlog",    label: "Event Log",   icon: "fa-solid fa-clock-rotate-left", cssClass: this._activeTab === "eventlog"    ? "active" : "" }
    ];
    return context;
  }

  /** @override */
  async _preparePartContext(partId, context, options) {
    context = await super._preparePartContext(partId, context, options);

    if (partId !== "content") return context;

    context.selectedFaction = this._selectedFactionId
      ? FactionStore.getAll()[this._selectedFactionId] ?? null
      : null;

    // Auto-select first active project when switching to the Projects tab
    if (this._activeTab === "projects" && this._selectedFactionId && !this._selectedProjectId) {
      const all = ProjectStore.getForFaction(this._selectedFactionId);
      const sorted = all.sort((a, b) => a.name.localeCompare(b.name));
      const first = sorted.find(p => p.status === "active") ?? sorted[0];
      if (first) this._selectedProjectId = first.id;
    }

    // Overview: GM quick note + connections list
    context.partyNote         = context.selectedFaction?.partyNote ?? "";
    context.connectionTypes   = getConnectionTypes();
    context.relationshipItems = this._selectedFactionId
      ? this.#buildRelationshipItems()
      : [];

    // Objectives tab
    context.selectedProjectId = this._selectedProjectId;
    context.projects           = buildProjectContext(this._selectedFactionId);
    context.selectedProject    = buildSelectedProjectContext(this._selectedProjectId);
    context.editingOverview    = this._editingOverview;
    context.editingNoteId      = this._editingNoteId;

    if (context.selectedProject && !this._editingOverview) {
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

    // Currency types + wage/share totals
    context.currencyTypes = PartyDetailApp.#readCurrencyTypes();
    const defaultCurrency = context.currencyTypes[0]?.id ?? "";
    const wageTotals = {};
    let totalShares = 0;
    for (const r of rawRetainers) {
      totalShares += r.wages?.treasureShare ?? 0;
      const amount   = r.wages?.weeklyWages ?? 0;
      const currency = r.wages?.weeklyWagesCurrency || defaultCurrency;
      if (amount > 0) wageTotals[currency] = (wageTotals[currency] ?? 0) + amount;
    }
    context.totalTreasureShares = totalShares;
    context.retainerWageTotals  = Object.entries(wageTotals)
      .map(([currency, amount]) => ({ currency, amount }))
      .sort((a, b) => a.currency.localeCompare(b.currency));

    context.noteExpanded = this.#noteExpanded;

    // Event Log tab
    context.eventLogEntries = this._selectedFactionId
      ? EventLogStore.getForFaction(this._selectedFactionId).map(e => ({
          ...e,
          formattedTime: new Date(e.timestamp).toLocaleString()
        }))
      : [];

    // Reputation tab
    if (this._activeTab === "reputation" && this._selectedFactionId) {
      const repData    = ReputationStore.getForParty(this._selectedFactionId);
      const allFactions = FactionStore.getAll();
      context.globalRepMax = ReputationStore.getEffectiveMax(null);

      context.reputations = Object.values(repData)
        .map(entry => {
          const faction = allFactions[entry.factionId];
          const maxVal  = ReputationStore.getEffectiveMax(entry);
          return {
            ...entry,
            factionName: faction?.name ?? "Unknown",
            maxValue:    maxVal,
            isSelected:  entry.factionId === this.#selectedRepFactionId,
            trackBoxes:  Array.from({ length: maxVal }, (_, i) => ({
              value:  i + 1,
              filled: (i + 1) <= entry.current,
              hue:    Math.round(((i + 1) / maxVal) * 120)
            }))
          };
        })
        .sort((a, b) => a.factionName.localeCompare(b.factionName));

      if (this.#selectedRepFactionId && repData[this.#selectedRepFactionId]) {
        const sel    = repData[this.#selectedRepFactionId];
        const maxVal = ReputationStore.getEffectiveMax(sel);
        context.selectedRep = {
          ...sel,
          factionName: allFactions[sel.factionId]?.name ?? "Unknown",
          maxValue:    maxVal,
          trackBoxes:  Array.from({ length: maxVal }, (_, i) => ({
            value:  i + 1,
            filled: (i + 1) <= sel.current,
            hue:    Math.round(((i + 1) / maxVal) * 120)
          })),
          recentEntries: [...sel.entries].reverse().slice(0, 5).map(e => ({
            ...e,
            formattedTime: new Date(e.timestamp).toLocaleString(),
            deltaLabel:    e.delta > 0 ? `+${e.delta}` : `${e.delta}`
          }))
        };
      }
    }

    return context;
  }

  // ─── Relationship Items (read-only list for Overview pane) ────────────────────

  #buildRelationshipItems() {
    const allFactions = FactionStore.getAll();
    const storedEdges = RelationshipStore.getEdgesForFaction(this._selectedFactionId);

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

    // ── Party node color: auto-save on change ────────────────────────────────
    const colorPicker = this.element.querySelector('input[name="partyColor"]');
    if (colorPicker && this._selectedFactionId) {
      colorPicker.addEventListener("change", async (e) => {
        await FactionStore.update(this._selectedFactionId, { color: e.target.value });
      });
    }

    // ── GM Quick Note: auto-save on blur or Enter (does not re-render) ───────
    const quickNote = this.element.querySelector(".party-quick-note-textarea");
    if (quickNote && this._selectedFactionId) {
      quickNote.addEventListener("blur", async () => {
        const note = quickNote.value;
        const faction = FactionStore.getAll()[this._selectedFactionId];
        if (!faction) return;
        if ((faction.partyNote ?? "") === note) return;  // no-op when unchanged
        await FactionStore.update(this._selectedFactionId, { partyNote: note });
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
        await this._logEvent("connection", `Connection type changed to: ${typeName}`, "scmConnectionTypeChanged");
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
        await this._logEvent("connection", `Connection direction changed to: ${next}`, "scmConnectionDirectionChanged");
        this.render({ parts: ["content"] });
      });
    });

    // ── Inline note editor (objectives tab) ─────────────────────────────────
    const presetRadios = this.element.querySelectorAll('input[name="note_preset"]');
    const customInput  = this.element.querySelector('input[name="note_custom"]');
    const textarea     = this.element.querySelector(".note-draft-textarea");

    if (textarea) {
      // Pre-fill editor when editing an existing note
      if (this._editingNoteId && this._selectedProjectId) {
        const project = ProjectStore.getAll()[this._selectedProjectId];
        const note    = project?.notes.find(n => n.id === this._editingNoteId);
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

    // ── Reputation tab wiring ────────────────────────────────────────────────
    const el = this.element;

    el.querySelectorAll(".ddf-rep-faction-row").forEach(row => {
      row.addEventListener("click", () => {
        this.#selectedRepFactionId = row.dataset.factionId ?? null;
        this.render({ parts: ["content"] });
      });
    });

    el.querySelector(".ddf-rep-add-faction")?.addEventListener("click", (e) => {
      this.#showRepFactionSearch(e.currentTarget);
    });

    el.querySelector(".ddf-rep-remove-faction")?.addEventListener("click", async () => {
      if (!this.#selectedRepFactionId) return;
      await ReputationStore.removeFaction(this._selectedFactionId, this.#selectedRepFactionId);
      this.#selectedRepFactionId = null;
      this.render({ parts: ["content"] });
    });

    el.querySelector(".ddf-rep-inc")?.addEventListener("click", async () => {
      if (!this.#selectedRepFactionId) return;
      await ReputationStore.recordChange(this._selectedFactionId, this.#selectedRepFactionId, 1, "");
      this.render({ parts: ["content"] });
    });

    el.querySelector(".ddf-rep-dec")?.addEventListener("click", async () => {
      if (!this.#selectedRepFactionId) return;
      await ReputationStore.recordChange(this._selectedFactionId, this.#selectedRepFactionId, -1, "");
      this.render({ parts: ["content"] });
    });

    el.querySelector(".ddf-rep-record-btn")?.addEventListener("click", async () => {
      const deltaInput = el.querySelector(".ddf-rep-delta-input");
      const noteInput  = el.querySelector(".ddf-rep-note-input");
      const delta      = parseInt(deltaInput?.value ?? "0", 10);
      if (!delta) return;
      const note = noteInput?.value?.trim() ?? "";
      await ReputationStore.recordChange(this._selectedFactionId, this.#selectedRepFactionId, delta, note);
      if (deltaInput) deltaInput.value = "";
      if (noteInput)  noteInput.value  = "";
      this.render({ parts: ["content"] });
    });

    el.querySelector(".ddf-rep-max-input")?.addEventListener("change", async (e) => {
      const val = parseInt(e.target.value, 10);
      if (isNaN(val) || val < 1) return;
      await ReputationStore.setMaxOverride(this._selectedFactionId, this.#selectedRepFactionId, val);
      this.render({ parts: ["content"] });
    });

    el.querySelector(".ddf-rep-view-log")?.addEventListener("click", () => {
      if (!this.#selectedRepFactionId) return;
      ReputationLogApp.show(this._selectedFactionId, this.#selectedRepFactionId);
    });

    el.querySelectorAll(".ddf-rep-track-box").forEach(box => {
      box.addEventListener("click", async (e) => {
        e.stopPropagation();
        const factionId = box.dataset.factionId;
        const value     = parseInt(box.dataset.value, 10);
        if (!factionId || isNaN(value)) return;
        const entry = ReputationStore.getEntry(this._selectedFactionId, factionId);
        if (!entry) return;
        const current = entry.current;
        const target  = current === value ? value - 1 : value;
        const delta   = target - current;
        if (!delta) return;
        await ReputationStore.recordChange(this._selectedFactionId, factionId, delta, "");
        this.render({ parts: ["content"] });
      });
    });

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
          const value = parseFloat(e.target.value) || 0;
          const person = this.#findPerson("retainer", this.#selectedPersonId);
          if (!person) return;
          const wages = { ...(person.wages ?? { treasureShare: 0, weeklyWages: 0 }), [field]: value };
          await this.#updatePerson("retainer", this.#selectedPersonId, { wages });
        });
      });

      // Currency select (retainer-only): auto-save on change
      const currencySelect = this.element.querySelector(".retainer-currency-select");
      if (currencySelect) {
        currencySelect.addEventListener("change", async (e) => {
          if (this.#selectedPersonKind !== "retainer") return;
          const person = this.#findPerson("retainer", this.#selectedPersonId);
          if (!person) return;
          const wages = { ...(person.wages ?? { treasureShare: 0, weeklyWages: 0 }), weeklyWagesCurrency: e.target.value };
          await this.#updatePerson("retainer", this.#selectedPersonId, { wages });
          this.render({ parts: ["content"] });
        });
      }

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
    const sf = FactionStore.getAll()[this._selectedFactionId];
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
    await FactionStore.update(this._selectedFactionId, { [this.#arrayKey(kind)]: list });
    return list[idx];
  }

  /** Append a new person to the appropriate array. */
  async #appendPerson(kind, person) {
    const list = this.#getPersonList(kind);
    list.push(person);
    await FactionStore.update(this._selectedFactionId, { [this.#arrayKey(kind)]: list });
    return person;
  }

  /** Remove a person by id. */
  async #removePerson(kind, id) {
    const list = this.#getPersonList(kind).filter(p => p.id !== id);
    await FactionStore.update(this._selectedFactionId, { [this.#arrayKey(kind)]: list });
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
          filled: (i + 1) <= (person.loyalty ?? 0),
          hue:    Math.round(((i + 1) / 12) * 120)
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

  static #readCurrencyTypes() {
    try {
      const raw = game.settings.get("ddf-faction-manager", "currencyTypes");
      return typeof raw === "string" ? JSON.parse(raw) : (raw ?? []);
    } catch { return []; }
  }

  // ─── Member / Retainer Actions ───────────────────────────────────────────────

  /** Add a player-driven party member — actor link required. */
  static #onAddMember(_event, target) {
    if (!this._selectedFactionId) return;
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
      await this._logEvent("member", `Party member added: ${person.name}`, "scmMemberAdded");
      this.render({ parts: ["content"] });
    });
  }

  /** Add a retainer/hireling — name only at create-time; actor optional later. */
  static async #onAddRetainer(_event, _target) {
    if (!this._selectedFactionId) return;
    const name = await promptName("New Retainer", "Name");
    if (!name) return;
    const person = {
      id:        foundry.utils.randomID(),
      name,
      actorUuid: null,
      notes:     [],
      wages:     { treasureShare: 0, weeklyWages: 0, weeklyWagesCurrency: PartyDetailApp.#readCurrencyTypes()[0]?.id ?? "" },
      loyalty:   6
    };
    await this.#appendPerson("retainer", person);
    this.#selectedPersonId   = person.id;
    this.#selectedPersonKind = "retainer";
    await this._logEvent("member", `Retainer added: ${person.name}`, "scmMemberAdded");
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

    await this._logEvent("member", `${label.charAt(0).toUpperCase() + label.slice(1)} removed: ${person.name}`, "scmMemberRemoved");
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
    await this._logEvent("member", `${person.name}: ${text}`, null);
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
    panel.className = "mm-search-panel ddf-fm-floating ddf-actor-search-panel";
    panel.style.position = "fixed";
    panel.style.zIndex   = "10000";
    positionPanelBesideApp(panel, this.element, triggerEl, 260);

    panel.innerHTML = `
      <div class="mm-panel-title">${foundry.utils.escapeHTML(title)}</div>
      <input type="text" class="mm-search-input" placeholder="Filter actors, or @ to browse a compendium…" autofocus />
      <div class="mm-search-results ddf-conn-faction-list"></div>
      <div class="mm-panel-actions"><button class="mm-btn-cancel">Cancel</button></div>
    `;

    const input   = panel.querySelector(".mm-search-input");
    const results = panel.querySelector(".mm-search-results");

    wireActorSearchList({ panel, input, results, onPick });

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

  static #onToggleNote(_event, _target) {
    this.#noteExpanded = !this.#noteExpanded;
    this.render({ parts: ["content"] });
  }

  #showRepFactionSearch(triggerEl) {
    document.querySelectorAll(".ddf-rep-faction-panel").forEach(el => el.remove());

    const allFactions = FactionStore.getAll();
    const repData     = ReputationStore.getForParty(this._selectedFactionId);
    const trackedIds  = new Set(Object.keys(repData));
    trackedIds.add(this._selectedFactionId); // exclude the party itself

    const candidates = Object.values(allFactions)
      .filter(f => !trackedIds.has(f.id) && f.kind !== "party")
      .sort((a, b) => a.name.localeCompare(b.name));

    const btnRect = triggerEl.getBoundingClientRect();
    const PANEL_W = 240;
    const GAP     = 6;

    const panel = document.createElement("div");
    panel.className      = "mm-search-panel ddf-fm-floating ddf-rep-faction-panel";
    panel.style.position = "fixed";
    panel.style.zIndex   = "10000";
    panel.style.left     = `${Math.min(btnRect.left, window.innerWidth - PANEL_W - GAP)}px`;
    panel.style.top      = `${btnRect.bottom + GAP}px`;

    panel.innerHTML = `
      <div class="mm-panel-title">Add Faction</div>
      <input type="text" class="mm-search-input" placeholder="Filter factions…" autofocus />
      <div class="mm-search-results ddf-conn-faction-list">
        ${candidates.length
          ? candidates.map(f => `
              <div class="mm-search-result" data-id="${f.id}">
                <i class="fa-solid fa-shield-halved ddf-link-icon"></i>
                <span>${foundry.utils.escapeHTML(f.name)}</span>
              </div>`).join("")
          : "<div class='mm-search-empty'>No factions available</div>"
        }
      </div>
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
      panel.remove();
      await ReputationStore.addFaction(this._selectedFactionId, el.dataset.id);
      this.#selectedRepFactionId = el.dataset.id;
      this.render({ parts: ["content"] });
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
