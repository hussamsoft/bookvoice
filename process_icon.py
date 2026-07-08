import sys
from PIL import Image
import os

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

img_path = sys.argv[1]
input_image = Image.open(img_path)

output_image = remove(input_image)

# Resize appropriately for icon
dist_dir = r"C:\AI Projects\Narrator\dist"
public_dir = r"C:\AI Projects\Narrator\frontend\public"
os.makedirs(dist_dir, exist_ok=True)
os.makedirs(public_dir, exist_ok=True)

output_image.save(os.path.join(dist_dir, "bookvoice.ico"), format="ICO", sizes=[(256, 256), (128, 128), (64, 64), (32, 32)])
output_image.save(os.path.join(public_dir, "bookvoice.png"), format="PNG")
print("Transparent clean icon created.")
