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
