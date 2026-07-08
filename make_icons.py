from PIL import Image
import os

img_path = r"C:\Users\hussa\.gemini\antigravity-cli\brain\acae6e66-b22f-40f9-86bb-8abbf27be21c\bookvoice_icon_1783522138888.jpg"
img = Image.open(img_path)

# Convert to RGBA and make background transparent (optional, but let's just keep the nice background for the icon)
img = img.convert("RGBA")

frontend_public_dir = r"C:\AI Projects\Narrator\frontend\public"
dist_dir = r"C:\AI Projects\Narrator\dist"

os.makedirs(frontend_public_dir, exist_ok=True)

# Save PNG for web
img.save(os.path.join(frontend_public_dir, "bookvoice.png"), format="PNG")

# Save ICO for Pyinstaller
img.save(os.path.join(dist_dir, "bookvoice.ico"), format="ICO", sizes=[(256, 256), (128, 128), (64, 64), (32, 32)])

print("Icons successfully created.")
