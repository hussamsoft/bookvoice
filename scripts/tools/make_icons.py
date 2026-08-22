import sys
from pathlib import Path

from PIL import Image

if len(sys.argv) != 2:
    print("Usage: python make_icons.py <source_image>")
    sys.exit(1)

img = Image.open(sys.argv[1])

# Convert to RGBA and make background transparent (optional, but let's just keep the nice background for the icon)
img = img.convert("RGBA")

root = Path(__file__).resolve().parents[2]
frontend_public_dir = root / "frontend" / "public"
dist_dir = root / "dist"

frontend_public_dir.mkdir(parents=True, exist_ok=True)
dist_dir.mkdir(parents=True, exist_ok=True)

# Save PNG for web
img.save(frontend_public_dir / "bookvoice.png", format="PNG")

# Save ICO for Pyinstaller
img.save(dist_dir / "bookvoice.ico", format="ICO", sizes=[(256, 256), (128, 128), (64, 64), (32, 32)])

print("Icons successfully created.")
