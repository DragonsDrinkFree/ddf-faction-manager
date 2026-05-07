/**
 * Pure data and helpers for MindMapRenderer.
 *
 * Everything here is stateless: tunable constants, the canonical NODE_TYPE /
 * NODE_KEY enums, and the small helpers that translate between key prefixes
 * and {kind, id} structures. The renderer imports from this file; consumers
 * (e.g. GlobalRelationshipsApp) get the public-surface re-exports through
 * MindMapRenderer.js.
 */

export const SVG_NS = "http://www.w3.org/2000/svg";

/** Radii and geometry constants */
export const R = {
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

export const INNER_RING            = 145;
export const OUTER_RING            = 280;
export const ORBIT_GAP             = 20;  // minimum gap between parent edge and sub-faction edge
export const MEMBER_NODE_R         = 26;  // radius of faction-member orbit nodes
export const MEMBER_ORBIT_GAP      = 15;  // gap between faction node edge and member ring
export const PARTY_MEMBER_NODE_R   = 24;  // radius of party-member/retainer orbit nodes
export const PARTY_MEMBER_GAP      = 15;  // gap between party node edge and member ring
export const PARTY_RETAINER_GAP    = 18;  // gap between member ring outer edge and retainer ring

/**
 * Preset radii (px) for the Small / Medium / Large size buttons.
 * Scene documents use larger defaults to fill their hexagon visually.
 * All other document types use smaller defaults.
 * Exported so the context-menu builder can highlight the active preset.
 */
export const DOC_SIZE_PRESETS = {
  scene: { small: 90, medium: 180, large: 360 },
  other: { small: 15, medium: 30,  large: 90  }
};

/**
 * Canonical set of node.type string values used across the renderer.
 * Also drives the CSS class name `mm-node-type-${node.type}` in styles.css —
 * DO NOT rename a value without updating the matching selector.
 */
export const NODE_TYPE = {
  // Local-map node kinds
  CENTRAL:        "central",        // center of the local map (POV faction)
  SUBFACTION:     "subfaction",     // dashed-link sub-faction on local map
  FACTION:        "faction",        // related faction on local map
  DOCUMENT:       "document",       // generic document hexagon on local map
  SIMPLE:         "simple",         // misc endpoint (not a known type)

  // Global-map node kinds
  POV:                   "pov",                   // currently-selected faction (global)
  FACTION_GLOBAL:        "faction-global",         // non-POV faction on the global map
  PARTY_GLOBAL:          "party-global",           // adventuring party hexagon (global)
  DOC_ACTOR:             "doc-actor",              // actor document on the global map
  DOC_SCENE:             "doc-scene",              // scene document on the global map
  DOC_JOURNAL:           "doc-journal",            // journal document on the global map
  DOC_OTHER:             "doc-other",              // any other document kind
  MEMBER_ACTOR:          "member-actor",           // member diamond with actor reference
  MEMBER_OTHER:          "member-other",           // member diamond without actor reference
  PARTY_MEMBER_ACTOR:    "party-member-actor",     // party-member diamond with actor reference
  PARTY_MEMBER_OTHER:    "party-member-other",     // party-member diamond without actor reference
  PARTY_RETAINER_ACTOR:  "party-retainer-actor",   // party-retainer diamond with actor reference
  PARTY_RETAINER_OTHER:  "party-retainer-other",   // party-retainer diamond without actor reference
};

/**
 * Node-key prefix conventions used by the global map.
 * - `doc_<uuid>`     → free-floating document node
 * - `member_<id>`    → faction member diamond
 * - otherwise        → plain faction id (top-level or sub-faction)
 *
 * Exported helpers keep this convention in one place so callers don't hand-slice.
 */
export const NODE_KEY = {
  DOC_PREFIX:             "doc_",
  MEMBER_PREFIX:          "member_",
  PARTY_MEMBER_PREFIX:    "pmember_",
  PARTY_RETAINER_PREFIX:  "pretainer_",
  forDocument(uuid)        { return `${NODE_KEY.DOC_PREFIX}${uuid}`; },
  forMember(memberId)      { return `${NODE_KEY.MEMBER_PREFIX}${memberId}`; },
  forPartyMember(id)       { return `${NODE_KEY.PARTY_MEMBER_PREFIX}${id}`; },
  forPartyRetainer(id)     { return `${NODE_KEY.PARTY_RETAINER_PREFIX}${id}`; },
};

/**
 * Parses a node-key into its logical kind and the embedded identifier.
 * Returns `{ kind: "document", uuid }`, `{ kind: "member", memberId }`,
 * or `{ kind: "faction", factionId }`. Safe on null/undefined input.
 */
export function parseNodeKey(nodeKey) {
  if (!nodeKey) return { kind: "none" };
  if (nodeKey.startsWith(NODE_KEY.DOC_PREFIX)) {
    return { kind: "document", uuid: nodeKey.slice(NODE_KEY.DOC_PREFIX.length) };
  }
  if (nodeKey.startsWith(NODE_KEY.PARTY_RETAINER_PREFIX)) {
    return { kind: "party-retainer", id: nodeKey.slice(NODE_KEY.PARTY_RETAINER_PREFIX.length) };
  }
  if (nodeKey.startsWith(NODE_KEY.PARTY_MEMBER_PREFIX)) {
    return { kind: "party-member", id: nodeKey.slice(NODE_KEY.PARTY_MEMBER_PREFIX.length) };
  }
  if (nodeKey.startsWith(NODE_KEY.MEMBER_PREFIX)) {
    return { kind: "member", memberId: nodeKey.slice(NODE_KEY.MEMBER_PREFIX.length) };
  }
  return { kind: "faction", factionId: nodeKey };
}

/** Default display radius by node.type. Used when node.radius is not set. */
export const NODE_TYPE_RADIUS = {
  [NODE_TYPE.CENTRAL]:               R.central,
  [NODE_TYPE.SUBFACTION]:            R.subfaction,
  [NODE_TYPE.FACTION]:               R.faction,
  [NODE_TYPE.POV]:                   R.pov,
  [NODE_TYPE.FACTION_GLOBAL]:        R.factionGlobal,
  [NODE_TYPE.PARTY_GLOBAL]:          R.factionGlobal,
  [NODE_TYPE.DOCUMENT]:              Math.max(R.document.rx, R.document.ry),
  [NODE_TYPE.DOC_ACTOR]:             R.docGlobal,
  [NODE_TYPE.DOC_SCENE]:             R.docGlobal,
  [NODE_TYPE.DOC_JOURNAL]:           R.docGlobal,
  [NODE_TYPE.DOC_OTHER]:             R.docGlobal,
  [NODE_TYPE.MEMBER_ACTOR]:          MEMBER_NODE_R,
  [NODE_TYPE.MEMBER_OTHER]:          MEMBER_NODE_R,
  [NODE_TYPE.PARTY_MEMBER_ACTOR]:    PARTY_MEMBER_NODE_R,
  [NODE_TYPE.PARTY_MEMBER_OTHER]:    PARTY_MEMBER_NODE_R,
  [NODE_TYPE.PARTY_RETAINER_ACTOR]:  PARTY_MEMBER_NODE_R,
  [NODE_TYPE.PARTY_RETAINER_OTHER]:  PARTY_MEMBER_NODE_R,
  [NODE_TYPE.SIMPLE]:                Math.max(R.simple.rx, R.simple.ry),
};

/**
 * Force-directed layout constants.
 * Tuned for a map of ~5–30 nodes; adjust repulsion/springRest for denser graphs.
 */
export const FORCE = {
  // ── Base strengths (level 3 = default; all scale with forceLevel) ─────────
  repulsion:         12000, // cluster-vs-cluster base repulsion
  springK:           0.04,  // rubber-band spring constant for edges
  springRest:        180,   // edge rest length in px

  // ── Orbit constraints ──────────────────────────────────────────────────────
  orbitSpringK:         0.35,  // radial spring for sub-faction orbits (stiff — keep tight)
  memberOrbitK:         0.25,  // radial spring for faction-member orbits
  partyMemberOrbitK:    0.25,  // radial spring for party-member inner ring
  partyRetainerOrbitK:  0.22,  // radial spring for party-retainer outer ring

  // ── Sibling repulsion fractions of base repulsion ─────────────────────────
  siblingSubFacMult:    0.35,  // sub-faction siblings repel each other (mid-strength)
  siblingMemberMult:    0.12,  // member/party-member siblings repel each other (gentle)

  // ── Document node fraction ─────────────────────────────────────────────────
  docRepulsionMult:  0.30,  // docs repel other nodes at this fraction

  // ── Simulation meta ────────────────────────────────────────────────────────
  centerK:           0.0002, // gentle pull toward world origin (keep nodes visible)
  alphaDecay:        0.0228,
  alphaMin:          0.001,
  velocityDecay:     0.4,
  maxVelocity:       12,
  maxDist:           1400,
  nodePadding:       22,    // guaranteed gap beyond summed node radii
  collisionSpring:   3.0,   // hard-push when nodes overlap
};

/** Zoom limits */
export const MIN_SCALE = 0.15;
export const MAX_SCALE = 5;
