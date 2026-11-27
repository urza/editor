// @ts-check
// The native disk backend (architecture.md §17). WebKit has no File System
// Access API and WebView2 forgets a stored handle's grant at every restart, so
// the desktop shell reads and writes files through Rust instead. This module
// is the adapter: the twelve handle methods the page already calls, over the
// shell's `disk_*` commands.
//
// Two rules hold this layer together:
//  - The page imports nothing from Tauri (architecture.md §15). The IPC entry
//    point is read off `window` at call time, the way ui/desktop.js does it,
//    so a browser build loads this module without a shell and simply never
//    reaches a command.
//  - A handle is plain data with its methods on the prototype:
//    { native, kind, name, root, rootPath, path } and nothing else is an own
//    field, so IndexedDB and the BroadcastChannel structured-clone a handle
//    into exactly that descriptor by themselves. reviveHandle() turns one back
//    into a live adapter at the two read boundaries.
//
// Paths are relative to the root, "/" separated, "" for the root itself. The
// page never invents one: every path comes from a listing or from a pick.

/**
 * @typedef {Object} Root A folder or file the user picked, registered in Rust.
 * @property {string} id
 * @property {'file'|'directory'} kind
 * @property {string} name
 * @property {string} path  Absolute, for display only. The page never sends it back.
 */

/** @param {string} command @param {object} args */
function invoke(command, args) {
  const core = /** @type {any} */ (window).__TAURI__?.core;
  if (!core) return Promise.reject(new Error("no shell IPC"));
  return core.invoke(command, args);
}

/**
 * A failed command carries `{ code, message, path }` (architecture.md §17).
 * Two codes become DOMExceptions, because model/folders.js, model/docs.js and
 * ui/search.js branch on those names today and must keep working unchanged.
 * @param {any} err
 */
export function fromDiskError(err) {
  const code = err && err.code;
  const message = (err && err.message) || String(code || err);
  if (code === "notFound") return new DOMException(message, "NotFoundError");
  if (code === "permission") return new DOMException(message, "NotAllowedError");
  if (code === "exists") return new DOMException(message, "InvalidModificationError");
  // A transport failure (no shell, a dropped window) is already an Error.
  if (err instanceof Error) return err;
  const error = /** @type {any} */ (new Error(message));
  error.code = code;
  error.path = err && err.path;
  return error;
}

/** @param {string} command @param {object} args */
async function call(command, args) {
  try {
    return await invoke(command, args);
  } catch (err) {
    throw fromDiskError(err);
  }
}

/** @param {string} path @param {string} name */
function childPath(path, name) {
  return path ? path + "/" + name : name;
}

/**
 * The fields both handle kinds carry, and the four methods that are the same
 * for both. Subclasses add only own data fields, so a structured clone of any
 * handle is the descriptor and nothing more.
 */
class NativeHandle {
  /** @param {{kind: 'file'|'directory', name: string, root: string, rootPath: string, path: string}} fields */
  constructor(fields) {
    // `native` is the descriptor's tag: it is what isNativeHandle() and the
    // revive boundaries recognize after a structured clone has eaten the class.
    this.native = true;
    this.kind = fields.kind;
    this.name = fields.name;
    this.root = fields.root;
    this.rootPath = fields.rootPath;
    this.path = fields.path;
  }

  /** The absolute path, for a hover or a heading. Display only. */
  get fullPath() {
    if (!this.path) return this.rootPath;
    // A Windows root arrives as "C:\Users\u\notes". Joining that with "/"
    // would print a path the user does not recognize as theirs.
    const sep = this.rootPath.includes("\\") ? "\\" : "/";
    return this.rootPath.replace(/[\\/]+$/, "") + sep + this.path.split("/").join(sep);
  }

  /**
   * The grant is the root record in Rust, not a per-session permission, so a
   * native handle is always granted and no row ever shows a reconnect marker.
   * @returns {Promise<'granted'>}
   */
  async queryPermission() {
    return "granted";
  }

  /** @returns {Promise<'granted'>} */
  async requestPermission() {
    return "granted";
  }

  /**
   * A root picked twice keeps its id, so identity is a field comparison and
   * costs no IPC. A real FSA handle is never equal to one of these; fsa.js
   * sameEntry() answers that case without a call.
   * @param {any} other
   */
  async isSameEntry(other) {
    return Boolean(
      other && other.native && other.root === this.root && other.path === this.path
    );
  }
}

class NativeDirectoryHandle extends NativeHandle {
  /** @param {{name: string, root: string, rootPath: string, path: string}} fields */
  constructor(fields) {
    super({ ...fields, kind: "directory" });
  }

