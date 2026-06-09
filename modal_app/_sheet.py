"""4-view orthographic model-sheet generator — cloud version.

Verbatim port of `scripts/multiview_sheet_gen.py` (called by
`scripts/generate_back_view_sheet.py` on the desktop). Single SDXL pass
with IPAdapter Plus produces a consistent 2x2 grid:
  view_0 = front  | view_1 = right
  view_2 = back   | view_3 = left

ATTENTION — the desktop layout is (front, right, back, left) read
left-to-right top-to-bottom. So view_1 (top-right cell) is the RIGHT
profile and view_2 (bottom-left cell) is the BACK. We follow the desktop
slot ordering verbatim.

For hard-surface asset types (vehicle/building/weapon/prop) the
2x2 sheet path produces a back-view consistent with the front (same
identity / paint / wear), whereas a single back generation tends to
drift. The desktop dispatches sheet for these types in main.js:4806.

The cloud endpoint returns only the BACK view (view_2) — multi-view
texture refine isn't yet implemented cloud-side, so the other 2 views
would be unused. A future Wave can expand the return shape to expose
all 4 if a multi-view texture step is added.
"""
import os
from PIL import Image
import torch


# Verbatim layout from multiview_sheet_gen.py:42-61 (4-view branch).
# We keep the desktop's exact slot ordering — front, right, back, left
# read left-to-right top-to-bottom — so the prompt and view_N index
# semantics match the desktop output 1:1.
LAYOUT_4 = (2, 2, 1024, [
    ('front', 'strict front view, facing camera directly'),
    ('right', 'strict right side profile, 90 degrees'),
    ('back',  'strict back view, 180 degrees, no face visible'),
    ('left',  'strict left side profile, 270 degrees'),
])


NEG_PROMPT = (
    'perspective, foreshortening, three-quarter view, asymmetric, '
    'cropped, missing limbs, deformed, blurry, low quality, '
    'multiple characters per cell, different characters, text, '
    'watermark, signature, frame, border'
)


def _build_prompt(subject_hint: str, layout=LAYOUT_4) -> str:
    """Verbatim port of multiview_sheet_gen.py:build_prompt."""
    cols, rows, _, slots = layout
    base = (subject_hint or '').strip() or 'subject'
    grid_label = f'{cols}x{rows}' if rows > 1 else f'{cols} views'
    parts = [
        f'{len(slots)}-view orthographic model sheet of {base}',
        f'{grid_label} grid layout, equal cells',
        'STRICT ORTHOGRAPHIC projection, no perspective, no foreshortening',
        'neutral stance, full subject visible in each cell',
        'consistent identical subject across all cells, same lighting',
        'plain white background, even studio lighting, no shadows',
        'symmetric grid, perfectly aligned, centered subject in each cell',
        'ultra detailed, sharp focus, 8k, photorealistic',
    ]
    cell_lines = []
    for i, (_label, orient) in enumerate(slots):
        col = i % cols
        row = i // cols
        pos_v = 'top' if row == 0 else ('middle' if row < rows - 1 else 'bottom')
        if rows == 1:
            pos_v = 'middle'
        pos_h = 'left' if col == 0 else ('right' if col == cols - 1 else 'middle')
        cell_lines.append(f'{pos_v}-{pos_h} cell: {orient}')
    parts += cell_lines
    return ', '.join(parts)


def _split_sheet(sheet_img: Image.Image, layout=LAYOUT_4) -> dict:
    """Verbatim port of multiview_sheet_gen.py:split_sheet, returning
    a dict {label: PIL.Image} instead of writing files."""
    cols, rows, _cell_size, slots = layout
    sheet_w, sheet_h = sheet_img.size
    cell_w = sheet_w // cols
    cell_h = sheet_h // rows
    out = {}
    for i, (label, _) in enumerate(slots):
        col = i % cols
        row = i // cols
        box = (col * cell_w, row * cell_h,
               (col + 1) * cell_w, (row + 1) * cell_h)
        out[label] = sheet_img.crop(box)
    return out


def generate(
    pipe,                            # StableDiffusionXLControlNetPipeline on CUDA (back-view class)
    front_img: Image.Image,
    prompt_hint: str = '',
    ip_scale: float = 0.6,
    seed: int = 424242,
    steps: int = 30,
    guidance: float = 7.0,
) -> dict:
    """Run RealVisXL + IPAdapter to produce a 2x2 grid of orthographic
    views from the front image, split into 4 PIL images. Returns
    {'front': Img, 'right': Img, 'back': Img, 'left': Img}.

    Reuses the MyFabmeshBackview's ControlNet pipeline. ControlNet is
    NEUTRALIZED via blank image + cn_scale=0 (same trick as _rectify.py).
    IPAdapter is the load-bearing piece — without it, SDXL prompt-only
    invents a generic character unrelated to the user's front image. The
    desktop's ip_scale=0.6 is the default; can be overridden via env on
    Modal but we don't expose it in the API yet.
    """
    layout = LAYOUT_4
    cols, rows, cell_size, _ = layout
    sheet_w = cols * cell_size
    sheet_h = rows * cell_size

    # Same ControlNet-neutralization trick as _rectify.py: feed a black
    # image with cn_scale=0 so the conv branch runs but its residuals
    # are zeroed — diffusion is effectively pure SDXL + IPAdapter.
    blank_skel = Image.new('RGB', (sheet_w, sheet_h), (0, 0, 0))

    try:
        pipe.set_ip_adapter_scale(ip_scale)
    except Exception:
        pass

    prompt = _build_prompt(prompt_hint, layout)
    gen = torch.Generator('cuda').manual_seed(int(seed))
    base_kwargs = dict(
        image=blank_skel,
        controlnet_conditioning_scale=0.0,
        ip_adapter_image=front_img,
        width=sheet_w,
        height=sheet_h,
        num_inference_steps=int(steps),
        guidance_scale=guidance,
        generator=gen,
    )
    # Compel bypasses SDXL's 77-token CLIP-L cap (workflow woydvj5w6).
    # _sheet.py is WORST CASE: POS=149-158 tokens — cell mapping hints
    # (top-left=front, top-right=right, bottom-left=back, bottom-right
    # =left) all live past pos 77 and are INVISIBLE to vanilla SDXL,
    # which collapses the 2x2 sheet to 4 near-front views. Falls back
    # to vanilla pipe() if Compel is unavailable — never blocks gen.
    try:
        from modal_app._sdxl_prompt_utils import encode_sdxl_long_prompt
        embeds = encode_sdxl_long_prompt(pipe, prompt, NEG_PROMPT)
        sheet = pipe(**embeds, **base_kwargs).images[0]
    except Exception as _ce:
        print(f"[_sheet] Compel fallback ({_ce}); cell hints will be "
              f"truncated past pos 77", flush=True)
        sheet = pipe(
            prompt=prompt, negative_prompt=NEG_PROMPT, **base_kwargs
        ).images[0]
    return _split_sheet(sheet, layout)
