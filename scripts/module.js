import { FactionStore } from "./data/FactionStore.js";
import { ProjectStore } from "./data/ProjectStore.js";
import { RelationshipStore } from "./data/RelationshipStore.js";
import { FolderStore } from "./data/FolderStore.js";
import { MemberStore } from "./data/MemberStore.js";
import { FactionsSidebarTab } from "./apps/FactionsSidebarTab.js";
import { FactionDetailApp } from "./apps/FactionDetailApp.js";

const MODULE_ID = "ddf-faction-manager";

Hooks.once("init", async () => {
  // ── Data stores ───────────────────────────────────────────────────────────────
  FactionStore.register();
  ProjectStore.register();
  RelationshipStore.register();
  FolderStore.register();
  MemberStore.register();

  // ── Faction text enricher  (@Faction[id]{label}) ──────────────────────────────
  CONFIG.TextEditor.enrichers.push({
    pattern: /@Faction\[([a-zA-Z0-9]+)\](?:\{([^}]*)\})?/g,
    enricher: (match, options) => {
      const id    = match[1];
      const label = match[2]?.trim() || null;
      const faction = FactionStore.getAll()[id];
      const display = label || faction?.name || id;

      const a = document.createElement("a");
      a.className        = "ddf-faction-link";
      a.dataset.factionId = id;
      a.title            = faction?.name ?? id;
      a.innerHTML        = `<i class="fa-solid fa-shield-halved"></i> ${foundry.utils.escapeHTML(display)}`;
      return a;
    }
  });

  // ── Module settings (appear directly in the Game Settings panel) ──────────────
  game.settings.register(MODULE_ID, "factionJournalId", {
    name: "Faction Journal",
    hint: "All faction notes are stored as pages within this journal. Leave blank to auto-create a journal named \"Faction Details\" on first use.",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, "nodeSizeDetermination", {
    name: "Node Size Determination",
    hint: "How faction node size is calculated in the Faction Relationships map.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      "average": "Average Value",
      "highest": "Highest Value",
      "single":  "Single Value"
    },
    default: "average"
  });

  game.settings.register(MODULE_ID, "statDefinitions", {
    name: "Faction Stats",
    hint: "Stats shown on every faction's Overview. Each faction stores its own value per stat.",
    scope: "world",
    config: true,
    type: String,
    default: JSON.stringify([
      { id: "influence",  name: "Influence",  default: 1 },
      { id: "wealth",     name: "Wealth",     default: 1 },
      { id: "membership", name: "Membership", default: 1 },
      { id: "location",   name: "Location",   default: 1 }
    ])
  });

  game.settings.register(MODULE_ID, "connectionTypes", {
    name: "Connection Types",
    hint: "Types available when creating faction relationships. Each type has a name and a default color.",
    scope: "world",
    config: true,
    type: String,
    default: JSON.stringify([
      { id: "ally",    name: "Ally",    color: "#00bcd4" },
      { id: "friend",  name: "Friend",  color: "#4caf50" },
      { id: "neutral", name: "Neutral", color: "#9e9e9e" },
      { id: "rival",   name: "Rival",   color: "#ff9800" },
      { id: "enemy",   name: "Enemy",   color: "#f44336" }
    ])
  });

  // ── Sidebar tab ───────────────────────────────────────────────────────────────
  Sidebar.TABS.ddfFactions = {
    tooltip: "Factions",
    icon:    "fa-solid fa-shield-halved",
    gmOnly:  true
  };
  CONFIG.ui.ddfFactions = FactionsSidebarTab;

  // Reorder tabs so Factions appears between Journal and Roll Tables.
  // JS objects preserve insertion order, so we clear and re-insert all entries.
  const tabSnapshot = { ...Sidebar.TABS };
  for (const key of Object.keys(Sidebar.TABS)) delete Sidebar.TABS[key];
  for (const [key, val] of Object.entries(tabSnapshot)) {
    if (key === "ddfFactions") continue;        // skip — we'll place it manually
    Sidebar.TABS[key] = val;
    if (key === "journal") Sidebar.TABS.ddfFactions = tabSnapshot.ddfFactions;
  }

  // ── Templates ─────────────────────────────────────────────────────────────────
  await loadTemplates([
    `modules/${MODULE_ID}/templates/sidebar-tab.hbs`,
    `modules/${MODULE_ID}/templates/faction-detail.hbs`,
    `modules/${MODULE_ID}/templates/global-relationships.hbs`,
    `modules/${MODULE_ID}/templates/partials/faction-item.hbs`
  ]);

  // Register the recursive faction-item partial
  Handlebars.registerPartial(
    "ddf-faction-item",
    Handlebars.partials[`modules/${MODULE_ID}/templates/partials/faction-item.hbs`]
  );

  // Register helpers used in templates
  Handlebars.registerHelper("eq", (a, b) => a === b);

  console.log(`${MODULE_ID} | Initialized`);
});

