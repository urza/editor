#!/usr/bin/env python3
"""Generate PWA icons: Mariana-colored 'text lines' with an orange caret.

Pure Pillow drawing, no font files needed. The maskable variant keeps all
content inside the central 80% safe zone required by adaptive icons.
"""

from pathlib import Path

from PIL import Image, ImageDraw

ICONS = Path(__file__).resolve().parent.parent / "icons"

BACKGROUND = "#303841"
# Mariana token colors: keyword pink, function teal, string green, comment grey.
LINES = ["#C695C6", "#5FB4B4", "#99C794", "#A6ACB9"]
CARET = "#F9AE58"
# Line widths as fractions of the drawing area, mimicking a code snippet.
WIDTHS = [0.85, 0.6, 0.72, 0.45]


def draw_icon(size, safe_zone):
    img = Image.new("RGB", (size, size), BACKGROUND)
    d = ImageDraw.Draw(img)

    area = size * safe_zone
    left = (size - area) / 2
    top = (size - area) / 2
    line_h = area * 0.11
    gap = area * 0.115

    y = top + area * 0.08
    for color, width in zip(LINES, WIDTHS):
        d.rounded_rectangle(
            [left, y, left + area * width, y + line_h],
            radius=line_h / 2,
            fill=color,
        )
        y += line_h + gap

    # Caret after the last line, slightly taller than a text line.
    caret_x = left + area * WIDTHS[-1] + area * 0.06
    d.rounded_rectangle(
        [caret_x, y - line_h - gap - area * 0.02, caret_x + area * 0.045, y - gap + area * 0.02],
        radius=area * 0.02,
        fill=CARET,
    )
    return img


def main():
    ICONS.mkdir(exist_ok=True)
    draw_icon(192, 0.84).save(ICONS / "icon-192.png")
    draw_icon(512, 0.84).save(ICONS / "icon-512.png")
    draw_icon(512, 0.66).save(ICONS / "icon-512-maskable.png")
    print("icons written to", ICONS)


if __name__ == "__main__":
    main()
