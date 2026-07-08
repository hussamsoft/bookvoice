"""
make_icon.py  -  build bookvoice.ico + frontend/public/bookvoice.png from a source image.
Usage:  python make_icon.py <source_image_path>
"""
import sys
import os
from PIL import Image

SRC = sys.argv[1] if len(sys.argv) > 1 else None
if not SRC or not os.path.exists(SRC):
    print("Usage: python make_icon.py <source_image>"); sys.exit(1)

# ---- Try rembg for background removal ----
def remove_bg(img):
    try:
        from rembg import remove as _rm
        return _rm(img)
    except Exception:
        return img.convert("RGBA")

img = Image.open(SRC).convert("RGBA")

# Remove background if not already transparent
if img.split()[3].getextrema()[0] == 255:  # fully opaque → try rembg
    print("Removing background...")
    img = remove_bg(img)

# Crop tight to content
bb = img.getbbox()
if bb:
    img = img.crop(bb)

# Add 8% padding around content (keeps icon looking sharp at small sizes)
w, h = img.size
pad = int(max(w, h) * 0.08)
size = max(w, h) + pad * 2
canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
offset_x = (size - w) // 2
offset_y = (size - h) // 2
canvas.paste(img, (offset_x, offset_y), img)

# ---- Output paths ----
ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, "frontend", "public")
os.makedirs(PUBLIC, exist_ok=True)

# Save PNG for frontend (1024x1024)
png = canvas.resize((1024, 1024), Image.LANCZOS)
png.save(os.path.join(PUBLIC, "bookvoice.png"), format="PNG")

# Save ICO with proper multi-size layers
ico_path = os.path.join(ROOT, "bookvoice.ico")
sizes = [256, 128, 64, 48, 32, 16]
ico_frames = [canvas.resize((s, s), Image.LANCZOS) for s in sizes]
ico_frames[0].save(
    ico_path,
    format="ICO",
    append_images=ico_frames[1:],
    sizes=[(s, s) for s in sizes],
)

print(f"✓ ICO saved to {ico_path}")
print(f"✓ PNG saved to {os.path.join(PUBLIC, 'bookvoice.png')}")
