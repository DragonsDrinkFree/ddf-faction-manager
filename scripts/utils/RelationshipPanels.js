import { FactionStore } from "../data/FactionStore.js";
import { RelationshipStore } from "../data/RelationshipStore.js";
import {
  getConnectionTypes,
  connectionTypePickerHTML,
  connectionDirectionPickerHTML,
  readSelectedDirection,
  readSelectedType
} from "./ConnectionPanelHelpers.js";
import { logEvent } from "./AppHelpers.js";

/**
 * Connection-picker panels shared between FactionDetailApp and PartyDetailApp.
 *
 * The panel element is constructed and positioned by the caller (so it can
 * choose its own dismiss timing and class names); we just populate the
 * contents and wire the result handler. After a successful pick we call
 * `onComplete()` so the caller can re-render their app.
 */

/** Removes any open connection picker panel from the DOM. */
export function closeConnPanel() {
  document.querySelectorAll(".ddf-conn-panel").forEach(el => el.remove());
}

/**
 * Populate `panel` with a faction-search connection picker.
 * @param {HTMLElement} panel
 * @param {string} fromFactionId
 * @param {() => void} onComplete  Called after a successful create (typically `app.render({ parts: ["content"] })`).
 */
export function showConnFactionSearch(panel, fromFactionId, onComplete) {
  const allFactions  = FactionStore.getAll();
  const liveEdges    = RelationshipStore.getEdgesForFaction(fromFactionId);
  const connectedIds = new Set(
    liveEdges.filter(e => e.type === "faction")
             .map(e => e._reversed ? e.fromFactionId : e.toFactionId)
  );
  connectedIds.add(fromFactionId);
  // Also exclude factions already linked via parent/child hierarchy
  const faction = allFactions[fromFactionId];
  if (faction?.parentId) connectedIds.add(faction.parentId);
  Object.values(allFactions).filter(f => f.parentId === fromFactionId).forEach(f => connectedIds.add(f.id));

  const candidates = Object.values(allFactions).filter(f => !connectedIds.has(f.id));

  panel.innerHTML = `
    <div class="mm-panel-title">Link Faction</div>
    <input type="text" class="mm-search-input" placeholder="Filter factions…" autofocus />
    <div class="mm-search-results ddf-conn-faction-list">
      ${candidates.length
        ? candidates.map(f => `
            <div class="mm-search-result" data-id="${f.id}">
              <i class="fa-solid fa-link ddf-link-icon"></i>
              <span>${foundry.utils.escapeHTML(f.name)}</span>
            </div>`).join("")
        : "<div class='mm-search-empty'>No factions available</div>"
      }
    </div>
    ${connectionTypePickerHTML()}
    ${connectionDirectionPickerHTML()}
    <div class="mm-panel-actions"><button class="mm-btn-cancel">Cancel</button></div>
  `;

  const input   = panel.querySelector(".mm-search-input");
  const results = panel.querySelector(".mm-search-results");

  input.addEventListener("input", () => {
    const q = input.value.toLowerCase();
    results.querySelectorAll(".mm-search-result").forEach(el => {
      el.style.display = el.textContent.toLowerCase().includes(q) ? "" : "none";
    });
  });

  results.addEventListener("click", async (e) => {
    const el = e.target.closest(".mm-search-result");
    if (!el) return;
    const toFactionId      = el.dataset.id;
    const direction        = readSelectedDirection(panel);
    const connectionTypeId = readSelectedType(panel);
    const opts             = { toFactionId };
    if (connectionTypeId) opts.connectionTypeId = connectionTypeId;
    await RelationshipStore.createEdge(fromFactionId, "faction", direction, opts);

    const fromName = FactionStore.getAll()[fromFactionId]?.name ?? "Faction";
    const toName   = FactionStore.getAll()[toFactionId]?.name   ?? "Faction";
    const typeName = connectionTypeId
      ? (getConnectionTypes().find(t => t.id === connectionTypeId)?.name ?? "")
      : "";
    const dirArrow = direction === "two-way" ? "↔" : "→";
    await logEvent(fromFactionId, "connection",
      `Connection established: ${fromName} ${dirArrow} ${toName}${typeName ? ` (${typeName})` : ""}`,
      "scmConnectionEstablished");
    closeConnPanel();
    onComplete?.();
  });

  panel.querySelector(".mm-btn-cancel").addEventListener("click", closeConnPanel);
  input.focus();
}

/**
 * Populate `panel` with a document-search connection picker.
 * @param {HTMLElement} panel
 * @param {string} fromFactionId
 * @param {() => void} onComplete
 */
export function showConnDocumentSearch(panel, fromFactionId, onComplete) {
  const collections = [
    { type: "Actor",        icon: "fa-user",     col: game.actors  },
    { type: "JournalEntry", icon: "fa-book",     col: game.journal },
    { type: "Item",         icon: "fa-suitcase", col: game.items   },
    { type: "Scene",        icon: "fa-map",      col: game.scenes  }
  ];

  const docs = [];
  for (const { type, icon, col } of collections) {
    for (const doc of col) docs.push({ uuid: doc.uuid, name: doc.name, type, icon });
  }

  panel.innerHTML = `
    <div class="mm-panel-title">Link Document</div>
    <input type="text" class="mm-search-input" placeholder="Filter documents…" autofocus />
    <div class="mm-search-results">
      ${docs.length
        ? docs.map(d => `
          <div class="mm-search-result" data-uuid="${d.uuid}" data-type="${d.type}" data-name="${foundry.utils.escapeHTML(d.name)}">
            <i class="fa-solid ${d.icon}"></i> ${foundry.utils.escapeHTML(d.name)}
            <span class="mm-result-type">${d.type}</span>
          </div>`).join("")
        : "<div class='mm-search-empty'>No documents found</div>"
      }
    </div>
    ${connectionTypePickerHTML()}
    ${connectionDirectionPickerHTML()}
    <div class="mm-panel-actions"><button class="mm-btn-cancel">Cancel</button></div>
  `;

  const input   = panel.querySelector(".mm-search-input");
  const results = panel.querySelector(".mm-search-results");

  input.addEventListener("input", () => {
    const q = input.value.toLowerCase();
    results.querySelectorAll(".mm-search-result").forEach(el => {
      el.style.display = el.dataset.name.toLowerCase().includes(q) ? "" : "none";
    });
  });

  results.addEventListener("click", async (e) => {
    const el = e.target.closest(".mm-search-result");
    if (!el) return;
    const direction        = readSelectedDirection(panel);
    const connectionTypeId = readSelectedType(panel);
    const opts = { documentUuid: el.dataset.uuid, documentType: el.dataset.type, documentName: el.dataset.name };
    if (connectionTypeId) opts.connectionTypeId = connectionTypeId;
    await RelationshipStore.createEdge(fromFactionId, "document", direction, opts);

    const typeName = connectionTypeId
      ? (getConnectionTypes().find(t => t.id === connectionTypeId)?.name ?? "")
      : "";
    const dirArrow = direction === "two-way" ? "↔" : "→";
    await logEvent(fromFactionId, "connection",
      `Document linked: ${el.dataset.name} ${dirArrow}${typeName ? ` (${typeName})` : ""}`,
      "scmConnectionEstablished");
    closeConnPanel();
    onComplete?.();
  });

  panel.querySelector(".mm-btn-cancel").addEventListener("click", closeConnPanel);
  input.focus();
}