// ── Open faction sheet when a @Faction enricher link is clicked ───────────────
Hooks.once("ready", () => {
  document.addEventListener("click", (event) => {
    const link = event.target.closest(".ddf-faction-link[data-faction-id]");
    if (!link) return;
    if (!game.user.isGM) return;
    event.preventDefault();
    event.stopPropagation();
    FactionDetailApp.show(link.dataset.factionId);
  }, true);
});

// ── Enhance the Game Settings panel for Faction Manager settings ──────────────
//
// Replaces the plain text inputs Foundry renders for our two settings with
// purpose-built controls:
//   • factionJournalId  → <select> populated from game.journal
//   • statDefinitions   → dynamic list editor (add / rename / remove)
//     The list editor keeps a <input type="hidden"> in sync so Foundry's
//     native "Save Changes" button saves the JSON string automatically.

Hooks.on("renderSettingsConfig", (_app, html) => {
  const root = html instanceof HTMLElement ? html : (html[0] ?? html);
  if (!root) return;

  // ── Journal: swap text input for a <select> ───────────────────────────────
  const journalInput = root.querySelector(`input[name="${MODULE_ID}.factionJournalId"]`);
  if (journalInput) {
    const currentId = game.settings.get(MODULE_ID, "factionJournalId") ?? "";
    const select    = document.createElement("select");
    select.name     = `${MODULE_ID}.factionJournalId`;

    const blank = document.createElement("option");
    blank.value       = "";
    blank.textContent = '— Auto: create "Faction Details" on first use —';
    if (!currentId) blank.selected = true;
    select.appendChild(blank);

    for (const j of game.journal.contents.sort((a, b) => a.name.localeCompare(b.name))) {
      const opt = document.createElement("option");
      opt.value       = j.id;
      opt.textContent = j.name;
      if (j.id === currentId) opt.selected = true;
      select.appendChild(opt);
    }

    journalInput.replaceWith(select);
  }

  // ── Stats: swap text input for a list editor ──────────────────────────────
  // Guard: only replace the visible (non-hidden) input; avoid double-injection.
  const statInput = root.querySelector(
    `input[name="${MODULE_ID}.statDefinitions"]:not([type="hidden"])`
  );
  if (!statInput) return; // If the stat input isn't here, neither section applies

  let currentDefs = [];
  try {
    const raw = game.settings.get(MODULE_ID, "statDefinitions");
    currentDefs = typeof raw === "string" ? JSON.parse(raw) : (raw ?? []);
  } catch { /* keep empty */ }

  // Wrapper replaces the original <input>
  const wrap = document.createElement("div");
  wrap.className = "ddf-inline-stat-editor";

  // Hidden input — Foundry's "Save Changes" reads this by name and persists it
  const hidden  = document.createElement("input");
  hidden.type   = "hidden";
  hidden.name   = `${MODULE_ID}.statDefinitions`;
  hidden.value  = JSON.stringify(currentDefs);
  wrap.appendChild(hidden);

  // Column header row
  const header = document.createElement("div");
  header.className = "ddf-stat-list-header";
  header.innerHTML = `
    <span class="ddf-stat-col-name">Name</span>
    <span class="ddf-stat-col-default">Default</span>
    <span class="ddf-stat-col-sizekey">Size</span>
    <span></span>
  `;
  wrap.appendChild(header);

  const list = document.createElement("div");
  list.className = "ddf-stat-list";
  wrap.appendChild(list);

  /** Rebuild the hidden JSON from the current rows. */
  const syncHidden = () => {
    const defs = [];
    list.querySelectorAll(".ddf-stat-row").forEach(row => {
      const id         = row.dataset.statId;
      const name       = row.querySelector(".ddf-stat-name")?.value.trim();
      const defaultRaw = parseFloat(row.querySelector(".ddf-stat-default")?.value);
      const isSizeKey  = row.querySelector(".ddf-stat-sizekey")?.checked ?? false;
      if (id && name) defs.push({
        id,
        name,
        default:  isNaN(defaultRaw) ? 0 : defaultRaw,
        sizeKey:  isSizeKey
      });
    });
    hidden.value = JSON.stringify(defs);
  };

  /** Append a row to the stat list. */
  const addRow = (id, name, defaultVal = 0, isSizeKey = false) => {
    const row       = document.createElement("div");
    row.className   = "ddf-stat-row";
    row.dataset.statId = id;

    const nameInput       = document.createElement("input");
    nameInput.type        = "text";
    nameInput.className   = "ddf-stat-name";
    nameInput.value       = name;
    nameInput.placeholder = "Stat name…";
    nameInput.addEventListener("input", syncHidden);

    const defaultInput         = document.createElement("input");
    defaultInput.type          = "number";
    defaultInput.className     = "ddf-stat-default";
    defaultInput.value         = defaultVal;
    defaultInput.min           = "0";
    defaultInput.step          = "1";
    defaultInput.addEventListener("input", syncHidden);

    const sizekeyCell     = document.createElement("label");
    sizekeyCell.className = "ddf-stat-sizekey-cell";
    sizekeyCell.title     = "Use this stat for node size";
    const sizekeyRadio    = document.createElement("input");
    sizekeyRadio.type     = "radio";
    sizekeyRadio.className = "ddf-stat-sizekey";
    sizekeyRadio.name     = "stat_sizekey";
    sizekeyRadio.checked  = isSizeKey;
    sizekeyRadio.addEventListener("change", syncHidden);
    sizekeyCell.appendChild(sizekeyRadio);

    const delBtn     = document.createElement("button");
    delBtn.type      = "button";
    delBtn.className = "ddf-stat-delete icon";
    delBtn.title     = "Remove stat";
    delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
    delBtn.addEventListener("click", () => { row.remove(); syncHidden(); });

    row.appendChild(nameInput);
    row.appendChild(defaultInput);
    row.appendChild(sizekeyCell);
    row.appendChild(delBtn);
    list.appendChild(row);
    return row;
  };

  for (const def of currentDefs) addRow(def.id, def.name, def.default ?? 0, def.sizeKey ?? false);

  // ── Size key column visibility: show only when "Single Value" is selected ────
  const sizeSelect = root.querySelector(`select[name="${MODULE_ID}.nodeSizeDetermination"]`);
  if (sizeSelect) {
    const updateSizeKeyVisibility = () => {
      wrap.classList.toggle("ddf-sizekey-visible", sizeSelect.value === "single");
    };
    sizeSelect.addEventListener("change", updateSizeKeyVisibility);
    updateSizeKeyVisibility();
  }

  const addBtn     = document.createElement("button");
  addBtn.type      = "button";
  addBtn.className = "ddf-add-stat-btn";
  addBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Add Stat';
  addBtn.addEventListener("click", () => {
    const row = addRow(foundry.utils.randomID(), "");
    syncHidden();
    row.querySelector(".ddf-stat-name")?.focus();
  });
  wrap.appendChild(addBtn);

  statInput.replaceWith(wrap);

  // ── Connection Types: swap text input for a list editor ───────────────────
  const ctInput = root.querySelector(
    `input[name="${MODULE_ID}.connectionTypes"]:not([type="hidden"])`
  );
  if (!ctInput) return;

  let currentTypes = [];
  try {
    const raw = game.settings.get(MODULE_ID, "connectionTypes");
    currentTypes = typeof raw === "string" ? JSON.parse(raw) : (raw ?? []);
  } catch { /* keep empty */ }

  const ctWrap = document.createElement("div");
  ctWrap.className = "ddf-inline-conntype-editor";

  const ctHidden  = document.createElement("input");
  ctHidden.type   = "hidden";
  ctHidden.name   = `${MODULE_ID}.connectionTypes`;
  ctHidden.value  = JSON.stringify(currentTypes);
  ctWrap.appendChild(ctHidden);

  const ctList = document.createElement("div");
  ctList.className = "ddf-conntype-list";
  ctWrap.appendChild(ctList);

  const syncCtHidden = () => {
    const defs = [];
    ctList.querySelectorAll(".ddf-conntype-row").forEach(row => {
      const id    = row.dataset.typeId;
      const name  = row.querySelector(".ddf-conntype-name")?.value.trim();
      const color = row.querySelector(".ddf-conntype-color")?.value ?? "#888888";
      if (id && name) defs.push({ id, name, color });
    });
    ctHidden.value = JSON.stringify(defs);
  };

  const addTypeRow = (id, name, color = "#888888") => {
    const row       = document.createElement("div");
    row.className   = "ddf-conntype-row";
    row.dataset.typeId = id;

    const nameInput       = document.createElement("input");
    nameInput.type        = "text";
    nameInput.className   = "ddf-conntype-name";
    nameInput.value       = name;
    nameInput.placeholder = "Type name…";
    nameInput.addEventListener("input", syncCtHidden);

    const colorInput     = document.createElement("input");
    colorInput.type      = "color";
    colorInput.className = "ddf-conntype-color";
    colorInput.value     = color;
    colorInput.addEventListener("input", syncCtHidden);

    const delBtn     = document.createElement("button");
    delBtn.type      = "button";
    delBtn.className = "ddf-conntype-delete icon";
    delBtn.title     = "Remove type";
    delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
    delBtn.addEventListener("click", () => { row.remove(); syncCtHidden(); });

    row.appendChild(nameInput);
    row.appendChild(colorInput);
    row.appendChild(delBtn);
    ctList.appendChild(row);
    return row;
  };

  for (const def of currentTypes) addTypeRow(def.id, def.name, def.color);

  const addCtBtn     = document.createElement("button");
  addCtBtn.type      = "button";
  addCtBtn.className = "ddf-add-conntype-btn";
  addCtBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Add Type';
  addCtBtn.addEventListener("click", () => {
    const row = addTypeRow(foundry.utils.randomID(), "");
    syncCtHidden();
    row.querySelector(".ddf-conntype-name")?.focus();
  });
  ctWrap.appendChild(addCtBtn);

  ctInput.replaceWith(ctWrap);
});
