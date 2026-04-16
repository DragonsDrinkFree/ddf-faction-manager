/**
 * Soft integration with the Sandbox Campaign Manager module.
 * All calls are no-ops when the module is absent or has no active session.
 * Never throws.
 */

/**
 * Attempt to add a note to the current Sandbox Campaign Manager session.
 * Tags the note with "Faction" and the faction's display name.
 *
 * @param {string} text        - Note body
 * @param {string} factionName - Used as a tag alongside "Faction"
 */
export async function tryAddSessionNote(text, factionName, settingKey = null) {
  try {
    if (settingKey) {
      const enabled = game.settings.get("ddf-faction-manager", settingKey) ?? true;
      if (!enabled) return;
    }
    const scm = game.modules.get("sandbox-campaign-manager")?.api;
    if (!scm) return;
    await scm.addSessionNote({ text, tags: ["Faction", factionName] });
  } catch { /* no active session, or module unavailable */ }
}
