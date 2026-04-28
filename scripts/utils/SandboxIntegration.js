import { FactionStore } from "../data/FactionStore.js";

/**
 * Soft integration with the Sandbox Campaign Manager module.
 * All calls are no-ops when the module is absent or has no active session.
 * Never throws.
 */

/** Returns the SCM API or null. */
function getScm() {
  try { return game.modules.get("sandbox-campaign-manager")?.api ?? null; }
  catch { return null; }
}

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

/** Returns the active Sandbox party ID, or null if SCM is missing/no active party. */
export function getActiveSandboxPartyId() {
  try {
    return getScm()?.getActivePartyId?.() || null;
  } catch { return null; }
}

/**
 * Read all parties from SCM (or empty object if absent).
 * The shape is `{ [partyId]: { id, name, members, ... } }`.
 */
function getAllSandboxParties() {
  try { return getScm()?.getParties?.() ?? {}; }
  catch { return {}; }
}

/**
 * Pull an actor UUID from a sandbox member entry. SCM's `members` array can
 * be either bare UUID strings or objects (the API reference is light here),
 * so we accept both.
 */
function readMemberActorUuid(m) {
  if (typeof m === "string") return m;
  return m?.actorUuid ?? m?.uuid ?? m?.actor?.uuid ?? null;
}

/**
 * Resolve a UUID-or-id reference to an actor's display name. Tries multiple
 * paths because async fromUuid can fail to resolve world-level actors in some
 * V14 timing windows; the synchronous game.actors.get() lookup is more
 * reliable for plain "Actor.<id>" or bare-id references.
 */
async function resolveActorName(ref) {
  if (!ref) return null;
  // Synchronous lookup for world-level actor references — fastest + most reliable
  const idPart = typeof ref === "string"
    ? (ref.startsWith("Actor.") ? ref.slice("Actor.".length) : ref)
    : null;
  if (idPart) {
    const actor = game.actors?.get?.(idPart);
    if (actor?.name) return actor.name;
  }
  // Fallback: async fromUuid (handles compendium and scene-scoped UUIDs)
  try {
    const doc = await fromUuid(ref);
    if (doc?.name) return doc.name;
  } catch { /* stale or unresolvable */ }
  return null;
}

/**
 * Returns SCM parties that don't yet have a matching record in our FactionStore
 * (matched by `sandboxPartyId`). Empty array if SCM is absent.
 */
export function getMissingSandboxParties() {
  const sandboxParties = getAllSandboxParties();
  if (!Object.keys(sandboxParties).length) return [];
  const ourSandboxIds = new Set(
    Object.values(FactionStore.getAll())
      .filter(f => f.kind === "party" && f.sandboxPartyId)
      .map(f => f.sandboxPartyId)
  );
  return Object.values(sandboxParties).filter(p => p?.id && !ourSandboxIds.has(p.id));
}

/**
 * Reconcile a single party's auto-managed members with its matching SCM party.
 * - Adds new sandbox members not yet present (marked source: "sandbox")
 * - Removes our sandbox-sourced members that are no longer in the SCM list
 * - Manually-added members are untouched
 *
 * No-op if SCM is missing, the faction isn't a sandbox-linked party, or
 * nothing changed (idempotent).
 */
export async function syncSandboxPartyMembers(factionId) {
  const faction = FactionStore.getAll()[factionId];
  if (!faction || faction.kind !== "party" || !faction.sandboxPartyId) return;

  const sandboxParty = getAllSandboxParties()[faction.sandboxPartyId];
  if (!sandboxParty) return;

  const sandboxMembers = Array.isArray(sandboxParty.members) ? sandboxParty.members : [];
  const sandboxUuids   = new Set();
  for (const m of sandboxMembers) {
    const uuid = readMemberActorUuid(m);
    if (uuid) sandboxUuids.add(uuid);
  }

  const current = faction.members ?? [];

  // Drop sandbox-sourced members no longer in the SCM list
  let next = current.filter(m =>
    m.source !== "sandbox" || (m.actorUuid && sandboxUuids.has(m.actorUuid))
  );

  // Add new sandbox members (skip ones we already have by actorUuid, regardless of source)
  const ownedUuids = new Set(next.filter(m => m.actorUuid).map(m => m.actorUuid));
  for (const m of sandboxMembers) {
    const uuid = readMemberActorUuid(m);
    if (!uuid || ownedUuids.has(uuid)) continue;
    // Prefer a name supplied directly on the member object; otherwise resolve
    // the actor — sync world lookup first, async fromUuid as fallback.
    let name = (typeof m === "object" && m?.name) ? m.name : null;
    if (!name) name = await resolveActorName(uuid);
    if (!name) {
      console.warn(`ddf-faction-manager | Could not resolve actor for UUID "${uuid}" — imported as "Unknown"`);
    }
    // Normalise stored UUID to canonical "Actor.<id>" form so unlink/relink works
    const storedUuid = uuid.includes(".") ? uuid : `Actor.${uuid}`;
    next.push({
      id:        foundry.utils.randomID(),
      name:      name || "Unknown",
      actorUuid: storedUuid,
      notes:     [],
      source:    "sandbox"
    });
  }

  // Skip the write if the list is unchanged (avoids spurious re-renders)
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  await FactionStore.update(factionId, { members: next });
}

/** Reconcile every sandbox-linked party in the FactionStore. */
export async function syncAllSandboxPartyMembers() {
  const ids = Object.values(FactionStore.getAll())
    .filter(f => f.kind === "party" && f.sandboxPartyId)
    .map(f => f.id);
  for (const id of ids) await syncSandboxPartyMembers(id);
}

/**
 * Imports a single SCM party into the FactionStore as `kind: "party"` and
 * immediately syncs its members. Returns the new faction record, or null if
 * the input is invalid.
 */
export async function importSandboxParty(sandboxParty) {
  if (!sandboxParty?.id || !sandboxParty?.name) return null;
  const faction = await FactionStore.create(sandboxParty.name, null, {
    kind:           "party",
    sandboxPartyId: sandboxParty.id
  });
  await syncSandboxPartyMembers(faction.id);
  return faction;
}
