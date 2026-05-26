"""SDXL img2img — cloud version.

Direct port of the desktop's persistent SDXL server `/img2img` endpoint
(triggered by ipcMain handler `img2img` in src/main/main.js:2874-2904).

Takes an input image + a text prompt + a denoising strength and returns
a "modified" version of the image where the AI re-paints according to
the prompt while preserving overall layout.

Same model as desktop : SG161222/RealVisXL_V4.0. We reuse the weights
already loaded by MyFabmeshBackview's StableDiffusionXLControlNetPipeline
by constructing a StableDiffusionXLImg2ImgPipeline `from_pipe` — that
shares the unet/vae/text_encoders so we don't pay a second snapshot.
"""
from PIL import Image
import torch


def generate(
    base_pipe,                       # StableDiffusionXLControlNetPipeline on CUDA
    source_img: Image.Image,
    prompt: str,
    strength: float = 0.55,
    seed: int = 42,
    steps: int = 30,
    guidance: float = 7.0,
    size: int = 1024,
) -> Image.Image:
    """Run RealVisXL img2img on source_img. strength is the SDXL noising
    amount in [0,1]; 0.55 matches the desktop default for `Modify Image`
    (just enough denoising to obey the prompt without losing the layout).

    We construct the img2img pipeline lazily and CACHE it on the base
    pipe to avoid rebuilding `from_pipe()` on every call (it's fast
    but pointless to repeat).
    """
    from diffusers import StableDiffusionXLImg2ImgPipeline

    cached = getattr(base_pipe, '_img2img_cached', None)
    if cached is None:
        cached = StableDiffusionXLImg2ImgPipeline(
            vae=base_pipe.vae,
            text_encoder=base_pipe.text_encoder,
            text_encoder_2=base_pipe.text_encoder_2,
            tokenizer=base_pipe.tokenizer,
            tokenizer_2=base_pipe.tokenizer_2,
            unet=base_pipe.unet,
            scheduler=base_pipe.scheduler,
        )
        # Inherit the same dtype/device as the parent pipe — no .to('cuda')
        # because all components are already on the GPU.
        base_pipe._img2img_cached = cached

    # Resize the source to SDXL native — img2img copies the layout 1:1 so
    # the output res matches the input res. We force 1024 for consistency
    # with text2image / back-view / tpose outputs.
    src = source_img.convert('RGB').resize((size, size), Image.LANCZOS)

    # IPAdapter is loaded into shared text_encoder/unet — explicitly
    # disable for img2img (otherwise the IPAdapter image from a previous
    # back_view/tpose call would bleed in).
    try:
        base_pipe.set_ip_adapter_scale(0.0)
    except Exception:
        pass

    gen = torch.Generator('cuda').manual_seed(int(seed))
    return cached(
        prompt=prompt,
        image=src,
        strength=float(strength),
        num_inference_steps=int(steps),
        guidance_scale=guidance,
        generator=gen,
    ).images[0]
