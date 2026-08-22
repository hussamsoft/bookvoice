import sys
from pathlib import Path

from PIL import Image

try:
    from rembg import remove
except ImportError:
    # Fallback to simple color replacement if rembg fails
    def remove(img):
        img = img.convert("RGBA")
        datas = img.getdata()
        new_data = []
        for item in datas:
            # The background is mostly #14110f (20, 17, 15)
            if item[0] < 30 and item[1] < 30 and item[2] < 30:
                new_data.append((255, 255, 255, 0))
            else:
                new_data.append(item)
        img.putdata(new_data)
        return img

if len(sys.argv) != 2:
    print("Usage: python process_icon.py <source_image>")
    sys.exit(1)

input_image = Image.open(sys.argv[1])

output_image = remove(input_image)

root = Path(__file__).resolve().parents[2]
dist_dir = root / "dist"
public_dir = root / "frontend" / "public"
dist_dir.mkdir(parents=True, exist_ok=True)
public_dir.mkdir(parents=True, exist_ok=True)

output_image.save(dist_dir / "bookvoice.ico", format="ICO", sizes=[(256, 256), (128, 128), (64, 64), (32, 32)])
output_image.save(public_dir / "bookvoice.png", format="PNG")
print("Transparent clean icon created.")