  /** One listing, one command. storage/fsa.js sorts what comes out. */
  async *values() {
    /** @type {{name: string, kind: 'file'|'directory'}[]} */
    const entries = await call("disk_list", { root: this.root, path: this.path });
    for (const entry of entries) {
      const fields = {
        name: entry.name,
        root: this.root,
        rootPath: this.rootPath,
        path: childPath(this.path, entry.name),
      };
      yield entry.kind === "directory"
        ? new NativeDirectoryHandle(fields)
        : new NativeFileHandle(fields);
    }
  }

  /**
   * Pure: no command runs here. The FSA version would throw NotFoundError for
   * a missing directory, but model/folders.js only walks down to list a level,
   * and the disk_list that follows throws the same NotFoundError. One command
   * per level instead of one per segment.
   * @param {string} name
   */
  async getDirectoryHandle(name) {
    return new NativeDirectoryHandle({
      name,
      root: this.root,
      rootPath: this.rootPath,
      path: childPath(this.path, name),
    });
  }

  /**
   * Pure, like getDirectoryHandle: the file comes into being at its first
   * write, because disk_write creates a file under a root. `create` is
   * accepted for the FSA signature (storage/fsa.js fileIn) and always true
   * in effect. The backup of a space (architecture.md §27) is the caller.
   * @param {string} name @param {{create?: boolean}} [_options]
   */
  async getFileHandle(name, _options) {
    return new NativeFileHandle({
      name,
      root: this.root,
      rootPath: this.rootPath,
      path: childPath(this.path, name),
    });
  }
}

class NativeFileHandle extends NativeHandle {
  /** @param {{name: string, root: string, rootPath: string, path: string}} fields */
  constructor(fields) {
    super({ ...fields, kind: "file" });
  }

  /**
   * One stat, no read. `text()` and `arrayBuffer()` fetch on demand, which is
   * what keeps ui/search.js's 2 MB guard in front of the read: it looks at
   * `size` first and skips the file without ever pulling its bytes.
   * @returns {Promise<{name: string, size: number, lastModified: number,
   *   text: () => Promise<string>, arrayBuffer: () => Promise<ArrayBuffer>}>}
   */
  async getFile() {
    const { root, path } = this;
    const { size, mtime } = await call("disk_stat", { root, path });
    return {
      name: this.name,
      size,
      lastModified: mtime,
      text: async () => (await call("disk_read", { root, path })).text,
      arrayBuffer: async () => {
        const bytes = await call("disk_read_bytes", { root, path });
        // Tauri hands a raw byte response back as an ArrayBuffer; a view would
        // still have to satisfy File.arrayBuffer()'s contract.
        return bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer;
      },
    };
  }

  /**
   * Single-IPC atomic write for the native shell: passes `expectedMtime` so
   * Rust checks external modifications before rename and returns the new
   * `mtime` in one round trip instead of `disk_stat` -> `disk_write` -> `disk_stat`.
   * @param {string} text
   * @param {number} [expectedMtime]
   * @returns {Promise<{mtime: number}>}
   */
  async writeAtomic(text, expectedMtime) {
    if (typeof text !== "string") throw new TypeError("native write takes text");
    const args =
      expectedMtime === undefined
        ? { root: this.root, path: this.path, text }
        : { root: this.root, path: this.path, text, expectedMtime };
    return call("disk_write", args);
  }

  /**
   * The writable collects and commits on close(), because disk_write is one
   * atomic replacement of the whole file (temp plus rename). Nothing lands on
   * disk before close(), exactly like the browser's default writable.
   */
  async createWritable() {
    const { root, path } = this;
    /** @type {string[]} */
    const chunks = [];
    return {
      /** @param {string} chunk */
      async write(chunk) {
        // The app only ever writes text (model/docs.js is byte-agnostic but
        // holds a string). Anything else would silently become "[object …]".
        if (typeof chunk !== "string") throw new TypeError("native write takes text");
        chunks.push(chunk);
      },
      async close() {
        return call("disk_write", { root, path, text: chunks.join("") });
      },
    };
  }

  /**
   * Rename in the same directory. FSA's move() mutates the handle in place and
   * model/docs.js reads handle.name straight after the call, so this does the
   * same; the caller re-puts the handle record to persist the new path.
   * @param {string} newName
   */
  async move(newName) {
    const result = await call("disk_rename", {
      root: this.root,
      path: this.path,
      newName,
    });
    this.path = result.path;
    this.name = result.name;
  }
}

/**
 * What a browser answers for a handle whose grant is gone. model/docs.js and
 * model/folders.js already turn this name into the reconnect marker.
 */
function noGrant() {
  return new DOMException("old browser handle: reconnect picks it again", "NotAllowedError");
}

