// @ts-check
// The icons of the row menus (ui/menu.js): one color, outlines only, drawn on
// a 16x16 grid with the stroke of `.menu-icon` in app.css. They help the eye
// find an item; the label still says what the item does, so each icon is
// hidden from a screen reader.
//
// One path string per icon, with several "M" sub-paths where a shape needs
// them. No icon font and no sprite file: a menu shows a dozen of these, and a
// string per icon keeps them in the precache with the code that names them.

const SVG_NS = "http://www.w3.org/2000/svg";

/** @type {Record<string, string>} */
const ICONS = {
  rename: "M11.5 2.5l2 2L5 13l-2.5.5L3 11z",
  firstLine: "M2.5 4.5h11M2.5 8h7M2.5 11.5h5",
  // A chain with its middle link gone, and two marks where it was.
  unlink: "M6.5 5.5H5a2.5 2.5 0 0 0 0 5h1.5M9.5 5.5H11a2.5 2.5 0 0 1 0 5H9.5M8 2.5V4M8 12v1.5",
  copy: "M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3",
  copyPath: "M5.5 3.5h-2v10h9v-10h-2M5.5 2.5h5v2h-5zM9 7l-2 4.5",
  folder: "M2 12.5v-9h4l1.5 2H13v2M2 12.5l2-5h10.5l-2 5z",
  diacritics: "M3.5 14L8 4.5l4.5 9.5M5.2 10.5h5.6M7.5 2.8l2-1.8",
  sync: "M13 6.5a5.2 5.2 0 0 0-9.6-1.5M3 2.5v3h3M3 9.5a5.2 5.2 0 0 0 9.6 1.5M13 13.5v-3h-3",
  move: "M2.5 8h10M9 4.5L12.5 8 9 11.5",
  history: "M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11zM8 5v3.2l2 1.3",
  lock: "M4 7.5h8v6H4zM5.5 7.5v-2a2.5 2.5 0 0 1 5 0v2",
  unlock: "M4 7.5h8v6H4zM5.5 7.5v-2a2.5 2.5 0 0 1 4.8-1",
  pin: "M6 13a2.5 2.5 0 1 0 0-5a2.5 2.5 0 1 0 0 5zM7.8 8.7l5.7-5.7M11.5 5L13 6.5M9.8 6.7L11 7.9",
  close: "M4 4l8 8M12 4l-8 8",
  open: "M6.5 3.5h-3v9h9v-3M9 2.5h4.5V7M13.5 2.5l-6 6",
  // The same two shapes as the hover buttons of a drawer row (ui/sidebar.js).
  trash: "M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5",
  restore: "M5 5L2 8l3 3M2.5 8h7a3 3 0 0 1 0 6H7",
  remove: "M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11zM5.5 8h5",
};

/**
 * @param {string} name A key of ICONS. An unknown name gives an empty icon,
 *   so a typing mistake costs a picture and never the menu.
 * @returns {SVGSVGElement}
 */
export function menuIcon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "menu-icon");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ICONS[name] ?? "");
  svg.appendChild(path);
  return svg;
}
