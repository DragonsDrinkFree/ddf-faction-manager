const MODULE_ID = "ddf-faction-manager";

/**
 * Shared picker-panel utilities used by FactionDetailApp and GlobalRelationshipsApp
 * when rendering the "add connection" popovers. Kept deliberately small and stateless
 * so each app can stitch them into its own panel lifecycle.
 */

/** Reads the "connectionTypes" world setting, tolerating both string and array storage. */
export function getConnectionTypes() {
  try {
    const raw = game.settings.get(MODULE_ID, "connectionTypes");
    return typeof raw === "string" ? JSON.parse(raw) : (raw ?? []);
  } catch {
    return [];
  }
}

/** HTML fragment for a <select> of connection types. */
export function connectionTypePickerHTML() {
  const opts = getConnectionTypes().map(t =>
    `<option value="${t.id}">${foundry.utils.escapeHTML(t.name)}</option>`
  ).join("");
  return `
    <div class="mm-type-row">
      <span>Type:</span>
      <select class="mm-type-select" name="mm_type">
        <option value="">— None —</option>
        ${opts}
      </select>
    </div>`;
}

/** HTML fragment for a one-way/two-way radio group. */
export function connectionDirectionPickerHTML() {
  return `
    <div class="mm-direction-row">
      <span>Direction:</span>
      <label><input type="radio" name="mm_dir" value="one-way" checked> One-way</label>
      <label><input type="radio" name="mm_dir" value="two-way"> Two-way</label>
    </div>`;
}

/** Reads the chosen direction value from a rendered panel. Defaults to "one-way". */
export function readSelectedDirection(panel) {
  return panel.querySelector('input[name="mm_dir"]:checked')?.value ?? "one-way";
}

/** Reads the chosen type id from a rendered panel, or null when "None" selected. */
export function readSelectedType(panel) {
  return panel.querySelector('select[name="mm_type"]')?.value || null;
}

/**
 * Positions a floating panel to hang beside the given app window.
 * Prefers the right side of `appEl`; falls back to the left when the
 * viewport is too narrow. Vertically aligns with the top of `triggerEl`,
 * clamped so the panel is never entirely below the fold.
 */
export function positionPanelBesideApp(panel, appEl, triggerEl, panelWidth = 260, gap = 8) {
  const appRect = appEl.getBoundingClientRect();
  const btnRect = triggerEl.getBoundingClientRect();
  const fitsRight = appRect.right + gap + panelWidth <= window.innerWidth;
  if (fitsRight) panel.style.left  = `${appRect.right + gap}px`;
  else           panel.style.right = `${window.innerWidth - appRect.left + gap}px`;
  panel.style.top = `${Math.min(btnRect.top, window.innerHeight - 40)}px`;
}

/**
 * Wires an outside-click dismiss handler for a floating panel.
 * Fires `onDismiss` once removed so callers can run cleanup (e.g. re-render).
 */
export function bindPanelDismiss(panel, onDismiss) {
  const handler = (e) => {
    if (!panel.contains(e.target)) {
      panel.remove();
      document.removeEventListener("mousedown", handler, true);
      onDismiss?.();
    }
  };
  setTimeout(() => document.addEventListener("mousedown", handler, true), 50);
}

const ACTOR_LIST_MAX_RESULTS = 150;

/**
 * Wires a filterable, keyboard-navigable actor list into an existing
 * `.mm-search-results` container and its `.mm-search-input`. Supports browsing
 * Actor compendium packs via a leading "@" search-tag in the input text
 * itself — e.g. typing "@bestiary" then Tab completes to "@Bestiary " and
 * immediately opens that pack's contents; typing further after the tag
 * filters within it. All state (which pack, if any, is being browsed) is
 * derived purely from the current input text on every keystroke, so
 * backspacing through the tag naturally falls back out of the compendium —
 * no separate "back" control is needed. Arrow keys move a highlight through
 * the current rows and Enter activates it, mirroring what a click does.
 *
 * The caller owns the panel's surrounding chrome (title, buttons, dismissal)
 * — this only owns the input/results pair. Call once after both are in the
 * DOM; it renders the initial (world-actor) list immediately.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.panel      — the floating panel; removed on a successful pick
 * @param {HTMLInputElement} opts.input — the `.mm-search-input` element
 * @param {HTMLElement} opts.results    — the `.mm-search-results` container
 * @param {Set<string>} [opts.excludeUuids] — UUIDs rendered as already-linked (non-clickable)
 * @param {(doc: object) => void|Promise<void>} opts.onPick — receives the resolved document
 */
