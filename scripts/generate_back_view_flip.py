"""Flip-only back-view generator (no AI inpaint).

Mirrors the front image horizontally and saves it as the "back" photo.
The result still shows the subject's face (just side-flipped), but the
silhouette + outfit + colors are pixel-identical to the front. That's
strictly better than what an AI inpainter does on a creature/animal/
object, where the inpaint step hallucinates costumes / wrong anatomy
("white spandex suit on a monkey", etc.).

For TRELLIS-2 multi-ref, the back image is mainly used to:
  - anchor dorsal colors / patterns
  - complement the front silhouette
Both are satisfied by a horizontal flip. The visible face on the back
just means TRELLIS-2 gets the same face information from two angles,
which doesn't hurt the bake quality (it's still a single subject).

CLI (identical to generate_back_view.py contract):
    python generate_back_view_flip.py <front> <out_dir> [prompt_hint]
                                       [num_images] [name_suffix]
"""
import os
import sys
from PIL import Image


def log(msg):
    print(f'[back-flip] {msg}', flush=True)


def main():
    if len(sys.argv) < 3:
        print('Usage: generate_back_view_flip.py <front_image> '
              '<output_dir> [prompt_hint] [num_images] [name_suffix]')
        sys.exit(1)
    front_image = os.path.abspath(sys.argv[1])
    output_dir = os.path.abspath(sys.argv[2])
    # prompt_hint accepted for CLI compat, ignored (no AI here).
    _prompt_hint = sys.argv[3] if len(sys.argv) > 3 else ''
    num_images = int(sys.argv[4]) if len(sys.argv) > 4 else 1
    name_suffix = sys.argv[5] if len(sys.argv) > 5 else os.path.splitext(
        os.path.basename(front_image))[0]

    if not os.path.isfile(front_image):
        log(f'ERROR: front image not found: {front_image}')
        sys.exit(2)

    os.makedirs(output_dir, exist_ok=True)
    log(f'front={front_image}')
    log(f'out_dir={output_dir}  stem={name_suffix}  n={num_images}')

    img = Image.open(front_image)
    flipped = img.transpose(Image.FLIP_LEFT_RIGHT)

    for i in range(num_images):
        out_path = os.path.join(output_dir, f'back_{name_suffix}_{i}.png')
        flipped.save(out_path)
        log(f'wrote {out_path}')
        print(f'BACK_VIEW_PATH: {out_path}', flush=True)

    log('done (horizontal flip, no AI)')


if __name__ == '__main__':
    main()
