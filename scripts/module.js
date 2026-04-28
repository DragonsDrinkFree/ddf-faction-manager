import { FactionStore } from "./data/FactionStore.js";
import { ProjectStore } from "./data/ProjectStore.js";
import { RelationshipStore } from "./data/RelationshipStore.js";
import { FolderStore } from "./data/FolderStore.js";
import { MemberStore } from "./data/MemberStore.js";
import { EventLogStore } from "./data/EventLogStore.js";
import { FactionsSidebarTab } from "./apps/FactionsSidebarTab.js";
import { FactionDetailApp } from "./apps/FactionDetailApp.js";
import { getActiveSandboxPartyId } from "./utils/SandboxIntegration.js";

const MODULE_ID = "ddf-faction-manager";

Hooks.once("init", async () => {
  // ── Data stores ───────────────────────────────────────────────────────────────
  FactionStore.register();
  ProjectStore.register();
  RelationshipStore.register();
  FolderStore.register();
  MemberStore.register();
  EventLogStore.register();

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

  game.settings.register(MODULE_ID, "relationshipMapBg", {
    name: "Relationship Map: Background Image",
    hint: "Image displayed behind the Faction Relationship Map. Leave blank to use the color setting instead.",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, "relationshipMapBgColor", {
    name: "Relationship Map: Background Color",
    hint: "Background color used when no image is set.",
    scope: "world",
    config: true,
    type: String,
    default: "#1a1c2e"
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

  // ── Sandbox Campaign Manager Integration toggles ──────────────────────────────
  const scmSettings = [
    { key: "scmMemberAdded",              name: "Member: Added" },
    { key: "scmMemberRemoved",            name: "Member: Removed" },
    { key: "scmMemberRankChanged",        name: "Member: Rank Changed" },
    { key: "scmObjectiveCreated",         name: "Objective: Created" },
    { key: "scmObjectiveFinished",        name: "Objective: Completed / Reactivated" },
    { key: "scmProgressNote",             name: "Objective: Progress Note Added" },
    { key: "scmConnectionEstablished",    name: "Connection: Established" },
    { key: "scmConnectionTypeChanged",    name: "Connection: Type Changed" },
    { key: "scmConnectionDirectionChanged", name: "Connection: Direction Changed" }
  ];
  for (const { key, name } of scmSettings) {
    game.settings.register(MODULE_ID, key, {
      name,
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true
    });
  }

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
    `modules/${MODULE_ID}/templates/party-detail.hbs`,
    `modules/${MODULE_ID}/templates/global-relationships.hbs`,
    `modules/${MODULE_ID}/templates/partials/faction-item.hbs`,
    `modules/${MODULE_ID}/templates/partials/folder-section.hbs`
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

  // Re-render the faction sidebar tab whenever the user clicks/activates it.
  // Forces a fresh sandbox-import check (in case SCM loaded after us) and
  // refreshes active-party gold styling + sort order when the GM has switched
  // active parties in SCM since the last render. Multiple trigger paths
  // because V14 sidebar tab activation doesn't have one stable hook signature.
  const refreshFactionTab = () => {
    const tab = ui.sidebar?.tabs?.ddfFactions
             ?? ui.sidebar?.tabs?.get?.("ddfFactions")
             ?? ui?.ddfFactions
             ?? null;
    if (tab?.render) tab.render({ force: true });
  };

  // Trigger 1: documented changeSidebarTab hook (works in V12-V13, may differ in V14)
  Hooks.on("changeSidebarTab", (arg) => {
    const tabName = typeof arg === "string" ? arg : (arg?.tabName ?? arg?.id ?? null);
    if (tabName === "ddfFactions") refreshFactionTab();
  });

  // Trigger 2: renderSidebar hook — fires when the sidebar redraws; check active tab
  Hooks.on("renderSidebar", (sidebar) => {
    const active = sidebar?.activeTab ?? sidebar?.tabName
                ?? sidebar?.element?.querySelector?.('[data-tab].active')?.dataset?.tab;
    if (active === "ddfFactions") refreshFactionTab();
  });

  // Trigger 3: direct DOM click on any nav element marked for our tab. Covers
  // multiple V13/V14 button shapes — buttons, anchor tags, etc.
  document.addEventListener("click", (event) => {
    const btn = event.target.closest(
      '[data-tab="ddfFactions"], [data-action="tab"][data-tab="ddfFactions"], [data-tab-id="ddfFactions"]'
    );
    if (!btn) return;
    Promise.resolve().then(refreshFactionTab);
  }, true);

  // Trigger 4 (bulletproof safety net): poll every 1.5s to catch both tab
  // activation and active-party changes that other triggers may have missed.
  // The cost is minimal — render() is a no-op when nothing has changed in the
  // store, and the dispatch only fires on observed transitions.
  let lastActiveTabName = null;
  let lastActivePartyId = null;
  const detectActiveTabName = () => {
    return ui.sidebar?.activeTab?.tabName
        ?? (typeof ui.sidebar?.activeTab === "string" ? ui.sidebar.activeTab : null)
        ?? ui.sidebar?.tabName
        ?? document.querySelector?.('.sidebar-tab.active, [data-tab].active')?.dataset?.tab
        ?? null;
  };
  setInterval(() => {
    const tabName       = detectActiveTabName();
    const activePartyId = getActiveSandboxPartyId();
    const onOurTab      = tabName === "ddfFactions";
    const tabChanged    = tabName !== lastActiveTabName;
    const partyChanged  = activePartyId !== lastActivePartyId;
    if (onOurTab && (tabChanged || partyChanged)) refreshFactionTab();
    lastActiveTabName = tabName;
    lastActivePartyId = activePartyId;
  }, 1500);
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

  // ── SCM Integration: inject section header before first SCM setting ───────
  const scmFirstInput = root.querySelector(`input[name="${MODULE_ID}.scmMemberAdded"]`);
  if (scmFirstInput) {
    const formGroup = scmFirstInput.closest(".form-group");
    if (formGroup) {
      const header = document.createElement("div");
      header.className = "ddf-settings-section-header";
      header.innerHTML = `
        <h3 class="ddf-settings-section-title">
          <i class="fa-solid fa-book-open"></i> Sandbox Campaign Manager Integration
        </h3>
        <p class="ddf-settings-section-hint">
          If the Sandbox Campaign Manager module is present, these options determine
          which faction events are sent to session notes. Disabled events are still
          logged in the faction's Event Log.
        </p>
      `;
      formGroup.parentElement.insertBefore(header, formGroup);
    }
  }

  // ── Relationship Map Background Image: swap text input for file picker ────
  const bgImgInput = root.querySelector(
    `input[name="${MODULE_ID}.relationshipMapBg"]:not([type="hidden"])`
  );
  if (bgImgInput) {
    const currentPath = game.settings.get(MODULE_ID, "relationshipMapBg") ?? "";

    const bgWrap = document.createElement("div");
    bgWrap.className = "ddf-file-picker-wrap";

    const pathInput       = document.createElement("input");
    pathInput.type        = "text";
    pathInput.name        = `${MODULE_ID}.relationshipMapBg`;
    pathInput.value       = currentPath;
    pathInput.placeholder = "path/to/image.webp";
    pathInput.className   = "ddf-bg-path-input";

    const browseBtn     = document.createElement("button");
    browseBtn.type      = "button";
    browseBtn.className = "ddf-bg-browse-btn";
    browseBtn.title     = "Browse for image";
    browseBtn.innerHTML = '<i class="fa-solid fa-file-image"></i>';
    browseBtn.addEventListener("click", () => {
      new FilePicker({
        type:     "image",
        current:  pathInput.value || "",
        callback: (path) => { pathInput.value = path; }
      }).browse();
    });

    const clearBtn     = document.createElement("button");
    clearBtn.type      = "button";
    clearBtn.className = "ddf-bg-clear-btn icon";
    clearBtn.title     = "Clear image";
    clearBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    clearBtn.addEventListener("click", () => { pathInput.value = ""; });

    bgWrap.appendChild(pathInput);
    bgWrap.appendChild(browseBtn);
    bgWrap.appendChild(clearBtn);
    bgImgInput.replaceWith(bgWrap);
  }

  // ── Relationship Map Background Color: swap text input for color picker ───
  const bgColorInput = root.querySelector(
    `input[name="${MODULE_ID}.relationshipMapBgColor"]:not([type="hidden"])`
  );
  if (bgColorInput) {
    const currentColor = game.settings.get(MODULE_ID, "relationshipMapBgColor") ?? "#1a1c2e";

    const colorWrap = document.createElement("div");
    colorWrap.className = "ddf-color-picker-wrap";

    const colorSwatch       = document.createElement("input");
    colorSwatch.type        = "color";
    colorSwatch.value       = currentColor;
    colorSwatch.className   = "ddf-color-swatch";

    const colorText         = document.createElement("input");
    colorText.type          = "text";
    colorText.name          = `${MODULE_ID}.relationshipMapBgColor`;
    colorText.value         = currentColor;
    colorText.placeholder   = "#1a1c2e";
    colorText.className     = "ddf-color-text-input";
    colorText.maxLength     = 7;

    colorSwatch.addEventListener("input", () => { colorText.value = colorSwatch.value; });
    colorText.addEventListener("input",   () => {
      if (/^#[0-9a-fA-F]{6}$/.test(colorText.value)) colorSwatch.value = colorText.value;
    });

    colorWrap.appendChild(colorSwatch);
    colorWrap.appendChild(colorText);
    bgColorInput.replaceWith(colorWrap);
  }
});
