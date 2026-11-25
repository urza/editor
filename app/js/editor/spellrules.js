// @ts-check
// Harper's rules in its own groups, for the Spellcheck page (ui/spellpage.js).
// The groups, the rule names, the descriptions and the defaults all come from
// the engine, so vrtti keeps no list of rules that a Harper update could
// leave behind.
//
// A module of its own because two places hold a Harper engine: the spellcheck
// worker (editor/spellcheck.worker.js) and, where a browser has no workers,
// the main thread (editor/spellcheck.js). Both build the catalog here. No
// imports, so the worker, which cannot use the import map, can load it.

/**
 * @typedef {{ name: string, description: string, byDefault: boolean }} CatalogRule
 * @typedef {{ label: string, description: string, rules: CatalogRule[] }} CatalogGroup
 */

/**
 * @param {any} harper  A LocalLinter of harper.js, set up.
 * @returns {Promise<CatalogGroup[]>} Plain data, so it can cross from the worker.
 */
export async function buildCatalog(harper) {
  const [structured, descriptions, defaults] = await Promise.all([
    harper.getStructuredLintConfig(),
    harper.getLintDescriptions(),
    // Not the `state` of the structured config: that reads false for every
    // rule the user never touched, on or off by default alike.
    harper.getDefaultLintConfig(),
  ]);
  /** @param {any} entry @returns {CatalogRule[]} */
  const rule = (entry) =>
    entry?.Bool
      ? [{ name: entry.Bool.name, description: descriptions[entry.Bool.name] ?? "", byDefault: defaults[entry.Bool.name] === true }]
      : [];
  /** @type {CatalogGroup[]} */
  const groups = [];
  /** @type {CatalogRule[]} */
  const loose = [];
  for (const entry of structured?.settings ?? []) {
    if (entry?.Group) {
      groups.push({
        label: entry.Group.label,
        description: entry.Group.description ?? "",
        rules: (entry.Group.child?.settings ?? []).flatMap(rule),
      });
    } else loose.push(...rule(entry));
  }
  // Harper 2.7.0 puts every rule in a group. A later version that does not
  // must still show each rule, or it could never be switched.
  if (loose.length > 0) groups.push({ label: "Other", description: "", rules: loose });
  return groups;
}
