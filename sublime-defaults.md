# Sublime Text 4 default appearance: verified facts

Research report (Opus agent, 2026-09-01). Sources: `twolfson/sublime-files`, an extracted mirror of the shipped Sublime packages, at build 4180 (October 2024), cross-checked against builds 3211 (last ST3) and 4107 (first ST4 stable).

**Note on sources.** The `sublimehq/Packages` GitHub repo holds syntax definitions only, not color schemes. The schemes and default settings ship inside the binary's `.sublime-package` archives. The `twolfson/sublime-files` extraction is the authoritative public mirror.

---

## Part 1: Default font

### 1.1 Per-platform defaults

The main `Preferences.sublime-settings` sets `"font_face": ""` and `"font_size": 10`, but platform files override both:

| Platform | `font_face` | `font_size` (points) |
|---|---|---|
| Windows | `Consolas` | **11** |
| macOS | `Menlo` | **12** |
| Linux | `Monospace` | **10** |

These values are identical in builds 3211, 4107 and 4180. The widely repeated "Consolas 10 on Windows" is wrong; it is 11. `Monospace` on Linux is a fontconfig alias; it usually resolves to DejaVu Sans Mono on Debian, Ubuntu and Fedora.

**Sublime ships no font.** The whole extracted package tree contains zero `.ttf`/`.otf`/`.woff`/`.woff2` files.

### 1.2 Other default rendering settings

From `Packages/Default/Preferences.sublime-settings`:

| Setting | Default | Note |
|---|---|---|
| `font_options` | `[]` | No ligature or antialias override. Windows implicit mode is `directwrite`. |
| `line_padding_top` | `0` | |
| `line_padding_bottom` | `0` | |
| `caret_style` | `"solid"` | Not blinking by default. |
| `caret_extra_top` | `4` | Caret extends 4px above the line box. |
| `caret_extra_bottom` | `4` | |
| `caret_extra_width` | `1` | Caret is 1px wide. |
| `block_caret` | `false` | |
| `highlight_line` | **`false`** | Current line body is NOT highlighted by default. |
| `highlight_gutter` | `true` | Only the gutter row of the caret line is highlighted. |
| `line_numbers` | `true` | |
| `margin` | `4` | Gap between gutter and text. |
| `tab_size` | `4` | |
| `draw_white_space` | `["selection"]` | |

Documented `font_options` values: `no_bold`, `no_italic`, `no_antialias`, `gray_antialias`, `no_liga`, `no_clig`, `no_calt`, `dlig`, `ss01`–`ss10`, plus Windows-only `directwrite` (default), `gdi`, `dwrite_cleartype_classic`, `dwrite_cleartype_natural`, `subpixel_antialias`, plus Mac-only `no_round`.

### 1.3 Point-to-pixel conversion (derived arithmetic, not a Sublime fact)

| Platform | Points | Assumed DPI | CSS px |
|---|---|---|---|
| Windows | 11 | 96 | 14.67 |
| macOS | 12 | 72 (logical point = px) | 12.0 |
| Linux | 10 | 96 | 13.33 |

### 1.4 Closest freely licensed webfonts

Measured with fontTools where possible:

| Font | License | Advance width in em | Line height (hhea) |
|---|---|---|---|
| Consolas (target) | proprietary | 0.5498 (secondary source, unverified) | - |
| Menlo (target) | proprietary (Apple) | 0.6021 | - |
| **DejaVu Sans Mono** | Bitstream Vera / free | **0.6021** | 1.164 |
| **Cascadia Mono** | SIL OFL 1.1 | 0.5859 | 1.162 |
| **Inconsolata** (variable, default width) | SIL OFL 1.1 | 0.5000 | 1.049 |

**For Menlo: DejaVu Sans Mono.** Menlo is a direct Apple derivative of DejaVu Sans Mono (itself from Bitstream Vera Sans Mono). Apple changed only small details (asterisk position, quote size, slashed vs dotted zero). The advance width 1233/2048 is unchanged. DejaVu also covers the Linux `Monospace` case.

**For Consolas, two options:**
1. **Inconsolata**: designed by Raph Levien under explicit Consolas influence (per Wikipedia). Not metrically compatible; renders ~9% narrower. Trick: the Google Fonts variable version has a `wdth` axis; `font-variation-settings: 'wdth' 110` widens the advance to roughly 0.55em, a close Consolas match.
2. **Cascadia Mono**: Microsoft's own OFL successor to Consolas. 6.6% wider than Consolas, better Unicode and box-drawing coverage.

---

## Part 2: Default color scheme

### 2.1 Mariana is confirmed as the ST4 default

