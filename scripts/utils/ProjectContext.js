import { ProjectStore } from "../data/ProjectStore.js";
import { quarterBars } from "./AppHelpers.js";

/**
 * Project context builders shared between FactionDetailApp and PartyDetailApp.
 * Both apps render the same Objectives tab UI from the same data shape.
 */

/** Decorate a project with `sections`/`filled` legacy fallbacks plus quarter-bar list display. */
function decorateProject(p) {
  const sections = p.sections ?? 4;
  const filled   = p.filled   ?? Math.round((p.progress ?? 0) / 25);
  return { ...p, sections, filled, quarterBars: quarterBars(filled, sections) };
}

/**
 * Returns { active: [...], finished: [...] } for a faction's project list,
 * each project decorated with `quarterBars`. Sorted alphabetically.
 */
export function buildProjectContext(factionId) {
  if (!factionId) return { active: [], finished: [] };
  const all = ProjectStore.getForFaction(factionId);
  const sort = arr => arr.sort((a, b) => a.name.localeCompare(b.name)).map(decorateProject);
  return {
    active:   sort(all.filter(p => p.status === "active")),
    finished: sort(all.filter(p => p.status === "finished"))
  };
}

/**
 * Returns the selected project decorated with derived display fields, or null
 * if no project is selected or it no longer exists.
 */
export function buildSelectedProjectContext(projectId) {
  if (!projectId) return null;
  const project = ProjectStore.getAll()[projectId];
  if (!project) return null;

  const sections = project.sections ?? 4;
  const filled   = project.filled   ?? Math.round((project.progress ?? 0) / 25);

  const notes = [...project.notes].reverse().map(n => ({
    ...n,
    formattedDate:  new Date(n.timestamp).toLocaleString(),
    formattedDelta: n.progressDelta !== 0
      ? `${n.progressDelta > 0 ? "+" : ""}${n.progressDelta}`
      : "—",
    deltaClass: n.progressDelta > 0 ? "positive" : n.progressDelta < 0 ? "negative" : "neutral"
  }));

  return { ...project, sections, filled, notes };
}
