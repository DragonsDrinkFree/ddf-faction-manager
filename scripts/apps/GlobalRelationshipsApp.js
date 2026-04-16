import { FactionStore } from "../data/FactionStore.js";
import { RelationshipStore } from "../data/RelationshipStore.js";
import { MemberStore } from "../data/MemberStore.js";
import { MindMapRenderer } from "./MindMapRenderer.js";
import { FactionDetailApp } from "./FactionDetailApp.js";

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
      if (this.rendered) this.#mindMap?.remount();
    };

    Hooks.on("ddf-factions-changed",      this.#onFactionsChanged);
    Hooks.on("ddf-relationships-changed", this.#onRelationshipsChanged);
    Hooks.on("ddf-members-changed",       this.#onMembersChanged);
  }

  static show() {
    if (!game.user.isGM) return;
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

      // Top-level factions sorted by custom order, then alphabetical fallback
      const topLevel = Object.values(allFactions)
        .filter(f => !f.parentId || !allFactions[f.parentId])
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
          .filter(f => f.parentId === parent.id)
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
          isSelected: `doc_${d.uuid}` === this.#povFactionId
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
    this.element.querySelectorAll(".global-rel-faction-item").forEach(item => {
      item.addEventListener("click", () => {
        const factionId = item.dataset.factionId;
        if (factionId) this.#togglePOV(factionId);
      });
    });

    // ── Documents section: Add button ────────────────────────────────────────
    this.element.querySelector("[data-action='addDocument']")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.#closeFloatingPanels();
      const appRect = this.element.getBoundingClientRect();
      const btn     = e.currentTarget;
      const btnRect = btn.getBoundingClientRect();
      const panel   = document.createElement("div");
      panel.className  = "mm-search-panel";
      panel.style.left = `${btnRect.right - appRect.left}px`;
      panel.style.top  = `${btnRect.bottom - appRect.top}px`;
      this.#showDocumentSearch(panel, null); // null = pin-only mode
      this.element.appendChild(panel);
      this.#bindPanelDismiss(panel);
    });

    // ── Documents section: click to select on canvas ──────────────────────────
    this.element.querySelectorAll(".global-rel-doc-item").forEach(item => {
      item.addEventListener("click", (e) => {
        if (e.target.closest("[data-action='removeDocument']")) return;
        const uuid = item.dataset.uuid;
        if (uuid) this.#togglePOV(`doc_${uuid}`);
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
        if (this.#povFactionId === `doc_${uuid}`) this.#povFactionId = null;
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
   * @param {string} factionId
   */
  #togglePOV(factionId) {
    this.#povFactionId = (this.#povFactionId === factionId) ? null : factionId;

    // Update left-pane CSS without a full re-render
    this.element.querySelectorAll(".global-rel-faction-item").forEach(el => {
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
      get pinnedDocuments()       { return RelationshipStore.getPinnedDocuments(); },
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
      get connectionTypes() {
        try {
          const raw = game.settings.get("ddf-faction-manager", "connectionTypes");
          return typeof raw === "string" ? JSON.parse(raw) : (raw ?? []);
        } catch { return []; }
      },

      onPositionSave: (nodeKey, x, y) => {
        RelationshipStore.savePosition("__global__", nodeKey, x, y);
      },

      onContextMenu: (_sx, _sy, clientX, clientY) => {
        app.#showCanvasContextMenu(clientX, clientY);
      },

      onNodeContextMenu: (nodeKey, _edge, clientX, clientY) => {
        app.#showNodeContextMenu(nodeKey, clientX, clientY);
      },

      onSetPOV: (factionId) => {
        app.#togglePOV(factionId);
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

  #showCanvasContextMenu(clientX, clientY) {
    this.#closeFloatingPanels();

    if (!this.#povFactionId) {
      // No POV: cannot add from canvas; show a hint
      const hint = document.createElement("div");
      hint.className = "mm-search-panel";
      const appRect = this.element.getBoundingClientRect();
      hint.style.left = `${clientX - appRect.left}px`;
      hint.style.top  = `${clientY - appRect.top}px`;
      hint.innerHTML = `
        <div class="mm-panel-title">Add Connection</div>
        <p class="mm-panel-hint-text">Click a faction node or select one in the left pane to select a node first.</p>
        <div class="mm-panel-actions"><button class="mm-btn-cancel">Close</button></div>
      `;
      hint.querySelector(".mm-btn-cancel").addEventListener("click", () => this.#closeFloatingPanels());
      this.element.appendChild(hint);
      this.#bindPanelDismiss(hint);
      return;
    }

    const fromFactionId = this.#povFactionId;
    const appRect = this.element.getBoundingClientRect();
    const x = clientX - appRect.left;
    const y = clientY - appRect.top;

    const panel = document.createElement("div");
    panel.className = "mm-search-panel";
    panel.style.left = `${x}px`;
    panel.style.top  = `${y}px`;

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

    this.element.appendChild(panel);
    this.#bindPanelDismiss(panel);
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
      ${this.#typePickerHTML()}
      ${this.#directionPickerHTML()}
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
      const direction        = this.#selectedDirection(panel);
      const connectionTypeId = this.#selectedType(panel);
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
      ${pinOnly ? "" : this.#typePickerHTML()}
      ${pinOnly ? "" : this.#directionPickerHTML()}
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
        const direction        = this.#selectedDirection(panel);
        const connectionTypeId = this.#selectedType(panel);
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

  #showNodeContextMenu(nodeKey, clientX, clientY) {
    this.#closeFloatingPanels();

    const appRect = this.element.getBoundingClientRect();
    const x = clientX - appRect.left;
    const y = clientY - appRect.top;

    const menu = document.createElement("div");
    menu.className = "mm-node-menu";
    menu.style.left = `${x}px`;
    menu.style.top  = `${y}px`;

    const isDocument   = nodeKey.startsWith("doc_");
    const isCurrent    = nodeKey === this.#povFactionId;
    const povIsDoc     = this.#povFactionId?.startsWith("doc_") ?? false;
    const hasSelected  = !!this.#povFactionId && !isCurrent && !povIsDoc;
    const allFactions  = FactionStore.getAll();
    const selectedName = hasSelected ? (allFactions[this.#povFactionId]?.name ?? "Selected") : null;
    const targetName   = isDocument ? "Document" : (allFactions[nodeKey]?.name ?? "Target");

    // Existing connections between the selected faction and this node
    const types = this.#getConnectionTypes();
    const existingEdges = hasSelected
      ? Object.values(RelationshipStore.getAll().edges).filter(e => {
          if (!isDocument && e.type === "faction") {
            return (e.fromFactionId === this.#povFactionId && e.toFactionId === nodeKey) ||
                   (e.fromFactionId === nodeKey && e.toFactionId === this.#povFactionId);
          }
          if (isDocument && e.type === "document") {
            return e.fromFactionId === this.#povFactionId && e.documentUuid === nodeKey.slice(4);
          }
          return false;
        })
      : [];

    let menuHTML = `
      <button class="mm-node-menu-item" data-action="open-sheet">
        <i class="fa-solid fa-arrow-up-right-from-square"></i> Open Sheet
      </button>
    `;

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
          <i class="fa-solid fa-plus"></i> Add Connection to ${foundry.utils.escapeHTML(selectedName)}
        </button>`;
    }

    if (!isDocument) {
      menuHTML += `
        <button class="mm-node-menu-item" data-action="toggle-pov">
          <i class="fa-solid fa-crosshairs"></i> ${isCurrent ? "Deselect Node" : "Select Node"}
        </button>`;
    }
    menu.innerHTML = menuHTML;

    menu.querySelector('[data-action="open-sheet"]').addEventListener("click", async () => {
      this.#closeFloatingPanels();
      if (isDocument) {
        const uuid = nodeKey.slice(4);
        const doc  = await fromUuid(uuid);
        doc?.sheet?.render(true);
      } else {
        FactionDetailApp.show(nodeKey);
      }
    });

    // Wire per-edge delete buttons
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
        if (isDocument) {
          this.#showDirectDocumentConnectionPanel(this.#povFactionId, nodeKey, clientX, clientY);
        } else {
          this.#showDirectConnectionPanel(this.#povFactionId, nodeKey, clientX, clientY);
        }
      });
    }

    if (!isDocument) {
      menu.querySelector('[data-action="toggle-pov"]').addEventListener("click", () => {
        this.#closeFloatingPanels();
        this.#togglePOV(nodeKey);
      });
    }

    this.element.appendChild(menu);
    this.#bindPanelDismiss(menu);
  }

  /**
   * Show a type+direction picker to create a direct faction→faction connection.
   * Used when right-clicking a node while another node is selected.
   */
  #showDirectConnectionPanel(fromFactionId, toFactionId, clientX, clientY) {
    const allFactions = FactionStore.getAll();
    const fromName    = allFactions[fromFactionId]?.name ?? "Selected";
    const toName      = allFactions[toFactionId]?.name   ?? "Target";

    const appRect = this.element.getBoundingClientRect();
    const panel   = document.createElement("div");
    panel.className  = "mm-search-panel";
    panel.style.left = `${clientX - appRect.left}px`;
    panel.style.top  = `${clientY - appRect.top}px`;

    panel.innerHTML = `
      <div class="mm-panel-title">Connect Factions</div>
      <p class="mm-panel-hint-text">
        <strong>${foundry.utils.escapeHTML(fromName)}</strong>
        &rarr;
        <strong>${foundry.utils.escapeHTML(toName)}</strong>
      </p>
      ${this.#typePickerHTML()}
      ${this.#directionPickerHTML()}
      <div class="mm-panel-actions">
        <button class="mm-btn-confirm">Create</button>
        <button class="mm-btn-cancel">Cancel</button>
      </div>
    `;

    panel.querySelector(".mm-btn-confirm").addEventListener("click", async () => {
      const direction        = this.#selectedDirection(panel);
      const connectionTypeId = this.#selectedType(panel);
      const opts             = { toFactionId };
      if (connectionTypeId) opts.connectionTypeId = connectionTypeId;
      await RelationshipStore.createEdge(fromFactionId, "faction", direction, opts);
      this.#closeFloatingPanels();
      this.#refreshMap();
    });

    panel.querySelector(".mm-btn-cancel").addEventListener("click", () => this.#closeFloatingPanels());
    this.element.appendChild(panel);
    this.#bindPanelDismiss(panel);
  }

  /**
   * Create a faction → document edge from a direct right-click "Connect" action.
   * @param {string} fromFactionId
   * @param {string} docNodeKey   e.g. "doc_Actor.abc123"
   */
  #showDirectDocumentConnectionPanel(fromFactionId, docNodeKey, clientX, clientY) {
    const uuid = docNodeKey.slice(4);
    const allEdges  = RelationshipStore.getAll().edges;
    const pinned    = RelationshipStore.getPinnedDocuments();
    const fromName  = FactionStore.getAll()[fromFactionId]?.name ?? "Selected";

    // Resolve document name from pinned record or any existing edge
    let docName = pinned[uuid]?.documentName ?? null;
    let docType = pinned[uuid]?.documentType ?? null;
    if (!docName) {
      const edge = Object.values(allEdges).find(e => e.documentUuid === uuid);
      docName = edge?.documentName ?? uuid;
      docType = edge?.documentType ?? "Other";
    }

    const appRect = this.element.getBoundingClientRect();
    const panel   = document.createElement("div");
    panel.className  = "mm-search-panel";
    panel.style.left = `${clientX - appRect.left}px`;
    panel.style.top  = `${clientY - appRect.top}px`;

    panel.innerHTML = `
      <div class="mm-panel-title">Connect to Document</div>
      <p class="mm-panel-hint-text">
        <strong>${foundry.utils.escapeHTML(fromName)}</strong>
        &rarr;
        <strong>${foundry.utils.escapeHTML(docName)}</strong>
      </p>
      ${this.#typePickerHTML()}
      ${this.#directionPickerHTML()}
      <div class="mm-panel-actions">
        <button class="mm-btn-confirm">Create</button>
        <button class="mm-btn-cancel">Cancel</button>
      </div>
    `;

    panel.querySelector(".mm-btn-confirm").addEventListener("click", async () => {
      const direction        = this.#selectedDirection(panel);
      const connectionTypeId = this.#selectedType(panel);
      const opts = { documentUuid: uuid, documentType: docType, documentName: docName };
      if (connectionTypeId) opts.connectionTypeId = connectionTypeId;
      await RelationshipStore.createEdge(fromFactionId, "document", direction, opts);
      this.#closeFloatingPanels();
      this.#refreshMap();
    });

    panel.querySelector(".mm-btn-cancel").addEventListener("click", () => this.#closeFloatingPanels());
    this.element.appendChild(panel);
    this.#bindPanelDismiss(panel);
  }

  // ─── Map Refresh ─────────────────────────────────────────────────────────────

  /** Full data + visual refresh after a store mutation. */
  #refreshMap() {
    this.render({ force: true });
  }

  // ─── Floating Panel Utilities ─────────────────────────────────────────────────

  #directionPickerHTML() {
    return `
      <div class="mm-direction-row">
        <span>Direction:</span>
        <label><input type="radio" name="mm_dir" value="one-way" checked> One-way</label>
        <label><input type="radio" name="mm_dir" value="two-way"> Two-way</label>
      </div>`;
  }

  #typePickerHTML() {
    const types = this.#getConnectionTypes();
    const opts = types.map(t =>
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

  #getConnectionTypes() {
    try {
      const raw = game.settings.get("ddf-faction-manager", "connectionTypes");
      return typeof raw === "string" ? JSON.parse(raw) : (raw ?? []);
    } catch { return []; }
  }

  #selectedDirection(panel) {
    return panel.querySelector('input[name="mm_dir"]:checked')?.value ?? "one-way";
  }

  #selectedType(panel) {
    return panel.querySelector('select[name="mm_type"]')?.value || null;
  }

  #closeFloatingPanels() {
    this.element.querySelectorAll(".mm-search-panel, .mm-node-menu").forEach(el => el.remove());
  }

  #bindPanelDismiss(panel) {
    const handler = (e) => {
      if (!panel.contains(e.target)) {
        panel.remove();
        document.removeEventListener("mousedown", handler, true);
      }
    };
    setTimeout(() => document.addEventListener("mousedown", handler, true), 50);
  }
}
