"""Remove background from image using rembg."""
import sys
from PIL import Image
from rembg import remove

def main():
    if len(sys.argv) < 2:
        print("Usage: python remove_bg.py <image_path>")
        sys.exit(1)

    img_path = sys.argv[1]
    img = Image.open(img_path)
    out = remove(img)
    # Always save as PNG (RGBA with transparency), even if source was JPEG
    import os
    base, ext = os.path.splitext(img_path)
    if ext.lower() in ('.jpg', '.jpeg', '.webp'):
        img_path = base + '.png'
    out.save(img_path, 'PNG')
    print(f"OK: {img_path}")

if __name__ == '__main__':
    main()
