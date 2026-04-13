const SVG_NS = "http://www.w3.org/2000/svg";

/** Radii and geometry constants */
const R = {
  central:    38,
  subfaction: 28,
  faction:    24,
  pov:        34,
  factionGlobal: 36,
  document: { rx: 32, ry: 20 },
  simple:   { rx: 30, ry: 18 },
  memberNode: 26,  // member orbit nodes
  docGlobal:  30   // document nodes on the global map
};
const INNER_RING       = 145;
const OUTER_RING       = 280;
const ORBIT_GAP        = 20;  // minimum gap between parent edge and sub-faction edge
const MEMBER_NODE_R    = 26;  // radius of member orbit nodes
const MEMBER_ORBIT_GAP = 15;  // gap between faction node edge and member ring

/** Zoom limits */
const MIN_SCALE = 0.15;
const MAX_SCALE = 5;

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
 *   onContextMenu:     (svgX, svgY, clientX, clientY) => void
 *   onNodeContextMenu: (nodeKey, edge|null, clientX, clientY) => void
 *   members:           getter → object (global mode — all members keyed by id)
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
  }

  destroy() {
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
    this.#pan      = null;
    this._globalEdgeEls      = null;
    this._globalNodeEls      = null;
    this._globalNodeMap      = null;
    this._orbitRingEls       = null;
    this._spokeLinkEls       = null;
    this._orbitRadii         = null;
    this._memberOrbitRingEls = null;
    this._memberSpokeEls     = null;
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
        this.#config.onContextMenu(0, 0, e.clientX, e.clientY);
      }
    });

    const nodes    = this.#buildGlobalNodes(cx, cy);
    const nodeMap  = Object.fromEntries(nodes.map(n => [n.key, n]));

    // Build edge descriptors
    const edgeDescs = this.#buildGlobalEdgeDescs();

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

    // Render edges (behind nodes)
    const edgeEls = {}; // key = "fromKey|toKey"
    for (const desc of edgeDescs) {
      const fromNode = nodeMap[desc.fromKey];
      const toNode   = nodeMap[desc.toKey];
      if (!fromNode || !toNode) continue;
      const line = this.#renderGlobalEdge(fromNode, toNode, desc);
      edgeGroup.appendChild(line);
      edgeEls[`${desc.fromKey}|${desc.toKey}`] = { line, fromKey: desc.fromKey, toKey: desc.toKey };
    }

    // Render nodes
    const nodeEls = {};
    for (const node of nodes) {
      const g = this.#renderNode(node);
      nodeGroup.appendChild(g);
      nodeEls[node.key] = { el: g, node };
    }

    // Wire drag + left-click (POV toggle) + right-click on each node.
    // Member and document nodes get drag only — no POV toggle or context menu.
    for (const { el, node } of Object.values(nodeEls)) {
      this.#wireNodeDrag(el, node, null, null, true);

      if (!node.isMember && !node.isDocument) {
        el.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.#config.onNodeContextMenu(node.key, null, e.clientX, e.clientY);
        });
      }
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
      const resolvedColor = this.#resolveGlobalNodeColor(key, isPOV);
      const radius        = this.#computeNodeRadius(faction);
      nodes.push({
        key, label: faction.name,
        type: isPOV ? "pov" : "faction-global",
        x: pos.x, y: pos.y,
        edge: null, edgeStyle: null,
        resolvedColor, radius,
        isSubFaction: false
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
          const resolvedColor = this.#resolveGlobalNodeColor(key, isPOV);
          const radius        = this.#computeNodeRadius(faction);
          nodes.push({
            key, label: faction.name,
            type: isPOV ? "pov" : "faction-global",
            x: pos.x, y: pos.y,
            edge: null, edgeStyle: null,
            resolvedColor, radius,
            isSubFaction: true,
            parentId: faction.parentId
          });
        }
      }
      remaining = nextRound;
    }

    // ── Pass 3: document nodes (only those that have at least one stored edge) ─
    const edgesMap = this.#config.edges;
    const docMap   = new Map(); // uuid → { name, docType, factionIds[] }
    for (const edge of Object.values(edgesMap)) {
      if (edge.type !== "document" || !edge.documentUuid) continue;
      const uuid = edge.documentUuid;
      if (!docMap.has(uuid)) {
        docMap.set(uuid, {
          name:      edge.documentName  ?? "Document",
          docType:   edge.documentType  ?? "Other",
          factionIds: []
        });
      }
      docMap.get(uuid).factionIds.push(edge.fromFactionId);
    }

    docMap.forEach(({ name, docType, factionIds }, uuid) => {
      const key = `doc_${uuid}`;
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
      nodes.push({
        key,
        label:        name,
        type:         docType === "Actor" ? "doc-actor" : "doc-other",
        x: pos.x, y: pos.y,
        edge: null, edgeStyle: null,
        resolvedColor: null,
        radius:       R.docGlobal,
        isSubFaction: false,
        isMember:     false,
        isDocument:   true,
        documentType: docType
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
        const sp = saved[`member_${m.id}`];
        if (sp) {
          orbitR = Math.sqrt((sp.x - parentPos.x) ** 2 + (sp.y - parentPos.y) ** 2);
          break;
        }
      }

      members.forEach((member, i) => {
        const key   = `member_${member.id}`;
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
          resolvedColor: null,
          radius:       MEMBER_NODE_R,
          isSubFaction: false,
          isMember:     true,
          isDocument:   false,
          parentId:     factionId
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
    // Default: parent radius + gap + largest sub-faction radius
    const parentR = this.#computeNodeRadius(parentFaction);
    const maxSubR = siblings.length
      ? Math.max(...siblings.map(f => this.#computeNodeRadius(f)))
      : 20;
    return parentR + ORBIT_GAP + maxSubR;
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

    const values = statDefinitions.map(s => {
      const v = parseFloat(stats[s.id]);
      return isNaN(v) ? (s.default ?? 0) : v;
    });

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
      ? Math.max(0.4, Math.min(2.5, Math.sqrt(rawValue)))
      : 0.4;
    return R.factionGlobal * scale;
  }

  /** Determine a JS-applied fill/stroke color for a global-mode faction node. */
  #resolveGlobalNodeColor(factionId, isPOV) {
    const { povFactionId, edges: edgesMap, allFactions } = this.#config;

    // POV faction: gold (matched by CSS class mm-node-type-pov, no JS override needed)
    if (isPOV) return null;

    // No POV selected — all nodes use CSS default
    if (!povFactionId) return null;

    const allEdges = Object.values(edgesMap);

    // Check for a stored faction-to-faction edge connecting this node to the POV
    const connectingEdge = allEdges.find(e =>
      e.type === "faction" && (
        (e.fromFactionId === povFactionId && e.toFactionId === factionId) ||
        (e.fromFactionId === factionId   && e.toFactionId === povFactionId)
      )
    );
    if (connectingEdge) {
      const connectionTypes = this.#config.connectionTypes ?? [];
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
        color:   edge.color ?? typeColor ?? null
      });
    }

    // Document edges — line from faction node to document node.
    for (const edge of Object.values(edgesMap)) {
      if (edge.type !== "document" || !edge.documentUuid) continue;
      const typeColor = edge.connectionTypeId
        ? connectionTypes.find(t => t.id === edge.connectionTypeId)?.color ?? null
        : null;
      descs.push({
        fromKey: edge.fromFactionId,
        toKey:   `doc_${edge.documentUuid}`,
        style:   edge.direction === "two-way" ? "two-way" : "one-way",
        color:   edge.color ?? typeColor ?? null
      });
    }

    return descs;
  }

  #renderGlobalEdge(fromNode, toNode, desc) {
    const { x1, y1, x2, y2 } = this.#edgeEndpoints(fromNode, toNode);
    const line = this.#el("line", {
      x1, y1, x2, y2,
      class: `mm-edge${desc.style === "dashed" ? " mm-dashed" : ""}`
    });
    // Use inline style so it wins over the CSS class stroke rule
    if (desc.color) line.style.stroke = desc.color;
    if (desc.style === "one-way")  line.setAttribute("marker-end", "url(#arrow-end)");
    if (desc.style === "two-way") {
      line.setAttribute("marker-end",   "url(#arrow-end)");
      line.setAttribute("marker-start", "url(#arrow-start)");
    }
    return line;
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
      shape = this.#el("circle", { r: node.radius ?? R.pov, class: "mm-shape mm-pov" });
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
    } else {
      shape = this.#el("ellipse", { rx: R.simple.rx, ry: R.simple.ry, class: "mm-shape mm-simple" });
    }

    if (color) {
      // Use inline style so it wins over CSS class fill/stroke rules
      shape.style.stroke = color;
      // For global connected nodes, also tint the fill
      if (node.type === "faction-global") {
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

    // Label — member nodes use tight wrap so text fits inside the diamond
    const wrapAt     = node.isMember ? 7 : 12;
    const lines      = this.#wrapText(node.label, wrapAt);
    const lineHeight = node.isMember ? 11 : 13;
    const totalH     = lines.length * lineHeight;
    const startY     = (node.type === "document" ? 6 : 0) + (-totalH / 2 + lineHeight / 2);

    lines.forEach((line, i) => {
      const t = this.#el("text", {
        class:               "mm-node-label",
        x: 0, y:            startY + i * lineHeight,
        "text-anchor":      "middle",
        "dominant-baseline": "middle",
        "pointer-events":   "none"
      });
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
    // Handle background pan
    if (this.#pan) {
      this.#transform.x = this.#pan.startPanX + (e.clientX - this.#pan.startClientX);
      this.#transform.y = this.#pan.startPanY + (e.clientY - this.#pan.startClientY);
      this.#applyTransform();
      return;
    }

    // Handle node drag
    if (!this.#drag) return;
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
  }

  #onMouseUp(_e) {
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

    if (isGlobal && !moved && this.#config.onSetPOV && !node.isMember && !node.isDocument) {
      this.#config.onSetPOV(nodeKey);
    } else if (isGlobal && node.isSubFaction && moved) {
      // Sub-faction dragged: normalize all siblings to same orbit radius
      this.#normalizeOrbitAfterSubFactionDrag(node);
    } else if (isGlobal && node.isMember && moved) {
      // Member dragged: normalize all sibling members to same orbit radius
      this.#normalizeOrbitAfterMemberDrag(node);
    } else {
      this.#config.onPositionSave(nodeKey, node.x, node.y);
      // Save all descendants (any depth) that moved with the dragged node
      if (isGlobal) this.#saveDescendantPositions(nodeKey);
    }

    this.#drag = null;
  }

  /**
   * After a sub-faction is dragged to a new position, compute the new orbit
   * radius from its distance to the parent and rearrange all siblings to that
   * same radius (preserving each sibling's angle). Updates the orbit ring too.
   */
  #normalizeOrbitAfterSubFactionDrag(draggedSub) {
    const parentNode = this._globalNodeMap?.[draggedSub.parentId];
    if (!parentNode) {
      this.#config.onPositionSave(draggedSub.key, draggedSub.x, draggedSub.y);
      return;
    }

    const newRadius = Math.sqrt(
      (draggedSub.x - parentNode.x) ** 2 +
      (draggedSub.y - parentNode.y) ** 2
    );

    // Rearrange every sibling (including the dragged one) to the new radius
    const siblings = Object.values(this._globalNodeEls ?? {})
      .map(({ node: n }) => n)
      .filter(n => n.parentId === draggedSub.parentId && n.isSubFaction);

    for (const sib of siblings) {
      const oldX  = sib.x;
      const oldY  = sib.y;
      const angle = Math.atan2(sib.y - parentNode.y, sib.x - parentNode.x);
      sib.x = parentNode.x + newRadius * Math.cos(angle);
      sib.y = parentNode.y + newRadius * Math.sin(angle);
      const sibEl = this._globalNodeEls?.[sib.key]?.el;
      if (sibEl) sibEl.setAttribute("transform", `translate(${sib.x},${sib.y})`);
      this.#config.onPositionSave(sib.key, sib.x, sib.y);
      this.#redrawGlobalEdgesForNode(sib.key);

      // Move and save any children of this sibling by the same delta
      const sdx = sib.x - oldX, sdy = sib.y - oldY;
      if (sdx || sdy) {
        this.#moveDescendantsLive(sib.key, sdx, sdy);
        this.#saveDescendantPositions(sib.key);
      }
    }

    // Update orbit ring radius
    if (this._orbitRadii) this._orbitRadii[draggedSub.parentId] = newRadius;
    const ring = this._orbitRingEls?.[draggedSub.parentId];
    if (ring) ring.setAttribute("r", newRadius);
  }

  /**
   * After a member node is dragged, compute the new orbit radius from its distance
   * to the parent faction and rearrange all sibling members to that same radius
   * (preserving each sibling's angle). Updates the member orbit ring too.
   */
  #normalizeOrbitAfterMemberDrag(draggedMember) {
    const parentNode = this._globalNodeMap?.[draggedMember.parentId];
    if (!parentNode) {
      this.#config.onPositionSave(draggedMember.key, draggedMember.x, draggedMember.y);
      return;
    }

    const newRadius = Math.sqrt(
      (draggedMember.x - parentNode.x) ** 2 +
      (draggedMember.y - parentNode.y) ** 2
    );

    // Rearrange every sibling member to the new radius
    const siblings = Object.values(this._globalNodeEls ?? {})
      .map(({ node: n }) => n)
      .filter(n => n.isMember && n.parentId === draggedMember.parentId);

    for (const sib of siblings) {
      const angle = Math.atan2(sib.y - parentNode.y, sib.x - parentNode.x);
      sib.x = parentNode.x + newRadius * Math.cos(angle);
      sib.y = parentNode.y + newRadius * Math.sin(angle);
      const sibEl = this._globalNodeEls?.[sib.key]?.el;
      if (sibEl) sibEl.setAttribute("transform", `translate(${sib.x},${sib.y})`);
      this.#config.onPositionSave(sib.key, sib.x, sib.y);
      this.#redrawGlobalEdgesForNode(sib.key);
    }

    // Update member orbit ring radius
    if (this._memberOrbitRingEls) this._memberOrbitRingEls[draggedMember.parentId]?.setAttribute("r", newRadius);
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
   * Recursively save positions of all descendants of nodeKey.
   * Called on mouseup so persisted data matches the moved DOM positions.
   */
  #saveDescendantPositions(nodeKey) {
    if (!this._globalNodeEls) return;
    for (const { node: child } of Object.values(this._globalNodeEls)) {
      if (child.parentId !== nodeKey) continue;
      this.#config.onPositionSave(child.key, child.x, child.y);
      this.#saveDescendantPositions(child.key);
    }
  }

  /** Redraw all global edges, spoke lines, and orbit rings touching the given node. */
  #redrawGlobalEdgesForNode(factionKey) {
    const nodeMap = this._globalNodeMap;
    if (!nodeMap) return;

    // Stored relationship edges
    if (this._globalEdgeEls) {
      for (const { line, fromKey, toKey } of Object.values(this._globalEdgeEls)) {
        if (fromKey !== factionKey && toKey !== factionKey) continue;
        const fn = nodeMap[fromKey]; const tn = nodeMap[toKey];
        if (!fn || !tn) continue;
        const { x1, y1, x2, y2 } = this.#edgeEndpoints(fn, tn);
        line.setAttribute("x1", x1); line.setAttribute("y1", y1);
        line.setAttribute("x2", x2); line.setAttribute("y2", y2);
      }
    }

    // Spoke lines (parent ↔ sub-faction)
    if (this._spokeLinkEls) {
      for (const { line, parentKey, subKey } of Object.values(this._spokeLinkEls)) {
        if (parentKey !== factionKey && subKey !== factionKey) continue;
        const pn = nodeMap[parentKey]; const sn = nodeMap[subKey];
        if (!pn || !sn) continue;
        const { x1, y1, x2, y2 } = this.#edgeEndpoints(pn, sn);
        line.setAttribute("x1", x1); line.setAttribute("y1", y1);
        line.setAttribute("x2", x2); line.setAttribute("y2", y2);
      }
    }

    // Sub-faction orbit ring — moves when its parent faction moves
    const ring = this._orbitRingEls?.[factionKey];
    if (ring) {
      const pn = nodeMap[factionKey];
      if (pn) { ring.setAttribute("cx", pn.x); ring.setAttribute("cy", pn.y); }
    }

    // Member orbit ring — moves when its parent faction moves
    const memberRing = this._memberOrbitRingEls?.[factionKey];
    if (memberRing) {
      const pn = nodeMap[factionKey];
      if (pn) { memberRing.setAttribute("cx", pn.x); memberRing.setAttribute("cy", pn.y); }
    }

    // Member spoke lines
    if (this._memberSpokeEls) {
      for (const { line, parentKey, memberKey } of Object.values(this._memberSpokeEls)) {
        if (parentKey !== factionKey && memberKey !== factionKey) continue;
        const pn = nodeMap[parentKey]; const mn = nodeMap[memberKey];
        if (!pn || !mn) continue;
        const { x1, y1, x2, y2 } = this.#edgeEndpoints(pn, mn);
        line.setAttribute("x1", x1); line.setAttribute("y1", y1);
        line.setAttribute("x2", x2); line.setAttribute("y2", y2);
      }
    }
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
    if (node.radius != null)            return node.radius;
    if (node.type === "central")        return R.central;
    if (node.type === "subfaction")     return R.subfaction;
    if (node.type === "faction")        return R.faction;
    if (node.type === "pov")            return R.pov;
    if (node.type === "faction-global") return R.factionGlobal;
    if (node.type === "document")       return Math.max(R.document.rx, R.document.ry);
    if (node.type === "doc-actor"   || node.type === "doc-other")    return R.docGlobal;
    if (node.type === "member-actor"|| node.type === "member-other") return MEMBER_NODE_R;
    return Math.max(R.simple.rx, R.simple.ry);
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
