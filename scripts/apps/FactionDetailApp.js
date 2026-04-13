import { FactionStore } from "../data/FactionStore.js";
import { ProjectStore } from "../data/ProjectStore.js";
import { RelationshipStore } from "../data/RelationshipStore.js";
import { MemberStore } from "../data/MemberStore.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class FactionDetailApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @type {Map<string, FactionDetailApp>} factionId → open instance */
  static #instances = new Map();

  #selectedFactionId = null;
  #selectedProjectId = null;
  #selectedMemberId  = null;
  #activeTab = "overview";
  #editingOverview = false;
  #editingNoteId = null;

  /**
   * @param {string} factionId
   */
  constructor(factionId) {
    super({ id: `ddf-faction-detail-${factionId}` });
    this.#selectedFactionId = factionId;
  }

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
      breakParentLink:   FactionDetailApp.#onBreakParentLink,
      deleteConnection:  FactionDetailApp.#onDeleteConnection,
      addConnection:     FactionDetailApp.#onAddConnection,
      openConnection:    FactionDetailApp.#onOpenConnection,
      addMember:         FactionDetailApp.#onAddMember,
      addRank:           FactionDetailApp.#onAddRank,
      selectMember:      FactionDetailApp.#onSelectMember,
      editRank:          FactionDetailApp.#onEditRank,
      deleteRank:        FactionDetailApp.#onDeleteRank,
      deleteMember:      FactionDetailApp.#onDeleteMember,
      openMemberActor:   FactionDetailApp.#onOpenMemberActor,
      unlinkMemberActor: FactionDetailApp.#onUnlinkMemberActor,
      linkMemberActor:   FactionDetailApp.#onLinkMemberActor,
      moveMember:        FactionDetailApp.#onMoveMember
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
   * Open a detail window for the given faction.
   * If a window for that faction is already open, bring it to front.
   * @param {string} factionId
   */
  static show(factionId) {
    if (!game.user.isGM) return;

    // Reuse an already-open window for this faction
    const existing = FactionDetailApp.#instances.get(factionId);
    if (existing?.element?.isConnected) {
      existing.render({ force: true });
      return;
    }

    const app = new FactionDetailApp(factionId);
    FactionDetailApp.#instances.set(factionId, app);
    app.render({ force: true });
  }

  // ─── Context ─────────────────────────────────────────────────────────────────

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.activeTab = this.#activeTab;
    context.tabs = [
      { id: "overview", label: "Overview",   icon: "fa-solid fa-scroll",      cssClass: this.#activeTab === "overview" ? "active" : "" },
      { id: "projects", label: "Objectives", icon: "fa-solid fa-list-check",  cssClass: this.#activeTab === "projects" ? "active" : "" },
      { id: "members",  label: "Members",    icon: "fa-solid fa-users",        cssClass: this.#activeTab === "members"  ? "active" : "" }
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
    context.journalContent    = await this.#getJournalContent();
    context.connectionTypes   = this.#getConnectionTypes();
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

    // Members tab
    const memberCtx = await this.#buildMembersContext();
    context.membersByRank       = memberCtx.membersByRank;
    context.factionRanks        = memberCtx.factionRanks;
    context.subFactionSections  = memberCtx.subFactionSections;
    context.selectedMemberId    = this.#selectedMemberId;
    context.selectedMember      = await this.#buildSelectedMemberContext();

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
        id:              `parent_${faction.parentId}`,
        name:            allFactions[faction.parentId].name,
        icon:            "",
        directionSymbol: "↑",
        isAuto:          true,
        isParentLink:    true,
        parentFactionId: faction.parentId,
        targetFactionId: faction.parentId,
        color:           ""
      });
    }

    // Sub-faction auto-connections (derived from hierarchy, not stored)
    const subItems = Object.values(allFactions)
      .filter(f => f.parentId === this.#selectedFactionId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(f => ({
        id:              `sub_${f.id}`,
        name:            f.name,
        icon:            "",
        directionSymbol: "↕",
        isAuto:          true,
        targetFactionId: f.id,
        color:           ""
      }));

    // Stored relationship edges
    const connectionTypes = this.#getConnectionTypes();

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

    // Wire connection-type dropdowns in the connections pane (overview tab)
    this.element.querySelectorAll(".rel-type-select").forEach(select => {
      select.addEventListener("change", async (e) => {
        const edgeId = e.target.dataset.edgeId;
        await RelationshipStore.updateEdgeConnectionType(edgeId, e.target.value || null);
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
        // When a reversed edge goes two-way → one-way, swap from/to so the
        // resulting one-way edge points FROM this faction rather than away from it.
        const swapParties = isReversed && next === "one-way";
        await RelationshipStore.updateEdgeDirection(edgeId, next, { swapParties });
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

    // ── Members tab wiring ────────────────────────────────────────────────────
    // Member name: auto-save on blur or Enter
    const memberNameInput = this.element.querySelector(".member-name-input");
    if (memberNameInput && this.#selectedMemberId) {
      const save = async () => {
        const name = memberNameInput.value.trim();
        if (!name) return;
        await MemberStore.updateMember(this.#selectedMemberId, { name });
        this.render({ parts: ["content"] });
      };
      memberNameInput.addEventListener("blur", save);
      memberNameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); save(); }
      });
    }

    // Member rank: auto-save on change
    const memberRankSelect = this.element.querySelector(".member-rank-select");
    if (memberRankSelect && this.#selectedMemberId) {
      memberRankSelect.addEventListener("change", async (e) => {
        await MemberStore.updateMember(this.#selectedMemberId, { rankId: e.target.value || null });
        this.render({ parts: ["content"] });
      });
    }
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

    const enriched = await foundry.applications.ux.TextEditor.implementation.enrichHTML(
      page.text?.content ?? "", {
        relativeTo: page,
        secrets: game.user.isGM,
        async: true
      }
    );

    // Strip any @Faction link that refers to this faction itself (auto-inserted on create)
    const tmp = document.createElement("div");
    tmp.innerHTML = enriched;
    tmp.querySelectorAll(`.ddf-faction-link[data-faction-id="${this.#selectedFactionId}"]`).forEach(el => {
      const p = el.parentElement;
      el.remove();
      if (p?.tagName === "P" && !p.textContent.trim()) p.remove();
    });
    return tmp.innerHTML;
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

  async #buildMembersContext() {
    if (!this.#selectedFactionId) return { membersByRank: [], factionRanks: [], subFactionSections: [] };

    const ranks   = MemberStore.getRanksForFaction(this.#selectedFactionId);
    const members = MemberStore.getMembersForFaction(this.#selectedFactionId);

    // Group direct members by rank
    const byRank  = new Map(ranks.map(r => [r.id, []]));
    const unranked = [];
    for (const member of members) {
      if (member.rankId && byRank.has(member.rankId)) {
        byRank.get(member.rankId).push(member);
      } else {
        unranked.push(member);
      }
    }

    const membersByRank = ranks.map(rank => ({
      rankId:          rank.id,
      rankName:        rank.name,
      rankOrder:       rank.order,
      rankDescription: rank.description,
      members:         byRank.get(rank.id) ?? []
    }));

    if (unranked.length > 0 || ranks.length === 0) {
      membersByRank.push({ rankId: null, rankName: "Unranked", members: unranked });
    }

    // Sub-faction sections (read-only view of each child faction's members)
    const allFactions = FactionStore.getAll();
    const subFactionSections = Object.values(allFactions)
      .filter(f => f.parentId === this.#selectedFactionId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(sf => ({
        factionId:   sf.id,
        factionName: sf.name,
        members:     MemberStore.getMembersForFaction(sf.id)
      }));

    return { membersByRank, factionRanks: ranks, subFactionSections };
  }

  async #buildSelectedMemberContext() {
    if (!this.#selectedMemberId) return null;
    const { members } = MemberStore.getAll();
    const member = members[this.#selectedMemberId];
    if (!member) return null;

    let actorName = null;
    if (member.actorUuid) {
      try {
        const actor = await fromUuid(member.actorUuid);
        actorName = actor?.name ?? null;
      } catch { /* uuid stale */ }
    }

    // Ranks from the member's actual faction (may be a sub-faction with its own ranks)
    const memberRanks = MemberStore.getRanksForFaction(member.factionId);

    // Factions the member can be moved to: main + sub-factions, excluding current
    const allFactions   = FactionStore.getAll();
    const mainFaction   = allFactions[this.#selectedFactionId];
    const subFactions   = Object.values(allFactions)
      .filter(f => f.parentId === this.#selectedFactionId)
      .sort((a, b) => a.name.localeCompare(b.name));
    const moveTargets = [
      { id: this.#selectedFactionId, name: mainFaction?.name ?? "Main Faction" },
      ...subFactions.map(f => ({ id: f.id, name: f.name }))
    ].filter(t => t.id !== member.factionId);

    const currentFactionName = allFactions[member.factionId]?.name ?? "";

    return {
      ...member,
      actorName,
      memberRanks,
      moveTargets,
      hasMoveTargets: moveTargets.length > 0,
      currentFactionName
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
    const name = await FactionDetailApp.#promptName("New Objective", "Name");
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
      FactionDetailApp.show(factionId);
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

  // ─── Add Connection Panel ─────────────────────────────────────────────────────

  static #onAddConnection(_event, target) {
    this.#closeConnPanel();
    if (!this.#selectedFactionId) return;

    const fromFactionId = this.#selectedFactionId;
    const appRect  = this.element.getBoundingClientRect();
    const btnRect  = target.getBoundingClientRect();

    const panel = document.createElement("div");
    panel.className = "mm-search-panel ddf-conn-panel";

    // Hang the panel to the right of the faction window.
    // Fall back to left side if the window is too close to the screen edge.
    const PANEL_W = 260;
    const GAP     = 8;
    const fitsRight = appRect.right + GAP + PANEL_W <= window.innerWidth;
    if (fitsRight) {
      panel.style.left = `${appRect.right + GAP}px`;
    } else {
      panel.style.right = `${window.innerWidth - appRect.left + GAP}px`;
    }
    // Vertically align with the button that opened it
    const topMax = window.innerHeight - 40; // keep at least some of the panel visible
    panel.style.top = `${Math.min(btnRect.top, topMax)}px`;

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
    this.#bindConnPanelDismiss(panel);
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
      ${this.#connTypePickerHTML()}
      ${this.#connDirectionPickerHTML()}
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
      const direction        = this.#connSelectedDirection(panel);
      const connectionTypeId = this.#connSelectedType(panel);
      const opts             = { toFactionId };
      if (connectionTypeId) opts.connectionTypeId = connectionTypeId;
      await RelationshipStore.createEdge(fromFactionId, "faction", direction, opts);
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
      ${this.#connTypePickerHTML()}
      ${this.#connDirectionPickerHTML()}
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
      const direction        = this.#connSelectedDirection(panel);
      const connectionTypeId = this.#connSelectedType(panel);
      const opts = { documentUuid: el.dataset.uuid, documentType: el.dataset.type, documentName: el.dataset.name };
      if (connectionTypeId) opts.connectionTypeId = connectionTypeId;
      await RelationshipStore.createEdge(fromFactionId, "document", direction, opts);
      this.#closeConnPanel();
      this.render({ parts: ["content"] });
    });

    panel.querySelector(".mm-btn-cancel").addEventListener("click", () => this.#closeConnPanel());
    input.focus();
  }

  #connTypePickerHTML() {
    const types = this.#getConnectionTypes();
    const opts  = types.map(t =>
      `<option value="${t.id}">${foundry.utils.escapeHTML(t.name)}</option>`
    ).join("");
    return `
      <div class="mm-type-row">
        <span>Type:</span>
        <select class="mm-type-select" name="mm_type">
          <option value="">— None —</option>
          ${opts}
        </select>
      </div>`;
  }

  #connDirectionPickerHTML() {
    return `
      <div class="mm-direction-row">
        <span>Direction:</span>
        <label><input type="radio" name="mm_dir" value="one-way" checked> One-way</label>
        <label><input type="radio" name="mm_dir" value="two-way"> Two-way</label>
      </div>`;
  }

  #connSelectedDirection(panel) {
    return panel.querySelector('input[name="mm_dir"]:checked')?.value ?? "one-way";
  }

  #connSelectedType(panel) {
    return panel.querySelector('select[name="mm_type"]')?.value || null;
  }

  #closeConnPanel() {
    document.querySelectorAll(".ddf-conn-panel").forEach(el => el.remove());
  }

  #bindConnPanelDismiss(panel) {
    const handler = (e) => {
      if (!panel.contains(e.target)) {
        panel.remove();
        document.removeEventListener("mousedown", handler, true);
      }
    };
    setTimeout(() => document.addEventListener("mousedown", handler, true), 50);
  }

  // ─── Member Actions ───────────────────────────────────────────────────────────

  static #onAddMember(_event, target) {
    if (!this.#selectedFactionId) return;
    this.#showMemberAddPanel(target);
  }

  #showMemberAddPanel(triggerEl) {
    document.querySelectorAll(".ddf-member-add-panel").forEach(el => el.remove());

    const factionId = this.#selectedFactionId;
    const appRect   = this.element.getBoundingClientRect();
    const btnRect   = triggerEl.getBoundingClientRect();
    const PANEL_W   = 280;
    const GAP       = 8;

    const panel = document.createElement("div");
    panel.className  = "mm-search-panel ddf-member-add-panel";
    panel.style.position = "fixed";
    panel.style.zIndex   = "10000";

    const fitsRight = appRect.right + GAP + PANEL_W <= window.innerWidth;
    if (fitsRight) {
      panel.style.left = `${appRect.right + GAP}px`;
    } else {
      panel.style.right = `${window.innerWidth - appRect.left + GAP}px`;
    }
    panel.style.top = `${Math.min(btnRect.top, window.innerHeight - 40)}px`;

    // Actors already linked in this faction — skip showing them as selectable
    const linkedUuids = new Set(
      MemberStore.getMembersForFaction(factionId)
        .filter(m => m.actorUuid).map(m => m.actorUuid)
    );

    const actors = [...game.actors].sort((a, b) => a.name.localeCompare(b.name));

    panel.innerHTML = `
      <div class="mm-panel-title">Add Member</div>
      <input type="text" class="mm-search-input" placeholder="Search actors or enter a name…" autofocus />
      <div class="mm-search-results ddf-conn-faction-list">
        ${actors.length
          ? actors.map(a => `
              <div class="mm-search-result${linkedUuids.has(a.uuid) ? " ddf-already-linked" : ""}"
                   data-uuid="${a.uuid}">
                <i class="fa-solid fa-user ddf-link-icon"></i>
                <span>${foundry.utils.escapeHTML(a.name)}</span>
                ${linkedUuids.has(a.uuid) ? '<span class="ddf-linked-badge">already added</span>' : ""}
              </div>`).join("")
          : "<div class='mm-search-empty'>No actors in world</div>"
        }
      </div>
      <div class="ddf-member-add-actions">
        <button class="ddf-member-btn-unlinked" title="Add as an unlinked member using the name above">
          <i class="fa-solid fa-user-slash"></i> Create Unlinked
        </button>
        <button class="ddf-member-btn-new-actor" title="Create a new actor and add as member">
          <i class="fa-solid fa-user-plus"></i> Create New
        </button>
      </div>
    `;

    const input   = panel.querySelector(".mm-search-input");
    const results = panel.querySelector(".mm-search-results");

    // Live filter
    input.addEventListener("input", () => {
      const q = input.value.toLowerCase();
      results.querySelectorAll(".mm-search-result").forEach(el => {
        el.style.display = el.querySelector("span").textContent.toLowerCase().includes(q) ? "" : "none";
      });
    });

    // Link existing actor
    results.addEventListener("click", async (e) => {
      const el = e.target.closest(".mm-search-result");
      if (!el || el.classList.contains("ddf-already-linked")) return;
      const actor = await fromUuid(el.dataset.uuid);
      if (!actor) return;
      const member = await MemberStore.createMember(factionId, {
        name:      actor.name,
        actorUuid: el.dataset.uuid
      });
      this.#selectedMemberId = member.id;
      panel.remove();
      this.render({ parts: ["content"] });
    });

    // Create unlinked — use whatever text is in the input
    panel.querySelector(".ddf-member-btn-unlinked").addEventListener("click", async () => {
      const name   = input.value.trim() || "Unnamed Member";
      const member = await MemberStore.createMember(factionId, { name });
      this.#selectedMemberId = member.id;
      panel.remove();
      this.render({ parts: ["content"] });
    });

    // Create new actor, then link as member
    panel.querySelector(".ddf-member-btn-new-actor").addEventListener("click", async () => {
      const name = input.value.trim() || "New Actor";
      const type = await FactionDetailApp.#pickActorType();
      if (type === null) return; // cancelled
      const actor = await Actor.create({ name, type });
      if (!actor) return;
      const member = await MemberStore.createMember(factionId, {
        name:      actor.name,
        actorUuid: actor.uuid
      });
      this.#selectedMemberId = member.id;
      panel.remove();
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

  /**
   * Returns the actor type to use.
   * If the system has only one actor type, returns it immediately.
   * If multiple types exist, prompts the user to pick one.
   * Returns null if the user cancels.
   */
  static async #pickActorType() {
    const raw   = game.system.documentTypes?.Actor ?? {};
    const types = (Array.isArray(raw) ? raw : Object.keys(raw)).filter(t => t !== "base");
    if (types.length === 0) return "character"; // safe fallback
    if (types.length === 1) return types[0];

    // Build a localised label for each type
    const opts = types.map(t => {
      const raw   = CONFIG.Actor.typeLabels?.[t] ?? t;
      const label = game.i18n.localize(raw);
      return `<option value="${t}">${foundry.utils.escapeHTML(label)}</option>`;
    }).join("");

    return new Promise(resolve => {
      foundry.applications.api.DialogV2.prompt({
        window: { title: "Choose Actor Type" },
        content: `
          <div class="standard-form">
            <div class="form-group">
              <label>Type</label>
              <div class="form-fields">
                <select name="actor_type">${opts}</select>
              </div>
            </div>
          </div>`,
        ok: {
          label: "Create",
          callback: (_event, button) => resolve(button.form.elements.actor_type.value)
        },
        rejectClose: false
      }).catch(() => resolve(null));
    });
  }

  static async #onAddRank(_event, _target) {
    if (!this.#selectedFactionId) return;
    const maxOrder = MemberStore.getMaxOrder(this.#selectedFactionId);
    const result   = await FactionDetailApp.#promptRank("New Rank", null, maxOrder + 1);
    if (!result) return;
    await MemberStore.createRank(this.#selectedFactionId, result);
    this.render({ parts: ["content"] });
  }

  static #onSelectMember(_event, target) {
    const memberId = target.closest("[data-member-id]")?.dataset.memberId;
    if (!memberId || memberId === this.#selectedMemberId) return;
    this.#selectedMemberId = memberId;
    this.render({ parts: ["content"] });
  }

  static async #onEditRank(_event, target) {
    if (!this.#selectedFactionId) return;
    const rankId = target.closest("[data-rank-id]")?.dataset.rankId;
    if (!rankId) return;
    const { ranks } = MemberStore.getAll();
    const rank     = ranks[rankId];
    if (!rank) return;
    const maxOrder = MemberStore.getMaxOrder(this.#selectedFactionId);
    const result   = await FactionDetailApp.#promptRank("Edit Rank", rank, maxOrder);
    if (!result) return;
    await MemberStore.updateRank(rankId, result);
    this.render({ parts: ["content"] });
  }

  static async #onDeleteRank(_event, target) {
    const rankId = target.closest("[data-rank-id]")?.dataset.rankId;
    if (!rankId) return;
    const { ranks } = MemberStore.getAll();
    const rank = ranks[rankId];
    if (!rank) return;

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Delete Rank" },
      content: `<p>Delete rank <strong>${rank.name}</strong>? Members with this rank will become unranked.</p>`
    });
    if (!confirmed) return;

    await MemberStore.deleteRank(rankId);
    this.render({ parts: ["content"] });
  }

  static async #onDeleteMember(_event, _target) {
    if (!this.#selectedMemberId) return;
    const { members } = MemberStore.getAll();
    const member = members[this.#selectedMemberId];
    if (!member) return;

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Remove Member" },
      content: `<p>Remove <strong>${member.name}</strong> from this faction?</p>`
    });
    if (!confirmed) return;

    await MemberStore.deleteMember(this.#selectedMemberId);
    this.#selectedMemberId = null;
    this.render({ parts: ["content"] });
  }

  static async #onOpenMemberActor(_event, _target) {
    if (!this.#selectedMemberId) return;
    const { members } = MemberStore.getAll();
    const member = members[this.#selectedMemberId];
    if (!member?.actorUuid) return;
    try {
      const actor = await fromUuid(member.actorUuid);
      actor?.sheet?.render({ force: true });
    } catch { /* stale uuid */ }
  }

  static async #onUnlinkMemberActor(_event, _target) {
    if (!this.#selectedMemberId) return;
    await MemberStore.updateMember(this.#selectedMemberId, { actorUuid: null });
    this.render({ parts: ["content"] });
  }

  static #onLinkMemberActor(_event, target) {
    if (!this.#selectedMemberId) return;
    this.#showActorSearchPanel(target);
  }

  static async #onMoveMember(_event, _target) {
    if (!this.#selectedMemberId) return;
    const { members } = MemberStore.getAll();
    const member = members[this.#selectedMemberId];
    if (!member) return;

    const allFactions = FactionStore.getAll();
    const subFactions = Object.values(allFactions)
      .filter(f => f.parentId === this.#selectedFactionId)
      .sort((a, b) => a.name.localeCompare(b.name));

    const targets = [
      { id: this.#selectedFactionId, name: allFactions[this.#selectedFactionId]?.name ?? "Main Faction" },
      ...subFactions.map(f => ({ id: f.id, name: f.name }))
    ].filter(t => t.id !== member.factionId);

    if (!targets.length) return;

    const opts = targets.map(t =>
      `<option value="${t.id}">${foundry.utils.escapeHTML(t.name)}</option>`
    ).join("");

    const targetId = await new Promise(resolve => {
      foundry.applications.api.DialogV2.prompt({
        window: { title: "Move Member" },
        content: `
          <div class="standard-form">
            <div class="form-group">
              <label>Move to</label>
              <div class="form-fields">
                <select name="target">${opts}</select>
              </div>
            </div>
            <p class="hint">The member's rank will be cleared on move.</p>
          </div>`,
        ok: {
          label: "Move",
          callback: (_event, button) => resolve(button.form.elements.target.value)
        },
        rejectClose: false
      }).catch(() => resolve(null));
    });

    if (!targetId) return;
    await MemberStore.updateMember(this.#selectedMemberId, { factionId: targetId, rankId: null });
    this.render({ parts: ["content"] });
  }

  #showActorSearchPanel(triggerEl) {
    // Dismiss any existing panel
    document.querySelectorAll(".ddf-actor-search-panel").forEach(el => el.remove());

    const appRect = this.element.getBoundingClientRect();
    const btnRect = triggerEl.getBoundingClientRect();
    const PANEL_W = 260;
    const GAP     = 8;

    const panel = document.createElement("div");
    panel.className = "mm-search-panel ddf-actor-search-panel";
    panel.style.position = "fixed";
    panel.style.zIndex   = "10000";

    const fitsRight = appRect.right + GAP + PANEL_W <= window.innerWidth;
    if (fitsRight) {
      panel.style.left = `${appRect.right + GAP}px`;
    } else {
      panel.style.right = `${window.innerWidth - appRect.left + GAP}px`;
    }
    panel.style.top = `${Math.min(btnRect.top, window.innerHeight - 40)}px`;

    const actors = [...game.actors].sort((a, b) => a.name.localeCompare(b.name));
    panel.innerHTML = `
      <div class="mm-panel-title">Link Actor</div>
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
      await MemberStore.updateMember(this.#selectedMemberId, {
        actorUuid: el.dataset.uuid,
        name:      actor.name
      });
      panel.remove();
      this.render({ parts: ["content"] });
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

  // ─── Rank Prompt Dialog ───────────────────────────────────────────────────────

  static #promptRank(title, existing = null, defaultOrder = 1) {
    return new Promise(resolve => {
      const orderVal = existing?.order ?? defaultOrder;

      foundry.applications.api.DialogV2.prompt({
        window: { title },
        content: `
          <div class="standard-form">
            <div class="form-group">
              <label>Order</label>
              <div class="form-fields">
                <input type="number" name="rank_order" value="${orderVal}" min="1" step="1" style="width:80px;" />
              </div>
            </div>
            <div class="form-group">
              <label>Name</label>
              <div class="form-fields">
                <input type="text" name="rank_name" autofocus
                       value="${foundry.utils.escapeHTML(existing?.name ?? "")}"
                       placeholder="Rank name…" />
              </div>
            </div>
            <div class="form-group">
              <label>Description</label>
              <div class="form-fields">
                <textarea name="rank_desc" rows="3"
                          placeholder="Describe this rank…">${foundry.utils.escapeHTML(existing?.description ?? "")}</textarea>
              </div>
            </div>
          </div>`,
        ok: {
          label: existing ? "Save" : "Create",
          callback: (_event, button) => {
            const els = button.form.elements;
            resolve({
              order:       Math.max(1, parseInt(els.rank_order.value) || defaultOrder),
              name:        els.rank_name.value.trim() || "Rank",
              description: els.rank_desc.value.trim()
            });
          }
        },
        rejectClose: false
      }).catch(() => resolve(null));
    });
  }
}