From `Preferences.sublime-settings` at build 4180:

```json
"color_scheme": "Mariana.sublime-color-scheme",
"light_color_scheme": "Breakers.sublime-color-scheme",
"dark_color_scheme": "Mariana.sublime-color-scheme",
```

The value is the literal string, not `"auto"`, so Mariana applies in every OS appearance mode. Version history: ST3 (build 3211) defaulted to Monokai; ST4 (4107 onward) defaults to Mariana.

### 2.2 Exact source file

```
https://raw.githubusercontent.com/twolfson/sublime-files/master/Packages/Color%20Scheme%20-%20Default/Mariana.sublime-color-scheme
```

Author field: "Sublime HQ Pty Ltd, Dmitri Voronianski".

### 2.3 Variables block (complete, hsl converted to hex)

| Variable | As written | Hex | Used for |
|---|---|---|---|
| `black` | `hsl(0, 0%, 0%)` | `#000000` | |
| `blue` | `hsl(210, 50%, 60%)` | `#6699CC` | function calls, links |
| `blue-vibrant` | `hsl(210, 60%, 60%)` | `#5C99D6` | accent |
| `blue2` | `hsla(210, 13%, 40%, 0.7)` | `rgba(89, 102, 115, 0.7)` | selection, line highlight |
| `blue3` | `hsl(210, 15%, 22%)` | `#303841` | **background** |
| `blue4` | `hsl(210, 13%, 45%)` | `#647382` | selection border |
| `blue5` | `hsl(180, 36%, 54%)` | `#5FB4B4` | teal: function defs, punctuation |
| `blue6` | `hsl(221, 12%, 69%)` | `#A6ACB9` | comments |
| `green` | `hsl(114, 31%, 68%)` | `#99C794` | strings |
| `grey` | `hsl(0, 0%, 20%)` | `#333333` | find-highlight text |
| `orange` | `hsl(32, 93%, 66%)` | `#F9AE58` | **caret**, numbers |
| `orange2` | `hsl(32, 85%, 55%)` | `#EE932B` | deprecated background |
| `orange3` | `hsl(40, 94%, 68%)` | `#FAC761` | find highlight |
| `pink` | `hsl(300, 30%, 68%)` | `#C695C6` | keywords, storage types |
| `red` | `hsl(357, 79%, 65%)` | `#EC5F66` | storage, tags, misspelling |
| `red2` | `hsl(13, 93%, 66%)` | `#F97B58` | operators |
| `white` | `hsl(0, 0%, 100%)` | `#FFFFFF` | section punctuation |
| `white2` | `hsl(0, 0%, 97%)` | `#F7F7F7` | invalid foreground |
| `white3` | `hsl(219, 28%, 88%)` | `#D8DEE9` | **foreground** |

### 2.4 Globals block (complete)

| Global | Value | Resolved |
|---|---|---|
| `foreground` | `var(white3)` | `#D8DEE9` |
| `background` | `var(blue3)` | `#303841` |
| `accent` | `var(blue-vibrant)` | `#5C99D6` |
| `caret` | `var(orange)` | `#F9AE58` |
| `line_highlight` | `var(blue2)` | `rgba(89, 102, 115, 0.7)` |
| `selection` | `var(blue2)` | `rgba(89, 102, 115, 0.7)` |
| `selection_border` | `var(blue4)` | `#647382` |
| `inactive_selection` | `var(blue2)` | `rgba(89, 102, 115, 0.7)` |
| `misspelling` | `var(red)` | `#EC5F66` |
| `shadow` | `black alpha 0.25` | `rgba(0, 0, 0, 0.25)` |
| `active_guide` | `var(blue5)` | `#5FB4B4` |
| `stack_guide` | `blue5 alpha 0.5` | `rgba(95, 180, 180, 0.5)` |
| `highlight` | `var(blue5)` | `#5FB4B4` |
| `find_highlight_foreground` | `var(grey)` | `#333333` |
| `find_highlight` | `var(orange3)` | `#FAC761` |
| `brackets_options` | `underline` | style |
| `brackets_foreground` | `var(orange)` | `#F9AE58` |
| `bracket_contents_options` | `underline` | style |
| `bracket_contents_foreground` | `var(blue5)` | `#5FB4B4` |
| `tags_options` | `stippled_underline` | style |
| `tags_foreground` | `var(pink)` | `#C695C6` |

**`gutter` and `gutter_foreground` are NOT defined in Mariana.** Gutter background falls back to the editor background `#303841` (observed, not documented). Gutter line-number color has no documented rule; `#647382` (blue4) is a practical approximation, marked as such.

