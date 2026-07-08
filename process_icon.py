from PIL import Image, ImageDraw

def add_rounded_corners(im, rad):
    circle = Image.new('L', (rad * 2, rad * 2), 0)
    draw = ImageDraw.Draw(circle)
    draw.ellipse((0, 0, rad * 2 - 1, rad * 2 - 1), fill=255)
    alpha = Image.new('L', im.size, 255)
    w, h = im.size
    alpha.paste(circle.crop((0, 0, rad, rad)), (0, 0))
    alpha.paste(circle.crop((0, rad, rad, rad * 2)), (0, h - rad))
    alpha.paste(circle.crop((rad, 0, rad * 2, rad)), (w - rad, 0))
    alpha.paste(circle.crop((rad, rad, rad * 2, rad * 2)), (w - rad, h - rad))
    im.putalpha(alpha)
    return im

img_path = r"C:\Users\hussa\.gemini\antigravity-cli\brain\acae6e66-b22f-40f9-86bb-8abbf27be21c\bookvoice_icon_1783522138888.jpg"
img = Image.open(img_path).convert("RGBA")

# Make it a rounded rectangle
radius = 200 # Since it's likely 1024x1024
img = add_rounded_corners(img, radius)

dist_dir = r"C:\AI Projects\Narrator\dist"
public_dir = r"C:\AI Projects\Narrator\frontend\public"
import os
os.makedirs(dist_dir, exist_ok=True)
os.makedirs(public_dir, exist_ok=True)

img.save(os.path.join(dist_dir, "bookvoice.ico"), format="ICO", sizes=[(256, 256), (128, 128), (64, 64), (32, 32)])
img.save(os.path.join(public_dir, "bookvoice.png"), format="PNG")
print("Rounded transparent icon created.")
