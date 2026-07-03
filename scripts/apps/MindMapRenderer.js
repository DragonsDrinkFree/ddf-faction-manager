import {
  SVG_NS,
  R,
  INNER_RING,
  OUTER_RING,
  ORBIT_GAP,
  MEMBER_NODE_R,
  MEMBER_ORBIT_GAP,
  PARTY_MEMBER_NODE_R,
  PARTY_MEMBER_GAP,
  PARTY_RETAINER_GAP,
  NODE_TYPE,
  NODE_TYPE_RADIUS,
  FORCE,
  MIN_SCALE,
  MAX_SCALE,
  DOC_SIZE_PRESETS,
  NODE_KEY,
  parseNodeKey
} from "./MindMapConstants.js";

// Re-export the public-surface symbols so existing consumers (e.g.
// GlobalRelationshipsApp) can keep importing them from this module.
export { DOC_SIZE_PRESETS, NODE_KEY, parseNodeKey };

/**
 * Pure SVG mind-map renderer. Not an Application — mount into a container div.
 *
 * Config shape:
 *   mode:              "local" | "global"  (default "local")
 *   factionId:         string              (local mode only)
 *   povFactionId:      string | null       (global mode — null = no selection)
 *   allFactions:       getter → object
 *   edges:             getter → array (local) or object map (global)
 *   positions:         getter → object
 *   onPositionSave:    (nodeKey, x, y) => void
 *   onPositionsSave:   (entries: Array<{nodeKey, x, y}>) => void  (optional; batches multi-node saves into one write)
 *   onContextMenu:     (svgX, svgY, clientX, clientY) => void
 *   onNodeContextMenu: (nodeKey, edge|null, clientX, clientY) => void
 *   members:           getter → object (global mode — all members keyed by id)
 *   pinnedDocuments:   getter → object (global mode — pinned docs keyed by uuid)
 *   onSetPOV:          (factionId) => void  (global mode — toggles selected node)
 */
export class MindMapRenderer {
  #container;
  #svg = null;
  #config;

  // viewport group that receives the pan/zoom transform
  #viewport = null;

  // pan/zoom state
  #transform = { x: 0, y: 0, scale: 1 };

  // node drag state
  #drag = null;

  // background pan state
  #pan = null;

  // connector drag state
  #connHover     = null;   // node object the cursor is hovering over
  #connDrag      = null;   // { fromKey, startPx } while dragging a new connection
  #connectorDot  = null;   // <circle class="mm-connector-dot"> SVG element
  #ghostLine     = null;   // <line class="mm-ghost-edge"> SVG element
  #connTargetKey = null;   // nodeKey of the drop-target node (highlighted during drag)

  // ─── Force-directed layout state ──────────────────────────────────────────
  #forceAlpha               = 0;
  #forceVelocities          = new Map();  // nodeKey → { vx, vy }
  #forceRafId               = null;
  #forceMemberRadii         = new Map();  // nodeKey → orbit radius (faction members)
  #forceSubFacRadii         = new Map();  // nodeKey → orbit radius (sub-factions)
  #forcePartyMemberRadii    = new Map();  // nodeKey → orbit radius (party members inner ring)
  #forcePartyRetainerRadii  = new Map();  // nodeKey → orbit radius (party retainers outer ring)
  #nodeClusterKey           = new Map();  // nodeKey → top-level faction key for cluster grouping
  #forceActive              = false;
  #forceLevel               = 3;

  // bound listener refs for cleanup
  #boundMouseMove;
  #boundMouseUp;
  #boundOnWheel;
  #boundOnBgMousedown;

