"""make_icon_set.py - render the BookVoice "voice rising from a book" mark and
write every icon consumer in the repo (no external source image needed).

The mark is drawn procedurally at 4x supersampling and mirrors
frontend/public/favicon.svg (the vector master, hand-maintained with the same
geometry). Run from the repo root:

    python scripts/tools/make_icon_set.py

Outputs:
    scripts/tools/icon-master.png          2048px master (input for make_icons.py)
    frontend/public/bookvoice.png          512px web + WinUI splash icon
    frontend/public/favicon.svg            vector master (static file, not rendered here)
    bookvoice.ico                          exe/PyInstaller/tray icon (root)
    dist/bookvoice.ico                     packaged payload copy (when dist/ exists)
    desktop/BookVoice.App/bookvoice.ico    WinUI ApplicationIcon
    desktop/BookVoice.App/Assets/bookvoice.ico   WinUI window icon
    desktop/BookVoice.App/Assets/bookvoice.png   WinUI splash image
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parents[2]

# Aurora Glass palette — must stay in sync with tokens.css --aurora-a/b.
AURORA_A = (109, 90, 232)    # violet  #6D5AE8
AURORA_MID = (78, 123, 234)  # azure   #4E7BEA
AURORA_B = (42, 212, 232)    # cyan    #2AD4E8
INK = (12, 12, 24)           # shade tint #0C0C18

TILE = 512
SS = 4                       # supersample factor
S = TILE * SS
RADIUS = 116


def _lerp_color(a: tuple, b: tuple, t: float) -> tuple:
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def _diagonal_ramp() -> Image.Image:
    """Full-canvas L ramp where value = (x + y) / 2 scaled to 0..255."""
    horizontal = Image.linear_gradient("L").rotate(90)          # 0 left -> 255 right
    vertical = Image.linear_gradient("L")                       # 0 top -> 255 bottom
    return ImageChops.add(
        horizontal.resize((S, S), Image.BILINEAR),
        vertical.resize((S, S), Image.BILINEAR),
        scale=2.0,
    )


def _gradient_ramp(stops: list[tuple[float, tuple]]) -> Image.Image:
    """Diagonal ramp colorized with the given (position, color) stops."""
    lut = []
    for c in range(3):
        channel = []
        for i in range(256):
            t = i / 255
            for j in range(len(stops) - 1):
                t0, c0 = stops[j]
                t1, c1 = stops[j + 1]
                if t <= t0:
                    channel.append(c0[c])
                    break
                if t0 < t <= t1:
                    channel.append(_lerp_color(c0, c1, (t - t0) / (t1 - t0))[c])
                    break
            else:
                channel.append(stops[-1][1][c])
        lut.extend(channel)
    return _diagonal_ramp().point(lut, "RGB")


def _vertical_alpha(top: float, bottom: float, a_top: int, a_bottom: int) -> Image.Image:
    """Full-canvas vertical alpha ramp between two (position, alpha) points."""
    ramp = Image.linear_gradient("L").resize((S, S), Image.BILINEAR)
    lut = []
    for i in range(256):
        t = i / 255
        if t <= top:
            lut.append(a_top)
        elif t >= bottom:
            lut.append(a_bottom)
        else:
            lut.append(round(a_top + (a_bottom - a_top) * (t - top) / (bottom - top)))
    return ramp.point(lut)


def _cubic(p0, p1, p2, p3, steps=48):
    return [
        (
            (1 - t) ** 3 * p0[0] + 3 * (1 - t) ** 2 * t * p1[0]
            + 3 * (1 - t) * t ** 2 * p2[0] + t ** 3 * p3[0],
            (1 - t) ** 3 * p0[1] + 3 * (1 - t) ** 2 * t * p1[1]
            + 3 * (1 - t) * t ** 2 * p2[1] + t ** 3 * p3[1],
        )
        for t in (i / steps for i in range(steps + 1))
    ]


def draw_mark(simplified: bool = False) -> Image.Image:
    """Render the mark at supersampled resolution with alpha corners.

    `simplified` drops to three bold bars for the tiny ICO sizes, where the
    five-bar full detail merges into a blob.
    """
    # Tile: aurora gradient + rounded corners.
    tile = _gradient_ramp([(0.0, AURORA_A), (0.52, AURORA_MID), (1.0, AURORA_B)]).convert("RGBA")

    # Bottom shade for depth.
    shade = Image.new("RGBA", (S, S), INK + (0,))
    shade.putalpha(_vertical_alpha(0.42, 1.0, 0, 92))
    tile.alpha_composite(shade)

    # Top-left sheen for the glass feel: white fading out along the diagonal.
    sheen_alpha = _diagonal_ramp().point(
        lambda v: max(0, round((1 - v / 140) * 36)) if v < 140 else 0
    )
    sheen = Image.new("RGBA", (S, S), (255, 255, 255, 0))
    sheen.putalpha(sheen_alpha)
    tile.alpha_composite(sheen)

    draw = ImageDraw.Draw(tile)
    k = SS  # 512-space -> supersampled pixels

    # Open book: two mirrored pages with a spine gap the voice rises from.
    left = _cubic((110, 206), (162, 194), (216, 224), (250, 248))          # top edge -> gutter
    left += [(250, 248), (250, 370)]
    left += _cubic((250, 370), (204, 392), (152, 386), (110, 362))         # bottom edge back out
    draw.polygon([(x * k, y * k) for x, y in left], fill=(255, 255, 255, 246))
    right = [(TILE - x, y) for x, y in left]
    draw.polygon([(x * k, y * k) for x, y in right], fill=(255, 255, 255, 246))

    # Voice bars rising from the gutter (equalizer silhouette).
    if simplified:
        bar_w, gap, heights = 30, 20, [92, 158, 92]
    else:
        bar_w, gap, heights = 20, 24, [58, 104, 150, 104, 58]
    bottom_y = 240
    cx = TILE / 2
    for i, h in enumerate(heights):
        offset = (i - (len(heights) - 1) / 2) * (bar_w + gap)
        x0 = cx + offset - bar_w / 2
        draw.rounded_rectangle(
            (x0 * k, (bottom_y - h) * k, (x0 + bar_w) * k, bottom_y * k),
            radius=10 * k,
            fill=(255, 255, 255, 255),
        )

    # Clip everything to the rounded tile: alpha outside the corner radius -> 0.
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), radius=RADIUS * k, fill=255)
    result = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    result.paste(tile, (0, 0), mask)
    return result


def write_svg() -> None:
    """Hand-mirrored vector master (geometry identical to draw_mark)."""
    bars = "".join(
        f'<rect x="{256 + (i - 2) * 44 - 10}" y="{240 - h}" width="20" height="{h}" rx="10" fill="#fff"/>'
        for i, h in enumerate([58, 104, 150, 104, 58])
    )
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="BookVoice">
  <defs>
    <linearGradient id="aurora" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6D5AE8"/>
      <stop offset=".52" stop-color="#4E7BEA"/>
      <stop offset="1" stop-color="#2AD4E8"/>
    </linearGradient>
    <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
      <stop offset=".42" stop-color="#0C0C18" stop-opacity="0"/>
      <stop offset="1" stop-color="#0C0C18" stop-opacity=".36"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="116" fill="url(#aurora)"/>
  <rect width="512" height="512" rx="116" fill="url(#shade)"/>
  <path d="M110 206 C162 194 216 224 250 248 L250 370 C204 392 152 386 110 362 Z" fill="#fff" opacity=".965"/>
  <path d="M402 206 C350 194 296 224 262 248 L262 370 C308 392 360 386 402 362 Z" fill="#fff" opacity=".965"/>
  {bars}
</svg>
'''
    (ROOT / "frontend" / "public" / "favicon.svg").write_text(svg, encoding="utf-8")


def main() -> None:
    master = draw_mark().resize((TILE, TILE), Image.LANCZOS)
    draw_mark().save(ROOT / "scripts" / "tools" / "icon-master.png")
    master.save(ROOT / "frontend" / "public" / "bookvoice.png")

    # Tiny sizes get the simplified three-bar variant so the mark stays
    # legible at tray/favicon scale; the full mark serves 48px and up.
    ico_images = {}
    simple = draw_mark(simplified=True)
    for n in (256, 128, 64, 48, 32, 24, 16):
        source = simple if n <= 32 else master
        ico_images[n] = source.resize((n, n), Image.LANCZOS)
    ico_kwargs = dict(
        format="ICO",
        sizes=[(n, n) for n in (256, 128, 64, 48, 32, 24, 16)],
        append_images=[ico_images[n] for n in (128, 64, 48, 32, 24, 16)],
    )
    for rel in ["bookvoice.ico", "desktop/BookVoice.App/bookvoice.ico",
                "desktop/BookVoice.App/Assets/bookvoice.ico"]:
        ico_images[256].save(ROOT / rel, **ico_kwargs)
    dist_ico = ROOT / "dist" / "bookvoice.ico"
    if dist_ico.parent.exists():
        ico_images[256].save(dist_ico, **ico_kwargs)
    master.save(ROOT / "desktop" / "BookVoice.App" / "Assets" / "bookvoice.png")
    write_svg()
    print("icon set written")


if __name__ == "__main__":
    main()
