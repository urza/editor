// @ts-check
// Search in files (architecture.md §16). The sidebar switches to a results
// view over this workspace: its tabs first, then every file under its folders.
// Owns #search-view and the `searching` class on #sidebar; app.css hides the
// lists under that class, and ui/sidebar.js does not know this module exists.
//
// Enter searches, typing does not. The tabs are in memory, but the folders are
// disk reads through the File System Access API, and a live search would walk
// the tree on every keystroke.
//
// All user-derived text goes through textContent and append(), never innerHTML:
// a file line is arbitrary text and a <mark> is the only markup a row gets.

import { run } from "../commands/registry.js";
import { hasFileSystemAccess } from "../model/capabilities.js";
import { titleOf } from "../model/docs.js";

/**
 * One run of the search. Everything a run accumulates lives here, so a
 * cancelled run's numbers can never leak into the one that replaced it.
 * @typedef {Object} Run
 * @property {number} gen       Its generation; a newer one ends this run.
 * @property {RegExp} re        The query, escaped, case flag applied.
 * @property {number} len       Match length. Plain text, so it is the query's.
 * @property {number} hits
 * @property {number} files
 * @property {number} locked    Encrypted documents skipped (§5).
 * @property {boolean} capped   The cap cut the scan short.
 * @property {{text: string, folderId?: string}[]} notes  Per-folder trouble.
 * @property {Set<string>} paths  file.path of every tab searched.
 */

// The list is a snapshot in the DOM; a search of a source tree can match
// hundreds of thousands of lines, and the sidebar would die building them.
const MAX_HITS = 1000;
// Checked with file.size before the read: a 300 MB video must not be pulled
// into memory only to be found binary.
const MAX_BYTES = 2 * 1024 * 1024;
// Preview budget in characters. One 8000-character minified line must not push
// every other row's text out of the column.
const PREVIEW = 160;
// Characters of the line kept in front of the match when the preview is cut,
// so the row still shows what the match sits in.
const HEAD = 40;

/** @param {string} text */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {{store: ReturnType<import("../model/docs.js").createDocStore>,
 *          folders: ReturnType<import("../model/folders.js").createFolderStore>,
 *          workspaces: ReturnType<import("../model/workspace.js").createWorkspaces>,
 *          editor: ReturnType<import("../editor/editor.js").mountEditor>}} deps
 */