/**
 * The stand-in for a real browser handle met inside the shell: a record from
 * before this backend (architecture.md §17, "Mixed handles"). The real handle
 * has no use here. Its grant is gone after a restart, and it cannot tell Rust
 * which file it points at. Its one way forward is the reconnect click, which
 * picks the file or folder again under the same record id.
 *
 * The stand-in exists because the real handle must not be called at all. In
 * WebView2 158 (shell 26.11.3, 2026-11-25) queryPermission() and getFile() on
 * such a handle never settled. Both stores await queryPermission() in load(),
 * so the app started with no list, no editor and no error, while every note
 * sat intact in IndexedDB. The stand-in answers what a restored handle
 * should: "prompt", and NotAllowedError for every disk call.
 *
 * Own fields are data only, like a native handle, so a structured clone is
 * the descriptor { oldBrowser, kind, name }, and reviveHandle() makes a
 * stand-in of that too.
 */
class OldBrowserHandle {
  /** @param {{kind: 'file'|'directory', name: string}} handle The real handle, or a cloned stand-in. */
  constructor(handle) {
    this.oldBrowser = true;
    this.kind = handle.kind;
    this.name = handle.name;
  }

  /** @returns {Promise<'prompt'>} */
  async queryPermission() {
    return "prompt";
  }

  /** @returns {Promise<'prompt'>} A reconnect in the shell is a fresh pick, never a grant. */
  async requestPermission() {
    return "prompt";
  }

  async isSameEntry() {
    return false;
  }

  async getFile() {
    throw noGrant();
  }

  async createWritable() {
    throw noGrant();
  }

  async move() {
    throw noGrant();
  }

  async getFileHandle() {
    throw noGrant();
  }

  async getDirectoryHandle() {
    throw noGrant();
  }

  // No yield on purpose: the listing fails at its first step, the way a
  // directory handle without a grant fails in a browser.
  async *values() {
    throw noGrant();
  }
}

/** @param {any} value Is this a native handle, live or as a cloned descriptor? */
export function isNativeHandle(value) {
  return Boolean(value && value.native === true);
}

/**
 * The read boundary: IndexedDB and the BroadcastChannel return descriptors,
 * this returns handles. In a browser a real FSA handle passes through
 * untouched. In the shell it leaves as its stand-in, and no caller ever holds
 * the real one (see OldBrowserHandle for the reason).
 * @param {any} value
 */
export function reviveHandle(value) {
  if (isNativeHandle(value)) {
    return value.kind === "directory"
      ? new NativeDirectoryHandle(value)
      : new NativeFileHandle(value);
  }
  // Read off `window` at call time, like invoke(): this module loads without
  // a shell, and model/capabilities.js is not imported here.
  const inShell = Boolean(/** @type {any} */ (window).vrttiDesktop);
  if (inShell && value) return new OldBrowserHandle(value);
  return value;
}

/**
 * Show a file in the file manager of the system, selected where the system
 * can do that. The shell resolves the path itself from the root id, like
 * every other disk command: the page sends no absolute path.
 * @param {{root: string, path: string}} handle A native file handle.
 */
export async function reveal(handle) {
  await call("disk_reveal", { root: handle.root, path: handle.path });
}

/**
 * @param {string} command @param {object} args
 * @returns {Promise<Root>} Rejects with AbortError when the user cancels, the
 *   name main.js already reads as "the user closed the dialog".
 */
async function pick(command, args) {
  /** @type {Root | null} */
  const root = await call(command, args);
  if (!root) throw new DOMException("picker cancelled", "AbortError");
  return root;
}

/** @param {Root} root */
function rootFields(root) {
  return { name: root.name, root: root.id, rootPath: root.path, path: "" };
}

/**
 * A root the shell registered by itself, from a drop on the window, an "Open
 * with" or a launch argument (architecture.md §24), delivered as the arg of
 * the `disk.open` command. The same handle a picker returns, so the caller
 * cannot tell the two apart. Null for anything that is not a Root: the
 * command arrives as a DOM event, which any script could raise.
 * @param {any} root
 * @returns {NativeFileHandle | NativeDirectoryHandle | null}
 */
export function handleFromRoot(root) {
  if (!root || typeof root.id !== "string" || typeof root.name !== "string") return null;
  if (root.kind !== "file" && root.kind !== "directory") return null;
  const fields = rootFields(root);
  return root.kind === "directory" ? new NativeDirectoryHandle(fields) : new NativeFileHandle(fields);
}

export async function pickFolder() {
  return new NativeDirectoryHandle(rootFields(await pick("disk_pick_folder", {})));
}

export async function pickFile() {
  return new NativeFileHandle(rootFields(await pick("disk_pick_file", {})));
}

/** @param {string} suggestedName */
export async function pickSave(suggestedName) {
  return new NativeFileHandle(rootFields(await pick("disk_pick_save", { suggestedName })));
}

/**
 * Drop every root the page no longer references. Runs once at boot: a folder
 * closed in a previous session would otherwise sit in Rust's roots.json
 * forever, and a root there is a standing grant.
 * @param {string[]} keepIds @returns {Promise<number>} roots dropped
 */
export async function pruneRoots(keepIds) {
  return call("disk_prune", { keep: keepIds });
}
