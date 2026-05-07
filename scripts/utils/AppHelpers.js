import { FactionStore } from "../data/FactionStore.js";
import { EventLogStore } from "../data/EventLogStore.js";
import { tryAddSessionNote } from "./SandboxIntegration.js";

/**
 * Helpers shared between FactionDetailApp and PartyDetailApp.
 * These were previously duplicated as private static methods on each class.
 */

/**
 * Convert filled/sections into 4 quarter-bar descriptors for compact list display.
 * Used by project list rows on overview/objectives tabs.
 */
export function quarterBars(filled, sections) {
  const pct = sections > 0 ? (filled / sections) * 100 : 0;
  return [0, 1, 2, 3].map(i => {
    const low  = i * 25;
    const high = low + 25;
    if (pct >= high) return { filled: true,  partial: 100 };
    if (pct <= low)  return { filled: false, partial: 0 };
    return { filled: false, partial: Math.round((pct - low) / 25 * 100) };
  });
}

/**
 * Prompt for a single text value via DialogV2. Resolves to the trimmed value
 * or null if cancelled / blank.
 */
export function promptName(title, label) {
  return new Promise(resolve => {
    foundry.applications.api.DialogV2.prompt({
      window: { title },
      content: `<div class="standard-form"><div class="form-group"><label>${label}</label><div class="form-fields"><input type="text" name="name" autofocus placeholder="${label}…" /></div></div></div>`,
      ok: {
        label: "Create",
        callback: (_event, button) => {
          const value = button.form.elements.name.value.trim();
          resolve(value || null);
        }
      },
      rejectClose: false
    }).catch(() => resolve(null));
  });
}

/**
 * Prompt for objective name + required-progress sections. Resolves to
 * { name, sections } or null if cancelled / blank name.
 */
export function promptObjective(title, existing = null) {
  return new Promise(resolve => {
    const defaultSections = existing?.sections ?? 8;
    foundry.applications.api.DialogV2.prompt({
      window: { title },
      content: `
        <div class="standard-form">
          <div class="form-group">
            <label>Name</label>
            <div class="form-fields">
              <input type="text" name="obj_name" autofocus
                     value="${foundry.utils.escapeHTML(existing?.name ?? "")}"
                     placeholder="Objective name…" />
            </div>
          </div>
          <div class="form-group">
            <label>Required Progress</label>
            <div class="form-fields">
              <input type="number" name="obj_sections"
                     value="${defaultSections}" min="1" max="99" style="width:80px;" />
            </div>
          </div>
        </div>`,
      ok: {
        label: existing ? "Save" : "Create",
        callback: (_event, button) => {
          const name     = button.form.elements.obj_name.value.trim();
          const sections = parseInt(button.form.elements.obj_sections.value) || 8;
          resolve(name ? { name, sections } : null);
        }
      },
      rejectClose: false
    }).catch(() => resolve(null));
  });
}

/**
 * Append an entry to the faction event log and (when SCM is present and the
 * matching toggle is enabled) post a session note. No-op without a faction id.
 */
export async function logEvent(factionId, category, text, settingKey = null) {
  if (!factionId) return;
  const factionName = FactionStore.getAll()[factionId]?.name ?? "Faction";
  await EventLogStore.addEntry(factionId, category, text);
  await tryAddSessionNote(text, factionName, settingKey);
}
