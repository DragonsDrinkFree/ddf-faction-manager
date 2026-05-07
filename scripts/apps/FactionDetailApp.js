import { FactionStore } from "../data/FactionStore.js";
import { ProjectStore } from "../data/ProjectStore.js";
import { RelationshipStore } from "../data/RelationshipStore.js";
import { MemberStore } from "../data/MemberStore.js";
import { EventLogStore } from "../data/EventLogStore.js";
import { BaseDetailApp } from "./BaseDetailApp.js";
import {
  getConnectionTypes,
  positionPanelBesideApp
} from "../utils/ConnectionPanelHelpers.js";
import { buildProjectContext, buildSelectedProjectContext } from "../utils/ProjectContext.js";

export class FactionDetailApp extends BaseDetailApp {
  /** @type {Map<string, FactionDetailApp>} factionId → open instance */
  static #instances = new Map();
  static get instances() { return FactionDetailApp.#instances; }
  static idPrefix      = "ddf-faction-detail";
  static fallbackTitle = "Faction";

  #selectedMemberId = null;

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
      ...BaseDetailApp.SHARED_ACTIONS,
      openJournal:       FactionDetailApp.#onOpenJournal,
      breakParentLink:   FactionDetailApp.#onBreakParentLink,
      addMember:         FactionDetailApp.#onAddMember,
      addRank:           FactionDetailApp.#onAddRank,
      selectMember:      FactionDetailApp.#onSelectMember,
      editRank:          FactionDetailApp.#onEditRank,
      deleteRank:        FactionDetailApp.#onDeleteRank,
      deleteMember:      FactionDetailApp.#onDeleteMember,
      openMemberActor:   FactionDetailApp.#onOpenMemberActor,
      unlinkMemberActor: FactionDetailApp.#onUnlinkMemberActor,
      linkMemberActor:   FactionDetailApp.#onLinkMemberActor,
      moveMember:        FactionDetailApp.#onMoveMember,
      addTag:            FactionDetailApp.#onAddTag,
      deleteTag:         FactionDetailApp.#onDeleteTag,
      addSecret:         FactionDetailApp.#onAddSecret,
      deleteSecret:      FactionDetailApp.#onDeleteSecret,
      addRumor:          FactionDetailApp.#onAddRumor,
      deleteRumor:       FactionDetailApp.#onDeleteRumor
    }
  };

  static PARTS = {
    content: {
      template: "modules/ddf-faction-manager/templates/faction-detail.hbs",
      scrollable: [
        ".faction-journal-body",
        ".faction-connections-body",
        ".project-notes-log",
        ".project-items",
        ".event-log-list"
      ]
    }
  };

  // ─── Context ─────────────────────────────────────────────────────────────────

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.activeTab = this._activeTab;
    context.tabs = [
      { id: "overview",  label: "Overview",   icon: "fa-solid fa-scroll",      cssClass: this._activeTab === "overview"  ? "active" : "" },
      { id: "projects",  label: "Objectives", icon: "fa-solid fa-list-check",  cssClass: this._activeTab === "projects"  ? "active" : "" },
      { id: "members",   label: "Members",    icon: "fa-solid fa-users",       cssClass: this._activeTab === "members"   ? "active" : "" },
      { id: "eventlog",  label: "Event Log",  icon: "fa-solid fa-clock-rotate-left", cssClass: this._activeTab === "eventlog" ? "active" : "" }
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

    // Overview: header stats + journal body + connections list
    const rawStats = game.settings.get("ddf-faction-manager", "statDefinitions");
    context.statDefinitions = (() => {
      try { return typeof rawStats === "string" ? JSON.parse(rawStats) : (rawStats ?? []); }
      catch { return []; }
    })();
    context.factionStats = context.selectedFaction?.stats ?? {};
    context.journalContent    = await this.#getJournalContent();
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

    // Members tab
    const memberCtx = await this.#buildMembersContext();
    context.membersByRank       = memberCtx.membersByRank;
    context.factionRanks        = memberCtx.factionRanks;
    context.subFactionSections  = memberCtx.subFactionSections;
    context.selectedMemberId    = this.#selectedMemberId;
    context.selectedMember      = await this.#buildSelectedMemberContext();

    // Tags, secrets, rumors (Overview tab)
    const sf = context.selectedFaction;
    context.factionTags = sf?.tags ?? [];
    context.allTags     = FactionStore.getAllTags();
    context.secrets     = sf?.secrets ?? [];
    context.rumors      = sf?.rumors  ?? [];

    // Event Log tab
    context.eventLogEntries = this._selectedFactionId
      ? EventLogStore.getForFaction(this._selectedFactionId).map(e => ({
          ...e,
          formattedTime: new Date(e.timestamp).toLocaleString()
        }))
      : [];

    return context;
  }

  // ─── Relationship Items (read-only list for Overview pane) ────────────────────

  #buildRelationshipItems() {
    const allFactions = FactionStore.getAll();
    const faction     = allFactions[this._selectedFactionId];
    const storedEdges = RelationshipStore.getEdgesForFaction(this._selectedFactionId);

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
      .filter(f => f.parentId === this._selectedFactionId)
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
    const connectionTypes = getConnectionTypes();

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
        if (!this._selectedFactionId) return;
        const statId  = e.target.dataset.statId;
        const value   = e.target.value.trim();
        const faction = FactionStore.getAll()[this._selectedFactionId];
        if (!faction) return;
        const stats = { ...(faction.stats ?? {}), [statId]: value };
        await FactionStore.update(this._selectedFactionId, { stats });
      });
    });

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
        const rankId = e.target.value || null;
        await MemberStore.updateMember(this.#selectedMemberId, { rankId });
        const { members, ranks } = MemberStore.getAll();
        const memberName = members[this.#selectedMemberId]?.name ?? "Member";
        const rankName   = rankId ? (ranks[rankId]?.name ?? "Unknown") : "Unranked";
        await this._logEvent("member", `${memberName}'s rank changed to: ${rankName}`, "scmMemberRankChanged");
        this.render({ parts: ["content"] });
      });
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  async #getJournalContent() {
    if (!this._selectedFactionId) return null;
    const faction = FactionStore.getAll()[this._selectedFactionId];
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
    tmp.querySelectorAll(`.ddf-faction-link[data-faction-id="${this._selectedFactionId}"]`).forEach(el => {
      const p = el.parentElement;
      el.remove();
      if (p?.tagName === "P" && !p.textContent.trim()) p.remove();
    });
    return tmp.innerHTML;
  }

  async #buildMembersContext() {
    if (!this._selectedFactionId) return { membersByRank: [], factionRanks: [], subFactionSections: [] };

    const ranks   = MemberStore.getRanksForFaction(this._selectedFactionId);
    const members = MemberStore.getMembersForFaction(this._selectedFactionId);

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
      .filter(f => f.parentId === this._selectedFactionId)
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
    const mainFaction   = allFactions[this._selectedFactionId];
    const subFactions   = Object.values(allFactions)
      .filter(f => f.parentId === this._selectedFactionId)
      .sort((a, b) => a.name.localeCompare(b.name));
    const moveTargets = [
      { id: this._selectedFactionId, name: mainFaction?.name ?? "Main Faction" },
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

  // ─── Action Handlers ─────────────────────────────────────────────────────────

  static #onOpenJournal(_event, _target) {
    const journal = FactionStore.getFactionJournal();
    if (!journal) return;
    journal.sheet.render({ force: true });
  }

  /**
   * Offer the GM a choice when breaking the parent-faction link:
   *   • Break completely  — removes parentId, no replacement edge
   *   • Keep as connection — removes parentId, adds a two-way faction edge
   */
  static async #onBreakParentLink(_event, target) {
    const factionId = this._selectedFactionId;
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

  // ─── Member Actions ───────────────────────────────────────────────────────────

  static #onAddMember(_event, target) {
    if (!this._selectedFactionId) return;
    this.#showMemberAddPanel(target);
  }

  #showMemberAddPanel(triggerEl) {
    document.querySelectorAll(".ddf-member-add-panel").forEach(el => el.remove());

    const factionId = this._selectedFactionId;

    const panel = document.createElement("div");
    panel.className  = "mm-search-panel ddf-member-add-panel";
    panel.style.position = "fixed";
    panel.style.zIndex   = "10000";
    positionPanelBesideApp(panel, this.element, triggerEl, 280);

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
      await this._logEvent("member", `Member added: ${member.name}`, "scmMemberAdded");
      panel.remove();
      this.render({ parts: ["content"] });
    });

    // Create unlinked — use whatever text is in the input
    panel.querySelector(".ddf-member-btn-unlinked").addEventListener("click", async () => {
      const name   = input.value.trim() || "Unnamed Member";
      const member = await MemberStore.createMember(factionId, { name });
      this.#selectedMemberId = member.id;
      await this._logEvent("member", `Member added: ${member.name}`, "scmMemberAdded");
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
      await this._logEvent("member", `Member added: ${member.name}`, "scmMemberAdded");
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
    if (!this._selectedFactionId) return;
    const maxOrder = MemberStore.getMaxOrder(this._selectedFactionId);
    const result   = await FactionDetailApp.#promptRank("New Rank", null, maxOrder + 1);
    if (!result) return;
    await MemberStore.createRank(this._selectedFactionId, result);
    this.render({ parts: ["content"] });
  }

  static #onSelectMember(_event, target) {
    const memberId = target.closest("[data-member-id]")?.dataset.memberId;
    if (!memberId || memberId === this.#selectedMemberId) return;
    this.#selectedMemberId = memberId;
    this.render({ parts: ["content"] });
  }

  static async #onEditRank(_event, target) {
    if (!this._selectedFactionId) return;
    const rankId = target.closest("[data-rank-id]")?.dataset.rankId;
    if (!rankId) return;
    const { ranks } = MemberStore.getAll();
    const rank     = ranks[rankId];
    if (!rank) return;
    const maxOrder = MemberStore.getMaxOrder(this._selectedFactionId);
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

    await this._logEvent("member", `Member removed: ${member.name}`, "scmMemberRemoved");
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
      .filter(f => f.parentId === this._selectedFactionId)
      .sort((a, b) => a.name.localeCompare(b.name));

    const targets = [
      { id: this._selectedFactionId, name: allFactions[this._selectedFactionId]?.name ?? "Main Faction" },
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

    const panel = document.createElement("div");
    panel.className = "mm-search-panel ddf-actor-search-panel";
    panel.style.position = "fixed";
    panel.style.zIndex   = "10000";
    positionPanelBesideApp(panel, this.element, triggerEl, 260);

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

  // ─── Tag Actions ─────────────────────────────────────────────────────────────

  static #onAddTag(_event, target) {
    if (!this._selectedFactionId) return;
    this.#showTagAddPanel(target);
  }

  static async #onDeleteTag(_event, target) {
    const tag = target.dataset.tag;
    if (!tag || !this._selectedFactionId) return;
    const faction = FactionStore.getAll()[this._selectedFactionId];
    if (!faction) return;
    const tags = (faction.tags ?? []).filter(t => t !== tag);
    await FactionStore.update(this._selectedFactionId, { tags });
    this.render({ parts: ["content"] });
  }

  #showTagAddPanel(triggerEl) {
    document.querySelectorAll(".ddf-tag-panel").forEach(el => el.remove());

    const factionId   = this._selectedFactionId;
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

  // ─── Secrets / Rumors Actions ─────────────────────────────────────────────────
  // TODO: Future refactor — consider richer entry types (visibility toggle, source attribution,
  //   PC-knowledge tracking). For now this is deliberately minimal: plain text, add/delete only.

  static async #onAddSecret(_event, _target) {
    if (!this._selectedFactionId) return;
    const text = await FactionDetailApp.#promptSingleText("Add Secret", "Secret");
    if (!text) return;
    const faction  = FactionStore.getAll()[this._selectedFactionId];
    const secrets  = [...(faction?.secrets ?? []), { id: foundry.utils.randomID(), text }];
    await FactionStore.update(this._selectedFactionId, { secrets });
    this.render({ parts: ["content"] });
  }

  static async #onDeleteSecret(_event, target) {
    const id = target.dataset.secretId;
    if (!id || !this._selectedFactionId) return;
    const faction = FactionStore.getAll()[this._selectedFactionId];
    const secrets = (faction?.secrets ?? []).filter(s => s.id !== id);
    await FactionStore.update(this._selectedFactionId, { secrets });
    this.render({ parts: ["content"] });
  }

  static async #onAddRumor(_event, _target) {
    if (!this._selectedFactionId) return;
    const text = await FactionDetailApp.#promptSingleText("Add Rumor", "Rumor");
    if (!text) return;
    const faction = FactionStore.getAll()[this._selectedFactionId];
    const rumors  = [...(faction?.rumors ?? []), { id: foundry.utils.randomID(), text }];
    await FactionStore.update(this._selectedFactionId, { rumors });
    this.render({ parts: ["content"] });
  }

  static async #onDeleteRumor(_event, target) {
    const id = target.dataset.rumorId;
    if (!id || !this._selectedFactionId) return;
    const faction = FactionStore.getAll()[this._selectedFactionId];
    const rumors  = (faction?.rumors ?? []).filter(r => r.id !== id);
    await FactionStore.update(this._selectedFactionId, { rumors });
    this.render({ parts: ["content"] });
  }

  static #promptSingleText(title, label) {
    return new Promise(resolve => {
      foundry.applications.api.DialogV2.prompt({
        window: { title },
        content: `<div class="standard-form"><div class="form-group"><label>${label}</label><div class="form-fields"><textarea name="entry_text" rows="3" autofocus placeholder="${label}…"></textarea></div></div></div>`,
        ok: {
          label: "Add",
          callback: (_event, button) => {
            const value = button.form.elements.entry_text.value.trim();
            resolve(value || null);
          }
        },
        rejectClose: false
      }).catch(() => resolve(null));
    });
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
