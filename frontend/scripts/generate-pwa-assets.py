"""Builds the app's icons and splash screens into public/ (run again after changing the name or colours).

    python frontend/scripts/generate-pwa-assets.py           # needs Pillow (the backend's venv has it)
    APP_NAME="Green Valley School" python frontend/scripts/generate-pwa-assets.py

Writes:
  public/icons/icon-192.png, icon-512.png        rounded icon (Android, desktop install, notifications)
  public/icons/maskable-192.png, maskable-512.png full-bleed, mark inside the safe zone (Android adaptive icons)
  public/icons/apple-touch-icon.png               180×180, full-bleed (iOS rounds it)
  public/icons/badge-72.png                       one-colour mark for the Android status bar
  public/icons/favicon-32.png, public/favicon.ico browser tab
  public/splash/apple-<w>x<h>.png                 iOS launch screens (Android builds its own from the manifest)
The mark is the sidebar's: a pencil-yellow tile with the initial, on chalkboard green. Font: Figtree (SIL OFL).
"""

import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
PUBLIC = HERE.parent / "public"
FONT_BOLD = HERE / "pwa-assets" / "figtree-latin-800-normal.woff2"
FONT_NAME = HERE / "pwa-assets" / "figtree-latin-600-normal.woff2"

BOARD = (27, 54, 43)  # --color-board-900  #1b362b
BOARD_DARK = (20, 41, 31)  # --color-board-950
PENCIL = (242, 194, 48)  # --color-pencil-400 #f2c230
APP_NAME = os.environ.get("APP_NAME", "School ERP")
INITIAL = os.environ.get("APP_INITIAL", APP_NAME.strip()[:1].upper() or "S")

# iOS launch images: (css width, css height, scale) for current iPhones and iPads, portrait
APPLE_SPLASH = [
    (320, 568, 2), (375, 667, 2), (414, 736, 3), (375, 812, 3), (414, 896, 2), (414, 896, 3), (360, 780, 3),
    (390, 844, 3), (428, 926, 3), (393, 852, 3), (430, 932, 3), (402, 874, 3), (440, 956, 3),
    (768, 1024, 2), (810, 1080, 2), (820, 1180, 2), (834, 1194, 2), (834, 1112, 2), (1024, 1366, 2),
]  # fmt: skip


def tile(draw: ImageDraw.ImageDraw, cx: float, cy: float, size: float) -> None:
    """The yellow tile with the initial, centred at (cx, cy)."""
    r = size * 0.22
    draw.rounded_rectangle((cx - size / 2, cy - size / 2, cx + size / 2, cy + size / 2), radius=r, fill=PENCIL)
    font = ImageFont.truetype(str(FONT_BOLD), int(size * 0.68))
    l, t, rr, b = draw.textbbox((0, 0), INITIAL, font=font)
    draw.text((cx - (l + rr) / 2, cy - (t + b) / 2), INITIAL, font=font, fill=BOARD_DARK)


def icon(size: int, maskable: bool, tile_ratio: float = 0.46) -> Image.Image:
    scale = 4  # draw large, then shrink: smooth edges
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        d.rectangle((0, 0, s, s), fill=BOARD)
        tile(d, s / 2, s / 2, s * tile_ratio)  # 0.46: inside the 80% safe circle of adaptive icons
    else:
        d.rounded_rectangle((0, 0, s - 1, s - 1), radius=s * 0.22, fill=BOARD)
        tile(d, s / 2, s / 2, s * 0.58)
    return img.resize((size, size), Image.Resampling.LANCZOS)


def badge(size: int) -> Image.Image:
    """White initial on transparent: Android tints it for the status bar."""
    s = size * 4
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(str(FONT_BOLD), int(s * 0.9))
    l, t, r, b = d.textbbox((0, 0), INITIAL, font=font)
    d.text((s / 2 - (l + r) / 2, s / 2 - (t + b) / 2), INITIAL, font=font, fill=(255, 255, 255, 255))
    return img.resize((size, size), Image.Resampling.LANCZOS)


def splash(w: int, h: int) -> Image.Image:
    img = Image.new("RGB", (w, h), BOARD)
    d = ImageDraw.Draw(img)
    unit = min(w, h)
    size = unit * 0.24
    cy = h * 0.46
    tile(d, w / 2, cy, size)
    font = ImageFont.truetype(str(FONT_NAME), int(unit * 0.058))
    l, t, r, b = d.textbbox((0, 0), APP_NAME, font=font)
    d.text((w / 2 - (l + r) / 2, cy + size * 0.5 + unit * 0.06 - t), APP_NAME, font=font, fill=(255, 255, 255))
    return img


def main() -> None:
    icons = PUBLIC / "icons"
    splashes = PUBLIC / "splash"
    icons.mkdir(parents=True, exist_ok=True)
    splashes.mkdir(parents=True, exist_ok=True)
    for size in (192, 512):
        icon(size, maskable=False).save(icons / f"icon-{size}.png", optimize=True)
        icon(size, maskable=True).save(icons / f"maskable-{size}.png", optimize=True)
    icon(180, maskable=True, tile_ratio=0.6).convert("RGB").save(icons / "apple-touch-icon.png", optimize=True)
    icon(32, maskable=False).save(icons / "favicon-32.png", optimize=True)
    icon(48, maskable=False).save(PUBLIC / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    badge(72).save(icons / "badge-72.png", optimize=True)
    for f in splashes.glob("apple-*.png"):
        f.unlink()
    for cw, ch, k in APPLE_SPLASH:
        splash(cw * k, ch * k).save(splashes / f"apple-{cw * k}x{ch * k}.png", optimize=True)
    print(f"icons and {len(APPLE_SPLASH)} splash screens written to {PUBLIC}")


if __name__ == "__main__":
    main()