Flattened alpha values (composited over `#303841`), useful because CSS blending differs from Sublime's compositing:

| Effect | Flattened hex |
|---|---|
| selection / line_highlight (blue2 at 0.7) | `#4C5864` |
| markup.raw background (blue2 at 0.266) | `#3B444E` |
| markup.raw.inline background (blue2 at 0.35) | `#3E4852` |

### 2.5 Syntax scope rules (complete, file order)

| Name | Scope | Hex | Style |
|---|---|---|---|
| Comment | `comment, punctuation.definition.comment` | `#A6ACB9` | |
| String | `string` | `#99C794` | |
| Punctuation | `punctuation.definition - punctuation.definition.numeric.base` | `#5FB4B4` | |
| Number | `constant.numeric` | `#F9AE58` | |
| Number Suffix | `storage.type.numeric` | `#C695C6` | italic |
| Built-in constant | `constant.language` | `#EC5F66` | italic |
| User-defined constant | `constant.character, constant.other` | `#C695C6` | |
| Member Variable | `variable.member` | `#EC5F66` | |
| Keyword | `keyword - keyword.operator, keyword.operator.word` | `#C695C6` | |
| Operators | `keyword.operator` | `#F97B58` | |
| Punctuation | `punctuation.separator, punctuation.terminator` | `#A6ACB9` | |
| Punctuation | `punctuation.section` | `#FFFFFF` | |
| Accessor | `punctuation.accessor` | `#A6ACB9` | |
| Annotation Punctuation | `punctuation.definition.annotation` | `#5FB4B4` | |
| JavaScript Dollar | `variable.other.dollar.only.js` etc. | `#5FB4B4` | |
| Storage | `storage` | `#EC5F66` | |
| Storage type | `storage.type` | `#C695C6` | italic |
| Entity name (function def) | `entity.name.function` | `#5FB4B4` | |
| Entity name (other) | `entity.name - (entity.name.section \| entity.name.tag \| entity.name.label)` | `#F9AE58` | |
| Inherited class | `entity.other.inherited-class` | `#5FB4B4` | italic |
| Function argument | `variable.parameter` | `#F9AE58` | |
| Language variable | `variable.language` | `#EC5F66` | italic |
| Tag name | `entity.name.tag` | `#EC5F66` | |
| Tag attribute | `entity.other.attribute-name` | `#C695C6` | |
| Function call | `variable.function, variable.annotation` | `#6699CC` | |
| Library function | `support.function, support.macro` | `#6699CC` | italic |
| Library constant | `support.constant` | `#C695C6` | italic |
| Library class/type | `support.type, support.class` | `#6699CC` | italic |
| Invalid | `invalid` | fg `#F7F7F7`, bg `#EC5F66` | |
| Invalid deprecated | `invalid.deprecated` | fg `#F7F7F7`, bg `#EE932B` | |
| YAML Key | `entity.name.tag.yaml` | `#5FB4B4` | |
| YAML String | `source.yaml string.unquoted` | `#D8DEE9` | |
| CSS Properties | `support.type.property-name` | `#D8DEE9` | |
| (unnamed) | `constant.numeric.line-number.match` | `#EC5F66` | |
| (unnamed) | `message.error` | `#EC5F66` | |

Note the two distinct blues. A function definition (`entity.name.function`) is teal `#5FB4B4`. A function call (`variable.function`) is blue `#6699CC`. Reproduce that split for a faithful look.

### 2.6 Markup and Markdown scopes

| Scope | Color / style |
|---|---|
| `markup.heading` | bold, NO color change |
| `markup.heading punctuation.definition.heading` | `#F97B58` |
| `markup.heading.1 punctuation.definition.heading` | `#EC5F66` |
| `string.other.link, markup.underline.link` | `#6699CC` |
| `markup.bold` / `markup.italic` / `markup.underline` | bold / italic / underline (combinations combine) |
| `punctuation.definition.thematic-break` (hr) | `#F9AE58` |
| `markup.list.numbered.bullet` | `#99C794` |
| blockquote + list-item punctuation | `#F9AE58` |
| `markup.raw` (code block) | bg `#3B444E` (flattened) |
| `markup.raw.inline` (inline code) | bg `#3E4852` (flattened) |
| bold/italic punctuation in text | `#C695C6` |

Heading text carries no color. Only the leading `#` marks are colored.

### 2.7 Diff scopes

