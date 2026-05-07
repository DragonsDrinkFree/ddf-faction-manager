import { FactionStore } from "../data/FactionStore.js";
import { RelationshipStore } from "../data/RelationshipStore.js";
import { MemberStore } from "../data/MemberStore.js";
import { MindMapRenderer, DOC_SIZE_PRESETS, NODE_KEY, parseNodeKey } from "./MindMapRenderer.js";
import { FactionDetailApp } from "./FactionDetailApp.js";
import { PartyDetailApp } from "./PartyDetailApp.js";
import {
  getConnectionTypes,
  connectionTypePickerHTML,
  connectionDirectionPickerHTML,
  readSelectedDirection,
  readSelectedType,
  bindPanelDismiss
} from "../utils/ConnectionPanelHelpers.js";
import { syncAllSandboxPartyMembers, isSandboxPresent, getActiveSandboxPartyId } from "../utils/SandboxIntegration.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class GlobalRelationshipsApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @type {GlobalRelationshipsApp|null} */
  static #instance = null;

  /** Currently selected faction ID, or null for neutral/overview mode. */
  #povFactionId = null;

  /** Set of parent faction IDs whose sub-factions are collapsed in the left pane. */
  #collapsedParents = new Set();

  /** Custom faction order — array of top-level faction IDs. null = alphabetical. */
  #factionOrder = null;

  /** @type {MindMapRenderer|null} */
  #mindMap = null;
  #resizeObserver = null;

  /** Saved pan/zoom transform across full re-renders. */
  #savedTransform = null;

  /** Bound hook handlers for cleanup in _onClose. */
  #onFactionsChanged    = null;
  #onRelationshipsChanged = null;
  #onMembersChanged     = null;

  static DEFAULT_OPTIONS = {
    id: "ddf-global-relationships",
    classes: ["ddf-global-relationships"],
    tag: "div",
    window: {
      title: "Faction Relationships",
      resizable: true,
      minimizable: true
    },
    position: {
      width: 900,
      height: 600
    },
    actions: {}
  };

  static PARTS = {
    content: {
      template: "modules/ddf-faction-manager/templates/global-relationships.hbs",
      scrollable: [".global-rel-faction-list"]
    }
  };

  constructor(options = {}) {
    super(options);

    // Faction additions/removals → full re-render (new nodes must appear)
    this.#onFactionsChanged = () => {
      if (this.rendered) this.render({ force: true });
    };

    // Relationship edge/pin changes → full re-render so left pane stays in sync
    this.#onRelationshipsChanged = () => {
      if (this.rendered) this.render({ force: true });
    };

    this.#onMembersChanged = () => {
      if (!this.rendered) return;
      this.#mindMap?.remount();
    };

    Hooks.on("ddf-factions-changed",      this.#onFactionsChanged);
    Hooks.on("ddf-relationships-changed", this.#onRelationshipsChanged);
    Hooks.on("ddf-members-changed",       this.#onMembersChanged);
  }

  static async show() {
    if (!game.user.isGM) return;
    // Reconcile every sandbox-linked party's roster before the map mounts
    await syncAllSandboxPartyMembers();
    if (!GlobalRelationshipsApp.#instance) {
      GlobalRelationshipsApp.#instance = new GlobalRelationshipsApp();
    }
    GlobalRelationshipsApp.#instance.render({ force: true });
  }

  // ─── Context ─────────────────────────────────────────────────────────────────

  /** @override */
  async _preparePartContext(partId, context, options) {
    context = await super._preparePartContext(partId, context, options);

    if (partId === "content") {
      const allFactions  = FactionStore.getAll();
      const customOrder  = this.#factionOrder;

      // Separate parties from regular factions
      const allParties       = Object.values(allFactions).filter(f => f.kind === "party");
      const decorateParty    = p => ({ ...p, isPOV: p.id === this.#povFactionId });

      // SCM-aware party split
      const scmPresent       = isSandboxPresent();
      const activeSbPartyId  = getActiveSandboxPartyId();
      const activePartyRecord = (scmPresent && activeSbPartyId)
        ? allParties.find(p => p.sandboxPartyId === activeSbPartyId) ?? null
        : null;

      if (scmPresent) {
        context.activeParty  = activePartyRecord ? decorateParty(activePartyRecord) : null;
        context.otherParties = allParties
          .filter(p => p.id !== activePartyRecord?.id)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(decorateParty);
      } else {
        context.activeParty  = null;
        context.otherParties = allParties
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(decorateParty);
      }
      context.scmPresent = scmPresent;

      // Top-level non-party factions sorted by custom order, then alphabetical fallback
      const topLevel = Object.values(allFactions)
        .filter(f => f.kind !== "party" && (!f.parentId || !allFactions[f.parentId]))
        .sort((a, b) => {
          if (customOrder) {
            const ia = customOrder.indexOf(a.id);
            const ib = customOrder.indexOf(b.id);
            if (ia !== -1 && ib !== -1) return ia - ib;
            if (ia !== -1) return -1;
            if (ib !== -1) return  1;
          }
          return a.name.localeCompare(b.name);
        });

      // Build flat ordered list: parent → its sub-factions (indented), then next parent…
      const orderedList = [];
      for (const parent of topLevel) {
        const subs = Object.values(allFactions)
          .filter(f => f.parentId === parent.id && f.kind !== "party")
          .sort((a, b) => a.name.localeCompare(b.name));

        orderedList.push({
          ...parent,
          isPOV:          parent.id === this.#povFactionId,
          isSubFaction:   false,
          hasSubFactions: subs.length > 0,
          isCollapsed:    this.#collapsedParents.has(parent.id),
          isHidden:       false
        });

        for (const sub of subs) {
          orderedList.push({
            ...sub,
            isPOV:          sub.id === this.#povFactionId,
            isSubFaction:   true,
            hasSubFactions: false,
            isCollapsed:    false,
            isHidden:       this.#collapsedParents.has(parent.id)
          });
        }
      }

      context.allFactions  = orderedList;
      context.povFactionId = this.#povFactionId;

      // ── Documents on the map (pinned OR have at least one faction edge) ───────
      const allEdges = RelationshipStore.getAll().edges;
      const pinned   = RelationshipStore.getPinnedDocuments();
      const docsByUuid = { ...pinned };
      for (const edge of Object.values(allEdges)) {
        if (edge.type !== "document" || !edge.documentUuid) continue;
        if (!docsByUuid[edge.documentUuid]) {
          docsByUuid[edge.documentUuid] = {
            uuid:         edge.documentUuid,
            documentType: edge.documentType ?? "Other",
            documentName: edge.documentName ?? edge.documentUuid
          };
        }
      }
      const typeIcons = {
        Actor: "fa-user", JournalEntry: "fa-book", Scene: "fa-map",
        Item: "fa-suitcase", RollTable: "fa-list"
      };
      context.mapDocuments = Object.values(docsByUuid)
        .sort((a, b) => (a.documentName ?? "").localeCompare(b.documentName ?? ""))
        .map(d => ({
          ...d,
          icon:       typeIcons[d.documentType] ?? "fa-file",
          isSelected: NODE_KEY.forDocument(d.uuid) === this.#povFactionId
        }));
    }

    return context;
  }

  // ─── Render Hook ─────────────────────────────────────────────────────────────

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);

    this.#teardownMindMap();

    const wrap = this.element.querySelector(".relationship-canvas-wrap");
    if (wrap) {
      this.#applyCanvasBackground(wrap);
      this.#mountMindMap(wrap);
    }

    // ── Collapse/expand sub-factions ──────────────────────────────────────────
    this.element.querySelectorAll(".global-rel-collapse-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.factionId;
        if (!id) return;
        if (this.#collapsedParents.has(id)) this.#collapsedParents.delete(id);
        else this.#collapsedParents.add(id);
        this.render({ force: true });
      });
    });

    // ── POV toggle (click on item row, not the collapse button) ──────────────
    this.element.querySelectorAll(".global-rel-faction-item, .global-rel-party-item").forEach(item => {
      item.addEventListener("click", () => {
        const factionId = item.dataset.factionId;
        if (factionId) this.#togglePOV(factionId);
      });
    });

    // ── Documents section: Add button ────────────────────────────────────────
    this.element.querySelector("[data-action='addDocument']")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.#closeFloatingPanels();
      const btn     = e.currentTarget;
      const btnRect = btn.getBoundingClientRect();
      const panel   = document.createElement("div");
      panel.className  = "mm-search-panel";
      panel.style.left = `${btnRect.right}px`;
      panel.style.top  = `${btnRect.bottom}px`;
      this.#showDocumentSearch(panel, null); // null = pin-only mode
      this.#appendFloating(panel);
      bindPanelDismiss(panel);
    });

    // ── Documents section: click to select on canvas ──────────────────────────
    this.element.querySelectorAll(".global-rel-doc-item").forEach(item => {
      item.addEventListener("click", (e) => {
        if (e.target.closest("[data-action='removeDocument']")) return;
        const uuid = item.dataset.uuid;
        if (uuid) this.#togglePOV(NODE_KEY.forDocument(uuid));
      });
    });

    // ── Documents section: remove from map ───────────────────────────────────
    this.element.querySelectorAll("[data-action='removeDocument']").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const uuid = btn.dataset.uuid;
        if (!uuid) return;
        // Remove pin AND all faction→document edges for this UUID
        await RelationshipStore.removeDocumentFromMap(uuid);
        if (this.#povFactionId === NODE_KEY.forDocument(uuid)) this.#povFactionId = null;
        // Hook fires ddf-relationships-changed → full re-render
      });
    });

    // ── Canvas: accept Foundry document drag-drop ─────────────────────────────
    if (wrap) {
      wrap.addEventListener("dragover", (e) => {
        if (e.dataTransfer.types.includes("text/plain")) e.preventDefault();
      });
      wrap.addEventListener("drop", async (e) => {
        e.preventDefault();
        let dragData;
        try { dragData = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
        const uuid = dragData.uuid
          ?? (dragData.type && dragData.id ? `${dragData.type}.${dragData.id}` : null);
        if (!uuid) return;
        const doc = await fromUuid(uuid);
        if (!doc) return;
        const docType = dragData.type ?? doc.constructor?.documentName ?? "Other";
        await RelationshipStore.pinDocument(uuid, docType, doc.name);
        // Hook fires → full re-render
      });
    }

    // ── Left-pane filter ─────────────────────────────────────────────────────
    const filterInput = this.element.querySelector(".global-rel-filter-input");
    filterInput?.addEventListener("input", () => {
      const q = filterInput.value.toLowerCase().trim();
      this.element.querySelectorAll(".global-rel-faction-item, .global-rel-party-item").forEach(el => {
        const match = !q || el.dataset.filterName?.toLowerCase().includes(q);
        el.style.display = match ? "" : "none";
      });
      this.element.querySelectorAll(".global-rel-doc-item").forEach(el => {
        const match = !q || el.dataset.filterName?.toLowerCase().includes(q);
        el.style.display = match ? "" : "none";
      });
      const docEmpty = this.element.querySelector(".global-rel-doc-empty");
      if (docEmpty) docEmpty.style.display = q ? "none" : "";
    });

    // ── Drag-to-reorder (top-level factions only) ─────────────────────────────
    this.#wireDragReorder();
  }

  /** Wire HTML5 drag-and-drop reordering for top-level faction rows. */
  #wireDragReorder() {
    const list = this.element.querySelector(".global-rel-faction-list");
    if (!list) return;

    let dragId   = null;
    let dragOver = null;

    const topItems = () => [...list.querySelectorAll(".global-rel-faction-item:not(.is-subfaction)")];

    list.querySelectorAll(".global-rel-faction-item:not(.is-subfaction)").forEach(item => {
      item.draggable = true;

      item.addEventListener("dragstart", (e) => {
        dragId = item.dataset.factionId;
        e.dataTransfer.effectAllowed = "move";
        item.classList.add("drag-source");
      });

      item.addEventListener("dragend", () => {
        item.classList.remove("drag-source");
        list.querySelectorAll(".drag-target").forEach(el => el.classList.remove("drag-target"));
        dragId   = null;
        dragOver = null;
      });

      item.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (dragOver !== item) {
          list.querySelectorAll(".drag-target").forEach(el => el.classList.remove("drag-target"));
          dragOver = item;
          item.classList.add("drag-target");
        }
      });

      item.addEventListener("drop", (e) => {
        e.preventDefault();
        const targetId = item.dataset.factionId;
        if (!dragId || dragId === targetId) return;

        const ids = topItems().map(el => el.dataset.factionId);
        const from = ids.indexOf(dragId);
        const to   = ids.indexOf(targetId);
        if (from === -1 || to === -1) return;

        ids.splice(from, 1);
        ids.splice(to, 0, dragId);
        this.#factionOrder = ids;
        this.render({ force: true });
      });
    });
  }

  /** @override */
  _onClose(options) {
    this.#teardownMindMap();
    if (this.#onFactionsChanged)      Hooks.off("ddf-factions-changed",      this.#onFactionsChanged);
    if (this.#onRelationshipsChanged) Hooks.off("ddf-relationships-changed", this.#onRelationshipsChanged);
    if (this.#onMembersChanged)       Hooks.off("ddf-members-changed",       this.#onMembersChanged);
    this.#onFactionsChanged      = null;
    this.#onRelationshipsChanged = null;
    this.#onMembersChanged       = null;
    GlobalRelationshipsApp.#instance = null;
    super._onClose(options);
  }

  // ─── Node Selection ───────────────────────────────────────────────────────────

  /**
   * Toggle the selected node. Clicking the active selection clears it (neutral mode).
   * For member_ keys, opens the actor sheet directly instead of selecting.
   * @param {string} factionId
   */
  #togglePOV(factionId) {
    this.#povFactionId = (this.#povFactionId === factionId) ? null : factionId;

    // Update left-pane CSS without a full re-render
    this.element.querySelectorAll(".global-rel-faction-item, .global-rel-party-item").forEach(el => {
      el.classList.toggle("selected", el.dataset.factionId === this.#povFactionId);
    });

    // Remount the mind map with the new POV (getters re-read fresh data)
    this.#mindMap?.remount();

    // Pan to centre on the newly selected node
    if (this.#povFactionId) {
      this.#mindMap?.centerOn(this.#povFactionId);
    }
  }

  // ─── Mind Map ────────────────────────────────────────────────────────────────

  #teardownMindMap() {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    if (this.#mindMap) {
      this.#savedTransform = this.#mindMap.getTransform();
      this.#mindMap.destroy();
      this.#mindMap = null;
    }
  }

  #applyCanvasBackground(wrap) {
    const bgImage = game.settings.get("ddf-faction-manager", "relationshipMapBg")      ?? "";
    const bgColor = game.settings.get("ddf-faction-manager", "relationshipMapBgColor") ?? "";
    if (bgImage) {
      wrap.style.backgroundImage    = `url("${bgImage}")`;
      wrap.style.backgroundSize     = "cover";
      wrap.style.backgroundPosition = "center";
      wrap.style.backgroundColor    = "";
    } else {
      wrap.style.backgroundImage = "";
      wrap.style.backgroundColor = bgColor || "";
    }
  }

  #mountMindMap(wrap) {
    // Use arrow functions to capture `this` (private fields require class scope)
    const getPOV = () => this.#povFactionId;
    const app    = this;

    this.#mindMap = new MindMapRenderer(wrap, {
      mode: "global",

      get povFactionId()          { return getPOV(); },
      get allFactions()           { return FactionStore.getAll(); },
      get edges()                 { return RelationshipStore.getAll().edges; },
      get members()               { return MemberStore.getAll().members; },
      get partyMembers() {
        const result = [];
        for (const f of Object.values(FactionStore.getAll())) {
          if (f.kind !== "party") continue;
          for (const m of (f.members ?? [])) result.push({ ...m, factionId: f.id });
        }
        return result;
      },
      get partyRetainers() {
        const result = [];
        for (const f of Object.values(FactionStore.getAll())) {
          if (f.kind !== "party") continue;
          for (const r of (f.retainers ?? [])) result.push({ ...r, factionId: f.id });
        }
        return result;
      },
      get pinnedDocuments()       { return RelationshipStore.getPinnedDocuments(); },
      get documentSizes()         { return RelationshipStore.getDocumentSizes(); },
      get positions()             { return RelationshipStore.getPositions("__global__"); },
      get statDefinitions() {
        try {
          const raw = game.settings.get("ddf-faction-manager", "statDefinitions");
          return typeof raw === "string" ? JSON.parse(raw) : (raw ?? []);
        } catch { return []; }
      },
      get nodeSizeDetermination() {
        return game.settings.get("ddf-faction-manager", "nodeSizeDetermination") ?? "average";
      },
      get connectionTypes()       { return getConnectionTypes(); },

      onPositionSave: (nodeKey, x, y) => {
        RelationshipStore.savePosition("__global__", nodeKey, x, y);
      },

      onContextMenu: (worldX, worldY, clientX, clientY) => {
        app.#showCanvasContextMenu(clientX, clientY, worldX, worldY);
      },

      onNodeContextMenu: (nodeKey, _edge, clientX, clientY) => {
        app.#showNodeContextMenu(nodeKey, clientX, clientY);
      },

      onSetPOV: (factionId) => {
        app.#togglePOV(factionId);
      },

      onConnectNodes: (fromKey, toKey, clientX, clientY) => {
        const from = app.#describeNode(fromKey);
        const to   = app.#describeNode(toKey);
        app.#closeFloatingPanels();
        if (from.isDocLike && to.isDocLike) {
          app.#showDocToDocConnectionPanel(from.uuid, from.name, to.uuid, to.name, clientX, clientY);
        } else if (from.kind === "faction" && to.isDocLike) {
          app.#showDirectDocumentConnectionPanel(from.factionId, to.uuid, to.docType, to.docName, clientX, clientY);
        } else if (from.isDocLike && to.kind === "faction") {
          app.#showDirectDocumentConnectionPanel(to.factionId, from.uuid, from.docType, from.docName, clientX, clientY);
        } else if (from.kind === "faction" && to.kind === "faction") {
          app.#showDirectConnectionPanel(from.factionId, to.factionId, clientX, clientY);
        }
      },

      onEdgeClick: (edgeId, clientX, clientY) => {
        app.#closeFloatingPanels();
        app.#showEdgePanel(edgeId, clientX, clientY);
      }
    });

    if (this.#savedTransform) {
      this.#mindMap.setTransform(this.#savedTransform);
      this.#savedTransform = null;
    }
    this.#mindMap.mount();

    this.#resizeObserver = new ResizeObserver(() => {
      if (this.#mindMap) this.#mindMap.remount();
    });
    this.#resizeObserver.observe(wrap);
  }

  // ─── Canvas Context Menu (Add Connection) ─────────────────────────────────────

  #showCanvasContextMenu(clientX, clientY, worldX = 0, worldY = 0) {
    this.#closeFloatingPanels();

    if (!this.#povFactionId) {
      // No POV: offer to create a new node (faction or document)
      const panel = document.createElement("div");
      panel.className  = "mm-search-panel";
      panel.style.left = `${clientX}px`;
      panel.style.top  = `${clientY}px`;
      panel.innerHTML = `
        <div class="mm-panel-title">Create / Add Node</div>
        <div class="mm-panel-options">
          <button class="mm-option" data-mode="faction">
            <i class="fa-solid fa-shield-halved"></i> New Faction
          </button>
          <button class="mm-option" data-mode="document">
            <i class="fa-solid fa-file"></i> Add Document
          </button>
        </div>
      `;
      panel.querySelector('[data-mode="faction"]').addEventListener("click", () => {
        panel.innerHTML = `
          <div class="mm-panel-title">New Faction</div>
          <input type="text" class="mm-search-input" placeholder="Faction name…" autofocus>
          <div class="mm-panel-actions">
            <button class="mm-btn-confirm">Create</button>
            <button class="mm-btn-cancel">Cancel</button>
          </div>
        `;
        const nameInput = panel.querySelector(".mm-search-input");
        panel.querySelector(".mm-btn-confirm").addEventListener("click", async () => {
          const name = nameInput.value.trim();
          if (!name) return;
          const faction = await FactionStore.create(name);
          await RelationshipStore.savePosition("__global__", faction.id, worldX, worldY);
          this.#closeFloatingPanels();
          this.render({ force: true });
        });
        nameInput.addEventListener("keydown", async (e) => {
          if (e.key === "Enter") panel.querySelector(".mm-btn-confirm").click();
        });
        panel.querySelector(".mm-btn-cancel").addEventListener("click", () => this.#closeFloatingPanels());
      });
      panel.querySelector('[data-mode="document"]').addEventListener("click", () => {
        this.#showDocumentSearch(panel, null);
      });
      this.#appendFloating(panel);
      bindPanelDismiss(panel);
      return;
    }

    const fromFactionId = this.#povFactionId;

    const panel = document.createElement("div");
    panel.className = "mm-search-panel";
    panel.style.left = `${clientX}px`;
    panel.style.top  = `${clientY}px`;

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

    panel.querySelector('[data-mode="faction"]').addEventListener("click", () => {
      this.#showFactionSearch(panel, fromFactionId);
    });
    panel.querySelector('[data-mode="document"]').addEventListener("click", () => {
      this.#showDocumentSearch(panel, fromFactionId);
    });

    this.#appendFloating(panel);
    bindPanelDismiss(panel);
  }

  #showFactionSearch(panel, fromFactionId) {
    const allFactions = FactionStore.getAll();
    const liveEdges   = RelationshipStore.getEdgesForFaction(fromFactionId);
    const connectedIds = new Set(
      liveEdges
        .filter(e => e.type === "faction")
        .map(e => e._reversed ? e.fromFactionId : e.toFactionId)
    );
    connectedIds.add(fromFactionId);

    const candidates = Object.values(allFactions).filter(f => !connectedIds.has(f.id));

    panel.innerHTML = `
      <div class="mm-panel-title">Link Faction</div>
      <input type="text" class="mm-search-input" placeholder="Filter factions…" autofocus />
      <div class="mm-search-results">
        ${candidates.length
          ? candidates.map(f => `<div class="mm-search-result" data-id="${f.id}">${foundry.utils.escapeHTML(f.name)}</div>`).join("")
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
      this.#closeFloatingPanels();
      this.#refreshMap();
    });

    panel.querySelector(".mm-btn-cancel").addEventListener("click", () => this.#closeFloatingPanels());
    input.focus();
  }

  /**
   * @param {HTMLElement} panel
   * @param {string|null} fromFactionId  null = pin-only (no edge created)
   */
  #showDocumentSearch(panel, fromFactionId) {
    const collections = [
      { type: "Actor",        icon: "fa-user",     col: game.actors  },
      { type: "JournalEntry", icon: "fa-book",     col: game.journal },
      { type: "Item",         icon: "fa-suitcase", col: game.items   },
      { type: "Scene",        icon: "fa-map",      col: game.scenes  },
      { type: "RollTable",    icon: "fa-list",     col: game.tables  }
    ];

    const docs = [];
    for (const { type, icon, col } of collections) {
      for (const doc of col) {
        docs.push({ uuid: doc.uuid, name: doc.name, type, icon });
      }
    }

    const pinOnly = fromFactionId === null;

    panel.innerHTML = `
      <div class="mm-panel-title">${pinOnly ? "Add Document to Map" : "Link Document"}</div>
      <input type="text" class="mm-search-input" placeholder="Filter documents…" autofocus />
      <div class="mm-search-results">
        ${docs.length
          ? docs.map(d => `
            <div class="mm-search-result" data-uuid="${d.uuid}" data-type="${d.type}" data-name="${foundry.utils.escapeHTML(d.name)}">
              <i class="fa-solid ${d.icon}"></i>
              ${foundry.utils.escapeHTML(d.name)}
              <span class="mm-result-type">${d.type}</span>
            </div>`).join("")
          : "<div class='mm-search-empty'>No documents found</div>"
        }
      </div>
      ${pinOnly ? "" : connectionTypePickerHTML()}
      ${pinOnly ? "" : connectionDirectionPickerHTML()}
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
      this.#closeFloatingPanels();
      if (pinOnly) {
        await RelationshipStore.pinDocument(el.dataset.uuid, el.dataset.type, el.dataset.name);
        // ddf-relationships-changed hook fires → full re-render
      } else {
        const direction        = readSelectedDirection(panel);
        const connectionTypeId = readSelectedType(panel);
        const opts = {
          documentUuid: el.dataset.uuid,
          documentType: el.dataset.type,
          documentName: el.dataset.name
        };
        if (connectionTypeId) opts.connectionTypeId = connectionTypeId;
        await RelationshipStore.createEdge(fromFactionId, "document", direction, opts);
        this.#refreshMap();
      }
    });

    panel.querySelector(".mm-btn-cancel").addEventListener("click", () => this.#closeFloatingPanels());
    input.focus();
  }

  // ─── Node Context Menu ────────────────────────────────────────────────────────

  /**
   * Resolves a node-key into a complete identity descriptor. Member nodes
   * that have a linked actorUuid are surfaced as `isDocLike: true` so they
   * participate in doc-to-doc linking the same way pinned documents do.
   *
   * Shape: { nodeKey, kind, isDocLike, uuid?, factionId?, memberId?, docType?, docName?, name }
   *   kind:       "faction" | "member" | "document" | "none"
   *   isDocLike:  true when relationship logic should treat this as a document
   *   name:       display name with a sensible fallback per kind
   */
  #describeNode(nodeKey) {
    const parsed = parseNodeKey(nodeKey);
    if (parsed.kind === "none") {
      return { nodeKey, kind: "none", isDocLike: false, name: null };
    }

    if (parsed.kind === "document") {
      const pinned = RelationshipStore.getPinnedDocuments();
      let docType = pinned[parsed.uuid]?.documentType ?? null;
      let docName = pinned[parsed.uuid]?.documentName ?? null;
      if (!docType) {
        const e = Object.values(RelationshipStore.getAll().edges)
          .find(e => e.type === "document" && e.documentUuid === parsed.uuid);
        docType = e?.documentType ?? null;
        docName = e?.documentName ?? null;
      }
      return {
        nodeKey, kind: "document", isDocLike: true,
        uuid: parsed.uuid, docType, docName,
        name: docName ?? "Document",
      };
    }

    if (parsed.kind === "member") {
      const member   = MemberStore.getAll().members?.[parsed.memberId];
      const hasActor = !!member?.actorUuid;
      return {
        nodeKey, kind: "member", isDocLike: hasActor,
        memberId: parsed.memberId,
        uuid:     hasActor ? member.actorUuid : null,
        docType:  hasActor ? "Actor" : null,
        docName:  hasActor ? (member.name ?? null) : null,
        name:     member?.name ?? "Member",
      };
    }

    // Faction (top-level or sub-faction — both use a plain id for the node key)
    const faction = FactionStore.getAll()[parsed.factionId];
    return {
      nodeKey, kind: "faction", isDocLike: false,
      factionId: parsed.factionId,
      name:      faction?.name ?? "Faction",
    };
  }

  #showNodeContextMenu(nodeKey, clientX, clientY) {
    this.#closeFloatingPanels();

    const menu = document.createElement("div");
    menu.className = "mm-node-menu";
    menu.style.left = `${clientX}px`;
    menu.style.top  = `${clientY}px`;

    const target = this.#describeNode(nodeKey);
    const pov    = this.#describeNode(this.#povFactionId);
    const isCurrent = nodeKey === this.#povFactionId;

    // Connection eligibility:
    //   - faction POV → can connect to any non-current node (faction OR doc-like)
    //   - doc-like POV → can link only to other doc-like nodes
    const hasFactionSelected = pov.kind === "faction" && !isCurrent;
    const hasDocToDoc        = pov.isDocLike && target.isDocLike && !isCurrent;
    const hasSelected        = hasFactionSelected || hasDocToDoc;

    const selectedName = hasSelected ? pov.name : null;
    const targetName   = target.name ?? "Target";

    // Find existing connections between POV and target (for inline display/delete)
    const types = getConnectionTypes();
    const existingEdges = hasSelected
      ? Object.values(RelationshipStore.getAll().edges).filter(e => {
          if (hasFactionSelected && !target.isDocLike && e.type === "faction") {
            return (e.fromFactionId === pov.factionId && e.toFactionId === nodeKey) ||
                   (e.fromFactionId === nodeKey && e.toFactionId === pov.factionId);
          }
          if (hasFactionSelected && target.isDocLike && e.type === "document") {
            return e.fromFactionId === pov.factionId && e.documentUuid === target.uuid;
          }
          if (hasDocToDoc && e.type === "doc-link") {
            return (e.fromDocUuid === pov.uuid && e.documentUuid === target.uuid) ||
                   (e.fromDocUuid === target.uuid && e.documentUuid === pov.uuid);
          }
          return false;
        })
      : [];

    // Document-only: resolve the current display size (raw px) for the size UI
    let currentPx = null, presets = null;
    if (target.isDocLike) {
      presets = DOC_SIZE_PRESETS[target.docType === "Scene" ? "scene" : "other"];
      const stored = RelationshipStore.getDocumentSizes()[target.uuid];
      if (typeof stored === "number")                                 currentPx = stored;
      else if (typeof stored === "string" && presets[stored] != null) currentPx = presets[stored]; // legacy
      else                                                            currentPx = presets.medium;
    }

    // ─── Build menu HTML ────────────────────────────────────────────────────
    const isScene        = target.docType === "Scene";
    const sheetLabel     = isScene ? "Load Scene"         : "Open Sheet";
    const sheetIcon      = isScene ? "fa-solid fa-map"    : "fa-solid fa-arrow-up-right-from-square";
    // Size controls shown only when inspecting in isolation: no node selected, or this node IS selected
    const showSizeControls = target.isDocLike && (!this.#povFactionId || isCurrent);

    let menuHTML = `
      <button class="mm-node-menu-item" data-action="open-sheet">
        <i class="${sheetIcon}"></i> ${sheetLabel}
      </button>
    `;

    if (showSizeControls) {
      const sliderMin = Math.round(presets.small * 0.5);
      const sliderMax = Math.round(presets.large * 2);
      menuHTML += `
        <div class="mm-node-menu-divider"></div>
        <div class="mm-node-menu-section-label">Size</div>
        <div class="mm-doc-size-row">
          <button class="mm-doc-size-btn${currentPx === presets.small  ? " mm-active" : ""}" data-size-px="${presets.small}">S</button>
          <button class="mm-doc-size-btn${currentPx === presets.medium ? " mm-active" : ""}" data-size-px="${presets.medium}">M</button>
          <button class="mm-doc-size-btn${currentPx === presets.large  ? " mm-active" : ""}" data-size-px="${presets.large}">L</button>
        </div>
        <div class="mm-doc-size-slider-row">
          <input type="range" class="mm-doc-size-slider" min="${sliderMin}" max="${sliderMax}" value="${currentPx}" data-uuid="${target.uuid}">
          <span class="mm-doc-size-value">${currentPx}px</span>
        </div>`;
    }

    if (hasSelected) {
      if (existingEdges.length) {
        menuHTML += `<div class="mm-node-menu-divider"></div>
          <div class="mm-node-menu-section-label">Connections</div>`;
        for (const edge of existingEdges) {
          const isOutgoing = edge.fromFactionId === this.#povFactionId;
          const typeName   = types.find(t => t.id === edge.connectionTypeId)?.name ?? "(no type)";
          const dirHTML    = isOutgoing
            ? `${foundry.utils.escapeHTML(selectedName)} &rarr; ${foundry.utils.escapeHTML(targetName)}`
            : `${foundry.utils.escapeHTML(targetName)} &rarr; ${foundry.utils.escapeHTML(selectedName)}`;
          menuHTML += `
            <div class="mm-node-menu-edge-item" data-edge-id="${edge.id}">
              <span class="mm-edge-item-dir">${dirHTML}:</span>
              <span class="mm-edge-item-type">${foundry.utils.escapeHTML(typeName)}</span>
              <button class="mm-edge-item-delete" data-edge-id="${edge.id}" title="Delete connection">
                <i class="fa-solid fa-trash-can"></i>
              </button>
            </div>`;
        }
        menuHTML += `<div class="mm-node-menu-divider"></div>`;
      }
      menuHTML += `
        <button class="mm-node-menu-item" data-action="connect-to-selected">
          <i class="fa-solid fa-plus"></i> Create Connection to ${foundry.utils.escapeHTML(targetName)}
        </button>`;
    }

    menuHTML += `
      <button class="mm-node-menu-item" data-action="toggle-pov">
        <i class="fa-solid fa-crosshairs"></i> ${isCurrent ? "Deselect Node" : "Select Node"}
      </button>`;
    menu.innerHTML = menuHTML;

    // ─── Wire event handlers ────────────────────────────────────────────────
    menu.querySelector('[data-action="open-sheet"]').addEventListener("click", async () => {
      this.#closeFloatingPanels();
      if (target.isDocLike) {
        const doc = await fromUuid(target.uuid);
        if (isScene) {
          doc?.activate();
        } else {
          doc?.sheet?.render(true);
        }
      } else {
        const faction = FactionStore.getAll()[nodeKey];
        if (faction?.kind === "party") {
          PartyDetailApp.show(nodeKey);
        } else {
          FactionDetailApp.show(nodeKey);
        }
      }
    });

    if (showSizeControls) {
      menu.querySelectorAll(".mm-doc-size-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          const px = parseInt(btn.dataset.sizePx, 10);
          await RelationshipStore.setDocumentSize(target.uuid, px);
          this.#closeFloatingPanels();
          this.render({ force: true });
        });
      });

      const slider       = menu.querySelector(".mm-doc-size-slider");
      const valueDisplay = menu.querySelector(".mm-doc-size-value");
      slider?.addEventListener("input", () => {
        valueDisplay.textContent = `${slider.value}px`;
      });
      slider?.addEventListener("change", async () => {
        const px = parseInt(slider.value, 10);
        await RelationshipStore.setDocumentSize(target.uuid, px);
        this.render({ force: true });
      });
    }

    menu.querySelectorAll(".mm-edge-item-delete").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await RelationshipStore.deleteEdge(btn.dataset.edgeId);
        this.#closeFloatingPanels();
        this.#refreshMap();
      });
    });

    if (hasSelected) {
      menu.querySelector('[data-action="connect-to-selected"]').addEventListener("click", () => {
        this.#closeFloatingPanels();
        if (hasDocToDoc) {
          this.#showDocToDocConnectionPanel(
            pov.uuid, selectedName, target.uuid, targetName, clientX, clientY
          );
        } else if (target.isDocLike) {
          this.#showDirectDocumentConnectionPanel(
            pov.factionId, target.uuid, target.docType, target.docName, clientX, clientY
          );
        } else {
          this.#showDirectConnectionPanel(pov.factionId, nodeKey, clientX, clientY);
        }
      });
    }

    menu.querySelector('[data-action="toggle-pov"]').addEventListener("click", () => {
      this.#closeFloatingPanels();
      this.#togglePOV(nodeKey);
    });

    this.#appendFloating(menu);
    bindPanelDismiss(menu);
  }

  /**
   * Shared picker panel for creating any kind of connection edge.
   * Renders title, from→to header, type picker, direction picker, and
   * delegates edge creation to the caller via onConfirm.
   *
   * @param {object} opts
   * @param {string} opts.title           panel title text
   * @param {string} opts.fromName        left-hand name
   * @param {string} opts.toName          right-hand name
   * @param {string} [opts.arrow]         HTML arrow glyph (default &rarr;)
   * @param {number} opts.clientX
   * @param {number} opts.clientY
   * @param {(args: { direction: string, connectionTypeId: string|null }) => Promise<any>} opts.onConfirm
   */
  #showConnectionPanel({ title, fromName, toName, arrow = "&rarr;", clientX, clientY, onConfirm }) {
    const panel = document.createElement("div");
    panel.className  = "mm-search-panel";
    panel.style.left = `${clientX}px`;
    panel.style.top  = `${clientY}px`;

    panel.innerHTML = `
      <div class="mm-panel-title">${foundry.utils.escapeHTML(title)}</div>
      <p class="mm-panel-hint-text">
        <strong>${foundry.utils.escapeHTML(fromName)}</strong>
        ${arrow}
        <strong>${foundry.utils.escapeHTML(toName)}</strong>
      </p>
      ${connectionTypePickerHTML()}
      ${connectionDirectionPickerHTML()}
      <div class="mm-panel-actions">
        <button class="mm-btn-confirm">Create</button>
        <button class="mm-btn-cancel">Cancel</button>
      </div>
    `;

    panel.querySelector(".mm-btn-confirm").addEventListener("click", async () => {
      const direction        = readSelectedDirection(panel);
      const connectionTypeId = readSelectedType(panel);
      await onConfirm({ direction, connectionTypeId });
      this.#closeFloatingPanels();
      this.#refreshMap();
    });

    panel.querySelector(".mm-btn-cancel").addEventListener("click", () => this.#closeFloatingPanels());
    this.#appendFloating(panel);
    bindPanelDismiss(panel);
  }

  /**
   * Create a faction → faction edge via the shared connection panel.
   * Used when right-clicking a faction node while another faction is selected.
   */
  #showDirectConnectionPanel(fromFactionId, toFactionId, clientX, clientY) {
    const allFactions = FactionStore.getAll();
    this.#showConnectionPanel({
      title: "Connect Factions",
      fromName: allFactions[fromFactionId]?.name ?? "Selected",
      toName:   allFactions[toFactionId]?.name   ?? "Target",
      clientX, clientY,
      onConfirm: ({ direction, connectionTypeId }) => {
        const opts = { toFactionId };
        if (connectionTypeId) opts.connectionTypeId = connectionTypeId;
        return RelationshipStore.createEdge(fromFactionId, "faction", direction, opts);
      }
    });
  }

  /**
   * Create a faction → document edge via the shared connection panel.
   * @param {string} fromFactionId
   * @param {string} uuid          resolved document UUID (actorUuid for members)
   * @param {string} docType       e.g. "Actor", "JournalEntry"
   * @param {string} docName       display name
   */
  #showDirectDocumentConnectionPanel(fromFactionId, uuid, docType, docName, clientX, clientY) {
    const fromName = FactionStore.getAll()[fromFactionId]?.name ?? "Selected";
    const finalDocName = docName ?? uuid;
    const finalDocType = docType ?? "Other";
    this.#showConnectionPanel({
      title: "Connect to Document",
      fromName,
      toName: finalDocName,
      clientX, clientY,
      onConfirm: ({ direction, connectionTypeId }) => {
        const opts = { documentUuid: uuid, documentType: finalDocType, documentName: finalDocName };
        if (connectionTypeId) opts.connectionTypeId = connectionTypeId;
        return RelationshipStore.createEdge(fromFactionId, "document", direction, opts);
      }
    });
  }

  /** Create a document ↔ document link edge via the shared connection panel. */
  #showDocToDocConnectionPanel(fromUuid, fromName, toUuid, toName, clientX, clientY) {
    this.#showConnectionPanel({
      title: "Link Documents",
      fromName, toName,
      arrow: "&harr;",
      clientX, clientY,
      onConfirm: ({ direction, connectionTypeId }) => {
        const opts = { fromDocUuid: fromUuid, documentUuid: toUuid };
        if (connectionTypeId) opts.connectionTypeId = connectionTypeId;
        return RelationshipStore.createEdge(null, "doc-link", direction, opts);
      }
    });
  }

  // ─── Edge Click Panel ────────────────────────────────────────────────────────

  /** Opens a panel to edit (type, direction) or delete an existing connection edge. */
  #showEdgePanel(edgeId, clientX, clientY) {
    const edge = RelationshipStore.getAll().edges[edgeId];
    if (!edge) return;

    const panel = document.createElement("div");
    panel.className  = "mm-search-panel";
    panel.style.left = `${clientX}px`;
    panel.style.top  = `${clientY}px`;

    panel.innerHTML = `
      <div class="mm-panel-title">Edit Connection</div>
      ${connectionTypePickerHTML()}
      ${connectionDirectionPickerHTML()}
      <div class="mm-panel-actions">
        <button class="mm-btn-confirm">Save</button>
        <button class="mm-btn-delete"><i class="fa-solid fa-trash-can"></i> Delete</button>
        <button class="mm-btn-cancel">Cancel</button>
      </div>
    `;

    // Pre-select the edge's current values
    const typeSelect = panel.querySelector('select[name="mm_type"]');
    if (edge.connectionTypeId) typeSelect.value = edge.connectionTypeId;

    const dirInput = panel.querySelector(`input[name="mm_dir"][value="${edge.direction}"]`);
    if (dirInput) dirInput.checked = true;

    panel.querySelector(".mm-btn-confirm").addEventListener("click", async () => {
      const direction        = readSelectedDirection(panel);
      const connectionTypeId = readSelectedType(panel);
      await RelationshipStore.updateEdgeConnectionType(edgeId, connectionTypeId);
      await RelationshipStore.updateEdgeDirection(edgeId, direction);
      this.#closeFloatingPanels();
      this.#refreshMap();
    });

    panel.querySelector(".mm-btn-delete").addEventListener("click", async () => {
      await RelationshipStore.deleteEdge(edgeId);
      this.#closeFloatingPanels();
      this.#refreshMap();
    });

    panel.querySelector(".mm-btn-cancel").addEventListener("click", () => this.#closeFloatingPanels());
    this.#appendFloating(panel);
    bindPanelDismiss(panel);
  }

  // ─── Map Refresh ─────────────────────────────────────────────────────────────

  /** Full data + visual refresh after a store mutation. */
  #refreshMap() {
    this.render({ force: true });
  }

  // ─── Floating Panel Utilities ─────────────────────────────────────────────────

  #closeFloatingPanels() {
    document.querySelectorAll(".ddf-fm-floating").forEach(el => el.remove());
  }

  /** Appends a floating panel/menu to document.body so it can overflow the app window. */
  #appendFloating(el) {
    el.classList.add("ddf-fm-floating");
    document.body.appendChild(el);
    requestAnimationFrame(() => {
      const r = el.getBoundingClientRect();
      if (r.right  > window.innerWidth)  el.style.left = `${window.innerWidth  - r.width  - 8}px`;
      if (r.bottom > window.innerHeight) el.style.top  = `${window.innerHeight - r.height - 8}px`;
      if (r.left < 0) el.style.left = "8px";
      if (r.top  < 0) el.style.top  = "8px";
    });
  }
}
