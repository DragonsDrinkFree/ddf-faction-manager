import { FactionStore } from "../data/FactionStore.js";
import { ReputationStore } from "../data/ReputationStore.js";
import { positionPanelBesideApp } from "../utils/ConnectionPanelHelpers.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const MODULE_ID = "ddf-faction-manager";

export class ReputationLogApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @type {Map<string, ReputationLogApp>} "${partyId}:${factionId}" → open instance */
  static #instances = new Map();

  #partyId   = null;
  #factionId = null;

  constructor(partyId, factionId) {
    super({ id: `ddf-rep-log-${partyId}-${factionId}` });
    this.#partyId   = partyId;
    this.#factionId = factionId;
  }

  static DEFAULT_OPTIONS = {
    id: "ddf-rep-log",
    classes: ["ddf-rep-log-app"],
    tag: "div",
    window: { resizable: true, minimizable: true },
    position: { width: 420, height: 500 }
  };

  static PARTS = {
    content: {
      template: `modules/${MODULE_ID}/templates/party-reputation-log.hbs`
    }
  };

  get title() {
    const factionName = FactionStore.getAll()[this.#factionId]?.name ?? "Unknown";
    return `Reputation Log — ${factionName}`;
  }

  static show(partyId, factionId) {
    const key = `${partyId}:${factionId}`;
    const existing = ReputationLogApp.#instances.get(key);
    if (existing?.element?.isConnected) {
      existing.render({ force: true });
      return existing;
    }
    const app = new ReputationLogApp(partyId, factionId);
    ReputationLogApp.#instances.set(key, app);
    app.render({ force: true });
    return app;
  }

  /** @override */
  async _preparePartContext(partId, context, options) {
    context = await super._preparePartContext(partId, context, options);
    if (partId !== "content") return context;

    const entry      = ReputationStore.getEntry(this.#partyId, this.#factionId);
    const maxValue   = ReputationStore.getEffectiveMax(entry);
    const factionName = FactionStore.getAll()[this.#factionId]?.name ?? "Unknown";

    context.factionName = factionName;
    context.current     = entry?.current ?? 0;
    context.maxValue    = maxValue;
    context.entries     = (entry?.entries ?? [])
      .slice()
      .reverse()
      .map(e => ({
        ...e,
        formattedTime: new Date(e.timestamp).toLocaleString(),
        deltaLabel:    e.delta > 0 ? `+${e.delta}` : `${e.delta}`,
        deltaClass:    e.delta > 0 ? "positive" : e.delta < 0 ? "negative" : "neutral"
      }));

    return context;
  }

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);

    this.element.querySelector('[data-action="archiveToJournal"]')
      ?.addEventListener("click", (e) => this.#showJournalPicker(e.currentTarget));
  }

  #showJournalPicker(triggerEl) {
    document.querySelectorAll(".ddf-rep-journal-panel").forEach(el => el.remove());

    const journals = [...game.journal].sort((a, b) => a.name.localeCompare(b.name));

    const panel = document.createElement("div");
    panel.className      = "mm-search-panel ddf-rep-journal-panel";
    panel.style.position = "fixed";
    panel.style.zIndex   = "10001";
    positionPanelBesideApp(panel, this.element, triggerEl, 260);

    panel.innerHTML = `
      <div class="mm-panel-title">Select Journal</div>
      <input type="text" class="mm-search-input" placeholder="Filter journals…" autofocus />
      <div class="mm-search-results">
        ${journals.length
          ? journals.map(j => `
              <div class="mm-search-result" data-id="${j.id}">
                <i class="fa-solid fa-book ddf-link-icon"></i>
                <span>${foundry.utils.escapeHTML(j.name)}</span>
              </div>`).join("")
          : "<div class='mm-search-empty'>No journals found</div>"
        }
      </div>
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
      panel.remove();
      await this.#archiveToJournal(el.dataset.id);
    });

    panel.querySelector(".mm-btn-cancel").addEventListener("click", () => panel.remove());
    document.body.appendChild(panel);

    const handler = (e) => {
      if (!panel.contains(e.target)) {
        panel.remove();
        document.removeEventListener("mousedown", handler, true);
      }
    };
    setTimeout(() => document.addEventListener("mousedown", handler, true), 50);
    input.focus();
  }

  async #archiveToJournal(journalId) {
    const journal = game.journal.get(journalId);
    if (!journal) return;

    const entry      = ReputationStore.getEntry(this.#partyId, this.#factionId);
    const entries    = entry?.entries ?? [];
    const factionName = FactionStore.getAll()[this.#factionId]?.name ?? "Unknown";
    const date        = new Date().toLocaleDateString();

    const rows = entries
      .slice()
      .reverse()
      .map(e => {
        const dLabel = e.delta > 0 ? `+${e.delta}` : `${e.delta}`;
        const time   = new Date(e.timestamp).toLocaleString();
        const note   = e.note ? foundry.utils.escapeHTML(e.note) : "<em>—</em>";
        return `<tr><td>${dLabel}</td><td>${note}</td><td>${time}</td></tr>`;
      })
      .join("");

    const content = `
      <h2>${foundry.utils.escapeHTML(factionName)} — Reputation Log</h2>
      <p>Archived ${date} | Current: ${entry?.current ?? 0}</p>
      <table>
        <thead><tr><th>Delta</th><th>Note</th><th>Time</th></tr></thead>
        <tbody>${rows || "<tr><td colspan='3'>No entries</td></tr>"}</tbody>
      </table>`;

    await journal.createEmbeddedDocuments("JournalEntryPage", [{
      name:  `${factionName} Reputation — ${date}`,
      type:  "text",
      text:  { content, format: 1 }
    }]);

    await ReputationStore.archiveEntries(this.#partyId, this.#factionId);

    ui.notifications?.info(`Reputation log archived to "${journal.name}".`);
    this.render({ parts: ["content"] });
  }
}
