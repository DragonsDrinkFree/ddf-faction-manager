const MODULE_ID = "ddf-faction-manager";

/**
 * Replace a Foundry settings string-input with a custom list editor.
 *
 * The list editor stores the JSON-stringified array in a hidden input that
 * Foundry's "Save Changes" button picks up natively. The caller supplies row
 * construction and reading via two callbacks; this factory handles the
 * wrapper, hidden input, list container, "Add" button, and the sync wiring.
 *
 * @param {object}      opts
 * @param {HTMLElement} opts.root          The settings dialog's root element.
 * @param {string}      opts.settingKey    e.g. "statDefinitions" — used to find the source <input>.
 * @param {string}      opts.wrapperClass  Class name applied to the outer wrapper div.
 * @param {string}      opts.listClass     Class name for the row container.
 * @param {string}      opts.addBtnClass   Class name for the trailing "Add" button.
 * @param {string}      opts.addBtnLabel   Visible label inside the "Add" button.
 * @param {string}     [opts.headerHTML]   Optional column header row HTML.
 * @param {(row: HTMLElement) => object|null} opts.readRow
 *        Reads form values out of a row into a JSON entry. Return null to skip.
 * @param {(data: object, syncFn: () => void) => HTMLElement} opts.buildRow
 *        Builds a new row element. The implementation should attach `input`/`change`
 *        listeners that call `syncFn` so edits propagate to the hidden input.
 * @param {() => object} opts.newRowData   Initial data for newly-added rows.
 * @param {string}     [opts.focusSelector] Selector inside a new row to focus on add.
 * @param {(wrap: HTMLElement, syncFn: () => void) => void} [opts.onAttach]
 *        Optional hook fired after the wrapper is in the DOM (for cross-setting wiring).
 *
 * @returns {HTMLElement|null} the wrapper element, or null if the source input wasn't found.
 */
export function createListEditor({
  root,
  settingKey,
  wrapperClass,
  listClass,
  addBtnClass,
  addBtnLabel,
  headerHTML,
  readRow,
  buildRow,
  newRowData,
  focusSelector,
  onAttach
}) {
  const sourceInput = root.querySelector(
    `input[name="${MODULE_ID}.${settingKey}"]:not([type="hidden"])`
  );
  if (!sourceInput) return null;

  // Parse existing JSON (tolerates string or pre-parsed array)
  let initial = [];
  try {
    const raw = game.settings.get(MODULE_ID, settingKey);
    initial = typeof raw === "string" ? JSON.parse(raw) : (raw ?? []);
  } catch { /* leave empty */ }

  const wrap = document.createElement("div");
  wrap.className = wrapperClass;

  // Hidden input — Foundry's Save Changes reads this by name on submit
  const hidden  = document.createElement("input");
  hidden.type   = "hidden";
  hidden.name   = `${MODULE_ID}.${settingKey}`;
  hidden.value  = JSON.stringify(initial);
  wrap.appendChild(hidden);

  if (headerHTML) {
    const header     = document.createElement("div");
    header.innerHTML = headerHTML;
    // Strip the wrapper div so caller's HTML defines the structure
    while (header.firstChild) wrap.appendChild(header.firstChild);
  }

  const list = document.createElement("div");
  list.className = listClass;
  wrap.appendChild(list);

  /** Walk the rendered rows and rebuild the JSON array in the hidden input. */
  const sync = () => {
    const out = [];
    for (const row of list.children) {
      const entry = readRow(row);
      if (entry) out.push(entry);
    }
    hidden.value = JSON.stringify(out);
  };

  /** Append a row built by the caller; standard delete-button behavior is the caller's job. */
  const appendRow = (data) => {
    const row = buildRow(data, sync);
    list.appendChild(row);
    return row;
  };

  for (const entry of initial) appendRow(entry);

  const addBtn     = document.createElement("button");
  addBtn.type      = "button";
  addBtn.className = addBtnClass;
  addBtn.innerHTML = `<i class="fa-solid fa-plus"></i> ${addBtnLabel}`;
  addBtn.addEventListener("click", () => {
    const row = appendRow(newRowData());
    sync();
    if (focusSelector) row.querySelector(focusSelector)?.focus();
  });
  wrap.appendChild(addBtn);

  sourceInput.replaceWith(wrap);
  onAttach?.(wrap, sync);

  return wrap;
}
