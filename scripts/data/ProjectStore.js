const MODULE_ID = "ddf-faction-manager";
const SETTING_KEY = "projects";

/**
 * Manages project data stored in a world-level game setting.
 *
 * Data shape:
 * {
 *   [id: string]: {
 *     id: string,
 *     factionId: string,
 *     name: string,
 *     description: string,
 *     progress: number,       // 0–100, clamped
 *     status: "active" | "finished",
 *     notes: Array<{
 *       id: string,
 *       text: string,
 *       progressDelta: number,
 *       timestamp: number
 *     }>
 *   }
 * }
 */
export class ProjectStore {
  static register() {
    game.settings.register(MODULE_ID, SETTING_KEY, {
      name: "Project Data",
      scope: "world",
      config: false,
      type: Object,
      default: {}
    });
  }

  static getAll() {
    return game.settings.get(MODULE_ID, SETTING_KEY) ?? {};
  }

  static async _save(data) {
    await game.settings.set(MODULE_ID, SETTING_KEY, data);
  }

  static getForFaction(factionId) {
    const all = this.getAll();
    return Object.values(all).filter(p => p.factionId === factionId);
  }

  static async create(factionId, name) {
    const id = foundry.utils.randomID();
    const project = { id, factionId, name, description: "", progress: 0, status: "active", notes: [] };
    const all = this.getAll();
    all[id] = project;
    await this._save(all);
    return project;
  }

  static async update(id, updates) {
    const all = this.getAll();
    if (!all[id]) throw new Error(`Project ${id} not found`);
    all[id] = { ...all[id], ...updates, id };
    await this._save(all);
    return all[id];
  }

  static async delete(id) {
    const all = this.getAll();
    delete all[id];
    await this._save(all);
  }

  /** Delete all projects belonging to a faction (called on faction delete). */
  static async deleteForFaction(factionId) {
    const all = this.getAll();
    for (const id in all) {
      if (all[id].factionId === factionId) delete all[id];
    }
    await this._save(all);
  }

  /**
   * Append a note and apply its progress delta.
   * Progress is clamped to 0–100.
   */
  static async addNote(projectId, text, progressDelta) {
    const all = this.getAll();
    const project = all[projectId];
    if (!project) throw new Error(`Project ${projectId} not found`);

    const note = { id: foundry.utils.randomID(), text, progressDelta, timestamp: Date.now() };
    const notes = [...project.notes, note];
    all[projectId] = { ...project, notes, progress: this._calcProgress(notes) };

    await this._save(all);
    return all[projectId];
  }

  /** Edit an existing note's text and/or delta; recalculates total progress. */
  static async editNote(projectId, noteId, text, progressDelta) {
    const all = this.getAll();
    const project = all[projectId];
    if (!project) throw new Error(`Project ${projectId} not found`);

    const notes = project.notes.map(n =>
      n.id === noteId ? { ...n, text, progressDelta } : n
    );
    all[projectId] = { ...project, notes, progress: this._calcProgress(notes) };

    await this._save(all);
    return all[projectId];
  }

  /** Delete a note by id; recalculates total progress. */
  static async deleteNote(projectId, noteId) {
    const all = this.getAll();
    const project = all[projectId];
    if (!project) throw new Error(`Project ${projectId} not found`);

    const notes = project.notes.filter(n => n.id !== noteId);
    all[projectId] = { ...project, notes, progress: this._calcProgress(notes) };

    await this._save(all);
    return all[projectId];
  }

  /** Sum all note deltas, clamped to 0–100. */
  static _calcProgress(notes) {
    const total = notes.reduce((sum, n) => sum + (n.progressDelta ?? 0), 0);
    return Math.min(100, Math.max(0, total));
  }
}
