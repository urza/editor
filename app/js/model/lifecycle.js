// @ts-check
// Pure note-lifecycle helpers (architecture.md §28): space badge initials,
// 30-day Recent expiry check, PIN-safe stub titles, and retention constants.
// Kept dependency-free so plain Node unit tests run them directly.

const DAY = 24 * 60 * 60 * 1000;

/** Local Recent notes expire to Trash (or forget clean file links) after 30 days. */
export const RECENT_KEEP = 30 * DAY;

/** Trashed notes are purged permanently after 30 days. */
export const TRASH_KEEP = 30 * DAY;

/**
 * One or two uppercase letters for a space badge in the sidebar bottom bar.
 * Hyphen- or underscore-separated words contribute their first two initials
 * ("personal" -> "P", "infra" -> "I", "dev-work" -> "DW", "dev-hobby" -> "DH").
 *
 * @param {string} name
 * @returns {string}
 */
export function spaceBadge(name) {
  if (typeof name !== "string") return "";
  const parts = name
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/**
 * Whether a closed buffer record has exceeded the 30-day local Recent limit.
 * Synced notes never auto-expire from closing; file-backed records with
 * `file.unwritten` hold unsaved text not yet on disk and never auto-expire.
 * Records without `closedAt` (from before §28) are stamped at first start by
 * `docs.js` rather than falling back to `updatedAt`, so an upgrade never dumps
 * archived Recent notes into Trash on first launch.
 *
 * @param {{ kind?: string, sync?: unknown, trashedAt?: number, file?: { unwritten?: boolean }, closedAt?: number, updatedAt?: number } | null | undefined} record
 * @param {number} [now]
 * @returns {boolean}
 */
export function isRecentExpired(record, now = Date.now()) {
  if (!record || record.kind === "keyring") return false;
  if (record.sync || record.trashedAt) return false;
  if (record.file?.unwritten) return false;
  if (typeof record.closedAt !== "number" || !Number.isFinite(record.closedAt)) return false;
  return record.closedAt < now - RECENT_KEEP;
}

/**
 * Title stored on a RemoteStub. A PIN-locked note keeps only its explicit user
 * title and never its first line, so locking the PIN again cannot leak text
 * through a stub created while unlocked (architecture.md §28).
 *
 * @param {{ title?: string, line?: string, pin?: boolean }} [fields]
 * @returns {string}
 */
export function stubTitle(fields = {}) {
  const explicit = typeof fields.title === "string" ? fields.title : "";
  if (fields.pin) return explicit;
  const first = typeof fields.line === "string" ? fields.line : "";
  return explicit || first;
}

/**
 * Whole days remaining before a retention window ends (clamped to >= 1 while
 * the note is still retained).
 *
 * @param {number} since
 * @param {number} [keep]
 * @param {number} [now]
 * @returns {number}
 */
export function daysLeft(since, keep = TRASH_KEEP, now = Date.now()) {
  if (typeof since !== "number" || !Number.isFinite(since)) return Math.round(keep / DAY);
  const rem = since + keep - now;
  return Math.max(1, Math.ceil(rem / DAY));
}
