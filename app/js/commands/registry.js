// @ts-check
// Command registry: every user action gets an id here. Keyboard shortcuts,
// sidebar clicks, and the future command palette all dispatch the same ids,
// so a new invoker never duplicates behavior (architecture.md §6).

/**
 * @typedef {Object} Command
 * @property {string} id
 * @property {string} title
 * @property {string} [keys]  Physical-key chord in event.code names, e.g. "Alt+KeyN".
 * @property {(arg?: any) => any} run
 */

/** @type {Map<string, Command>} */
const commands = new Map();

/** @param {Command} command */
export function register(command) {
  commands.set(command.id, command);
}

/** @param {string} id @param {any} [arg] */
export function run(id, arg) {
  const command = commands.get(id);
  if (!command) throw new Error(`[vrtti] unknown command: ${id}`);
  return command.run(arg);
}

export function all() {
  return [...commands.values()];
}
