"""
FabMesh Local Inpainting Bridge
Auto-segments target area with CLIPSeg + inpaints with SDXL Inpainting.

Usage: python local_inpaint_bridge.py <input_image> <target_text> <prompt> <output_image> [dilate]

- target_text: what to segment (e.g. "hat", "background", "shirt")
- prompt: what to replace it with (e.g. "hair", "white background", "red shirt")
  - Use "background" or "empty" to remove the element
- dilate: mask dilation in pixels (default 15, higher = more context for seamless blending)
"""
import sys
import os
import torch
import numpy as np
from PIL import Image, ImageFilter


def auto_inpaint(input_path, target_text, prompt, output_path, dilate=15):
    from transformers import CLIPSegForImageSegmentation, CLIPSegProcessor
    from diffusers import StableDiffusionXLInpaintPipeline

    # Step 1: CLIPSeg - segment the target area
    print("INPAINT: Loading CLIPSeg...", flush=True)
    seg_processor = CLIPSegProcessor.from_pretrained("CIDAS/clipseg-rd64-refined")
    seg_model = CLIPSegForImageSegmentation.from_pretrained("CIDAS/clipseg-rd64-refined")
    seg_model.to("cuda")
    seg_model.eval()

    img = Image.open(input_path).convert("RGB")
    orig_w, orig_h = img.size

    # Work at 1024 max to keep VRAM reasonable
    max_dim = 1024
    if max(orig_w, orig_h) > max_dim:
        if orig_w > orig_h:
            work_w, work_h = max_dim, int(orig_h * max_dim / orig_w)
        else:
            work_h, work_w = max_dim, int(orig_w * max_dim / orig_h)
    else:
        work_w, work_h = orig_w, orig_h
    work_w = (work_w // 8) * 8
    work_h = (work_h // 8) * 8
    img_work = img.resize((work_w, work_h), Image.LANCZOS)

    print(f"INPAINT: Segmenting '{target_text}'...", flush=True)
    inputs = seg_processor(text=[target_text], images=[img_work], padding=True, return_tensors="pt")
    inputs = {k: v.to("cuda") for k, v in inputs.items()}
    with torch.no_grad():
        seg_out = seg_model(**inputs)
    # Get mask, normalize to 0-1
    mask = torch.sigmoid(seg_out.logits).squeeze().cpu().numpy()
    # Resize mask to work image size
    mask_img = Image.fromarray((mask * 255).astype(np.uint8)).resize((work_w, work_h), Image.BILINEAR)

    # Threshold: pixels > 50% probability are the mask
    mask_arr = np.array(mask_img)
    binary = (mask_arr > 100).astype(np.uint8) * 255
    mask_binary = Image.fromarray(binary, mode="L")

    # Dilate the mask to include some surrounding context
    if dilate > 0:
        mask_binary = mask_binary.filter(ImageFilter.MaxFilter(dilate * 2 + 1))
    # Smooth edges
    mask_binary = mask_binary.filter(ImageFilter.GaussianBlur(3))

    mask_coverage = (np.array(mask_binary) > 128).mean() * 100
    print(f"INPAINT: Mask covers {mask_coverage:.1f}% of image", flush=True)

    if mask_coverage < 0.5:
        print("INPAINT_ERROR: Mask empty - target not found in image", flush=True)
        sys.exit(1)

    # Save mask in .debug/ subfolder so it doesn't clutter the gallery
    debug_dir = os.path.join(os.path.dirname(output_path), ".debug")
    os.makedirs(debug_dir, exist_ok=True)
    debug_name = os.path.basename(output_path).replace(".png", "_mask.png").replace(".jpg", "_mask.png")
    debug_mask = os.path.join(debug_dir, debug_name)
    mask_binary.save(debug_mask)
    print(f"INPAINT: Debug mask saved to {debug_mask}", flush=True)

    # Free CLIPSeg before loading inpaint
    del seg_model, seg_processor
    torch.cuda.empty_cache()

    # Step 2: SDXL Inpainting
    print("INPAINT: Loading SDXL Inpainting...", flush=True)
    pipe = StableDiffusionXLInpaintPipeline.from_pretrained(
        "diffusers/stable-diffusion-xl-1.0-inpainting-0.1",
        torch_dtype=torch.float16,
        variant="fp16",
    )
    pipe.to("cuda")
    pipe.enable_attention_slicing()
    pipe.enable_vae_tiling()
    print(f"INPAINT: Model loaded ({torch.cuda.memory_allocated()/1024**3:.1f} GB)", flush=True)

    # Detect "remove" intent
    inpaint_prompt = prompt.strip()
    is_removal = inpaint_prompt.lower() in ("", "remove", "delete", "none", "nothing", "empty", "gone")

    if is_removal:
        # For removal: describe the surrounding context explicitly
        # + strong negative prompt targeting the removed object
        inpaint_prompt = f"continuation of the surrounding area, same background, nothing here, seamless"
        negative_prompt = f"{target_text}, any object, duplicate, artifact, blurry, distorted"
        print(f"INPAINT: Removal mode - negative='{target_text}'", flush=True)
    else:
        negative_prompt = f"blurry, distorted, duplicate, {target_text}"
        print(f"INPAINT: Replace mode - prompt='{inpaint_prompt}'", flush=True)

    result = pipe(
        prompt=inpaint_prompt,
        negative_prompt=negative_prompt,
        image=img_work,
        mask_image=mask_binary,
        num_inference_steps=40,
        guidance_scale=8.5,
        strength=0.99,
        height=work_h,
        width=work_w,
    ).images[0]

    # Resize back to original if needed
    if (work_w, work_h) != (orig_w, orig_h):
        result = result.resize((orig_w, orig_h), Image.LANCZOS)

    result.save(output_path)

    # Free GPU/RAM
    del pipe, result, mask_binary, img_work
    torch.cuda.empty_cache()
    import gc
    gc.collect()
    torch.cuda.empty_cache()

    print(f"INPAINT_SUCCESS: {os.path.getsize(output_path)} bytes", flush=True)
    return True


if __name__ == "__main__":
    if len(sys.argv) < 5:
        print("Usage: python local_inpaint_bridge.py <input> <target_text> <prompt> <output> [dilate]")
        sys.exit(1)

    input_path = sys.argv[1]
    target_text = sys.argv[2]
    prompt = sys.argv[3]
    output_path = sys.argv[4]
    dilate = int(sys.argv[5]) if len(sys.argv) > 5 else 15

    try:
        auto_inpaint(input_path, target_text, prompt, output_path, dilate)
        sys.exit(0)
    except Exception as e:
        print(f"INPAINT_ERROR: {type(e).__name__}: {e}", flush=True)
        import traceback
        traceback.print_exc()
        sys.exit(1)