  constructor(containerEl, config) {
    this.#container       = containerEl;
    this.#config          = config;
    this.#boundMouseMove     = this.#onMouseMove.bind(this);
    this.#boundMouseUp       = this.#onMouseUp.bind(this);
    this.#boundOnWheel       = this.#onWheel.bind(this);
    this.#boundOnBgMousedown = this.#onBgMousedown.bind(this);
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  mount() {
    const w = this.#container.clientWidth  || 600;
    const h = this.#container.clientHeight || 400;

    this.#svg = this.#createSVG(w, h);
    this.#container.appendChild(this.#svg);

    // Viewport group — all content lives here so pan/zoom applies uniformly
    this.#viewport = this.#el("g", { class: "mm-viewport" });
    this.#svg.appendChild(this.#viewport);
    this.#applyTransform();

    if (this.#config.mode === "global") {
      this.#mountGlobal(w, h);
    } else {
      this.#mountLocal(w, h);
    }

    this.#svg.addEventListener("wheel",     this.#boundOnWheel,       { passive: false });
    this.#svg.addEventListener("mousedown", this.#boundOnBgMousedown);
    this.#svg.addEventListener("mousemove", this.#boundMouseMove);
    this.#svg.addEventListener("mouseup",   this.#boundMouseUp);
    this.#svg.addEventListener("mouseleave", () => {
      if (this.#connectorDot) {
        this.#connectorDot.style.display = "none";
        this.#connHover = null;
      }
    });
  }

  destroy() {
    if (this.#forceRafId) {
      cancelAnimationFrame(this.#forceRafId);
      this.#forceRafId = null;
    }
    if (this.#svg) {
      this.#svg.removeEventListener("wheel",     this.#boundOnWheel);
      this.#svg.removeEventListener("mousedown", this.#boundOnBgMousedown);
      this.#svg.removeEventListener("mousemove", this.#boundMouseMove);
      this.#svg.removeEventListener("mouseup",   this.#boundMouseUp);
      this.#svg.remove();
      this.#svg = null;
    }
    this.#viewport = null;
    this.#drag     = null;
    if (this.#connTargetKey) {
      this.#svg?.querySelector(`[data-key="${CSS.escape(this.#connTargetKey)}"]`)
               ?.classList.remove("mm-connect-target");
    }
    this.#connDrag      = null;
    this.#connHover     = null;
    this.#connTargetKey = null;
    this.#pan      = null;
    this._globalEdgeEls              = null;
    this._globalNodeEls              = null;
    this._globalNodeMap              = null;
    this._orbitRingEls               = null;
    this._spokeLinkEls               = null;
    this._orbitRadii                 = null;
    this._memberOrbitRingEls         = null;
    this._memberSpokeEls             = null;
    this._partyMemberRingEls         = null;
    this._partyMemberSpokeEls        = null;
    this._partyRetainerRingEls       = null;
    this._partyRetainerSpokeEls      = null;
    this.#forceSubFacRadii.clear();
    this.#forceMemberRadii.clear();
    this.#forcePartyMemberRadii.clear();
    this.#forcePartyRetainerRadii.clear();
    this.#nodeClusterKey.clear();
  }

  // ─── Force-directed layout API ────────────────────────────────────────────────

  /**
   * Arm the simulation and start from full energy.
   * Stays "armed" after cooldown so the button remains active.
   * @param {number} [level=3]  Spacing intensity 1–5
   */
  startForceLayout(level = 3) {
    this.#forceLevel  = Math.max(1, Math.min(5, level));
    this.#forceActive = true;
    this.#forceAlpha  = 1;
    this.#forceVelocities.clear();
    if (this._globalNodeMap) {
      for (const key of Object.keys(this._globalNodeMap)) {
        this.#forceVelocities.set(key, { vx: 0, vy: 0 });
      }
    }
    if (this.#forceRafId) cancelAnimationFrame(this.#forceRafId);
    const tick = () => {
      this.#forceTick();
      if (this.#forceAlpha > FORCE.alphaMin) {
        this.#forceRafId = requestAnimationFrame(tick);
      } else {
        // Simulation cooled — save positions and idle.
        // Armed state (#forceActive) remains true; button stays gold.
        this.#forceRafId = null;
        this.#forceSaveAllPositions();
      }
    };
    this.#forceRafId = requestAnimationFrame(tick);
  }

  /** Explicitly disarm the simulation and save positions. Called by the user toggling off. */
  stopForceLayout() {
    if (this.#forceRafId) {
      cancelAnimationFrame(this.#forceRafId);
      this.#forceRafId = null;
    }
    this.#forceActive = false;
    this.#forceSaveAllPositions();
    this.#config.onForceLayoutStop?.();
  }

  /** Returns true when the simulation is armed (running or idling between remounts). */
  isForceLayoutActive() {
    return this.#forceActive;
  }

  remount() {
    // Preserve pan/zoom across remounts so the view doesn't reset on data refresh
    const savedTransform = { ...this.#transform };
    this.destroy();
    this.#transform = savedTransform;
    this.mount();
  }

  /** Returns a snapshot of the current pan/zoom state for external preservation. */
  getTransform() {
    return { ...this.#transform };
  }

  /** Restores a previously saved pan/zoom state (call before mount()). */
  setTransform(t) {
    if (t && typeof t.x === "number") this.#transform = { ...t };
  }

  /**
   * Pan so that the node identified by key is centred in the viewport.
   * No-ops if the key is not found (e.g. local mode or node not rendered).
   */
  centerOn(key) {
    if (!this._globalNodeMap) return;
    const node = this._globalNodeMap[key];
    if (!node) return;
    const w = this.#svg?.clientWidth  || this.#container.clientWidth  || 600;
    const h = this.#svg?.clientHeight || this.#container.clientHeight || 400;
    this.#transform.x = w / 2 - node.x * this.#transform.scale;
    this.#transform.y = h / 2 - node.y * this.#transform.scale;
    this.#applyTransform();
  }

  // ─── Local Mode ───────────────────────────────────────────────────────────────

  #mountLocal(w, h) {
    const cx = w / 2;
    const cy = h / 2;

    // Background right-click
    this.#svg.addEventListener("contextmenu", (e) => {
      if (e.target === this.#svg || e.target.classList.contains("mm-bg")) {
        e.preventDefault();
        e.stopPropagation();
        this.#config.onContextMenu(0, 0, e.clientX, e.clientY);
      }
    });

    const nodes   = this.#buildLocalNodes(cx, cy);
    const central = nodes.find(n => n.key === "self");

    const edgeGroup = this.#el("g", { class: "mm-edges" });
    this.#viewport.appendChild(edgeGroup);

    const nodeGroup = this.#el("g", { class: "mm-nodes" });
    this.#viewport.appendChild(nodeGroup);

    const nodeEls = {};
    for (const node of nodes) {
      const g = this.#renderNode(node);
      nodeGroup.appendChild(g);
      nodeEls[node.key] = { el: g, node };
    }

    const edgeEls = {};
    for (const node of nodes) {
      if (!node.edgeStyle || !central) continue;
      const line = this.#renderLocalEdge(central, node);
      edgeGroup.appendChild(line);
      edgeEls[node.key] = line;
    }

    // Wire drag + right-click on each satellite node
    for (const { el, node } of Object.values(nodeEls)) {
      if (node.key === "self") continue;
      this.#wireNodeDrag(el, node, edgeEls[node.key] ?? null, central, false);
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.#config.onNodeContextMenu(node.key, node.edge ?? null, e.clientX, e.clientY);
      });
    }
  }

  #buildLocalNodes(cx, cy) {
    const { factionId, allFactions, edges, positions } = this.#config;
    const saved = positions ?? {};
    const nodes = [];

    const selfPos = saved["self"] ?? { x: cx, y: cy };
    nodes.push({
      key:       "self",
      type:      "central",
      label:     allFactions[factionId]?.name ?? "?",
      x: selfPos.x, y: selfPos.y,
      edge:      null,
      edgeStyle: null
    });

    const subEdges    = edges.filter(e => e.direction === "auto");
    const storedEdges = edges.filter(e => e.direction !== "auto");

    const innerCount = subEdges.length;
    subEdges.forEach((edge, i) => {
      const key   = `sub_${edge.toFactionId}`;
      const label = allFactions[edge.toFactionId]?.name ?? "Sub-faction";
      const pos   = saved[key] ?? {
        x: cx + INNER_RING * Math.cos((2 * Math.PI * i) / Math.max(innerCount, 1) - Math.PI / 2),
        y: cy + INNER_RING * Math.sin((2 * Math.PI * i) / Math.max(innerCount, 1) - Math.PI / 2)
      };
      nodes.push({ key, type: "subfaction", label, x: pos.x, y: pos.y, edge, edgeStyle: "dashed" });
    });

    const outerCount = storedEdges.length;
    storedEdges.forEach((edge, i) => {
      const key = edge.id;
      let label = "";
      let type  = "simple";

      if (edge.type === "faction") {
        const targetId = edge._reversed ? edge.fromFactionId : edge.toFactionId;
        label = allFactions[targetId]?.name ?? "Faction";
        type  = "faction";
      } else if (edge.type === "document") {
        label = edge.documentName ?? "Document";
        type  = "document";
      } else {
        label = edge.label ?? "Note";
        type  = "simple";
      }

      const edgeStyle = edge.direction === "two-way" ? "two-way" : "one-way";
      const pos = saved[key] ?? {
        x: cx + OUTER_RING * Math.cos((2 * Math.PI * i) / Math.max(outerCount, 1) - Math.PI / 2),
        y: cy + OUTER_RING * Math.sin((2 * Math.PI * i) / Math.max(outerCount, 1) - Math.PI / 2)
      };
      nodes.push({ key, type, label, x: pos.x, y: pos.y, edge, edgeStyle });
    });

    return nodes;
  }

  #renderLocalEdge(from, to) {
    const { x1, y1, x2, y2 } = this.#edgeEndpoints(from, to);
    const { edgeStyle }       = to;
    const color               = to.edge?.color ?? null;

    const line = this.#el("line", {
      x1, y1, x2, y2,
      class: `mm-edge${edgeStyle === "dashed" ? " mm-dashed" : ""}`
    });
    // Use inline style so it wins over the CSS class stroke rule
    if (color) line.style.stroke = color;

    if (edgeStyle === "one-way") {
      if (to.edge?._reversed) {
        line.setAttribute("marker-start", "url(#arrow-end)");
      } else {
        line.setAttribute("marker-end", "url(#arrow-end)");
      }
    } else if (edgeStyle === "two-way") {
      line.setAttribute("marker-end",   "url(#arrow-end)");
      line.setAttribute("marker-start", "url(#arrow-start)");
    }

    return line;
  }

  // ─── Global Mode ──────────────────────────────────────────────────────────────

  #mountGlobal(w, h) {
    const cx = w / 2;
    const cy = h / 2;

    // Background right-click
    this.#svg.addEventListener("contextmenu", (e) => {
      if (e.target === this.#svg || e.target.classList.contains("mm-bg")) {
        e.preventDefault();
        e.stopPropagation();
        const wp = this.#svgCoords(e);
        this.#config.onContextMenu(wp.x, wp.y, e.clientX, e.clientY);
      }
    });

    const nodes    = this.#buildGlobalNodes(cx, cy);
    const nodeMap  = Object.fromEntries(nodes.map(n => [n.key, n]));

    // Populate orbit radii for the force simulation from actual node positions
    this.#forceMemberRadii.clear();
    this.#forceSubFacRadii.clear();
    this.#forcePartyMemberRadii.clear();
    this.#forcePartyRetainerRadii.clear();
    for (const node of nodes) {
      if (!node.parentId) continue;
      const parent = nodeMap[node.parentId];
      if (!parent) continue;
      const r = Math.sqrt((node.x - parent.x) ** 2 + (node.y - parent.y) ** 2);
      if      (node.isMember)         this.#forceMemberRadii.set(node.key, r);
      else if (node.isSubFaction)     this.#forceSubFacRadii.set(node.key, r);
      else if (node.isPartyMember)    this.#forcePartyMemberRadii.set(node.key, r);
      else if (node.isPartyRetainer)  this.#forcePartyRetainerRadii.set(node.key, r);
    }

    // Cluster-key map: each node maps to the top-level faction it belongs to.
    // Used so cluster-level repulsion can account for the full footprint of a system.
    this.#nodeClusterKey.clear();
    for (const node of nodes) {
      if (!node.isSubFaction && !node.isMember && !node.isDocument
          && !node.isPartyMember && !node.isPartyRetainer) {
        this.#nodeClusterKey.set(node.key, node.key);
      }
    }
    // Propagate downward through the hierarchy (handles any depth)
    let propagating = true;
    while (propagating) {
      propagating = false;
      for (const node of nodes) {
        if (node.parentId && !this.#nodeClusterKey.has(node.key)) {
          const ck = this.#nodeClusterKey.get(node.parentId);
          if (ck !== undefined) { this.#nodeClusterKey.set(node.key, ck); propagating = true; }
        }
      }
    }

    // Build edge descriptors, then assign curve offsets based on actual positions
    const edgeDescs = this.#buildGlobalEdgeDescs();
    this.#assignEdgeCurveOffsets(edgeDescs, nodeMap);

    // Layer order: orbit rings → spokes → edges → nodes
    const orbitGroup = this.#el("g", { class: "mm-orbit-rings" });
    this.#viewport.appendChild(orbitGroup);

    const spokeGroup = this.#el("g", { class: "mm-spoke-lines" });
    this.#viewport.appendChild(spokeGroup);

    const edgeGroup = this.#el("g", { class: "mm-edges" });
    this.#viewport.appendChild(edgeGroup);

    const nodeGroup = this.#el("g", { class: "mm-nodes" });
    this.#viewport.appendChild(nodeGroup);

    // Render orbit rings + spoke lines for every parent that has sub-factions.
    // Orbit radius is derived from actual node positions (which already respect saved data).
    this._orbitRingEls = {};
    this._spokeLinkEls = {};
    this._orbitRadii   = {};
    for (const node of nodes) {
      if (!node.isSubFaction) continue;
      const parentNode = nodeMap[node.parentId];
      if (!parentNode) continue;

      // Build orbit ring once per parent (use average distance of all sub-faction nodes)
      if (!(node.parentId in this._orbitRadii)) {
        const sibs = nodes.filter(n => n.parentId === node.parentId);
        const avgR = sibs.reduce((sum, n) => {
          return sum + Math.sqrt((n.x - parentNode.x) ** 2 + (n.y - parentNode.y) ** 2);
        }, 0) / Math.max(sibs.length, 1);
        this._orbitRadii[node.parentId] = avgR;

        const ring = this.#el("circle", {
          cx: parentNode.x, cy: parentNode.y,
          r:  avgR,
          class: "mm-orbit-ring"
        });
        orbitGroup.appendChild(ring);
        this._orbitRingEls[node.parentId] = ring;
      }

      // Spoke line from parent node edge to sub-faction node edge
      const { x1, y1, x2, y2 } = this.#edgeEndpoints(parentNode, node);
      const spoke = this.#el("line", { x1, y1, x2, y2, class: "mm-spoke-line" });
      spokeGroup.appendChild(spoke);
      this._spokeLinkEls[`${node.parentId}|${node.key}`] = {
        line: spoke, parentKey: node.parentId, subKey: node.key
      };
    }

    // Render member orbit rings + spokes for every faction that has members.
    this._memberOrbitRingEls = {};
    this._memberSpokeEls     = {};
    const membersByFactionNode = {};
    for (const node of nodes) {
      if (!node.isMember) continue;
      (membersByFactionNode[node.parentId] ??= []).push(node);
    }
    for (const [parentId, mNodes] of Object.entries(membersByFactionNode)) {
      const parentNode = nodeMap[parentId];
      if (!parentNode) continue;
      const avgR = mNodes.reduce((sum, n) =>
        sum + Math.sqrt((n.x - parentNode.x) ** 2 + (n.y - parentNode.y) ** 2)
      , 0) / Math.max(mNodes.length, 1);

      const mRing = this.#el("circle", {
        cx: parentNode.x, cy: parentNode.y, r: avgR,
        class: "mm-member-ring"
      });
      orbitGroup.appendChild(mRing);
      this._memberOrbitRingEls[parentId] = mRing;

      for (const mNode of mNodes) {
        const { x1, y1, x2, y2 } = this.#edgeEndpoints(parentNode, mNode);
        const spoke = this.#el("line", { x1, y1, x2, y2, class: "mm-member-spoke" });
        spokeGroup.appendChild(spoke);
        this._memberSpokeEls[`${parentId}|${mNode.key}`] = {
          line: spoke, parentKey: parentId, memberKey: mNode.key
        };
      }
    }

    // Render party-member inner orbit rings + spokes.
    this._partyMemberRingEls   = {};
    this._partyMemberSpokeEls  = {};
    const partyMembersByNode = {};
    for (const node of nodes) {
      if (!node.isPartyMember) continue;
      (partyMembersByNode[node.parentId] ??= []).push(node);
    }
    for (const [parentId, pmNodes] of Object.entries(partyMembersByNode)) {
      const parentNode = nodeMap[parentId];
      if (!parentNode) continue;
      const avgR = pmNodes.reduce((sum, n) =>
        sum + Math.sqrt((n.x - parentNode.x) ** 2 + (n.y - parentNode.y) ** 2)
      , 0) / Math.max(pmNodes.length, 1);

      const pmRing = this.#el("circle", {
        cx: parentNode.x, cy: parentNode.y, r: avgR,
        class: "mm-party-member-ring"
      });
      orbitGroup.appendChild(pmRing);
      this._partyMemberRingEls[parentId] = pmRing;

      for (const pmNode of pmNodes) {
        const { x1, y1, x2, y2 } = this.#edgeEndpoints(parentNode, pmNode);
        const spoke = this.#el("line", { x1, y1, x2, y2, class: "mm-party-member-spoke" });
        spokeGroup.appendChild(spoke);
        this._partyMemberSpokeEls[`${parentId}|${pmNode.key}`] = {
          line: spoke, parentKey: parentId, memberKey: pmNode.key
        };
      }
    }

    // Render party-retainer outer orbit rings + spokes.
    this._partyRetainerRingEls  = {};
    this._partyRetainerSpokeEls = {};
    const partyRetainersByNode = {};
    for (const node of nodes) {
      if (!node.isPartyRetainer) continue;
      (partyRetainersByNode[node.parentId] ??= []).push(node);
    }
    for (const [parentId, prNodes] of Object.entries(partyRetainersByNode)) {
      const parentNode = nodeMap[parentId];
      if (!parentNode) continue;
      const avgR = prNodes.reduce((sum, n) =>
        sum + Math.sqrt((n.x - parentNode.x) ** 2 + (n.y - parentNode.y) ** 2)
      , 0) / Math.max(prNodes.length, 1);

      const prRing = this.#el("circle", {
        cx: parentNode.x, cy: parentNode.y, r: avgR,
        class: "mm-party-retainer-ring"
      });
      orbitGroup.appendChild(prRing);
      this._partyRetainerRingEls[parentId] = prRing;

      for (const prNode of prNodes) {
        const { x1, y1, x2, y2 } = this.#edgeEndpoints(parentNode, prNode);
        const spoke = this.#el("line", { x1, y1, x2, y2, class: "mm-party-retainer-spoke" });
        spokeGroup.appendChild(spoke);
        this._partyRetainerSpokeEls[`${parentId}|${prNode.key}`] = {
          line: spoke, parentKey: parentId, memberKey: prNode.key
        };
      }
    }

    // Render edges (behind nodes)
    // Use an indexed key to support multiple edges between the same node pair.
    const edgeEls = {};
    edgeDescs.forEach((desc, idx) => {
      const fromNode = nodeMap[desc.fromKey];
      const toNode   = nodeMap[desc.toKey];
      if (!fromNode || !toNode) return;
      const [el, hitArea] = this.#renderGlobalEdge(fromNode, toNode, desc);
      edgeGroup.appendChild(el);
      edgeGroup.appendChild(hitArea);
      edgeEls[`${desc.fromKey}|${desc.toKey}|${idx}`] = {
        line: el,
        hitArea,
        fromKey: desc.fromKey,
        toKey:   desc.toKey,
        curveOffset: desc.curveOffset ?? 0
      };
    });

    // Render nodes
    const nodeEls = {};
    for (const node of nodes) {
      const g = this.#renderNode(node);
      nodeGroup.appendChild(g);
      nodeEls[node.key] = { el: g, node };
    }

    // Wire drag + connector hover + left-click (POV toggle) + right-click on each node.
    for (const { el, node } of Object.values(nodeEls)) {
      this.#wireNodeDrag(el, node, null, null, true);

      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.#config.onNodeContextMenu(node.key, null, e.clientX, e.clientY);
      });
    }

    // Store element maps for live drag updates
    this._globalEdgeEls  = edgeEls;
    this._globalNodeEls  = nodeEls;
    this._globalNodeMap  = nodeMap;
  }

  #buildGlobalNodes(cx, cy) {
    const { allFactions, positions } = this.#config;
    const povFactionId = this.#config.povFactionId;
    const saved = positions ?? {};

    const allList  = Object.values(allFactions).sort((a, b) => a.name.localeCompare(b.name));
    const topLevel = allList.filter(f => !f.parentId || !allFactions[f.parentId]);
    const subFacs  = allList.filter(f =>  f.parentId &&  allFactions[f.parentId]);

    const nodes  = [];
    const posMap = {}; // factionId → {x, y} resolved position

    // Group siblings by parent so orbit radius is computed once per parent
    const siblingsByParent = {};
    for (const f of subFacs) (siblingsByParent[f.parentId] ??= []).push(f);

    // ── Pass 1: top-level factions on the outer circle ────────────────────────
    const topCount = topLevel.length;
    topLevel.forEach((faction, i) => {
      const key = faction.id;
      const pos = saved[key] ?? {
        x: cx + OUTER_RING * Math.cos((2 * Math.PI * i / Math.max(topCount, 1)) - Math.PI / 2),
        y: cy + OUTER_RING * Math.sin((2 * Math.PI * i / Math.max(topCount, 1)) - Math.PI / 2)
      };
      posMap[key] = pos;

      const isPOV         = key === povFactionId;
      const isParty       = faction.kind === "party";
      const resolvedColor = isPOV ? "#FFD700"
        : isParty ? (faction.color || null)
        : this.#resolveGlobalNodeColor(key, isPOV);
      const radius        = this.#computeNodeRadius(faction);
      nodes.push({
        key, label: faction.name,
        type: isPOV ? "pov" : isParty ? "party-global" : "faction-global",
        x: pos.x, y: pos.y,
        edge: null, edgeStyle: null,
        resolvedColor, radius,
        isSubFaction: false, isParty
      });
    });

    // ── Pass 2: sub-factions orbit their parent (topological, handles nesting) ─
    let remaining = [...subFacs];
    let guard = 0;
    while (remaining.length && guard++ < 20) {
      const nextRound = [];
      // Collect all sub-factions whose parent position is now known
      const readyByParent = {};
      for (const f of remaining) {
        if (posMap[f.parentId]) (readyByParent[f.parentId] ??= []).push(f);
        else nextRound.push(f);
      }

      for (const [parentId, ready] of Object.entries(readyByParent)) {
        const parentPos  = posMap[parentId];
        const siblings   = siblingsByParent[parentId] ?? ready;
        const orbitR     = this.#computeOrbitRadius(
          allFactions[parentId], siblings, parentPos, saved
        );

        for (const faction of ready) {
          const key    = faction.id;
          const sibIdx = siblings.findIndex(f => f.id === key);
          const angle  = (2 * Math.PI * sibIdx / Math.max(siblings.length, 1)) - Math.PI / 2;
          const pos    = saved[key] ?? {
            x: parentPos.x + orbitR * Math.cos(angle),
            y: parentPos.y + orbitR * Math.sin(angle)
          };
          posMap[key] = pos;

          const isPOV         = key === povFactionId;
          const isParty       = faction.kind === "party";
          const resolvedColor = isPOV ? "#FFD700"
            : isParty ? (faction.color || null)
            : this.#resolveGlobalNodeColor(key, isPOV);
          const radius        = this.#computeNodeRadius(faction);
          nodes.push({
            key, label: faction.name,
            type: isPOV ? "pov" : isParty ? "party-global" : "faction-global",
            x: pos.x, y: pos.y,
            edge: null, edgeStyle: null,
            resolvedColor, radius,
            isSubFaction: true, isParty,
            parentId: faction.parentId
          });
        }
      }
      remaining = nextRound;
    }

    // ── Pass 3: document nodes (only those that have at least one stored edge) ─
    const edgesMap = this.#config.edges;

    // Build set of actor UUIDs already represented by member diamond nodes
    // so we don't create a second doc node for the same actor.
    const memberActorUuids = new Set();
    for (const member of Object.values(this.#config.members ?? {})) {
      if (member.actorUuid) memberActorUuids.add(member.actorUuid);
    }

    const docMap   = new Map(); // uuid → { name, docType, factionIds[] }
    for (const edge of Object.values(edgesMap)) {
      if (edge.type !== "document" || !edge.documentUuid) continue;
      const uuid = edge.documentUuid;
      if (memberActorUuids.has(uuid)) continue; // already a member diamond node
      if (!docMap.has(uuid)) {
        docMap.set(uuid, {
          name:      edge.documentName  ?? "Document",
          docType:   edge.documentType  ?? "Other",
          factionIds: []
        });
      }
      docMap.get(uuid).factionIds.push(edge.fromFactionId);
    }

    // Merge pinned documents — they appear even with no faction edges
    const pinnedDocs = this.#config.pinnedDocuments ?? {};
    for (const [uuid, pd] of Object.entries(pinnedDocs)) {
      if (memberActorUuids.has(uuid)) continue; // already a member diamond node
      if (!docMap.has(uuid)) {
        docMap.set(uuid, { name: pd.documentName, docType: pd.documentType, factionIds: [] });
      }
    }

    const docSizes = this.#config.documentSizes ?? {};

    docMap.forEach(({ name, docType, factionIds }, uuid) => {
      const key        = NODE_KEY.forDocument(uuid);
      const isSelected = key === povFactionId;
      let pos = saved[key];
      if (!pos) {
        const knownPos = factionIds.map(id => posMap[id]).filter(Boolean);
        if (knownPos.length) {
          const avgX = knownPos.reduce((s, p) => s + p.x, 0) / knownPos.length;
          const avgY = knownPos.reduce((s, p) => s + p.y, 0) / knownPos.length;
          pos = { x: avgX + 90, y: avgY + 90 };
        } else {
          pos = { x: cx + 90, y: cy + 90 };
        }
      }
      posMap[key] = pos;

      let docResolvedColor = null;
      if (isSelected) {
        docResolvedColor = "#FFD700";
      } else if (povFactionId && !povFactionId.startsWith(NODE_KEY.DOC_PREFIX)) {
        const connectionTypes = this.#config.connectionTypes ?? [];
        const connectingEdge = Object.values(edgesMap).find(e =>
          e.type === "document" && e.documentUuid === uuid && e.fromFactionId === povFactionId
        );
        if (connectingEdge) {
          const typeColor = connectingEdge.connectionTypeId
            ? connectionTypes.find(t => t.id === connectingEdge.connectionTypeId)?.color ?? null
            : null;
          docResolvedColor = connectingEdge.color ?? typeColor ?? "#a0a8c0";
        }
      }

      const docType2NodeType = {
        Actor:        "doc-actor",
        Scene:        "doc-scene",
        JournalEntry: "doc-journal"
      };
      const storedSize = docSizes[uuid];
      const presetKey  = docType === "Scene" ? "scene" : "other";
      const presets    = DOC_SIZE_PRESETS[presetKey];
      let docRadius;
      if (typeof storedSize === "number") {
        docRadius = storedSize;
      } else if (typeof storedSize === "string" && presets[storedSize] != null) {
        // legacy string value → migrate to number on next save; use preset for now
        docRadius = presets[storedSize];
      } else {
        docRadius = presets.medium;
      }

      nodes.push({
        key,
        label:         name,
        type:          docType2NodeType[docType] ?? "doc-other",
        x: pos.x, y: pos.y,
        edge: null, edgeStyle: null,
        resolvedColor: docResolvedColor,
        radius:        docRadius,
        isSubFaction:  false,
        isMember:      false,
        isDocument:    true,
        documentType:  docType
      });
    });

    // ── Pass 4: member nodes orbit their faction (inner ring) ─────────────────
    const allMembersData   = this.#config.members ?? {};
    const membersByFaction = {};
    for (const member of Object.values(allMembersData)) {
      if (!member.factionId) continue;
      (membersByFaction[member.factionId] ??= []).push(member);
    }

    for (const [factionId, members] of Object.entries(membersByFaction)) {
      const parentPos = posMap[factionId];
      if (!parentPos) continue; // faction not on map
      const faction   = allFactions[factionId];
      const factionR  = faction ? this.#computeNodeRadius(faction) : R.factionGlobal;

      // Use saved distance of any sibling; otherwise compute inner orbit radius
      let orbitR = factionR + MEMBER_ORBIT_GAP + MEMBER_NODE_R;
      for (const m of members) {
        const sp = saved[NODE_KEY.forMember(m.id)];
        if (sp) {
          orbitR = Math.sqrt((sp.x - parentPos.x) ** 2 + (sp.y - parentPos.y) ** 2);
          break;
        }
      }

      members.forEach((member, i) => {
        const key   = NODE_KEY.forMember(member.id);
        const angle = (2 * Math.PI * i / Math.max(members.length, 1)) - Math.PI / 2;
        const pos   = saved[key] ?? {
          x: parentPos.x + orbitR * Math.cos(angle),
          y: parentPos.y + orbitR * Math.sin(angle)
        };
        posMap[key] = pos;
        nodes.push({
          key,
          label:        member.name ?? "Member",
          type:         member.actorUuid ? "member-actor" : "member-other",
          x: pos.x, y: pos.y,
          edge: null, edgeStyle: null,
          resolvedColor: key === povFactionId ? "#FFD700" : null,
          radius:       MEMBER_NODE_R,
          isSubFaction: false,
          isMember:     true,
          isDocument:   false,
          parentId:     factionId
        });
      });
    }

    // ── Pass 5: party-member nodes orbit their party (inner ring) ─────────────
    const partyMembersByParty = {};
    for (const m of this.#config.partyMembers ?? []) {
      if (m.factionId) (partyMembersByParty[m.factionId] ??= []).push(m);
    }
    for (const [partyId, members] of Object.entries(partyMembersByParty)) {
      const parentPos = posMap[partyId];
      if (!parentPos) continue;
      const partyFaction = allFactions[partyId];
      const partyR = partyFaction ? this.#computeNodeRadius(partyFaction) : R.factionGlobal;

      let orbitR = partyR + PARTY_MEMBER_GAP + PARTY_MEMBER_NODE_R;
      for (const m of members) {
        const sp = saved[NODE_KEY.forPartyMember(m.id)];
        if (sp) { orbitR = Math.sqrt((sp.x - parentPos.x) ** 2 + (sp.y - parentPos.y) ** 2); break; }
      }

      members.forEach((m, i) => {
        const key   = NODE_KEY.forPartyMember(m.id);
        const angle = (2 * Math.PI * i / Math.max(members.length, 1)) - Math.PI / 2;
        const pos   = saved[key] ?? {
          x: parentPos.x + orbitR * Math.cos(angle),
          y: parentPos.y + orbitR * Math.sin(angle)
        };
        posMap[key] = pos;
        nodes.push({
          key,
          label:          m.name ?? "Member",
          type:           m.actorUuid ? "party-member-actor" : "party-member-other",
          x: pos.x, y: pos.y,
          edge: null, edgeStyle: null,
          resolvedColor:  key === povFactionId ? "#FFD700" : null,
          radius:         PARTY_MEMBER_NODE_R,
          isSubFaction:   false, isMember: false, isDocument: false,
          isPartyMember:  true,  isPartyRetainer: false,
          parentId:       partyId
        });
      });
    }

    // ── Pass 6: party-retainer nodes orbit their party (outer ring) ───────────
    const partyRetainersByParty = {};
    for (const r of this.#config.partyRetainers ?? []) {
      if (r.factionId) (partyRetainersByParty[r.factionId] ??= []).push(r);
    }
    for (const [partyId, retainers] of Object.entries(partyRetainersByParty)) {
      const parentPos = posMap[partyId];
      if (!parentPos) continue;
      const partyFaction = allFactions[partyId];
      const partyR = partyFaction ? this.#computeNodeRadius(partyFaction) : R.factionGlobal;

      // Outer ring: beyond the member ring outer edge
      const memberNodes = partyMembersByParty[partyId] ?? [];
      let innerOrbitR = partyR + PARTY_MEMBER_GAP + PARTY_MEMBER_NODE_R;
      if (memberNodes.length) {
        const sp = saved[NODE_KEY.forPartyMember(memberNodes[0].id)];
        if (sp) innerOrbitR = Math.sqrt((sp.x - parentPos.x) ** 2 + (sp.y - parentPos.y) ** 2);
      }
      let orbitR = innerOrbitR + PARTY_MEMBER_NODE_R + PARTY_RETAINER_GAP + PARTY_MEMBER_NODE_R;
      for (const ret of retainers) {
        const sp = saved[NODE_KEY.forPartyRetainer(ret.id)];
        if (sp) { orbitR = Math.sqrt((sp.x - parentPos.x) ** 2 + (sp.y - parentPos.y) ** 2); break; }
      }

      retainers.forEach((ret, i) => {
        const key   = NODE_KEY.forPartyRetainer(ret.id);
        const angle = (2 * Math.PI * i / Math.max(retainers.length, 1)) - Math.PI / 2;
        const pos   = saved[key] ?? {
          x: parentPos.x + orbitR * Math.cos(angle),
          y: parentPos.y + orbitR * Math.sin(angle)
        };
        posMap[key] = pos;
        nodes.push({
          key,
          label:           ret.name ?? "Retainer",
          type:            ret.actorUuid ? "party-retainer-actor" : "party-retainer-other",
          x: pos.x, y: pos.y,
          edge: null, edgeStyle: null,
          resolvedColor:   key === povFactionId ? "#FFD700" : null,
          radius:          PARTY_MEMBER_NODE_R,
          isSubFaction:    false, isMember: false, isDocument: false,
          isPartyMember:   false, isPartyRetainer: true,
          parentId:        partyId
        });
      });
    }

    return nodes;
  }

  /**
   * Compute the orbit ring radius for a set of sub-factions around a parent.
   * If any sibling has a saved position, derive the radius from that position.
   * Otherwise compute from node sizes so they never overlap.
   */
  #computeOrbitRadius(parentFaction, siblings, parentPos, saved) {
    // Prefer saved distance of any sibling over the computed default
    for (const sib of siblings) {
      const sp = saved[sib.id];
      if (sp && parentPos) {
        return Math.sqrt((sp.x - parentPos.x) ** 2 + (sp.y - parentPos.y) ** 2);
      }
    }
    // Default: parent radius + gap + largest sub-faction radius,
    // but also ensure enough circumference to fit all siblings without touching.
    const parentR = this.#computeNodeRadius(parentFaction);
    const maxSubR = siblings.length
      ? Math.max(...siblings.map(f => this.#computeNodeRadius(f)))
      : 20;
    const baseR   = parentR + ORBIT_GAP + maxSubR;
    // Minimum radius so N siblings spaced by (2*maxSubR + ORBIT_GAP) don't overlap
    const packR   = siblings.length > 1
      ? (siblings.length * (2 * maxSubR + ORBIT_GAP)) / (2 * Math.PI)
      : 0;
    return Math.max(baseR, packR);
  }

  /**
   * Compute the display radius for a global-mode faction node based on its
   * stat values and the current nodeSizeDetermination setting.
   * Returns a radius in the same units as R.factionGlobal.
   */
  #computeNodeRadius(faction) {
    const { statDefinitions, nodeSizeDetermination } = this.#config;
    const stats = faction.stats ?? {};

    if (!statDefinitions?.length) return R.factionGlobal;

    // Only include stats whose stored value is numeric; skip text-value stats entirely
    // so they don't skew the average/max by contributing a default of 0.
    const values = [];
    for (const s of statDefinitions) {
      const raw = stats[s.id];
      const hasTextValue = raw !== undefined && raw !== null && raw !== "" && isNaN(parseFloat(raw));
      if (hasTextValue) continue;
      const v = parseFloat(raw);
      values.push(isNaN(v) ? (s.default ?? 0) : v);
    }

    if (!values.length) return R.factionGlobal;

    let rawValue;
    if (nodeSizeDetermination === "highest") {
      rawValue = Math.max(...values, 0);
    } else if (nodeSizeDetermination === "single") {
      const sizeKeyStat = statDefinitions.find(s => s.sizeKey);
      if (sizeKeyStat) {
        const v = parseFloat(stats[sizeKeyStat.id]);
        rawValue = isNaN(v) ? (sizeKeyStat.default ?? 0) : v;
      } else {
        rawValue = 0;
      }
    } else {
      // "average" — default
      rawValue = values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);
    }

    // sqrt scaling: value=1 → scale=1 (base radius), clamped [0.4, 2.5]
    const scale = rawValue > 0
      ? Math.max(0.4, Math.min(10, Math.sqrt(rawValue)))
      : 0.4;
    return R.factionGlobal * scale;
  }

  /** Determine a JS-applied fill/stroke color for a global-mode faction node. */
  #resolveGlobalNodeColor(factionId, isPOV) {
    const { povFactionId, edges: edgesMap, allFactions } = this.#config;
    const connectionTypes = this.#config.connectionTypes ?? [];

    // POV faction: gold (matched by CSS class mm-node-type-pov, no JS override needed)
    if (isPOV) return null;

    // No POV selected — all nodes use CSS default
    if (!povFactionId) return null;

    const allEdges = Object.values(edgesMap);

    // POV is a document node — highlight factions that have an edge to that document
    if (povFactionId.startsWith(NODE_KEY.DOC_PREFIX)) {
      const docUuid = povFactionId.slice(NODE_KEY.DOC_PREFIX.length);
      const connectingEdge = allEdges.find(e =>
        e.type === "document" && e.documentUuid === docUuid && e.fromFactionId === factionId
      );
      if (connectingEdge) {
        const typeColor = connectingEdge.connectionTypeId
          ? connectionTypes.find(t => t.id === connectingEdge.connectionTypeId)?.color ?? null
          : null;
        return connectingEdge.color ?? typeColor ?? "#a0a8c0";
      }
      return null;
    }

    // Check for a stored faction-to-faction edge connecting this node to the POV
    const connectingEdge = allEdges.find(e =>
      e.type === "faction" && (
        (e.fromFactionId === povFactionId && e.toFactionId === factionId) ||
        (e.fromFactionId === factionId   && e.toFactionId === povFactionId)
      )
    );
    if (connectingEdge) {
      const typeColor = connectingEdge.connectionTypeId
        ? connectionTypes.find(t => t.id === connectingEdge.connectionTypeId)?.color ?? null
        : null;
      return connectingEdge.color ?? typeColor ?? "#a0a8c0";
    }

    // Check sub-faction hierarchy connection
    const thisFaction = allFactions[factionId];
    const povFaction  = allFactions[povFactionId];
    if (
      thisFaction?.parentId === povFactionId ||
      povFaction?.parentId === factionId
    ) {
      return "#a0a8c0";
    }

    // Unconnected — CSS default applies
    return null;
  }

  #buildGlobalEdgeDescs() {
    const { edges: edgesMap } = this.#config;
    const connectionTypes = this.#config.connectionTypes ?? [];
    const descs = [];

    // Faction-to-faction edges.
    // Sub-faction hierarchy is shown as orbit rings, not as lines.
    for (const edge of Object.values(edgesMap)) {
      if (edge.type !== "faction") continue;
      const typeColor = edge.connectionTypeId
        ? connectionTypes.find(t => t.id === edge.connectionTypeId)?.color ?? null
        : null;
      descs.push({
        fromKey: edge.fromFactionId,
        toKey:   edge.toFactionId,
        style:   edge.direction === "two-way" ? "two-way" : "one-way",
        color:   edge.color ?? typeColor ?? null,
        edgeId:  edge.id
      });
    }

    // Build lookup: actorUuid → memberId so edges targeting member actors route to diamond nodes.
    const membersByActorUuid = new Map();
    for (const [id, member] of Object.entries(this.#config.members ?? {})) {
      if (member.actorUuid) membersByActorUuid.set(member.actorUuid, id);
    }

    // Document edges — line from faction node to document/member node.
    for (const edge of Object.values(edgesMap)) {
      if (edge.type !== "document" || !edge.documentUuid) continue;
      const typeColor = edge.connectionTypeId
        ? connectionTypes.find(t => t.id === edge.connectionTypeId)?.color ?? null
        : null;
      const memberId = membersByActorUuid.get(edge.documentUuid);
      descs.push({
        fromKey: edge.fromFactionId,
        toKey:   memberId ? NODE_KEY.forMember(memberId) : NODE_KEY.forDocument(edge.documentUuid),
        style:   edge.direction === "two-way" ? "two-way" : "one-way",
        color:   edge.color ?? typeColor ?? null,
        edgeId:  edge.id
      });
    }

    // Doc-to-doc link edges — both endpoints may be doc_ nodes or member diamonds.
    for (const edge of Object.values(edgesMap)) {
      if (edge.type !== "doc-link" || !edge.fromDocUuid || !edge.documentUuid) continue;
      const typeColor = edge.connectionTypeId
        ? connectionTypes.find(t => t.id === edge.connectionTypeId)?.color ?? null
        : null;
      const fromMemberId = membersByActorUuid.get(edge.fromDocUuid);
      const toMemberId   = membersByActorUuid.get(edge.documentUuid);
      descs.push({
        fromKey: fromMemberId ? NODE_KEY.forMember(fromMemberId) : NODE_KEY.forDocument(edge.fromDocUuid),
        toKey:   toMemberId   ? NODE_KEY.forMember(toMemberId)   : NODE_KEY.forDocument(edge.documentUuid),
        style:   edge.direction === "two-way" ? "two-way" : "one-way",
        color:   edge.color ?? typeColor ?? null,
        edgeId:  edge.id
      });
    }

    return descs;
  }

  /**
   * Assigns perpendicular curve offsets to edges that visually overlap.
   * Two edges overlap when they share a canonical node pair (A↔B + B↔A)
   * OR when they share an endpoint and their vectors are nearly parallel
   * (e.g. sub-faction and parent both connecting to the same distant node).
   * Must be called after nodeMap is built so positions are available.
   *
   * @param {Array}  descs   — edge descriptor array (mutated in place)
   * @param {object} nodeMap — key → node with .x/.y
   */
  #assignEdgeCurveOffsets(descs, nodeMap) {
    const CURVE_BASE        = 40;             // px perpendicular offset per lane
    const ANGLE_THRESHOLD   = 20 * Math.PI / 180; // radians — edges closer than this overlap

    const assigned = new Set(); // desc indices already given an offset

    const applyOffsets = (indices) => {
      // Filter to indices not yet assigned, then apply symmetric spread
      const targets = indices.filter(i => !assigned.has(i));
      if (targets.length < 2) return;
      const n     = targets.length;
      const start = -((n - 1) / 2) * CURVE_BASE;
      targets.forEach((i, pos) => {
        descs[i].curveOffset = start + pos * CURVE_BASE;
        assigned.add(i);
      });
    };

    // ── Pass 1: exact canonical pair (A→B + B→A, or two A→B edges) ───────────
    const pairGroups = new Map();
    descs.forEach((desc, i) => {
      const canon = [desc.fromKey, desc.toKey].sort().join("|||");
      if (!pairGroups.has(canon)) pairGroups.set(canon, []);
      pairGroups.get(canon).push(i);
    });
    for (const indices of pairGroups.values()) {
      if (indices.length >= 2) applyOffsets(indices);
    }

    // ── Pass 2: shared endpoint + nearly parallel ─────────────────────────────
    // Group by shared toKey (convergence) and shared fromKey (divergence).
    const groupByEndpoint = (keyFn, otherKeyFn) => {
      const groups = new Map();
      descs.forEach((desc, i) => {
        const k = keyFn(desc);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(i);
      });
      for (const [sharedKey, indices] of groups.entries()) {
        if (indices.length < 2) continue;
        const sharedNode = nodeMap[sharedKey];
        if (!sharedNode) continue;

        // Compute edge angle at the shared endpoint for each desc
        const withAngle = indices.map(i => {
          const otherKey  = otherKeyFn(descs[i]);
          const otherNode = nodeMap[otherKey];
          if (!otherNode) return null;
          const angle = Math.atan2(otherNode.y - sharedNode.y, otherNode.x - sharedNode.x);
          return { i, angle };
        }).filter(Boolean);

        // Sort by angle and cluster edges within the threshold
        withAngle.sort((a, b) => a.angle - b.angle);
        const clusters = [];
        for (const e of withAngle) {
          let placed = false;
          for (const cluster of clusters) {
            const diff = Math.abs(e.angle - cluster[0].angle);
            if (Math.min(diff, 2 * Math.PI - diff) < ANGLE_THRESHOLD) {
              cluster.push(e); placed = true; break;
            }
          }
          if (!placed) clusters.push([e]);
        }
        for (const cluster of clusters) {
          if (cluster.length >= 2) applyOffsets(cluster.map(e => e.i));
        }
      }
    };

    groupByEndpoint(d => d.toKey,   d => d.fromKey); // convergence
    groupByEndpoint(d => d.fromKey, d => d.toKey);   // divergence
  }

  #renderGlobalEdge(fromNode, toNode, desc) {
    const { x1, y1, x2, y2 } = this.#edgeEndpoints(fromNode, toNode);
    const curveOffset = desc.curveOffset ?? 0;
    const cls = `mm-edge${desc.style === "dashed" ? " mm-dashed" : ""}`;
    const isCurved = curveOffset !== 0;
    const pathD = isCurved ? this.#curvedPath(x1, y1, x2, y2, curveOffset) : null;

    let el;
    if (!isCurved) {
      el = this.#el("line", { x1, y1, x2, y2, class: cls });
    } else {
      el = this.#el("path", { d: pathD, class: cls, fill: "none" });
    }

    if (desc.color) el.style.stroke = desc.color;
    if (desc.style === "one-way")  el.setAttribute("marker-end", "url(#arrow-end)");
    if (desc.style === "two-way") {
      el.setAttribute("marker-end",   "url(#arrow-end)");
      el.setAttribute("marker-start", "url(#arrow-start)");
    }

    // Wide invisible hit area makes the edge easy to click
    let hitArea;
    if (!isCurved) {
      hitArea = this.#el("line", { x1, y1, x2, y2, class: "mm-edge-hit" });
    } else {
      hitArea = this.#el("path", { d: pathD, class: "mm-edge-hit" });
    }

    if (desc.edgeId && this.#config.onEdgeClick) {
      hitArea.style.cursor = "pointer";
      hitArea.addEventListener("click", (e) => {
        e.stopPropagation();
        this.#config.onEdgeClick(desc.edgeId, e.clientX, e.clientY);
      });
    }

    return [el, hitArea];
  }

  /**
   * Cubic bezier path that creates an S-curve between two points.
   * The two control points are placed at 1/3 and 2/3 along the line and offset
   * perpendicularly in OPPOSITE directions, so strands with +offset and -offset
   * cross at the midpoint — producing a DNA-helix appearance when paired.
   */
  #curvedPath(x1, y1, x2, y2, offset) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const px = -dy / len, py = dx / len; // perpendicular unit vector

    const cp1x = x1 + dx / 3 + px * offset;
    const cp1y = y1 + dy / 3 + py * offset;
    const cp2x = x1 + 2 * dx / 3 - px * offset;
    const cp2y = y1 + 2 * dy / 3 - py * offset;

    return `M${x1},${y1} C${cp1x},${cp1y} ${cp2x},${cp2y} ${x2},${y2}`;
  }

  // ─── Force Simulation ─────────────────────────────────────────────────────────

  /**
   * Hierarchical force tick.
   *
   * Physics layers (strength decreasing at each level):
   *   1. Cluster-vs-cluster — whole faction solar systems repel as bounding circles
   *   2. Sub-faction siblings  — repel each other within their parent orbit (35%)
   *   3. Member siblings       — repel each other within their parent orbit (12%)
   *   4. Orbit springs         — sub-factions / members pulled back to orbit radius
   *   5. Edge rubber bands     — connections pull factions together
   *   6. Document repulsion    — docs avoid all other nodes (30%)
   *   7. Hard collision        — any overlapping pair gets an extra push
   *   8. Centering             — gentle pull toward world origin
   *
   * All forces are divided by node mass (∝ radius) so large nodes resist more.
   */
  #forceTick() {
    const ctx = this.#buildForceContext();
    if (!ctx) return;

    this.#forceClusterRepulsion(ctx);
    this.#forceSiblingRepulsion(ctx);
    this.#forceOrbitSprings(ctx);
    this.#forceSnapToOrbits(ctx);
    this.#forceEdgeSprings(ctx);
    this.#forceDocumentRepulsion(ctx);
    this.#forceCentering(ctx);
    this.#forceIntegrate(ctx);

    this.#forceAlpha *= (1 - FORCE.alphaDecay);
    this.#redrawAllNodePositions();
  }

  /**
   * Builds the per-tick simulation context — scaled force strengths, node lists,
   * and grouped lookups that every phase reuses. Returns null if the global map
   * hasn't been mounted yet.
   */
  #buildForceContext() {
    const nodeMap = this._globalNodeMap;
    if (!nodeMap) return null;

    const nodes    = Object.values(nodeMap);
    const vel      = this.#forceVelocities;
    const alpha    = this.#forceAlpha;
    const levelExp = this.#forceLevel - 3;

    // Ensure every node has a velocity slot
    for (const node of nodes) {
      if (!vel.has(node.key)) vel.set(node.key, { vx: 0, vy: 0 });
    }

    const topNodes = nodes.filter(n => !n.isSubFaction && !n.isMember && !n.isDocument
                                      && !n.isPartyMember && !n.isPartyRetainer);

    // Group children by parent once per tick (used by sibling repulsion)
    const siblingsByParent = new Map();
    for (const node of nodes) {
      if (!node.parentId || node.isDocument) continue;
      if (!siblingsByParent.has(node.parentId)) siblingsByParent.set(node.parentId, []);
      siblingsByParent.get(node.parentId).push(node);
    }

    return {
      nodeMap, nodes, vel, alpha, topNodes, siblingsByParent,
      levelMult:  Math.pow(1.4, levelExp),
      repulsion:  FORCE.repulsion  * Math.pow(2,   levelExp),
      springRest: FORCE.springRest * Math.pow(1.4, levelExp),
    };
  }

  /** Node mass (∝ radius) — larger nodes resist force more. */
  #forceMass(node) {
    return Math.max(1, this.#nodeRadius(node) / 18);
  }

  /**
   * Applies symmetric repulsion + hard-collision push between two nodes.
   * `mult` scales the base repulsion (e.g. sibling/doc passes use fractions).
   */
  #forceRepel(a, b, mult, ctx) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > FORCE.maxDist * FORCE.maxDist) return;
    const minDist  = this.#nodeRadius(a) + this.#nodeRadius(b) + FORCE.nodePadding;
    const effectD2 = Math.max(d2, minDist * minDist);
    const force    = (ctx.repulsion * mult * ctx.alpha) / effectD2;
    const dist     = Math.sqrt(d2) || 1;
    const ux = dx / dist, uy = dy / dist;
    const va = ctx.vel.get(a.key), vb = ctx.vel.get(b.key);
    const ma = this.#forceMass(a), mb = this.#forceMass(b);
    if (va) { va.vx -= ux * force / ma; va.vy -= uy * force / ma; }
    if (vb) { vb.vx += ux * force / mb; vb.vy += uy * force / mb; }
    if (dist < minDist) {
      const cf = (minDist - dist) * FORCE.collisionSpring * mult;
      if (va) { va.vx -= ux * cf / ma; va.vy -= uy * cf / ma; }
      if (vb) { vb.vx += ux * cf / mb; vb.vy += uy * cf / mb; }
    }
  }

  /**
   * ── Phase 1 ─ Cluster-vs-cluster repulsion ────────────────────────────────
   * Each top-level faction's cluster (faction + sub-factions + members) is
   * repelled from every other cluster as a rigid body. The velocity delta is
   * applied uniformly to every node in the cluster so the whole "solar system"
   * translates together.
   */
  #forceClusterRepulsion(ctx) {
    const { nodeMap, nodes, vel, alpha, topNodes, levelMult, repulsion } = ctx;

    // Compute cluster footprint (radius of farthest descendant) and membership
    const clusterRadius  = new Map();
    const clusterMembers = new Map();
    for (const node of nodes) {
      const ck = this.#nodeClusterKey.get(node.key);
      if (!ck) continue;
      const top = nodeMap[ck];
      if (!top) continue;
      const d = Math.sqrt((node.x - top.x) ** 2 + (node.y - top.y) ** 2) + this.#nodeRadius(node);
      if (!clusterRadius.has(ck) || d > clusterRadius.get(ck)) clusterRadius.set(ck, d);
      if (!clusterMembers.has(ck)) clusterMembers.set(ck, []);
      clusterMembers.get(ck).push(node);
    }

    for (let i = 0; i < topNodes.length; i++) {
      for (let j = i + 1; j < topNodes.length; j++) {
        const a = topNodes[i], b = topNodes[j];
        const rA = (clusterRadius.get(a.key) ?? this.#nodeRadius(a)) * levelMult;
        const rB = (clusterRadius.get(b.key) ?? this.#nodeRadius(b)) * levelMult;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > FORCE.maxDist * FORCE.maxDist) continue;
        const minDist  = rA + rB + FORCE.nodePadding;
        const effectD2 = Math.max(d2, minDist * minDist);
        const dist     = Math.sqrt(d2) || 1;
        const ux = dx / dist, uy = dy / dist;
        const ma = this.#forceMass(a), mb = this.#forceMass(b);
        const baseForce = (repulsion * alpha) / effectD2;
        const dvAx = -ux * baseForce / ma, dvAy = -uy * baseForce / ma;
        const dvBx =  ux * baseForce / mb, dvBy =  uy * baseForce / mb;

        let cfAx = 0, cfAy = 0, cfBx = 0, cfBy = 0;
        if (dist < minDist) {
          const cf = (minDist - dist) * FORCE.collisionSpring;
          cfAx = -ux * cf / ma; cfAy = -uy * cf / ma;
          cfBx =  ux * cf / mb; cfBy =  uy * cf / mb;
        }

        for (const m of clusterMembers.get(a.key) ?? []) {
          const v = vel.get(m.key);
          if (v) { v.vx += dvAx + cfAx; v.vy += dvAy + cfAy; }
        }
        for (const m of clusterMembers.get(b.key) ?? []) {
          const v = vel.get(m.key);
          if (v) { v.vx += dvBx + cfBx; v.vy += dvBy + cfBy; }
        }
      }
    }
  }

  /**
   * ── Phase 2 ─ Sibling repulsion within orbits ─────────────────────────────
   * Sub-factions repel sibling sub-factions; members repel sibling members.
   * Combined with the orbit spring, this balances children angularly around
   * their parent.
   */
  #forceSiblingRepulsion(ctx) {
    for (const siblings of ctx.siblingsByParent.values()) {
      const s0 = siblings[0];
      const mult = (s0?.isMember || s0?.isPartyMember || s0?.isPartyRetainer)
        ? FORCE.siblingMemberMult : FORCE.siblingSubFacMult;
      for (let i = 0; i < siblings.length; i++) {
        for (let j = i + 1; j < siblings.length; j++) {
          this.#forceRepel(siblings[i], siblings[j], mult, ctx);
        }
      }
    }
  }

  /**
   * ── Phase 3 ─ Orbit radial springs ────────────────────────────────────────
   * Pulls sub-factions and members toward their fixed orbit radius from their
   * parent. Radius is a hard parent-child constraint and does NOT scale with
   * the spacing level — only cluster separation does.
   */
  #forceOrbitSprings(ctx) {
    this.#applyOrbitSpring(ctx, this.#forceSubFacRadii,          FORCE.orbitSpringK);
    this.#applyOrbitSpring(ctx, this.#forceMemberRadii,          FORCE.memberOrbitK);
    this.#applyOrbitSpring(ctx, this.#forcePartyMemberRadii,     FORCE.partyMemberOrbitK);
    this.#applyOrbitSpring(ctx, this.#forcePartyRetainerRadii,   FORCE.partyRetainerOrbitK);
  }

  #applyOrbitSpring(ctx, radiiMap, springK) {
    const { nodeMap, vel, alpha } = ctx;
    for (const [key, targetR] of radiiMap.entries()) {
      const node = nodeMap[key];   if (!node) continue;
      const parent = nodeMap[node.parentId]; if (!parent) continue;
      const dx = node.x - parent.x, dy = node.y - parent.y;
      const dist  = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = springK * (dist - targetR) * alpha;
      const ux = dx / dist, uy = dy / dist;
      const vp = vel.get(node.parentId), vm = vel.get(key);
      const mp = this.#forceMass(parent), mn = this.#forceMass(node);
      if (vp) { vp.vx += ux * force / mp; vp.vy += uy * force / mp; }
      if (vm) { vm.vx -= ux * force / mn; vm.vy -= uy * force / mn; }
    }
  }

  /**
   * ── Phase 4 ─ Hard orbit clamp ────────────────────────────────────────────
   * Teleports any child node that has drifted more than 2.5× its orbit radius
   * back onto the ring. Prevents compounding drift from stale saved positions.
   */
  #forceSnapToOrbits(ctx) {
    this.#applyOrbitSnap(ctx, this.#forceSubFacRadii);
    this.#applyOrbitSnap(ctx, this.#forceMemberRadii);
    this.#applyOrbitSnap(ctx, this.#forcePartyMemberRadii);
    this.#applyOrbitSnap(ctx, this.#forcePartyRetainerRadii);
  }

  #applyOrbitSnap(ctx, radiiMap) {
    const { nodeMap, vel } = ctx;
    for (const [key, targetR] of radiiMap.entries()) {
      const node = nodeMap[key];   if (!node) continue;
      const parent = nodeMap[node.parentId]; if (!parent) continue;
      const dx = node.x - parent.x, dy = node.y - parent.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      if (dist > targetR * 2.5) {
        const ux = dx / dist, uy = dy / dist;
        node.x = parent.x + ux * targetR;
        node.y = parent.y + uy * targetR;
        const v = vel.get(key);
        if (v) { v.vx = 0; v.vy = 0; }
      }
    }
  }

  /**
   * ── Phase 5 ─ Edge rubber-band springs ────────────────────────────────────
   * Every relationship edge pulls its endpoints toward `springRest` distance.
   */
  #forceEdgeSprings(ctx) {
    if (!this._globalEdgeEls) return;
    const { nodeMap, vel, alpha, springRest } = ctx;
    for (const { fromKey, toKey } of Object.values(this._globalEdgeEls)) {
      const a = nodeMap[fromKey], b = nodeMap[toKey];
      if (!a || !b) continue;
      const dx   = b.x - a.x, dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = FORCE.springK * (dist - springRest) * alpha;
      const ux = dx / dist, uy = dy / dist;
      const va = vel.get(fromKey), vb = vel.get(toKey);
      const ma = this.#forceMass(a), mb = this.#forceMass(b);
      if (va) { va.vx += ux * force / ma; va.vy += uy * force / ma; }
      if (vb) { vb.vx -= ux * force / mb; vb.vy -= uy * force / mb; }
    }
  }

  /**
   * ── Phase 6 ─ Document repulsion ──────────────────────────────────────────
   * Document nodes gently push away from all other nodes — edges handle the
   * primary placement, this just prevents overlap.
   */
  #forceDocumentRepulsion(ctx) {
    for (const doc of ctx.nodes) {
      if (!doc.isDocument) continue;
      for (const other of ctx.nodes) {
        if (other === doc) continue;
        this.#forceRepel(doc, other, FORCE.docRepulsionMult, ctx);
      }
    }
  }

  /**
   * ── Phase 7 ─ Centering pull (top-level nodes only) ───────────────────────
   * Child nodes are already anchored by orbit springs; centering them directly
   * would fight that constraint. Only the top-level factions get nudged home.
   */
  #forceCentering(ctx) {
    for (const node of ctx.topNodes) {
      const v = ctx.vel.get(node.key);
      if (!v) continue;
      const m = this.#forceMass(node);
      v.vx -= (node.x * FORCE.centerK * ctx.alpha) / m;
      v.vy -= (node.y * FORCE.centerK * ctx.alpha) / m;
    }
  }

  /**
   * ── Phase 8 ─ Integrate + cool ────────────────────────────────────────────
   * Apply velocity decay, clamp to max speed, and advance node positions.
   */
  #forceIntegrate(ctx) {
    for (const node of ctx.nodes) {
      const v = ctx.vel.get(node.key);
      if (!v) continue;
      v.vx *= FORCE.velocityDecay;
      v.vy *= FORCE.velocityDecay;
      const speed = Math.sqrt(v.vx * v.vx + v.vy * v.vy);
      if (speed > FORCE.maxVelocity) {
        v.vx = (v.vx / speed) * FORCE.maxVelocity;
        v.vy = (v.vy / speed) * FORCE.maxVelocity;
      }
      node.x += v.vx;
      node.y += v.vy;
    }
  }

  /** Persist every node's current position after the simulation stops. */
  #forceSaveAllPositions() {
    const nodeMap = this._globalNodeMap;
    if (!nodeMap) return;
    this.#emitPositionSaves(
      Object.values(nodeMap).map(n => ({ nodeKey: n.key, x: n.x, y: n.y }))
    );
  }

  /**
   * Persist a set of node positions in one call. Prefers the batch config
   * callback (a single settings write) and falls back to per-node saves.
   * @param {Array<{nodeKey: string, x: number, y: number}>} entries
   */
  #emitPositionSaves(entries) {
    if (!entries.length) return;
    if (this.#config.onPositionsSave) return void this.#config.onPositionsSave(entries);
    for (const { nodeKey, x, y } of entries) this.#config.onPositionSave?.(nodeKey, x, y);
  }

  /** Update all node transforms plus every edge/spoke/ring in one pass. */
  #redrawAllNodePositions() {
    if (!this._globalNodeMap) return;
    for (const { el, node } of Object.values(this._globalNodeEls ?? {})) {
      el.setAttribute("transform", `translate(${node.x},${node.y})`);
    }
    this.#redrawEdgesAndRings(null);
  }

  /**
   * Core redraw routine for edges, spoke lines, and orbit rings.
   * If `filterKey` is non-null, only geometry touching that node is updated
   * (used during drag to keep the DOM writes cheap). If null, everything is
   * updated (used by the force simulation tick).
   */
  #redrawEdgesAndRings(filterKey) {
    const nodeMap = this._globalNodeMap;
    if (!nodeMap) return;

    // Updates a straight <line> (or curved <path> if it carries a curveOffset)
    const updateEdgeLine = (line, fn, tn, curveOffset) => {
      const { x1, y1, x2, y2 } = this.#edgeEndpoints(fn, tn);
      if (curveOffset) {
        line.setAttribute("d", this.#curvedPath(x1, y1, x2, y2, curveOffset));
      } else {
        line.setAttribute("x1", x1); line.setAttribute("y1", y1);
        line.setAttribute("x2", x2); line.setAttribute("y2", y2);
      }
    };

    // Moves an orbit-ring <circle> to a new parent center
    const updateRingCenter = (ring, parentKey) => {
      const pn = nodeMap[parentKey];
      if (pn) { ring.setAttribute("cx", pn.x); ring.setAttribute("cy", pn.y); }
    };

    // ── Relationship edges ───────────────────────────────────────────────────
    if (this._globalEdgeEls) {
      for (const { line, hitArea, fromKey, toKey, curveOffset } of Object.values(this._globalEdgeEls)) {
        if (filterKey != null && fromKey !== filterKey && toKey !== filterKey) continue;
        const fn = nodeMap[fromKey], tn = nodeMap[toKey];
        if (!fn || !tn) continue;
        updateEdgeLine(line, fn, tn, curveOffset);
        if (hitArea) updateEdgeLine(hitArea, fn, tn, curveOffset);
      }
    }

    // ── Sub-faction spoke lines (parent ↔ sub-faction) ───────────────────────
    if (this._spokeLinkEls) {
      for (const { line, parentKey, subKey } of Object.values(this._spokeLinkEls)) {
        if (filterKey != null && parentKey !== filterKey && subKey !== filterKey) continue;
        const pn = nodeMap[parentKey], sn = nodeMap[subKey];
        if (!pn || !sn) continue;
        updateEdgeLine(line, pn, sn, 0);
      }
    }

    // ── Orbit rings (sub-faction + member + party member/retainer) ───────────
    if (filterKey != null) {
      const ring = this._orbitRingEls?.[filterKey];
      if (ring) updateRingCenter(ring, filterKey);
      const memberRing = this._memberOrbitRingEls?.[filterKey];
      if (memberRing) updateRingCenter(memberRing, filterKey);
      const pmRing = this._partyMemberRingEls?.[filterKey];
      if (pmRing) updateRingCenter(pmRing, filterKey);
      const prRing = this._partyRetainerRingEls?.[filterKey];
      if (prRing) updateRingCenter(prRing, filterKey);
    } else {
      if (this._orbitRingEls) {
        for (const [pk, ring] of Object.entries(this._orbitRingEls)) updateRingCenter(ring, pk);
      }
      if (this._memberOrbitRingEls) {
        for (const [pk, ring] of Object.entries(this._memberOrbitRingEls)) updateRingCenter(ring, pk);
      }
      if (this._partyMemberRingEls) {
        for (const [pk, ring] of Object.entries(this._partyMemberRingEls)) updateRingCenter(ring, pk);
      }
      if (this._partyRetainerRingEls) {
        for (const [pk, ring] of Object.entries(this._partyRetainerRingEls)) updateRingCenter(ring, pk);
      }
    }

    // ── Member spoke lines (parent ↔ member) ─────────────────────────────────
    if (this._memberSpokeEls) {
      for (const { line, parentKey, memberKey } of Object.values(this._memberSpokeEls)) {
        if (filterKey != null && parentKey !== filterKey && memberKey !== filterKey) continue;
        const pn = nodeMap[parentKey], mn = nodeMap[memberKey];
        if (!pn || !mn) continue;
        updateEdgeLine(line, pn, mn, 0);
      }
    }

    // ── Party-member spoke lines ──────────────────────────────────────────────
    if (this._partyMemberSpokeEls) {
      for (const { line, parentKey, memberKey } of Object.values(this._partyMemberSpokeEls)) {
        if (filterKey != null && parentKey !== filterKey && memberKey !== filterKey) continue;
        const pn = nodeMap[parentKey], mn = nodeMap[memberKey];
        if (!pn || !mn) continue;
        updateEdgeLine(line, pn, mn, 0);
      }
    }

    // ── Party-retainer spoke lines ────────────────────────────────────────────
    if (this._partyRetainerSpokeEls) {
      for (const { line, parentKey, memberKey } of Object.values(this._partyRetainerSpokeEls)) {
        if (filterKey != null && parentKey !== filterKey && memberKey !== filterKey) continue;
        const pn = nodeMap[parentKey], mn = nodeMap[memberKey];
        if (!pn || !mn) continue;
        updateEdgeLine(line, pn, mn, 0);
      }
    }
  }

  // ─── Shared Node Rendering ────────────────────────────────────────────────────

  #renderNode(node) {
    const g = this.#el("g", {
      class:        `mm-node mm-node-type-${node.type}`,
      "data-key":   node.key,
      transform:    `translate(${node.x},${node.y})`
    });

    const color = node.resolvedColor ?? node.edge?.color ?? null;

    // Shape
    let shape;
    if (node.type === "central") {
      shape = this.#el("circle", { r: R.central, class: "mm-shape mm-central" });
    } else if (node.type === "subfaction") {
      shape = this.#el("circle", { r: R.subfaction, class: "mm-shape mm-subfaction" });
    } else if (node.type === "faction") {
      shape = this.#el("circle", { r: R.faction, class: "mm-shape mm-faction-node" });
    } else if (node.type === "pov") {
      if (node.isParty) {
        // POV party: hexagon (pointy-top) with POV gold styling
        const s = node.radius ?? R.pov;
        const pts = Array.from({length: 6}, (_, i) => {
          const a = (Math.PI / 3) * i - Math.PI / 2;
          return `${(s * Math.cos(a)).toFixed(1)},${(s * Math.sin(a)).toFixed(1)}`;
        }).join(" ");
        shape = this.#el("polygon", { points: pts, class: "mm-shape mm-pov" });
      } else {
        shape = this.#el("circle", { r: node.radius ?? R.pov, class: "mm-shape mm-pov" });
      }
    } else if (node.type === "faction-global") {
      shape = this.#el("circle", { r: node.radius ?? R.factionGlobal, class: "mm-shape mm-faction-global" });
    } else if (node.type === "document") {
      shape = this.#el("rect", {
        x: -R.document.rx, y: -R.document.ry,
        width: R.document.rx * 2, height: R.document.ry * 2,
        rx: 6, class: "mm-shape mm-document"
      });
    } else if (node.type === "doc-actor") {
      const s = node.radius ?? R.docGlobal;
      shape = this.#el("polygon", {
        points: `0,${-s} ${s},0 0,${s} ${-s},0`,
        class: "mm-shape mm-doc-actor"
      });
    } else if (node.type === "party-global") {
      // Pointy-top hexagon for adventuring party nodes
      const s = node.radius ?? R.factionGlobal;
      const pts = Array.from({length: 6}, (_, i) => {
        const a = (Math.PI / 3) * i - Math.PI / 2;
        return `${(s * Math.cos(a)).toFixed(1)},${(s * Math.sin(a)).toFixed(1)}`;
      }).join(" ");
      shape = this.#el("polygon", { points: pts, class: "mm-shape mm-party-global" });
    } else if (node.type === "doc-scene") {
      // Octagon (flat-top, stop-sign orientation) for Scene documents
      const s = node.radius ?? R.docGlobal;
      const pts = Array.from({length: 8}, (_, i) => {
        const a = (Math.PI / 4) * i + Math.PI / 8;
        return `${(s * Math.cos(a)).toFixed(1)},${(s * Math.sin(a)).toFixed(1)}`;
      }).join(" ");
      shape = this.#el("polygon", { points: pts, class: "mm-shape mm-doc-scene" });
    } else if (node.type === "doc-journal") {
      // Parallelogram (forward-leaning) for JournalEntry documents
      const s = node.radius ?? R.docGlobal;
      const w = s * 1.6, h = s * 0.85, sk = s * 0.3;
      const pts = [
        `${(-w/2+sk).toFixed(1)},${(-h/2).toFixed(1)}`,
        `${( w/2+sk).toFixed(1)},${(-h/2).toFixed(1)}`,
        `${( w/2-sk).toFixed(1)},${( h/2).toFixed(1)}`,
        `${(-w/2-sk).toFixed(1)},${( h/2).toFixed(1)}`
      ].join(" ");
      shape = this.#el("polygon", { points: pts, class: "mm-shape mm-doc-journal" });
    } else if (node.type === "doc-other") {
      const s = node.radius ?? R.docGlobal;
      shape = this.#el("rect", {
        x: -s, y: -s, width: s * 2, height: s * 2,
        rx: 3, class: "mm-shape mm-doc-other"
      });
    } else if (node.type === "member-actor") {
      const s = node.radius ?? MEMBER_NODE_R;
      shape = this.#el("polygon", {
        points: `0,${-s} ${s},0 0,${s} ${-s},0`,
        class: "mm-shape mm-member-actor"
      });
    } else if (node.type === "member-other") {
      const s = node.radius ?? MEMBER_NODE_R;
      shape = this.#el("polygon", {
        points: `0,${-s} ${s},0 0,${s} ${-s},0`,
        class: "mm-shape mm-member-other"
      });
    } else if (node.type === "party-member-actor") {
      const s = node.radius ?? PARTY_MEMBER_NODE_R;
      shape = this.#el("polygon", {
        points: `0,${-s} ${s},0 0,${s} ${-s},0`,
        class: "mm-shape mm-party-member-actor"
      });
    } else if (node.type === "party-member-other") {
      const s = node.radius ?? PARTY_MEMBER_NODE_R;
      shape = this.#el("polygon", {
        points: `0,${-s} ${s},0 0,${s} ${-s},0`,
        class: "mm-shape mm-party-member-other"
      });
    } else if (node.type === "party-retainer-actor") {
      const s = node.radius ?? PARTY_MEMBER_NODE_R;
      shape = this.#el("polygon", {
        points: `0,${-s} ${s},0 0,${s} ${-s},0`,
        class: "mm-shape mm-party-retainer-actor"
      });
    } else if (node.type === "party-retainer-other") {
      const s = node.radius ?? PARTY_MEMBER_NODE_R;
      shape = this.#el("polygon", {
        points: `0,${-s} ${s},0 0,${s} ${-s},0`,
        class: "mm-shape mm-party-retainer-other"
      });
    } else {
      shape = this.#el("ellipse", { rx: R.simple.rx, ry: R.simple.ry, class: "mm-shape mm-simple" });
    }

    if (color) {
      // Use inline style so it wins over CSS class fill/stroke rules
      shape.style.stroke = color;
      if (node.type === "faction-global" || node.type === "party-global"
          || node.isDocument || node.isMember
          || node.isPartyMember || node.isPartyRetainer) {
        shape.style.fill = color;
      }
    }
    g.appendChild(shape);

    // Document type icon
    if (node.type === "document" && node.edge?.documentType) {
      const glyphs = { Actor: "\uf007", JournalEntry: "\uf518", Item: "\uf466", Scene: "\uf03e" };
      const icon   = this.#el("text", {
        class:              "mm-node-icon",
        x: 0, y:           -R.document.ry + 14,
        "text-anchor":     "middle",
        "dominant-baseline": "middle",
        "font-family":     "Font Awesome 6 Free",
        "font-weight":     "900",
        "font-size":       "11",
        "pointer-events":  "none"
      });
      icon.textContent = glyphs[node.edge.documentType] ?? "\uf15b";
      g.appendChild(icon);
    }

    // Label — scale font/wrap with node radius for variable-size global nodes
    let fontSize   = null; // null → CSS controls font-size
    let wrapAt     = (node.isMember || node.isPartyMember || node.isPartyRetainer) ? 7 : 12;
    let lineHeight = (node.isMember || node.isPartyMember || node.isPartyRetainer) ? 11 : 13;

    if (node.type === "pov" || node.type === "faction-global" || node.type === "party-global") {
      const r  = node.radius ?? R.factionGlobal;
      fontSize   = Math.max(9, r * 0.35);
      lineHeight = fontSize * 1.2;
      wrapAt = Math.max(6, Math.floor((r * 1.5) / (fontSize * 0.55)));
    }

    const lines  = this.#wrapText(node.label, wrapAt);
    const totalH = lines.length * lineHeight;
    const startY = (node.type === "document" ? 6 : 0) + (-totalH / 2 + lineHeight / 2);

    lines.forEach((line, i) => {
      const t = this.#el("text", {
        class:               "mm-node-label",
        x: 0, y:            startY + i * lineHeight,
        "text-anchor":      "middle",
        "dominant-baseline": "middle",
        "pointer-events":   "none"
      });
      if (fontSize !== null) t.style.fontSize = `${fontSize}px`;
      t.textContent = line;
      g.appendChild(t);
    });

    // Relation label below node (local mode only)
    if (node.edge?.relationLabel) {
      const bottomY = (node.type === "document" ? R.document.ry
        : node.type === "simple"   ? R.simple.ry
        : node.type === "central"  ? R.central
        : R.faction) + 15;
      const rl = this.#el("text", {
        class:           "mm-relation-label",
        x: 0, y:         bottomY,
        "text-anchor":   "middle",
        "pointer-events": "none"
      });
      rl.textContent = node.edge.relationLabel;
      g.appendChild(rl);
    }

    return g;
  }

  // ─── Drag ────────────────────────────────────────────────────────────────────

  /**
   * Wire mousedown drag (and click-to-set-POV in global mode) on a node element.
   */
  #wireNodeDrag(el, node, edgeEl, centralNode, isGlobal) {
    el.addEventListener("mousedown", (e) => {
      e.stopPropagation(); // prevent the background pan handler from firing
      if (e.button !== 0) return;
      const pos = this.#svgCoords(e);
      this.#drag = {
        nodeKey:     node.key,
        nodeEl:      el,
        offsetX:     pos.x - node.x,
        offsetY:     pos.y - node.y,
        node,
        edgeEl:      edgeEl,
        centralNode: centralNode,
        startX:      pos.x,
        startY:      pos.y,
        moved:       false,
        isGlobal
      };
      el.style.cursor = "grabbing";
    });
  }

  // ─── Pan ─────────────────────────────────────────────────────────────────────

  /** Start a background pan when the user clicks the SVG canvas (not a node). */
  #onBgMousedown(e) {
    if (e.button !== 0) return;
    // Only pan when clicking the background, not a node group
    if (!e.target.classList.contains("mm-bg") && e.target !== this.#svg) return;
    e.preventDefault();
    this.#pan = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPanX:    this.#transform.x,
      startPanY:    this.#transform.y
    };
    this.#svg.style.cursor = "grabbing";
  }

  // ─── Zoom ─────────────────────────────────────────────────────────────────────

  #onWheel(e) {
    e.preventDefault();
    const rect      = this.#svg.getBoundingClientRect();
    const cursorSX  = e.clientX - rect.left; // cursor in SVG pixel space
    const cursorSY  = e.clientY - rect.top;

    const factor   = e.deltaY < 0 ? 1.1 : 0.9;
    const oldScale = this.#transform.scale;
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, oldScale * factor));

    // Keep the world point under the cursor stationary
    this.#transform.x     = cursorSX - (cursorSX - this.#transform.x) * (newScale / oldScale);
    this.#transform.y     = cursorSY - (cursorSY - this.#transform.y) * (newScale / oldScale);
    this.#transform.scale = newScale;

    this.#applyTransform();
  }

  #applyTransform() {
    if (!this.#viewport) return;
    const { x, y, scale } = this.#transform;
    this.#viewport.setAttribute("transform", `translate(${x},${y}) scale(${scale})`);
  }

  // ─── Unified Mouse Handlers ───────────────────────────────────────────────────

  #onMouseMove(e) {
    // Handle connection drag (ghost edge + target highlight)
    if (this.#connDrag) {
      const px = this.#svgPx(e);
      this.#ghostLine.setAttribute("x2", px.x);
      this.#ghostLine.setAttribute("y2", px.y);

      // Detect which node is under the cursor
      const underEl  = document.elementFromPoint(e.clientX, e.clientY);
      const nodeEl   = underEl?.closest?.(".mm-node");
      const overKey  = nodeEl?.dataset?.key ?? null;
      const newTarget = (overKey && overKey !== this.#connDrag.fromKey) ? overKey : null;

      if (newTarget !== this.#connTargetKey) {
        if (this.#connTargetKey) {
          this.#svg.querySelector(`[data-key="${CSS.escape(this.#connTargetKey)}"]`)
                   ?.classList.remove("mm-connect-target");
        }
        this.#connTargetKey = newTarget;
        if (this.#connTargetKey) {
          this.#svg.querySelector(`[data-key="${CSS.escape(this.#connTargetKey)}"]`)
                   ?.classList.add("mm-connect-target");
        }
      }
      return;
    }

    // Handle background pan
    if (this.#pan) {
      this.#transform.x = this.#pan.startPanX + (e.clientX - this.#pan.startClientX);
      this.#transform.y = this.#pan.startPanY + (e.clientY - this.#pan.startClientY);
      this.#applyTransform();
      return;
    }

    // Handle node drag
    if (this.#drag) {
    const pos  = this.#svgCoords(e);
    const newX = pos.x - this.#drag.offsetX;
    const newY = pos.y - this.#drag.offsetY;

    // Mark as moved if the cursor has shifted enough
    if (
      Math.abs(pos.x - this.#drag.startX) > 3 ||
      Math.abs(pos.y - this.#drag.startY) > 3
    ) {
      this.#drag.moved = true;
    }

    if (this.#drag.isGlobal) {
      // Compute delta before updating position
      const dx = newX - this.#drag.node.x;
      const dy = newY - this.#drag.node.y;

      this.#drag.node.x = newX;
      this.#drag.node.y = newY;
      this.#drag.nodeEl.setAttribute("transform", `translate(${newX},${newY})`);
      this.#redrawGlobalEdgesForNode(this.#drag.nodeKey);

      // Move ALL descendants (any depth) with the dragged node
      if (dx || dy) this.#moveDescendantsLive(this.#drag.nodeKey, dx, dy);
    } else {
      this.#drag.node.x = newX;
      this.#drag.node.y = newY;
      this.#drag.nodeEl.setAttribute("transform", `translate(${newX},${newY})`);

      if (this.#drag.edgeEl && this.#drag.centralNode) {
        const { x1, y1, x2, y2 } = this.#edgeEndpoints(
          this.#drag.centralNode,
          this.#drag.node
        );
        const el = this.#drag.edgeEl;
        el.setAttribute("x1", x1);
        el.setAttribute("y1", y1);
        el.setAttribute("x2", x2);
        el.setAttribute("y2", y2);
      }
    }
    return;
    }

    // Update connector dot position (global mode only, no active drag/pan)
    if (this._globalNodeMap) this.#updateHoverConnector(e);
  }

  #onMouseUp(e) {
    // End connection drag
    if (this.#connDrag) {
      const fromKey = this.#connDrag.fromKey;
      this.#connDrag = null;
      this.#ghostLine.style.display    = "none";
      this.#connectorDot.style.display = "none";
      this.#svg.style.cursor = "";

      // Clear target highlight and fire callback if over a valid target
      const toKey = this.#connTargetKey;
      if (this.#connTargetKey) {
        this.#svg.querySelector(`[data-key="${CSS.escape(this.#connTargetKey)}"]`)
                 ?.classList.remove("mm-connect-target");
        this.#connTargetKey = null;
      }
      if (toKey) this.#config.onConnectNodes?.(fromKey, toKey, e.clientX, e.clientY);
      return;
    }

    // End pan
    if (this.#pan) {
      this.#pan = null;
      this.#svg.style.cursor = "";
      return;
    }

    // End node drag
    if (!this.#drag) return;
    const { nodeKey, node, nodeEl, isGlobal, moved } = this.#drag;
    nodeEl.style.cursor = "";

    if (isGlobal && !moved && this.#config.onSetPOV) {
      this.#config.onSetPOV(nodeKey);
    } else if (isGlobal && moved && (node.isSubFaction || node.isMember || node.isPartyMember || node.isPartyRetainer)) {
      // Child dragged: normalize all siblings to the same orbit radius
      this.#normalizeOrbitAfterDrag(node);
    } else {
      const entries = [{ nodeKey, x: node.x, y: node.y }];
      // Include all descendants (any depth) that moved with the dragged node
      if (isGlobal) this.#collectDescendantPositions(nodeKey, entries);
      this.#emitPositionSaves(entries);
    }

    this.#drag = null;
  }

  /**
   * After a sub-faction or member is dragged, compute the new orbit radius from
   * its distance to the parent and rearrange all siblings (of the same kind) to
   * that same radius, preserving each sibling's angle. Updates the orbit ring.
   * Sub-factions also carry their descendants along; members have none.
   */
  #normalizeOrbitAfterDrag(draggedNode) {
    const parentNode = this._globalNodeMap?.[draggedNode.parentId];
    if (!parentNode) {
      this.#emitPositionSaves([{ nodeKey: draggedNode.key, x: draggedNode.x, y: draggedNode.y }]);
      return;
    }

    const newRadius = Math.sqrt(
      (draggedNode.x - parentNode.x) ** 2 +
      (draggedNode.y - parentNode.y) ** 2
    );

    const isMember        = !!draggedNode.isMember;
    const isPartyMember   = !!draggedNode.isPartyMember;
    const isPartyRetainer = !!draggedNode.isPartyRetainer;
    const isSubFaction    = !!draggedNode.isSubFaction;

    const siblings = Object.values(this._globalNodeEls ?? {})
      .map(({ node: n }) => n)
      .filter(n => n.parentId === draggedNode.parentId && (
        isMember        ? n.isMember        :
        isPartyMember   ? n.isPartyMember   :
        isPartyRetainer ? n.isPartyRetainer :
        n.isSubFaction
      ));

    const entries = [];
    for (const sib of siblings) {
      const oldX  = sib.x, oldY = sib.y;
      const angle = Math.atan2(sib.y - parentNode.y, sib.x - parentNode.x);
      sib.x = parentNode.x + newRadius * Math.cos(angle);
      sib.y = parentNode.y + newRadius * Math.sin(angle);
      const sibEl = this._globalNodeEls?.[sib.key]?.el;
      if (sibEl) sibEl.setAttribute("transform", `translate(${sib.x},${sib.y})`);
      entries.push({ nodeKey: sib.key, x: sib.x, y: sib.y });
      this.#redrawGlobalEdgesForNode(sib.key);

      // Sub-factions can have descendants — carry them along by the same delta.
      // Members and party-members/retainers are leaf nodes.
      if (isSubFaction) {
        const sdx = sib.x - oldX, sdy = sib.y - oldY;
        if (sdx || sdy) {
          this.#moveDescendantsLive(sib.key, sdx, sdy);
          this.#collectDescendantPositions(sib.key, entries);
        }
      }
    }
    this.#emitPositionSaves(entries);

    // Update the appropriate orbit ring radius
    if (isMember) {
      this._memberOrbitRingEls?.[draggedNode.parentId]?.setAttribute("r", newRadius);
    } else if (isPartyMember) {
      this._partyMemberRingEls?.[draggedNode.parentId]?.setAttribute("r", newRadius);
    } else if (isPartyRetainer) {
      this._partyRetainerRingEls?.[draggedNode.parentId]?.setAttribute("r", newRadius);
    } else {
      if (this._orbitRadii) this._orbitRadii[draggedNode.parentId] = newRadius;
      const ring = this._orbitRingEls?.[draggedNode.parentId];
      if (ring) ring.setAttribute("r", newRadius);
    }
  }

  /**
   * Recursively move all descendants of nodeKey by (dx, dy) — live DOM update,
   * no position saving. Called during drag so the whole subtree follows the cursor.
   */
  #moveDescendantsLive(nodeKey, dx, dy) {
    if (!this._globalNodeEls || (!dx && !dy)) return;
    for (const { el, node: child } of Object.values(this._globalNodeEls)) {
      if (child.parentId !== nodeKey) continue;
      child.x += dx;
      child.y += dy;
      el.setAttribute("transform", `translate(${child.x},${child.y})`);
      this.#redrawGlobalEdgesForNode(child.key);
      this.#moveDescendantsLive(child.key, dx, dy); // recurse into grandchildren
    }
  }

  /**
   * Recursively collect positions of all descendants of nodeKey into `entries`
   * so the caller can persist them in a single batched save on mouseup.
   */
  #collectDescendantPositions(nodeKey, entries) {
    if (!this._globalNodeEls) return;
    for (const { node: child } of Object.values(this._globalNodeEls)) {
      if (child.parentId !== nodeKey) continue;
      entries.push({ nodeKey: child.key, x: child.x, y: child.y });
      this.#collectDescendantPositions(child.key, entries);
    }
  }

  /** Redraw only edges / spokes / rings touching the given node (drag path). */
  #redrawGlobalEdgesForNode(nodeKey) {
    this.#redrawEdgesAndRings(nodeKey);
  }

  // ─── SVG Creation ─────────────────────────────────────────────────────────────

  #createSVG(w, h) {
    const svg = this.#el("svg", { width: w, height: h });

    // Background rect for pan detection and context-menu target
    svg.appendChild(this.#el("rect", {
      class: "mm-bg", x: 0, y: 0, width: w, height: h, fill: "transparent"
    }));

    const defs = this.#el("defs");
    defs.appendChild(this.#makeArrowMarker("arrow-end",   "M0,0 L0,6 L8,3 z", 7));
    defs.appendChild(this.#makeArrowMarker("arrow-start", "M8,0 M8,0 L8,6 L0,3 z", 1));
    svg.appendChild(defs);

    // Connector overlay — lives outside #viewport so it's in screen-px space,
    // unaffected by pan/zoom. Holds the hover dot and the ghost drag edge.
    this.#ghostLine = this.#el("line", {
      class: "mm-ghost-edge",
      "pointer-events": "none",
      style: "display:none"
    });
    this.#connectorDot = this.#el("circle", {
      class: "mm-connector-dot",
      r: 7,
      style: "display:none"
    });

    const connLayer = this.#el("g", { class: "mm-connector-layer" });
    connLayer.appendChild(this.#ghostLine);
    connLayer.appendChild(this.#connectorDot);
    svg.appendChild(connLayer);

    // Wire connector dot drag — mousedown starts a connection drag
    this.#connectorDot.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || !this.#connHover) return;
      e.stopPropagation();
      const startPx = {
        x: parseFloat(this.#connectorDot.getAttribute("cx")),
        y: parseFloat(this.#connectorDot.getAttribute("cy"))
      };
      this.#connDrag = { fromKey: this.#connHover.key, startPx };
      this.#ghostLine.setAttribute("x1", startPx.x);
      this.#ghostLine.setAttribute("y1", startPx.y);
      this.#ghostLine.setAttribute("x2", startPx.x);
      this.#ghostLine.setAttribute("y2", startPx.y);
      this.#ghostLine.style.display   = "";
      this.#connectorDot.style.display = "none";
      this.#svg.style.cursor = "crosshair";
    });

    return svg;
  }

  #makeArrowMarker(id, pathD, refX) {
    const marker = this.#el("marker", {
      id,
      markerWidth: 8, markerHeight: 6,
      refX, refY: 3,
      orient: "auto",
      markerUnits: "strokeWidth"
    });
    const path = this.#el("path", { d: pathD, fill: "context-stroke" });
    marker.appendChild(path);
    return marker;
  }

  // ─── Edge Geometry ────────────────────────────────────────────────────────────

  #edgeEndpoints(from, to) {
    const dx   = to.x - from.x;
    const dy   = to.y - from.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) return { x1: from.x, y1: from.y, x2: to.x, y2: to.y };

    const ux = dx / dist;
    const uy = dy / dist;
    const rf = this.#nodeRadius(from);
    const rt = this.#nodeRadius(to);

    return {
      x1: from.x + ux * rf,
      y1: from.y + uy * rf,
      x2: to.x   - ux * rt,
      y2: to.y   - uy * rt
    };
  }

  #nodeRadius(node) {
    if (node.radius != null) return node.radius;
    return NODE_TYPE_RADIUS[node.type] ?? NODE_TYPE_RADIUS[NODE_TYPE.SIMPLE];
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Convert a mouse event's client coordinates to world (canvas) coordinates,
   * accounting for the current pan/zoom transform.
   */
  #svgCoords(event) {
    const rect  = this.#svg.getBoundingClientRect();
    const sx    = event.clientX - rect.left; // SVG pixel space
    const sy    = event.clientY - rect.top;
    // Undo viewport transform: translate then scale
    return {
      x: (sx - this.#transform.x) / this.#transform.scale,
      y: (sy - this.#transform.y) / this.#transform.scale
    };
  }

  /** Convert a mouse event to SVG pixel coordinates (screen-space, no world transform). */
  #svgPx(event) {
    const rect = this.#svg.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /** Convert a world-space point to SVG pixel space (accounts for pan/zoom). */
  #worldToSvgPx(wx, wy) {
    const { x, y, scale } = this.#transform;
    return { x: wx * scale + x, y: wy * scale + y };
  }

  /**
   * Hover-connector detection driven by the SVG-level mousemove.
   * Finds whichever node the cursor is inside, then positions the connector dot
   * at the circumference point nearest the cursor. Because this runs off the
   * SVG's own mousemove (rather than per-node mouseenter/leave), there is no
   * "gap" between the node shape and the dot that would cause it to disappear
   * when the user tries to click it.
   */
  #updateHoverConnector(e) {
    if (e.target === this.#connectorDot) return;

    const worldPos = this.#svgCoords(e);
    let bestNode = null, bestEdgePt = null, bestDist = Infinity;

    const OUTER_GRAB = 14; // world-unit leeway outside the boundary
    for (const node of Object.values(this._globalNodeMap ?? {})) {
      const r  = this.#nodeRadius(node);
      const dx = worldPos.x - node.x;
      const dy = worldPos.y - node.y;
      // Pre-filter: skip nodes whose bounding circle is too far away
      if (Math.hypot(dx, dy) > r + OUTER_GRAB + 2) continue;
      const { x: ex, y: ey, inside } = this.#nodeEdgePoint(node, worldPos.x, worldPos.y);
      const distToEdge = Math.hypot(worldPos.x - ex, worldPos.y - ey);
      // Inside: show in the outer 55% of the shape. Outside: show within OUTER_GRAB units.
      const inZone = inside ? distToEdge < r * 0.55 : distToEdge < OUTER_GRAB;
      if (inZone && distToEdge < bestDist) {
        bestDist   = distToEdge;
        bestNode   = node;
        bestEdgePt = { x: ex, y: ey };
      }
    }

    if (bestNode) {
      this.#connHover = bestNode;
      const px = this.#worldToSvgPx(bestEdgePt.x, bestEdgePt.y);
      this.#connectorDot.setAttribute("cx", px.x);
      this.#connectorDot.setAttribute("cy", px.y);
      this.#connectorDot.style.display = "";
    } else {
      this.#connHover = null;
      this.#connectorDot.style.display = "none";
    }
  }

  /**
   * Returns the point on `node`'s actual shape boundary in the direction from
   * the node centre toward world point (wx, wy), plus whether (wx, wy) is
   * inside the shape. All coordinates are in world space.
   */
  #nodeEdgePoint(node, wx, wy) {
    const dx = wx - node.x, dy = wy - node.y;
    const dist = Math.hypot(dx, dy);
    // Cursor is at the exact centre — project upward as a safe default
    if (dist < 0.1) {
      const r = this.#nodeRadius(node);
      return { x: node.x, y: node.y - r, inside: true };
    }
    const ux = dx / dist, uy = dy / dist;
    const s  = this.#nodeRadius(node);
    const t  = node.type;

    // ── Circles ────────────────────────────────────────────────────────────
    if (t === NODE_TYPE.CENTRAL || t === NODE_TYPE.SUBFACTION ||
        t === NODE_TYPE.FACTION || t === NODE_TYPE.FACTION_GLOBAL) {
      return { x: node.x + ux * s, y: node.y + uy * s, inside: dist <= s };
    }
    if (t === NODE_TYPE.POV) {
      if (node.isParty) {
        // Party POV: hexagon edge geometry
        const poly = Array.from({length: 6}, (_, i) => {
          const a = (Math.PI / 3) * i - Math.PI / 2;
          return { x: s * Math.cos(a), y: s * Math.sin(a) };
        });
        const pt = this.#rayPolyEdge(ux, uy, poly) ?? {x: ux*s, y: uy*s};
        return { x: node.x + pt.x, y: node.y + pt.y,
                 inside: this.#pointInPoly(dx, dy, poly) };
      }
      return { x: node.x + ux * s, y: node.y + uy * s, inside: dist <= s };
    }

    // ── Hexagon pointy-top (party-global) ──────────────────────────────────
    if (t === NODE_TYPE.PARTY_GLOBAL) {
      const poly = Array.from({length: 6}, (_, i) => {
        const a = (Math.PI / 3) * i - Math.PI / 2;
        return { x: s * Math.cos(a), y: s * Math.sin(a) };
      });
      const pt = this.#rayPolyEdge(ux, uy, poly) ?? {x: ux*s, y: uy*s};
      return { x: node.x + pt.x, y: node.y + pt.y,
               inside: this.#pointInPoly(dx, dy, poly) };
    }

    // ── Diamond (axis-aligned rhombus) ─────────────────────────────────────
    if (t === NODE_TYPE.DOC_ACTOR       || t === NODE_TYPE.MEMBER_ACTOR      ||
        t === NODE_TYPE.MEMBER_OTHER    || t === NODE_TYPE.PARTY_MEMBER_ACTOR ||
        t === NODE_TYPE.PARTY_MEMBER_OTHER || t === NODE_TYPE.PARTY_RETAINER_ACTOR ||
        t === NODE_TYPE.PARTY_RETAINER_OTHER) {
      const poly = [{x:0,y:-s},{x:s,y:0},{x:0,y:s},{x:-s,y:0}];
      const pt   = this.#rayPolyEdge(ux, uy, poly) ?? {x: ux*s, y: uy*s};
      return { x: node.x + pt.x, y: node.y + pt.y,
               inside: Math.abs(dx) + Math.abs(dy) <= s };
    }

    // ── Octagon flat-top (doc-scene) ───────────────────────────────────────
    if (t === NODE_TYPE.DOC_SCENE) {
      const poly = Array.from({length: 8}, (_, i) => {
        const a = (Math.PI / 4) * i + Math.PI / 8;
        return { x: s * Math.cos(a), y: s * Math.sin(a) };
      });
      const pt = this.#rayPolyEdge(ux, uy, poly) ?? {x: ux*s, y: uy*s};
      return { x: node.x + pt.x, y: node.y + pt.y,
               inside: this.#pointInPoly(dx, dy, poly) };
    }

    // ── Parallelogram (doc-journal) ─────────────────────────────────────────
    if (t === NODE_TYPE.DOC_JOURNAL) {
      const w = s*1.6, h = s*0.85, sk = s*0.3;
      const poly = [
        {x: -w/2+sk, y: -h/2}, {x:  w/2+sk, y: -h/2},
        {x:  w/2-sk, y:  h/2}, {x: -w/2-sk, y:  h/2},
      ];
      const pt = this.#rayPolyEdge(ux, uy, poly) ?? {x: ux*s, y: uy*s};
      return { x: node.x + pt.x, y: node.y + pt.y,
               inside: this.#pointInPoly(dx, dy, poly) };
    }

    // ── Rectangle: document (fixed dims) ────────────────────────────────────
    if (t === NODE_TYPE.DOCUMENT) {
      const hw = R.document.rx, hh = R.document.ry;
      const pt = this.#rayRectEdge(ux, uy, hw, hh);
      return { x: node.x + pt.x, y: node.y + pt.y,
               inside: Math.abs(dx) <= hw && Math.abs(dy) <= hh };
    }

    // ── Square: doc-other (half-size = s) ───────────────────────────────────
    if (t === NODE_TYPE.DOC_OTHER) {
      const pt = this.#rayRectEdge(ux, uy, s, s);
      return { x: node.x + pt.x, y: node.y + pt.y,
               inside: Math.abs(dx) <= s && Math.abs(dy) <= s };
    }

    // ── Ellipse (simple) ────────────────────────────────────────────────────
    if (t === NODE_TYPE.SIMPLE) {
      const erx = R.simple.rx, ery = R.simple.ry;
      const te  = 1 / Math.sqrt((ux/erx)**2 + (uy/ery)**2);
      return { x: node.x + ux*te, y: node.y + uy*te,
               inside: (dx/erx)**2 + (dy/ery)**2 <= 1 };
    }

    // ── Fallback: treat as circle ────────────────────────────────────────────
    return { x: node.x + ux * s, y: node.y + uy * s, inside: dist <= s };
  }

  /** Ray from origin along (ux,uy) vs axis-aligned rect [-hw,hw]×[-hh,hh]. Returns local offset. */
  #rayRectEdge(ux, uy, hw, hh) {
    const tx = Math.abs(ux) > 1e-9 ? (ux > 0 ? hw : -hw) / ux : Infinity;
    const ty = Math.abs(uy) > 1e-9 ? (uy > 0 ? hh : -hh) / uy : Infinity;
    const te = Math.min(tx, ty);
    return { x: ux * te, y: uy * te };
  }

  /** Ray from origin along (ux,uy) vs polygon (vertices relative to origin). Returns local offset or null. */
  #rayPolyEdge(ux, uy, poly) {
    let best = Infinity;
    for (let i = 0, n = poly.length; i < n; i++) {
      const a = poly[i], b = poly[(i+1) % n];
      const edx = b.x - a.x, edy = b.y - a.y;
      const det = -ux*edy + edx*uy;
      if (Math.abs(det) < 1e-9) continue;
      const te = (-a.x*edy + edx*a.y) / det;
      const sv = ( ux*a.y - a.x*uy) / det;
      if (te > 1e-9 && sv >= -1e-9 && sv <= 1+1e-9 && te < best) best = te;
    }
    return best === Infinity ? null : { x: ux*best, y: uy*best };
  }

  /** Ray-casting point-in-polygon (works for any simple polygon, CW or CCW). */
  #pointInPoly(px, py, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      if (((yi > py) !== (yj > py)) && px < (xj-xi)*(py-yi)/(yj-yi)+xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  #el(tag, attrs = {}) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  #wrapText(text, maxChars) {
    if (!text) return [""];
    const words = text.split(" ");
    const lines = [];
    let current = "";
    for (const word of words) {
      if (current.length + word.length + 1 > maxChars && current) {
        lines.push(current);
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
    }
    if (current) lines.push(current);
    return lines;
  }
}
