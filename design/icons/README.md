# App icon candidates

The icon is drawn once as SVG and every PNG, ICO and ICNS in the repo is
generated from it. The four candidates the user kept on 2026-09-23:

- `caret.svg`: the caret, alone and lit. **Shipped.**
- `whirl.svg`: one spiral in the caret's orange, the movement of the mind.
- `whirl-orange.svg`: the same spiral, dark on the orange tile.
- `loop.svg`: a written line with one whirl in it.

To switch:

```
design/icons/build.sh loop
git add app/icons src-tauri/icons && git commit -m "Icon: the loop"
```

`build.sh` copies the candidate to `app/icons/icon.svg`, renders the PWA
icons (192, 512, and the full-bleed maskable one), and runs
`cargo tauri icon` for the desktop set. The push builds the shells, which
update themselves (architecture.md §18).

Every candidate keeps the tile as `<rect id="tile">`, the rim as
`<rect id="rim">` and the drawing inside `<g id="glyph">`: the script
relies on those three ids for the maskable variant.
