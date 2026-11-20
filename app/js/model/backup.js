// @ts-check
// "Back up to a folder" for a space (architecture.md §27): one file for each
// note, named after its title, in a folder the user picked.
//
// The names are the part with rules, so they are pure functions here and
// tested in Node (tests/backup.test.mjs). A second run of the same backup
// writes the same names again, so the folder stays one copy, not a pile.

import { fileIn, writeFile } from "../storage/fsa.js";

// What Windows forbids in a file name, plus the control characters. The
// backup folder may be on any disk, so the strictest system decides.
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/g;
// Names Windows reserves whatever the extension.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_BASE = 80;

/**
 * A title as a file name without its extension: the forbidden characters
 * become `_`, and a name Windows cannot hold gets one more `_`.
 * @param {string} title
 */
export function baseName(title) {
  let name = (title || "").replace(FORBIDDEN, "_").trim();
  // Windows drops trailing dots and spaces, which would make two names one.
  name = name.replace(/[. ]+$/, (tail) => "_".repeat(tail.length));
  if (name.length > MAX_BASE) name = name.slice(0, MAX_BASE);
  if (!name) name = "untitled";
  if (RESERVED.test(name)) name += "_";
  return name;
}

/**
 * One file name for each note. Names are compared without case, as Windows
 * and macOS compare them; on a clash, every note after the first gets a short
 * part of its id. The order is the notes' own, so a second run with the same
 * notes gives the same names.
 * @param {{id: string, title: string}[]} notes @param {string} ext  ".md" or ".md.age".
 * @returns {Map<string, string>} id -> file name
 */
export function fileNames(notes, ext) {
  /** @type {Map<string, string>} */
  const names = new Map();
  const taken = new Set();
  for (const note of notes) {
    const base = baseName(note.title);
    let name = base + ext;
    if (taken.has(name.toLowerCase())) name = base + " (" + note.id.slice(0, 8) + ")" + ext;
    taken.add(name.toLowerCase());
    names.set(note.id, name);
  }
  return names;
}

/**
 * Write the files. Armored age is text, which is what the native write takes,
 * so both kinds of backup go through the same write.
 * @param {any} dir A picked folder.
 * @param {{name: string, content: string}[]} files
 * @returns {Promise<number>} How many files were written.
 */
export async function writeFiles(dir, files) {
  let written = 0;
  for (const file of files) {
    await writeFile(await fileIn(dir, file.name), file.content);
    written++;
  }
  return written;
}
