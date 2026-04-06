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
    out.save(img_path)
    print(f"OK: {img_path}")

if __name__ == '__main__':
    main()
