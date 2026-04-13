const MODULE_ID = "ddf-faction-manager";
const SETTING_KEY = "memberData";

/**
 * Manages faction member and rank data stored in a world-level game setting.
 *
 * Data shape:
 * {
 *   members: {
 *     [id]: {
 *       id: string,
 *       factionId: string,
 *       name: string,
 *       actorUuid: string | null,
 *       rankId: string | null
 *     }
 *   },
 *   ranks: {
 *     [id]: {
 *       id: string,
 *       factionId: string,
 *       order: number,
 *       name: string,
 *       description: string
 *     }
 *   }
 * }
 */
export class MemberStore {
  static register() {
    game.settings.register(MODULE_ID, SETTING_KEY, {
      name: "Member Data",
      scope: "world",
      config: false,
      type: Object,
      default: { members: {}, ranks: {} }
    });
  }

  static getAll() {
    const data = game.settings.get(MODULE_ID, SETTING_KEY) ?? {};
    if (!data.members) data.members = {};
    if (!data.ranks)   data.ranks   = {};
    return data;
  }

  static async _save(data) {
    await game.settings.set(MODULE_ID, SETTING_KEY, data);
  }

  /** Returns all members for a faction, sorted by name. */
  static getMembersForFaction(factionId) {
    const { members } = this.getAll();
    return Object.values(members)
      .filter(m => m.factionId === factionId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Returns all ranks for a faction, sorted by order then name. */
  static getRanksForFaction(factionId) {
    const { ranks } = this.getAll();
    return Object.values(ranks)
      .filter(r => r.factionId === factionId)
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  }

  /** Returns the highest current rank order for a faction (0 if none). */
  static getMaxOrder(factionId) {
    const ranks = this.getRanksForFaction(factionId);
    return ranks.reduce((max, r) => Math.max(max, r.order), 0);
  }

  static async createMember(factionId, { name = "New Member", actorUuid = null, rankId = null } = {}) {
    const id   = foundry.utils.randomID();
    const data = this.getAll();
    data.members[id] = { id, factionId, name, actorUuid, rankId };
    await this._save(data);
    return data.members[id];
  }

  static async updateMember(memberId, updates) {
    const data = this.getAll();
    if (!data.members[memberId]) return null;
    Object.assign(data.members[memberId], updates);
    await this._save(data);
    return data.members[memberId];
  }

  static async deleteMember(memberId) {
    const data = this.getAll();
    delete data.members[memberId];
    await this._save(data);
  }

  /**
   * Creates a new rank. Existing ranks at the same order position or higher
   * are bumped up by 1 to keep ordering clean.
   */
  static async createRank(factionId, { order, name = "New Rank", description = "" } = {}) {
    const id   = foundry.utils.randomID();
    const data = this.getAll();
    for (const rank of Object.values(data.ranks)) {
      if (rank.factionId === factionId && rank.order >= order) rank.order++;
    }
    data.ranks[id] = { id, factionId, order, name, description };
    await this._save(data);
    return data.ranks[id];
  }

  static async updateRank(rankId, updates) {
    const data = this.getAll();
    if (!data.ranks[rankId]) return null;
    Object.assign(data.ranks[rankId], updates);
    await this._save(data);
    return data.ranks[rankId];
  }

  /**
   * Deletes a rank. Members that held this rank become unranked.
   */
  static async deleteRank(rankId) {
    const data = this.getAll();
    if (!data.ranks[rankId]) return;
    for (const member of Object.values(data.members)) {
      if (member.rankId === rankId) member.rankId = null;
    }
    delete data.ranks[rankId];
    await this._save(data);
  }

  /**
   * Removes all members and ranks belonging to a deleted faction.
   */
  static async cleanupFaction(factionId) {
    const data = this.getAll();
    for (const id of Object.keys(data.members)) {
      if (data.members[id].factionId === factionId) delete data.members[id];
    }
    for (const id of Object.keys(data.ranks)) {
      if (data.ranks[id].factionId === factionId) delete data.ranks[id];
    }
    await this._save(data);
  }
}
