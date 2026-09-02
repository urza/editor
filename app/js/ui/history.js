// @ts-check
// The revision history of one synced document (architecture.md §13.6).
//
// Read-only, and deliberately so: an old revision opens as a new scratch
// buffer, never as a rollback of the current one. "Restore" is then the user's
// own copy-paste, which is undoable and cannot lose the newer text.

import { readKeyringContent } from "../crypto/keyring.js";
import { titleOf } from "../model/docs.js";

/** @param {number} bytes */
function formatSize(bytes) {
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
  if (bytes >= 1e3) return (bytes / 1e3).toFixed(1) + " kB";
  return bytes + " B";
}

/**
 * Names for the device ids in the history, from the keyring record.
 * A device that never joined the keyring (or a keyring that is not set up
 * here) keeps a short id: it is still enough to tell two devices apart.
 * @param {ReturnType<import("../model/docs.js").createDocStore>} store
 * @returns {(id: string) => string}
 */
function deviceNamer(store) {
  const content = readKeyringContent(store.keyringRecord());
  const names = new Map((content?.devices ?? []).map((d) => [d.id, d.name]));
  return (id) => names.get(id) || (id || "unknown").slice(0, 8);
}

/**
 * @param {{record: import("../storage/idb.js").BufferRecord,
 *          client: ReturnType<import("../sync/client.js").createSyncClient>,
 *          store: ReturnType<import("../model/docs.js").createDocStore>}} deps
 */
export async function showHistory({ record, client, store }) {
  const dialog = document.createElement("dialog");
  dialog.className = "vrtti-dialog";
  const form = document.createElement("form");
  form.method = "dialog";

  const heading = document.createElement("h2");
  heading.className = "dialog-title";
  heading.textContent = "History of " + titleOf(record);

  const body = document.createElement("div");
  body.className = "dialog-body";
  const status = document.createElement("p");
  status.className = "settings-hint";
  status.textContent = "Loading…";
  body.appendChild(status);

  const list = document.createElement("ul");
  list.className = "history-list";
  body.appendChild(list);

  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const closeButton = document.createElement("button");
  closeButton.type = "submit";
  closeButton.className = "settings-button dialog-primary";
  closeButton.value = "close";
  closeButton.textContent = "Close";
  actions.appendChild(closeButton);

  form.append(heading, body, actions);
  dialog.appendChild(form);

  const returnFocus = document.activeElement;
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (returnFocus instanceof HTMLElement) returnFocus.focus();
  });
  document.body.appendChild(dialog);
  dialog.showModal();

  /** @param {number} rev */
  async function openAsCopy(rev) {
    status.textContent = "Fetching revision " + rev + "…";
    try {
      const change = await client.revision(record.id, rev);
      const enc = change.meta && change.meta.enc;
      let content = change.content ?? "";
      /** @type {import("../storage/idb.js").EncMeta | undefined} */
      let copyEnc = enc;
      if (enc) {
        try {
          content = await store.decodeContent(content, enc);
          // Decoded: the copy is plaintext, so it must not claim to be
          // ciphertext, or the editor would try to decrypt the text again.
          copyEnc = undefined;
        } catch {
          // Locked, or this device is not a recipient. The copy keeps the
          // ciphertext and its `enc`, which is exactly what a courier device
          // can still hold and hand on (architecture.md §5).
          copyEnc = enc;
        }
      }
      await store.createFrom({
        content,
        title: titleOf(record) + " @ rev " + rev,
        lang: change.meta && change.meta.lang,
        langSource: change.meta && change.meta.langSource,
        enc: copyEnc,
      });
      dialog.close("copied");
    } catch (err) {
      status.textContent = "Could not fetch that revision.";
      console.log("[vrtti] history fetch failed", err);
    }
  }

  try {
    const revisions = await client.history(record.id);
    const nameOf = deviceNamer(store);
    status.hidden = revisions.length > 0;
    status.textContent = "No revisions on the server yet.";
    for (const info of revisions) {
      const li = document.createElement("li");
      li.className = "history-row";

      const when = document.createElement("span");
      when.className = "history-when";
      // The author's clock, not the server's: it is the time the user typed,
      // which is what they remember.
      when.textContent = new Date(info.clientTime).toLocaleString();
      li.appendChild(when);

      const meta = document.createElement("span");
      meta.className = "history-meta";
      meta.textContent =
        "rev " +
        info.rev +
        " · " +
        nameOf(info.deviceId) +
        " · " +
        info.kind +
        " · " +
        formatSize(info.size);
      li.appendChild(meta);

      const open = document.createElement("button");
      // Not a submit: opening a copy must not close the form by itself.
      open.type = "button";
      open.className = "settings-button";
      open.textContent = "open as copy";
      // A tombstone has no text to open.
      open.disabled = info.kind !== "text";
      open.addEventListener("click", () => openAsCopy(info.rev));
      li.appendChild(open);

      list.appendChild(li);
    }
  } catch (err) {
    status.hidden = false;
    status.textContent = "Could not load the history.";
    console.log("[vrtti] history failed", err);
  }
}