export function mountSearch({ store, folders, workspaces, editor }) {
  const sidebar = /** @type {HTMLElement} */ (document.getElementById("sidebar"));
  const view = /** @type {HTMLElement} */ (document.getElementById("search-view"));
  const form = /** @type {HTMLFormElement} */ (document.getElementById("search-form"));
  const query = /** @type {HTMLInputElement} */ (document.getElementById("search-query"));
  const caseButton = /** @type {HTMLElement} */ (document.getElementById("search-case"));
  const status = /** @type {HTMLElement} */ (document.getElementById("search-status"));
  const results = /** @type {HTMLElement} */ (document.getElementById("search-results"));

  // Bumped by every new search and by close(). Every await in a scan checks it
  // and returns, so a cancelled scan appends nothing to a list that moved on.
  let generation = 0;

  // The handle behind each folder row on screen, keyed folder id + path. Not a
  // data attribute: a handle is an object, and a dataset holds strings only.
  /** @type {Map<string, any>} */
  const handles = new Map();

  /** @param {string} folderId @param {string} path */
  function handleKey(folderId, path) {
    // NUL is the one byte no file system allows in a name, like the folder
    // store's own cache keys, so no path can forge another key.
    return folderId + "\u0000" + path;
  }

  // ---- The list ------------------------------------------------------------

  /**
   * The line as a row shows it: the indent dropped and a window around the
   * match. The real column stays on the row's dataset; this is display only.
   * @param {string} line @param {number} col @param {number} len
   */
  function preview(line, col, len) {
    const indent = line.length - line.trimStart().length;
    // Keep the indent when the match is inside it: a query that starts with a
    // space would otherwise point past its own text.
    const start = col >= indent ? indent : 0;
    let text = line.slice(start);
    let at = col - start;
    if (at > HEAD) {
      text = "…" + text.slice(at - HEAD);
      at = HEAD + 1;
    }
    // Never shorter than the match itself: a long query stays readable whole.
    const budget = Math.max(PREVIEW, at + len);
    if (text.length > budget) text = text.slice(0, budget) + "…";
    return {
      before: text.slice(0, at),
      match: text.slice(at, at + len),
      after: text.slice(at + len),
    };
  }

  /**
   * @param {string} label @param {Record<string, string>} data
   *   Either `{ id }` for a tab or `{ folderId, path }` for a folder file.
   *   Every row of a group carries it, so a click needs no lookup upwards.
   */
  function fileHeading(label, data) {
    const li = document.createElement("li");
    li.className = "search-file";
    li.textContent = label;
    li.title = label;
    Object.assign(li.dataset, data);
    return li;
  }

  /**
   * @param {string} line @param {number} number @param {number} col
   * @param {number} len @param {Record<string, string>} data
   */
  function hitRow(line, number, col, len, data) {
    const li = document.createElement("li");
    li.className = "search-hit";
    // Focusable, like a tree row: the list is walked with Tab and opened with
    // Enter, and a touch device gets the same target.
    li.tabIndex = 0;
    li.dataset.line = String(number);
    // The column in the original line, not in the preview: the preview trims
    // the indent and may cut the front off, the editor selects in the document.
    li.dataset.col = String(col);
    li.dataset.len = String(len);
    Object.assign(li.dataset, data);
    li.title = line.trim();

    const num = document.createElement("span");
    num.className = "hit-line";
    num.textContent = String(number);
    li.appendChild(num);

    const text = document.createElement("span");
    text.className = "hit-text";
    const parts = preview(line, col, len);
    const mark = document.createElement("mark");
    mark.textContent = parts.match;
    text.append(parts.before, mark, parts.after);
    li.appendChild(text);
    return li;
  }

  /**
   * The matching lines of one text, as rows. Counts them into the run and sets
   * `capped` when the last one fits no more.
   * @param {Run} run @param {string} text @param {Record<string, string>} data
   * @returns {HTMLElement[]}
   */
  function matchRows(run, text, data) {
    const lines = text.split(/\r?\n/);
    /** @type {HTMLElement[]} */
    const rows = [];
    for (let i = 0; i < lines.length; i++) {
      // One hit per line, like grep: a row is a line, and a second match in it
      // has nowhere of its own to go.
      const col = lines[i].search(run.re);
      if (col < 0) continue;
      if (run.hits >= MAX_HITS) {
        run.capped = true;
        break;
      }
      run.hits++;
      rows.push(hitRow(lines[i], i + 1, col, run.len, data));
    }
    return rows;
  }

  /**
   * Append one file's group, when it has hits at all.
   * @param {Run} run @param {string} label @param {Record<string, string>} data
   * @param {string} text @returns {boolean} Did anything match?
   */
  function addFile(run, label, data, text) {
    const rows = matchRows(run, text, data);
    if (!rows.length) return false;
    run.files++;
    // Groups append as each file finishes, so a slow folder shows its first
    // hits long before the scan ends (architecture.md §16).
    results.append(fileHeading(label, data), ...rows);
    return true;
  }

  /** @param {Run} run @param {boolean} running */
  function paintStatus(run, running) {
    let text = running
      ? "Searching…"
      : run.hits
        ? run.hits + (run.hits === 1 ? " hit in " : " hits in ") +
          run.files + (run.files === 1 ? " file" : " files")
        : "No hits";
    if (run.locked) {
      text += " · " + run.locked +
        (run.locked === 1 ? " locked document skipped" : " locked documents skipped");
    }
    if (run.capped) text += " · stopped at " + MAX_HITS + " hits";

    /** @type {HTMLElement[]} */
    const lines = [];
    const summary = document.createElement("div");
    summary.textContent = text;
    lines.push(summary);
    // A folder that could not be read never reports zero hits: it says why,
    // and a permission gap offers the click that fixes it (architecture.md §16).
    for (const note of run.notes) {
      const line = document.createElement("div");
      line.className = "search-note";
      line.textContent = note.text;
      if (note.folderId) {
        const button = document.createElement("button");
        button.className = "search-reconnect";
        button.type = "button";
        button.dataset.folderId = note.folderId;
        button.textContent = "Reconnect";
        line.append(" ", button);
      }
      lines.push(line);
    }
    status.replaceChildren(...lines);
  }

  // ---- The scan ------------------------------------------------------------

  /**
   * One directory level, depth first, in the order the sidebar draws it.
   * @param {Run} run @param {{id: string, name: string}} folder @param {string} path
   * @returns {Promise<boolean>} false when the scan must stop.
   */
  async function walk(run, folder, path) {
    // Never `force`: a re-list emits "listing" and rebuilds the sidebar's tree
    // DOM under the user's pointer. Search reads the tree the sidebar shows.
    const level = await folders.entries(folder.id, path);
    if (run.gen !== generation) return false;

    for (const entry of level) {
      if (entry.kind === "directory") {
        // .git and .obsidian hold thousands of files nobody searches for.
        if (entry.name.startsWith(".")) continue;
        if (!(await walk(run, folder, entry.path))) return false;
        continue;
      }
      // Never attempt a decode on a guess (architecture.md §5), and the
      // ciphertext holds no readable hit anyway.
      if (entry.name.toLowerCase().endsWith(".age")) continue;
      // The tab holds the unsaved text, the disk holds the old one: a file
      // that is open is searched once, as the tab (architecture.md §16).
      const label = folder.name + "/" + entry.path;
      if (run.paths.has(label)) continue;

      // The listing is a cache: a file deleted or renamed on disk since the
      // sidebar listed it fails here with NotFoundError, and that one file is
      // what gets skipped, not the whole folder.
      let text;
      try {
        const file = await entry.handle.getFile();
        if (run.gen !== generation) return false;
        if (file.size > MAX_BYTES) continue;
        text = await file.text();
      } catch (err) {
        console.log("[vrtti] search: file skipped", label, err);
        continue;
      }
      if (run.gen !== generation) return false;
      // What grep does. An extension list would be wrong for someone's notes,
      // and a NUL byte in the first kilobyte is what a binary looks like.
      if (text.slice(0, 1024).includes("\0")) continue;

      const data = { folderId: folder.id, path: entry.path };
      if (addFile(run, label, data, text)) {
        // Only for a file on screen: a whole tree of handles would be held
        // alive for rows nobody can click.
        handles.set(handleKey(folder.id, entry.path), entry.handle);
      }
      if (run.capped) return false;
    }
    return true;
  }

  /** @param {Run} run @returns {Promise<boolean>} false when a newer run took over. */
  async function scanTabs(run) {
    for (const record of store.openBuffers()) {
      // Collected for every tab, hits or not: the folder pass skips a path
      // that is open here even when the tab itself matched nothing.
      if (record.file && record.file.path) run.paths.add(record.file.path);

      let text = "";
      if (record.enc) {
        // §5: search only sees currently unlocked documents. Nothing here may
        // prompt, so a locked store simply skips them and says how many.
        if (!store.isUnlocked) {
          run.locked++;
          continue;
        }
        try {
          text = await store.textOf(record.id);
        } catch (err) {
          // The courier case (§5): ciphertext for another device, which no
          // passphrase on this machine opens. Skip it, and stay quiet. The
          // name, not an instanceof: editor/editor.js reads the same error
          // the same way, and neither of them imports the crypto layer.
          if (!err || err.name !== "LockedError") {
            console.log("[vrtti] search: decode failed", record.id, err);
          }
          run.locked++;
          continue;
        }
        if (run.gen !== generation) return false;
      } else {
        text = /** @type {string} */ (store.textOf(record.id));
      }

      addFile(run, titleOf(record), { id: record.id }, text);
      if (run.capped) return false;
    }
    return true;
  }

  /** @param {Run} run */
  async function scanFolders(run) {
    // Without the API there is no directory handle to walk, and folder.openFile
    // is not registered, so a hit row could dispatch into nothing.
    if (!hasFileSystemAccess) return;
    for (const folder of folders.openFolders()) {
      if (folders.needsReconnect(folder.id)) {
        run.notes.push({
          text: "Folder " + folder.name + " needs a click to reconnect",
          folderId: folder.id,
        });
        continue;
      }
      try {
        if (!(await walk(run, folder, ""))) return;
      } catch (err) {
        // One unreadable folder must not end the search over the others.
        console.log("[vrtti] search: folder failed", folder.name, err);
        run.notes.push({ text: "Folder " + folder.name + " could not be read" });
      }
      if (run.gen !== generation) return;
    }
  }

  async function search() {
    const text = query.value;
    // Whitespace alone would match every line of every file on disk.
    if (!text.trim()) return;

    /** @type {Run} */
    const run = {
      gen: ++generation,
      // Plain text, not a pattern: §16 keeps regular expressions out of this
      // unit, so the query is escaped and the match length is its length.
      re: new RegExp(
        escapeRegExp(text),
        caseButton.getAttribute("aria-pressed") === "true" ? "" : "i"
      ),
      len: text.length,
      hits: 0,
      files: 0,
      locked: 0,
      capped: false,
      notes: [],
      paths: new Set(),
    };

    handles.clear();
    results.replaceChildren();
    paintStatus(run, true);

    if (await scanTabs(run)) await scanFolders(run);
    if (run.gen !== generation) return;
    paintStatus(run, false);
  }

  /** Nothing awaits a search, so a failure must not become an unhandled rejection. */
  function startSearch() {
    search().catch((err) => console.log("[vrtti] search failed", err));
  }

  // ---- Opening a hit -------------------------------------------------------

  /** @param {HTMLElement} row */
  async function openHit(row) {
    const at = {
      line: Number(row.dataset.line),
      col: Number(row.dataset.col),
      len: Number(row.dataset.len),
    };
    const id = row.dataset.id;
    if (id) {
      // Reopen, not activate: the rows are a snapshot, and the tab may have
      // been closed since the search ran. reopen activates an open tab, puts
      // a Recent buffer back into the tabs, and for a buffer another window
      // owns brings that window forward instead (architecture.md §14).
      await run("buffer.reopen", id);
      if (workspaces.ownerOf(id) !== workspaces.id) return;
      editor.reveal(id, at);
    } else {
      const folderId = row.dataset.folderId || "";
      const path = row.dataset.path || "";
      const handle = handles.get(handleKey(folderId, path));
      // The results outlived their run (a folder closed, a new search): the
      // row is stale and there is nothing to open.
      if (!handle) return;
      const folderName = folders.folders.get(folderId)?.name ?? "";
      // The same path string the sidebar builds, which is also the dedupe key
      // above: the two must agree or a file would be searched twice.
      const record = await run("folder.openFile", {
        handle,
        path: folderName + "/" + path,
      });
      if (!record) return;
      // The file is a tab of another window, which came forward instead
      // (architecture.md §14). This window shows something else, so revealing
      // would select in a document the user never asked for.
      if (workspaces.ownerOf(record.id) !== workspaces.id) return;
      editor.reveal(record.id, at);
    }
    // On a phone the sidebar is a drawer over the editor, so it has to get out
    // of the way of the line it just opened. A no-op on a PC.
    run("sidebar.autoclose");
  }

  // One delegated listener, not one per row: a run can put a thousand rows on
  // screen and replace them all on the next Enter.
  results.addEventListener("click", (event) => {
    const target = event.target;
    const row = target instanceof Element ? target.closest(".search-hit") : null;
    if (!(row instanceof HTMLElement)) return;
    openHit(row).catch((err) => console.log("[vrtti] search: open failed", err));
  });
  results.addEventListener("keydown", (event) => {
    const row = event.target;
    if (event.key !== "Enter") return;
    if (!(row instanceof HTMLElement) || !row.classList.contains("search-hit")) return;
    event.preventDefault();
    openHit(row).catch((err) => console.log("[vrtti] search: open failed", err));
  });

  status.addEventListener("click", (event) => {
    const button = event.target;
    if (!(button instanceof HTMLElement)) return;
    if (!button.classList.contains("search-reconnect")) return;
    // The click itself is the user gesture requestPermission needs; a
    // background retry can never get the grant.
    Promise.resolve(run("folder.reconnect", button.dataset.folderId))
      .then((ok) => {
        if (ok) startSearch();
      })
      .catch((err) => console.log("[vrtti] search: reconnect failed", err));
  });

  // ---- The view ------------------------------------------------------------

  function open() {
    // Idempotent on purpose: in the shell the chord can arrive twice, as a menu
    // event on Linux and macOS and as a keydown on Windows, and a toggle would
    // open and close (architecture.md §16).
    // A collapsed sidebar (Alt+B) or a closed drawer is inert, and focus()
    // into it does nothing; the chord is pressed from the editor exactly then.
    run("sidebar.show");
    view.hidden = false;
    sidebar.classList.add("searching");
    query.focus();
    // Selected, not cleared: the last query is usually the next one, and
    // typing replaces it anyway.
    query.select();
  }

  function close() {
    if (view.hidden) return;
    // Stops a scan that is still reading disk. The rows and the query stay,
    // so the next open shows what was found.
    generation++;
    view.hidden = true;
    sidebar.classList.remove("searching");
    // Back to the text: the view was opened from a chord inside the editor.
    editor.view.focus();
  }

  view.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    // The drawer closes on Escape too (ui/shell.js, a window listener). The
    // first Escape belongs to the view the user is looking at.
    event.stopPropagation();
    close();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    startSearch();
  });

  caseButton.addEventListener("click", () => {
    const on = caseButton.getAttribute("aria-pressed") === "true";
    caseButton.setAttribute("aria-pressed", String(!on));
    // Re-run only after a search has run: the toggle must not start a walk
    // over every folder because the user pressed it before typing. "No hits"
    // counts as run, since the other case may well have them.
    if (query.value.trim() && status.childElementCount) startSearch();
  });

  const closeButton = /** @type {HTMLElement} */ (document.getElementById("search-close"));
  closeButton.addEventListener("click", () => close());

  // The touch entry point, in the sidebar's action row. Through the command,
  // like every other invoker, so the button and the chord share one path.
  const openButton = /** @type {HTMLElement} */ (document.getElementById("search-open"));
  openButton.addEventListener("click", () => run("search.inFiles"));

  return { open, close, isOpen: () => !view.hidden };
}