| Scope | Hex |
|---|---|
| `meta.diff, meta.diff.header` | `#C695C6` |
| `markup.deleted` | `#EC5F66` |
| `markup.inserted` | `#99C794` |
| `markup.changed` | `#F9AE58` |
| `diff.deleted` bg | `hsla(357, 45%, 60%, 0.15)` |
| `diff.deleted.char` bg | `hsla(357, 60%, 60%, 0.30)` |
| `diff.inserted` bg | `hsla(180, 45%, 60%, 0.15)` |
| `diff.inserted.char` bg | `hsla(180, 60%, 60%, 0.30)` |

### 2.8 Default UI theme (secondary)

Default is `"theme": "auto"`, resolving to `Default.sublime-theme` (light OS) or `Default Dark.sublime-theme` (dark OS). Adaptive is bundled but not the default. Quirk: on a light-mode OS, stock ST4 shows light chrome around a dark Mariana editor.

From `Default Dark.sublime-theme`:

| Theme variable | Hex |
|---|---|
| `ui_bg` (panels, status bar) | `#2E3238` |
| `sidebar_bg` | `#22262A` |
| `sidebar_row_selected` | `#393F46` |
| `text_fg` | `#D9D9D9` |
| `sidebar_label` | `#CCCCCC` |
| `sidebar_heading` | `#E6E6E6` |
| `link_fg` | `#82A0CC` |

Tab bar backgrounds use Sublime's `blend()` function; not resolved to hex (unverified semantics).

---

## CSS starter

```css
:root {
  /* Sublime Text 4 - Mariana (default color scheme) */
  --st-background:      #303841;  /* blue3  */
  --st-foreground:      #D8DEE9;  /* white3 */
  --st-caret:           #F9AE58;  /* orange */
  --st-selection:       rgba(89, 102, 115, 0.7);  /* blue2 */
  --st-selection-flat:  #4C5864;  /* blue2 composited over background */
  --st-selection-border:#647382;  /* blue4  */
  --st-line-highlight:  rgba(89, 102, 115, 0.7);  /* blue2; highlight_line is FALSE by default */

  --st-comment:         #A6ACB9;  /* blue6  */
  --st-string:          #99C794;  /* green  */
  --st-keyword:         #C695C6;  /* pink   */
  --st-function-def:    #5FB4B4;  /* blue5, entity.name.function */
  --st-function-call:   #6699CC;  /* blue,  variable.function    */
  --st-number:          #F9AE58;  /* orange */
  --st-operator:        #F97B58;  /* red2   */
  --st-storage:         #EC5F66;  /* red    */
  --st-accent:          #5C99D6;  /* blue-vibrant */

  /* Gutter: NOT defined in Mariana. Background falls back to --st-background.
     The foreground below is an approximation, not a value from the file. */
  --st-gutter-bg:       #303841;
  --st-gutter-fg:       #647382;  /* APPROXIMATION - unverified */

  /* Type metrics. Sublime stores points; these are 96 DPI conversions. */
  --st-font-win:   Consolas, "Cascadia Mono", monospace;      /* 11pt = 14.67px */
  --st-font-mac:   Menlo, "DejaVu Sans Mono", monospace;      /* 12pt = 12px    */
  --st-font-linux: "DejaVu Sans Mono", monospace;             /* 10pt = 13.33px */
  --st-line-padding-top: 0;
  --st-line-padding-bottom: 0;
  --st-caret-width: 1px;
}
```

For a faithful reproduction: set `caret-color` to the orange, keep the caret 1px wide and solid (non-blinking), and do not paint a current-line background by default.

## Sources

- https://github.com/twolfson/sublime-files/blob/master/Packages/Color%20Scheme%20-%20Default/Mariana.sublime-color-scheme
- https://github.com/twolfson/sublime-files/blob/master/Packages/Default/Preferences.sublime-settings
- https://github.com/twolfson/sublime-files/blob/master/Packages/Default/Preferences%20(Windows).sublime-settings
- https://github.com/twolfson/sublime-files/blob/master/Packages/Default/Preferences%20(OSX).sublime-settings
- https://github.com/twolfson/sublime-files/blob/master/Packages/Default/Preferences%20(Linux).sublime-settings
- https://github.com/twolfson/sublime-files/blob/master/Packages/Theme%20-%20Default/Default%20Dark.sublime-theme
- https://www.sublimetext.com/docs/color_schemes.html
- https://en.wikipedia.org/wiki/Menlo_(typeface)
- https://en.wikipedia.org/wiki/DejaVu_fonts
- https://en.wikipedia.org/wiki/Inconsolata

## Items marked unverified

1. Consolas advance width 1126/2048 (secondary source only; the font is proprietary).
2. Gutter background fallback to `background` (observed behavior, not documented).
3. Gutter foreground value when omitted (no documented rule; `#647382` is an approximation).
4. Tab bar background hex values (depend on undocumented `blend()` semantics).
