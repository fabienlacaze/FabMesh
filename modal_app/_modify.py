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


# Subject-agnostic on purpose (was person-only: 'same character, same outfit,
# same pose, bad anatomy, extra limbs' — mis-steered SDXL on objects/vehicles
# like a catapult). Matches desktop scripts/sdxl_server.py.
PRESERVE_PREFIX = (
    'same subject, same shape, same proportions, same composition, '
    'same colors, preserve the original object identity, only change: '
)
PRESERVE_NEG = (
    'different subject, changed shape, different proportions, '
    'different composition, distorted, blurry, low quality, deformed, '
    'watermark, multiple subjects'
)


def generate(
    base_pipe,                       # StableDiffusionXLControlNetPipeline on CUDA
    source_img: Image.Image,
    prompt: str,
    strength: float = 0.35,
    seed: int = 42,
    steps: int = 30,
    guidance: float = 7.0,
    size: int = 1024,
) -> Image.Image:
    """Run RealVisXL img2img on source_img. strength is the SDXL noising
    amount in [0,1]; 0.35 is the new default for `Modify Image` —
    low enough to preserve the original subject (add/remove details and
    accessories without redrawing the character). Up to ~0.75 for
    aggressive restyling.

    The prompt is auto-prefixed with PRESERVE_PREFIX which tells SDXL
    to keep identity. Without it, even at strength=0.35 the model
    happily drifts to a different face / outfit (observed: orc lost
    helmet + swords + bag with strength=0.55 + "add a helmet").

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
    # Once load_ip_adapter has been called on the parent pipeline, the
    # UNet's config.encoder_hid_dim_type stays 'ip_image_proj' forever
    # — and the img2img pipeline (which doesn't accept ip_adapter_image
    # via the call) crashes with:
    #   "requires the keyword argument `image_embeds` to be passed in
    #    `added_cond_kwargs`"
    # set_ip_adapter_scale(0) zeros the contribution but doesn't undo
    # the config flag. We temporarily detach the projection layer
    # for the duration of this single call.
    unet = base_pipe.unet
    saved_proj = getattr(unet, 'encoder_hid_proj', None)
    saved_type = getattr(unet.config, 'encoder_hid_dim_type', None)
    unet.encoder_hid_proj = None
    unet.config.encoder_hid_dim_type = None
    # Auto-prefix the user prompt with identity-preserving tokens so
    # SDXL doesn't drift to a different subject. Skip the prefix when
    # the user is clearly going for a re-style (strength > 0.6) — at
    # that point they WANT a redraw.
    final_prompt = prompt
    final_neg = ''
    if float(strength) <= 0.6:
        final_prompt = PRESERVE_PREFIX + prompt
        final_neg = PRESERVE_NEG

    try:
        return cached(
            prompt=final_prompt,
            negative_prompt=final_neg,
            image=src,
            strength=float(strength),
            num_inference_steps=int(steps),
            guidance_scale=guidance,
            generator=gen,
        ).images[0]
    finally:
        unet.encoder_hid_proj = saved_proj
        unet.config.encoder_hid_dim_type = saved_type
