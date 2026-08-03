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
 * Wires a filterable actor list into an existing `.mm-search-results` container
 * and its `.mm-search-input`. Supports browsing Actor compendium packs via a
 * leading "@" token (e.g. "@bestiary" lists matching packs; clicking one opens
 * its contents, further filterable by continued typing). The caller is
 * responsible for the panel's surrounding chrome (title, buttons, dismissal) —
 * this only owns the input/results pair. Call once after both are in the DOM;
 * it renders the initial (world-actor) list immediately.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.panel      — the floating panel; removed on a successful pick
 * @param {HTMLInputElement} opts.input — the `.mm-search-input` element
 * @param {HTMLElement} opts.results    — the `.mm-search-results` container
 * @param {Set<string>} [opts.excludeUuids] — UUIDs rendered as already-linked (non-clickable)
 * @param {(doc: object) => void|Promise<void>} opts.onPick — receives the resolved document
 */
export function wireActorSearchList({ panel, input, results, excludeUuids = new Set(), onPick }) {
  /** The compendium pack currently being browsed, or null when listing world actors. */
  let activePack = null;
  /** Bumped on every render() call; guards against a slow getIndex() overwriting a newer render. */
  let renderToken = 0;

  const actorPacks = () => game.packs.filter(p => p.documentName === "Actor");

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

  function renderPackList(q) {
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

  async function renderPackContents(q, token) {
    results.innerHTML = `<div class="mm-search-empty">Loading…</div>`;
    const index = await activePack.getIndex();
    if (token !== renderToken) return; // a newer render has since started

    const matches = [...index]
      .filter(e => e.name?.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
    const shown = matches.slice(0, ACTOR_LIST_MAX_RESULTS);

    const breadcrumb = `
      <div class="mm-search-result mm-back-row" data-back="1">
        <i class="fa-solid fa-arrow-left ddf-link-icon"></i>
        <span>${foundry.utils.escapeHTML(activePack.title)}</span>
      </div>`;
    results.innerHTML = breadcrumb + (
      shown.length
        ? shown.map(e => rowHTML(e.uuid, e.name)).join("") + hintHTML(shown.length, matches.length)
        : `<div class="mm-search-empty">No actors found</div>`
    );
  }

  async function render() {
    const token = ++renderToken;
    const raw = input.value.trim();
    if (!activePack && raw.startsWith("@")) {
      renderPackList(raw.slice(1).toLowerCase());
    } else if (activePack) {
      await renderPackContents(input.value.toLowerCase(), token);
    } else {
      renderWorldActors(input.value.toLowerCase());
    }
  }

  input.addEventListener("input", () => { render(); });

  results.addEventListener("click", async (e) => {
    const packRow = e.target.closest("[data-pack-id]");
    if (packRow) {
      activePack = actorPacks().find(p => p.collection === packRow.dataset.packId) ?? null;
      input.value = "";
      render();
      return;
    }
    const backRow = e.target.closest("[data-back]");
    if (backRow) {
      activePack = null;
      input.value = "";
      render();
      return;
    }
    const row = e.target.closest(".mm-search-result[data-uuid]");
    if (!row || row.classList.contains("ddf-already-linked")) return;
    const doc = await fromUuid(row.dataset.uuid);
    if (!doc) return;
    panel.remove();
    await onPick(doc);
  });

  render();
}
