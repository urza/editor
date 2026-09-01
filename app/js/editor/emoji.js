// @ts-check
// Twemoji rendering (architecture.md §10). Emoji in the document are drawn as
// the vendored Twemoji SVGs instead of the platform font, fully offline.
// This is a view layer only: the decorations replace what you see, the
// document text keeps the original emoji characters. Nothing here ever
// dispatches a change.

import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";

// Resolved against the document, which is index.html, not against this module.
// "./vendor/..." is therefore correct and "../vendor/..." would be wrong.
const ASSET_BASE = "./vendor/twemoji/svg/";

// One emoji "element": a pictograph plus everything that binds to it.
// - \p{Emoji_Modifier} is a skin tone (U+1F3FB..U+1F3FF).
// - U+FE0F is the emoji-presentation selector.
// - U+E0020..U+E007F are tag characters, which spell out the subdivision
//   flags (England, Scotland, Wales).
const ELEMENT =
  "\\p{Extended_Pictographic}\\p{Emoji_Modifier}?\\uFE0F?[\\u{E0020}-\\u{E007F}]*";

// Keycaps come first in the alternation, but they cannot collide anyway:
// `#`, `*` and the digits are not Extended_Pictographic, so they match here
// only, and only when U+20E3 follows. That is what leaves plain text such as
// "a1b # x" undecorated.
const KEYCAP = "[#*0-9]\\uFE0F?\\u20E3";

// Flags are pairs of regional indicators. {2} keeps "🇨🇿🇸🇰" two flags.
// Pairs only, on purpose. The asset set also ships the 26 single regional
// indicators, the 5 bare skin tones and one private-use leftover (e50a.svg).
// Those 32 files are components, not emoji; leaving them as plain text is the
// point, not an oversight. Every one of the other 3,977 assets matches here.
const FLAG = "\\p{Regional_Indicator}{2}";

// ZWJ (U+200D) glues elements into one emoji: the family, the kiss, the
// running woman with an arrow.
const EMOJI_RE = new RegExp(
  KEYCAP + "|" + FLAG + "|" + ELEMENT + "(?:\\u200D" + ELEMENT + ")*",
  "gu"
);

/**
 * Twemoji asset name for one emoji: hyphen-joined lowercase hex code points.
 * U+FE0F is dropped unless the sequence contains a ZWJ. Verified against the
 * vendored set: no filename holds fe0f without 200d, and the round trip is
 * exact for all 4,009 files.
 *
 * The hex is NOT zero padded. Keycap one is "31-20e3.svg", not "0031-20e3.svg".
 *
 * @param {string} emoji
 * @returns {string}
 */
function assetName(emoji) {
  const points = Array.from(
    emoji,
    (ch) => /** @type {number} */ (ch.codePointAt(0))
  );
  const hasZwj = points.includes(0x200d);
  return points
    .filter((cp) => hasZwj || cp !== 0xfe0f)
    .map((cp) => cp.toString(16))
    .join("-");
}

class EmojiWidget extends WidgetType {
  /** @param {string} emoji */
  constructor(emoji) {
    super();
    this.emoji = emoji;
  }

  /**
   * The emoji text is the widget's whole identity, so equal text means the
   * existing DOM is reused and a redraw costs nothing.
   * @param {EmojiWidget} other
   */
  eq(other) {
    return other.emoji === this.emoji;
  }

  toDOM() {
    // The img sits inside a span because of the error fallback below: the
    // fallback replaces the img, and CodeMirror tracks the node toDOM returns.
    // Swapping that node out from under it would leave a stale reference.
    const wrap = document.createElement("span");
    wrap.className = "twemoji-wrap";

    const img = document.createElement("img");
    img.className = "twemoji";
    img.draggable = false;
    img.alt = this.emoji;
    img.src = ASSET_BASE + assetName(this.emoji) + ".svg";
    // Missing asset, or offline before the service worker cached this one:
    // fall back to the platform glyph. The document text is untouched either
    // way, so nothing is lost.
    img.addEventListener(
      "error",
      () => wrap.replaceChildren(document.createTextNode(this.emoji)),
      { once: true }
    );

    wrap.appendChild(img);
    return wrap;
  }

  ignoreEvent() {
    return false;
  }
}

const matcher = new MatchDecorator({
  regexp: EMOJI_RE,
  decoration: (match) =>
    Decoration.replace({ widget: new EmojiWidget(match[0]) }),
});

/**
 * The Twemoji extension. Always on for now; a toggle command can come later.
 * @returns {import("@codemirror/state").Extension}
 */
export function twemoji() {
  return ViewPlugin.fromClass(
    class {
      /** @param {EditorView} view */
      constructor(view) {
        this.emojis = matcher.createDeco(view);
      }

      /** @param {import("@codemirror/view").ViewUpdate} update */
      update(update) {
        this.emojis = matcher.updateDeco(update, this.emojis);
      }
    },
    {
      decorations: (instance) => instance.emojis,
      // An emoji is one grapheme to the user, so the caret must step over the
      // widget as a unit instead of landing inside the replaced range.
      provide: (plugin) =>
        EditorView.atomicRanges.of(
          (view) => view.plugin(plugin)?.emojis || Decoration.none
        ),
    }
  );
}