export function wireActorSearchList({ panel, input, results, excludeUuids = new Set(), onPick }) {
  /** Index of the currently arrow-key-highlighted row among the navigable rows. */
  let highlightIndex = 0;
  /** Bumped on every render() call; guards against a slow getIndex() overwriting a newer render. */
  let renderToken = 0;

  const actorPacks = () => game.packs.filter(p => p.documentName === "Actor");

  /**
   * Parses the input's raw text into a mode purely from its content:
   * - no leading "@"                      → world actors, filtered by the whole text
   * - "@<partial>" (no space yet)         → browsing/narrowing compendium names
   * - "@<Exact Pack Title> <query>"       → inside that pack, filtered by <query>
   * A space typed before the tag resolves to a real pack title falls back to
   * still narrowing compendium names (treats what's before the space as the tag).
   */
  function parseInput(raw) {
    if (!raw.startsWith("@")) return { mode: "world", query: raw };
    const spaceIdx = raw.indexOf(" ");
    if (spaceIdx === -1) return { mode: "pack-select", tag: raw.slice(1) };
    const tag  = raw.slice(1, spaceIdx);
    const pack = actorPacks().find(p => p.title.toLowerCase() === tag.toLowerCase());
    if (!pack) return { mode: "pack-select", tag };
    return { mode: "pack-contents", pack, query: raw.slice(spaceIdx + 1) };
  }

  const rowHTML = (uuid, name) => {
    const excluded = excludeUuids.has(uuid);
    return `
      <div class="mm-search-result${excluded ? " ddf-already-linked" : ""}" data-uuid="${uuid}">
        <i class="fa-solid fa-user ddf-link-icon"></i>
        <span>${foundry.utils.escapeHTML(name)}</span>
        ${excluded ? '<span class="ddf-linked-badge">already added</span>' : ""}
      </div>`;
  };

  const hintHTML = (shown, total) => total > shown
    ? `<div class="mm-search-hint">+${total - shown} more — keep typing to narrow it down</div>`
    : "";

  function renderWorldActors(q) {
    const matches = [...game.actors]
      .filter(a => a.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
    const shown = matches.slice(0, ACTOR_LIST_MAX_RESULTS);
    results.innerHTML = shown.length
      ? shown.map(a => rowHTML(a.uuid, a.name)).join("") + hintHTML(shown.length, matches.length)
      : `<div class="mm-search-empty">No actors found</div>`;
  }

  function renderPackList(tag) {
    const q     = tag.toLowerCase();
    const packs = actorPacks()
      .filter(p => p.title.toLowerCase().includes(q))
      .sort((a, b) => a.title.localeCompare(b.title));
    results.innerHTML = packs.length
      ? packs.map(p => `
          <div class="mm-search-result mm-pack-result" data-pack-id="${p.collection}">
            <i class="fa-solid fa-box-archive ddf-link-icon"></i>
            <span>${foundry.utils.escapeHTML(p.title)}</span>
          </div>`).join("")
      : `<div class="mm-search-empty">No matching compendiums</div>`;
  }

  async function renderPackContents(pack, query, token) {
    results.innerHTML = `<div class="mm-search-empty">Loading…</div>`;
    const index = await pack.getIndex();
    if (token !== renderToken) return; // a newer render has since started

    const q = query.toLowerCase();
    const matches = [...index]
      .filter(e => e.name?.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
    const shown = matches.slice(0, ACTOR_LIST_MAX_RESULTS);

    const label = `<div class="mm-pack-label">${foundry.utils.escapeHTML(pack.title)} — ${index.size} actor${index.size === 1 ? "" : "s"}</div>`;
    results.innerHTML = label + (
      shown.length
        ? shown.map(e => rowHTML(e.uuid, e.name)).join("") + hintHTML(shown.length, matches.length)
        : `<div class="mm-search-empty">No actors found</div>`
    );
  }

  /** Rows the keyboard/click can act on — excludes labels, hints, and already-linked actors. */
  function navigableRows() {
    return [...results.querySelectorAll(
      ".mm-search-result[data-uuid]:not(.ddf-already-linked), .mm-search-result[data-pack-id]"
    )];
  }

  function refreshHighlight() {
    const rows = navigableRows();
    if (!rows.length) return;
    highlightIndex = Math.max(0, Math.min(rows.length - 1, highlightIndex));
    rows.forEach((r, i) => r.classList.toggle("mm-row-highlighted", i === highlightIndex));
  }

  async function render() {
    const token = ++renderToken;
    highlightIndex = 0;
    const parsed = parseInput(input.value);
    if (parsed.mode === "world") {
      renderWorldActors(parsed.query.toLowerCase());
    } else if (parsed.mode === "pack-select") {
      renderPackList(parsed.tag);
    } else {
      await renderPackContents(parsed.pack, parsed.query, token);
    }
    if (token === renderToken) refreshHighlight();
  }

  /** Completes the input to an exact pack tag and opens its contents — used by both Tab and row activation. */
  function completeTag(pack) {
    input.value = `@${pack.title} `;
    input.setSelectionRange(input.value.length, input.value.length);
    render();
  }

  /** Shared by click and Enter-key activation, so both paths behave identically. */
  async function activateRow(rowEl) {
    if (rowEl.dataset.packId) {
      const pack = actorPacks().find(p => p.collection === rowEl.dataset.packId);
      if (pack) completeTag(pack);
      return;
    }
    if (rowEl.dataset.uuid && !rowEl.classList.contains("ddf-already-linked")) {
      const doc = await fromUuid(rowEl.dataset.uuid);
      if (!doc) return;
      panel.remove();
      await onPick(doc);
    }
  }

  function longestCommonPrefix(strings) {
    let prefix = strings[0] ?? "";
    for (const s of strings.slice(1)) {
      let i = 0;
      while (i < prefix.length && i < s.length && prefix[i].toLowerCase() === s[i].toLowerCase()) i++;
      prefix = prefix.slice(0, i);
      if (!prefix) break;
    }
    return prefix;
  }

  input.addEventListener("input", () => { render(); });

  input.addEventListener("keydown", async (e) => {
    if (e.key === "Tab") {
      // Only intercepted while narrowing a compendium name — elsewhere Tab
      // behaves normally (e.g. moves focus to the Cancel button).
      const parsed = parseInput(input.value);
      if (parsed.mode !== "pack-select") return;
      const tagLower = parsed.tag.toLowerCase();
      const candidates = actorPacks()
        .filter(p => p.title.toLowerCase().startsWith(tagLower))
        .sort((a, b) => a.title.localeCompare(b.title));
      if (!candidates.length) return; // nothing to complete — let Tab move focus normally
      e.preventDefault();
      if (candidates.length === 1) {
        completeTag(candidates[0]);
        return;
      }
      const prefix = longestCommonPrefix(candidates.map(p => p.title));
      if (prefix.length > parsed.tag.length) {
        input.value = `@${prefix}`;
        input.setSelectionRange(input.value.length, input.value.length);
        render();
      }
      // else: already at the shared prefix — ambiguous until typed further or arrow+Enter
      return;
    }

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const rows = navigableRows();
      if (!rows.length) return;
      e.preventDefault();
      highlightIndex = Math.max(0, Math.min(rows.length - 1, highlightIndex + (e.key === "ArrowDown" ? 1 : -1)));
      rows.forEach((r, i) => r.classList.toggle("mm-row-highlighted", i === highlightIndex));
      rows[highlightIndex]?.scrollIntoView({ block: "nearest" });
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      const row = navigableRows()[highlightIndex];
      if (row) await activateRow(row);
    }
  });

  results.addEventListener("click", (e) => {
    const row = e.target.closest(".mm-search-result[data-uuid], .mm-search-result[data-pack-id]");
    if (row) activateRow(row);
  });

  render();
}
