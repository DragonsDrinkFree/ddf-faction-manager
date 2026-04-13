import { FactionStore } from "../data/FactionStore.js";
import { RelationshipStore } from "../data/RelationshipStore.js";
import { MemberStore } from "../data/MemberStore.js";
import { MindMapRenderer } from "./MindMapRenderer.js";

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

    // Relationship edge changes → remount map only (no left-pane change needed)
    this.#onRelationshipsChanged = () => {
      if (this.rendered) this.#mindMap?.remount();
    };

    Hooks.on("ddf-factions-changed",      this.#onFactionsChanged);
    Hooks.on("ddf-relationships-changed", this.#onRelationshipsChanged);
    Hooks.on("ddf-members-changed",       this.#onRelationshipsChanged);
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
    }

    return context;
  }

  // ─── Render Hook ─────────────────────────────────────────────────────────────

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);

    this.#teardownMindMap();

    const wrap = this.element.querySelector(".relationship-canvas-wrap");
    if (wrap) this.#mountMindMap(wrap);

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
    if (this.#onRelationshipsChanged) {
      Hooks.off("ddf-relationships-changed", this.#onRelationshipsChanged);
      Hooks.off("ddf-members-changed",       this.#onRelationshipsChanged);
    }
    this.#onFactionsChanged      = null;
    this.#onRelationshipsChanged = null;
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

  #showDocumentSearch(panel, fromFactionId) {
    const collections = [
      { type: "Actor",       icon: "fa-user",     col: game.actors  },
      { type: "JournalEntry", icon: "fa-book",    col: game.journal },
      { type: "Item",        icon: "fa-suitcase", col: game.items   },
      { type: "Scene",       icon: "fa-map",      col: game.scenes  }
    ];

    const docs = [];
    for (const { type, icon, col } of collections) {
      for (const doc of col) {
        docs.push({ uuid: doc.uuid, name: doc.name, type, icon });
      }
    }

    panel.innerHTML = `
      <div class="mm-panel-title">Link Document</div>
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
      ${this.#typePickerHTML()}
      ${this.#directionPickerHTML()}
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
      const direction        = this.#selectedDirection(panel);
      const connectionTypeId = this.#selectedType(panel);
      const opts = {
        documentUuid: el.dataset.uuid,
        documentType: el.dataset.type,
        documentName: el.dataset.name
      };
      if (connectionTypeId) opts.connectionTypeId = connectionTypeId;
      await RelationshipStore.createEdge(fromFactionId, "document", direction, opts);
      this.#closeFloatingPanels();
      this.#refreshMap();
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

    const isCurrent   = nodeKey === this.#povFactionId;
    // "Connect to..." offered when a DIFFERENT node is already selected
    const hasSelected = !!this.#povFactionId && !isCurrent;
    const selectedName = hasSelected
      ? (FactionStore.getAll()[this.#povFactionId]?.name ?? "Selected")
      : null;

    let menuHTML = "";
    if (hasSelected) {
      menuHTML += `
        <button class="mm-node-menu-item" data-action="connect-to-selected">
          <i class="fa-solid fa-link"></i> Connect to ${foundry.utils.escapeHTML(selectedName)}
        </button>
      `;
    }
    menuHTML += `
      <button class="mm-node-menu-item" data-action="toggle-pov">
        <i class="fa-solid fa-crosshairs"></i> ${isCurrent ? "Deselect Node" : "Select Node"}
      </button>
    `;
    menu.innerHTML = menuHTML;

    if (hasSelected) {
      menu.querySelector('[data-action="connect-to-selected"]').addEventListener("click", () => {
        this.#closeFloatingPanels();
        this.#showDirectConnectionPanel(this.#povFactionId, nodeKey, clientX, clientY);
      });
    }

    menu.querySelector('[data-action="toggle-pov"]').addEventListener("click", () => {
      this.#closeFloatingPanels();
      this.#togglePOV(nodeKey);
    });

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

  // ─── Map Refresh ─────────────────────────────────────────────────────────────

  /** Full data + visual refresh after a store mutation. */
  #refreshMap() {
    this.#teardownMindMap();
    const wrap = this.element?.querySelector(".relationship-canvas-wrap");
    if (wrap) this.#mountMindMap(wrap);
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
