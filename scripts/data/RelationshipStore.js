const MODULE_ID = "ddf-faction-manager";
const SETTING_KEY = "relationships";

/**
 * Manages relationship edge data stored in a world-level game setting.
 *
 * Data shape:
 * {
 *   edges: {
 *     [id]: {
 *       id: string,
 *       fromFactionId: string,
 *       direction: "one-way" | "two-way",
 *       type: "faction" | "document",
 *       toFactionId?: string,
 *       documentUuid?: string,
 *       documentType?: string,
 *       documentName?: string,
 *       label?: string,
 *       relationLabel?: string
 *     }
 *   },
 *   positions: {
 *     [factionId]: {
 *       [nodeKey]: { x: number, y: number }
 *     }
 *   }
 * }
 */
export class RelationshipStore {
  static register() {
    game.settings.register(MODULE_ID, SETTING_KEY, {
      name: "Relationship Data",
      scope: "world",
      config: false,
      type: Object,
      default: { edges: {}, positions: {} }
    });
  }

  static getAll() {
    const data = game.settings.get(MODULE_ID, SETTING_KEY) ?? {};
    if (!data.edges) data.edges = {};
    if (!data.positions) data.positions = {};
    return data;
  }

  static async _save(data, { silent = false } = {}) {
    await game.settings.set(MODULE_ID, SETTING_KEY, data);
    if (!silent) Hooks.callAll("ddf-relationships-changed");
  }

  /**
   * Returns all edges relevant to the given faction:
   * - edges where fromFactionId === factionId
   * - two-way edges where toFactionId === factionId (reverse view)
   * For reverse two-way edges, a `_reversed: true` flag is added so the
   * renderer can flip the arrow direction.
   */
  static getEdgesForFaction(factionId) {
    const { edges } = this.getAll();
    const result = [];
    for (const edge of Object.values(edges)) {
      if (edge.fromFactionId === factionId) {
        result.push({ ...edge });
      } else if (edge.type === "faction" && edge.toFactionId === factionId) {
        // Show all faction edges targeting this faction (one-way AND two-way)
        // so incoming connections are always visible to the target.
        result.push({ ...edge, _reversed: true });
      }
    }
    return result;
  }

  /**
   * Creates a new relationship edge.
   * @param {string} fromFactionId
   * @param {"faction"|"document"} type
   * @param {"one-way"|"two-way"} direction
   * @param {object} opts
   * @param {string} [opts.toFactionId]
   * @param {string} [opts.documentUuid]
   * @param {string} [opts.documentType]
   * @param {string} [opts.documentName]
   * @param {string} [opts.label]
   * @returns {Promise<object>} the new edge
   */
  static async createEdge(fromFactionId, type, direction, opts = {}) {
    const id = foundry.utils.randomID();
    const edge = {
      id,
      fromFactionId,
      type,
      direction,
      ...opts
    };
    const data = this.getAll();
    data.edges[id] = edge;
    await this._save(data);
    return edge;
  }

  /**
   * Deletes a relationship edge by id.
   * @param {string} id
   */
  static async deleteEdge(id) {
    const data = this.getAll();
    delete data.edges[id];
    await this._save(data);
  }

  /**
   * Updates the relation label on an edge.
   * @param {string} id
   * @param {string} relationLabel
   */
  static async updateEdgeLabel(id, relationLabel) {
    const data = this.getAll();
    if (!data.edges[id]) return;
    data.edges[id].relationLabel = relationLabel;
    await this._save(data);
  }

  /**
   * Updates the display color on an edge (hex string, e.g. "#ff6600").
   * Pass null or "" to clear the color back to theme default.
   * @param {string} id
   * @param {string|null} color
   */
  static async updateEdgeColor(id, color) {
    const data = this.getAll();
    if (!data.edges[id]) return;
    data.edges[id].color = color || null;
    await this._save(data);
  }

  /**
   * Updates the connection type on an edge.
   * @param {string} id
   * @param {string|null} connectionTypeId
   */
  static async updateEdgeConnectionType(id, connectionTypeId) {
    const data = this.getAll();
    if (!data.edges[id]) return;
    data.edges[id].connectionTypeId = connectionTypeId || null;
    await this._save(data);
  }

  /**
   * Updates the direction on an edge.
   * When swapParties is true the fromFactionId/toFactionId are also swapped,
   * used when a reversed edge is made one-way so direction points toward the
   * faction that performed the action rather than away from it.
   * @param {string} id
   * @param {"one-way"|"two-way"} direction
   * @param {{ swapParties?: boolean }} [opts]
   */
  static async updateEdgeDirection(id, direction, { swapParties = false } = {}) {
    const data = this.getAll();
    if (!data.edges[id]) return;
    data.edges[id].direction = direction;
    if (swapParties) {
      const { fromFactionId, toFactionId } = data.edges[id];
      data.edges[id].fromFactionId = toFactionId;
      data.edges[id].toFactionId   = fromFactionId;
    }
    await this._save(data);
  }

  /**
   * Saves a node position within a faction's relationship view.
   * @param {string} factionId
   * @param {string} nodeKey
   * @param {number} x
   * @param {number} y
   */
  static async savePosition(factionId, nodeKey, x, y) {
    const data = this.getAll();
    if (!data.positions[factionId]) data.positions[factionId] = {};
    data.positions[factionId][nodeKey] = { x, y };
    await this._save(data, { silent: true });
  }

  /**
   * Returns the saved position map for a faction view.
   * @param {string} factionId
   * @returns {{ [nodeKey]: { x: number, y: number } }}
   */
  static getPositions(factionId) {
    return this.getAll().positions[factionId] ?? {};
  }

  /**
   * Removes all edges and positions involving a deleted faction.
   * Called by FactionStore.delete() to keep data consistent.
   * @param {string} factionId
   */
  static async cleanupFaction(factionId) {
    const data = this.getAll();
    for (const id of Object.keys(data.edges)) {
      const e = data.edges[id];
      if (e.fromFactionId === factionId || e.toFactionId === factionId) {
        delete data.edges[id];
      }
    }
    delete data.positions[factionId];
    await this._save(data);
  }
}
