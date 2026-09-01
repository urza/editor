// App wiring: buffer list, sidebar, autosave, shortcuts.
// Frameworkless on purpose. All user-derived text goes through textContent.

import { createEditorState, createView } from "./editor.js";
import {
  deleteBuffer,
  getAllBuffers,
  newBufferRecord,
  openDb,
  putBuffer,
  requestPersistence,
} from "./store.js";

const ACTIVE_KEY = "vrtti.activeBuffer";
const SAVE_DELAY = 300;
const TITLE_MAX = 40;

const buffers = new Map(); // id -> record
const states = new Map(); // id -> EditorState, built lazily on first activation
const saveTimers = new Map(); // id -> timeout handle

let view = null;
let activeId = null;

const openList = document.getElementById("open-list");
const recentList = document.getElementById("recent-list");
const statusTitle = document.getElementById("status-title");
const statusSave = document.getElementById("status-save");

function titleOf(record) {
  const lines = (record.content || "").split("\n");
  for (const line of lines) {
    const text = line.trim();
    if (text) return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX) : text;
  }
  return "untitled";
}

function openBuffers() {
  return [...buffers.values()]
    .filter((b) => !b.closed)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function closedBuffers() {
  return [...buffers.values()]
    .filter((b) => b.closed)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function setSaveStatus(text) {
  statusSave.textContent = text;
}

function renderStatus() {
  const record = buffers.get(activeId);
  statusTitle.textContent = record ? titleOf(record) : "";
}

function makeRow(record, { closable }) {
  const li = document.createElement("li");
  li.className = "buffer-row";
  if (record.id === activeId) li.classList.add("active");

  const title = document.createElement("span");
  title.className = "buffer-title";
  title.textContent = titleOf(record);
  li.appendChild(title);

  if (closable) {
    const close = document.createElement("button");
    close.className = "buffer-close";
    close.type = "button";
    close.textContent = "×";
    close.title = "Close (Alt+W)";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      closeBuffer(record.id);
    });
    li.appendChild(close);
  }

  li.addEventListener("click", () => {
    if (record.closed) reopenBuffer(record.id);
    else activate(record.id);
  });
  return li;
}

function renderSidebar() {
  openList.replaceChildren(
    ...openBuffers().map((b) => makeRow(b, { closable: true }))
  );
  recentList.replaceChildren(
    ...closedBuffers().map((b) => makeRow(b, { closable: false }))
  );
}

function render() {
  renderSidebar();
  renderStatus();
}

function stateFor(id) {
  let state = states.get(id);
  if (!state) {
    const record = buffers.get(id);
    state = createEditorState(record.content, (content) =>
      onDocChanged(id, content)
    );
    states.set(id, state);
  }
  return state;
}

function activate(id) {
  if (!buffers.has(id) || id === activeId) return;
  // Park the live state before swapping, so undo history survives the switch.
  if (activeId && view) states.set(activeId, view.state);
  activeId = id;
  localStorage.setItem(ACTIVE_KEY, id);
  view.setState(stateFor(id));
  view.focus();
  render();
}

function onDocChanged(id, content) {
  const record = buffers.get(id);
  if (!record) return;
  record.content = content;
  record.updatedAt = Date.now();
  if (id === activeId) {
    renderStatus();
    setSaveStatus("…");
  }
  renderSidebar();

  clearTimeout(saveTimers.get(id));
  saveTimers.set(
    id,
    setTimeout(async () => {
      saveTimers.delete(id);
      await putBuffer({ ...record });
      // Only claim "saved" if no newer keystroke started another debounce.
      if (id === activeId && !saveTimers.has(id)) setSaveStatus("saved");
    }, SAVE_DELAY)
  );
}

async function createBuffer() {
  const record = newBufferRecord();
  buffers.set(record.id, record);
  await putBuffer(record);
  activate(record.id);
  render();
  return record;
}

// The point of the whole PoC: closing never asks anything.
async function closeBuffer(id) {
  const record = buffers.get(id);
  if (!record || record.closed) return;
  record.closed = true;
  record.updatedAt = Date.now();
  states.delete(id);
  await putBuffer({ ...record });

  if (id === activeId) {
    activeId = null;
    const next = openBuffers()[0];
    if (next) activate(next.id);
    else await createBuffer();
  }
  render();
}

async function reopenBuffer(id) {
  const record = buffers.get(id);
  if (!record || !record.closed) return;
  record.closed = false;
  record.updatedAt = Date.now();
  await putBuffer({ ...record });
  activate(id);
  render();
}

function bindShortcuts() {
  // event.code, not event.key: Alt+N on a non-US layout can produce a
  // different character, but the physical key code stays KeyN.
  window.addEventListener("keydown", (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.code === "KeyN") {
      event.preventDefault();
      createBuffer();
    } else if (event.code === "KeyW") {
      event.preventDefault();
      if (activeId) closeBuffer(activeId);
    }
  });
}

async function start() {
  requestPersistence();
  await openDb();

  for (const record of await getAllBuffers()) buffers.set(record.id, record);

  view = createView(document.getElementById("editor-host"));

  let first = openBuffers()[0];
  if (!first) {
    const record = newBufferRecord();
    buffers.set(record.id, record);
    await putBuffer(record);
    first = record;
  }

  const stored = localStorage.getItem(ACTIVE_KEY);
  const target =
    stored && buffers.has(stored) && !buffers.get(stored).closed
      ? stored
      : first.id;

  activate(target);
  setSaveStatus("saved");
  render();
  bindShortcuts();
}

// Exposed for the Playwright checks; the UI itself never calls these.
window.vrtti = { buffers, createBuffer, closeBuffer, deleteBuffer };

start().catch((err) => console.error("[vrtti] startup failed", err));
