// Third-Party Licenses — attribution notice for the bundled models / libraries.
// Content mirrors THIRD_PARTY_LICENSES.txt at the repo root. The DINOv3 /
// Apache attribution links in the app point here (/legal/licenses).

export const metadata = {
  title: 'Third-Party Licenses — MyFabmesh.AI',
  description:
    'Attributions and licenses for the third-party models and libraries used by MyFabmesh.AI.',
};

// Each entry: the component, its license, and the canonical license URL.
const COMPONENTS: {
  name: string;
  license: string;
  url: string;
  note?: string;
}[] = [
  { name: 'Electron', license: 'MIT', url: 'https://github.com/electron/electron/blob/main/LICENSE' },
  { name: 'three.js', license: 'MIT', url: 'https://github.com/mrdoob/three.js/blob/dev/LICENSE' },
  { name: 'PyTorch', license: 'BSD-3-Clause', url: 'https://github.com/pytorch/pytorch/blob/main/LICENSE' },
  { name: 'Hugging Face Diffusers', license: 'Apache-2.0', url: 'https://github.com/huggingface/diffusers/blob/main/LICENSE' },
  { name: 'Hugging Face Transformers', license: 'Apache-2.0', url: 'https://github.com/huggingface/transformers/blob/main/LICENSE' },
  { name: 'trimesh', license: 'MIT', url: 'https://github.com/mikedh/trimesh/blob/main/LICENSE.md' },
  { name: 'pygltflib', license: 'MIT', url: 'https://gitlab.com/dodgyville/pygltflib/-/blob/main/LICENSE' },
  { name: 'UniRig', license: 'MIT', url: 'https://github.com/VAST-AI-Research/UniRig/blob/main/LICENSE' },
  { name: 'TripoSR', license: 'MIT', url: 'https://github.com/VAST-AI-Research/TripoSR/blob/main/LICENSE' },
  {
    name: 'Stable Diffusion XL (SDXL base 1.0)',
    license: 'CreativeML Open RAIL++-M',
    url: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md',
    note: 'Model weights are downloaded on first run, not redistributed. Commercial use permitted subject to the use-based restrictions in the license.',
  },
  {
    name: 'RealVis XL V4.0',
    license: 'CreativeML Open RAIL++-M',
    url: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md',
    note: 'Community photorealistic fine-tune of SDXL. Weights downloaded on first run, not redistributed.',
  },
  {
    name: 'Hi3DGen',
    license: 'MIT',
    url: 'https://github.com/Stable-X/Hi3DGen/blob/main/LICENSE',
    note: 'Companion model weights (trellis-normal-v0-1, yoso-normal-v1-8-1) downloaded at runtime under their MIT / Apache-2.0 licenses.',
  },
  {
    name: 'TRELLIS-2-4B',
    license: 'MIT',
    url: 'https://github.com/microsoft/TRELLIS/blob/main/LICENSE',
    note: 'Microsoft TRELLIS-2-4B for native 3D PBR texturing. Internally depends on the DINOv3 feature extractor (see below).',
  },
  {
    name: 'Stable Fast 3D (SF3D)',
    license: 'Stability AI Community License',
    url: 'https://huggingface.co/stabilityai/stable-fast-3d/blob/main/LICENSE.md',
    note: 'Commercial use free up to USD 1,000,000 annual revenue; above that an Enterprise License from Stability AI is required.',
  },
  { name: 'BiRefNet', license: 'MIT', url: 'https://github.com/ZhengPeng7/BiRefNet/blob/main/LICENSE.md' },
  { name: 'MV-Adapter (i2mv-sdxl)', license: 'Apache-2.0', url: 'https://github.com/huanngzh/MV-Adapter/blob/main/LICENSE' },
  { name: 'CRM (Convolutional Reconstruction Model)', license: 'MIT', url: 'https://github.com/thu-ml/CRM/blob/main/LICENSE' },
  {
    name: 'DINOv3',
    license: 'DINOv3 License (Meta Platforms)',
    url: 'https://ai.meta.com/resources/models-and-libraries/dinov3-license/',
    note: 'Used by TRELLIS-2-4B as its image-feature backbone. The license requires prominent "Built with DINOv3" attribution, which MyFabmesh.AI provides here and in the application.',
  },
  { name: 'IP-Adapter', license: 'Apache-2.0', url: 'https://github.com/tencent-ailab/IP-Adapter/blob/main/LICENSE' },
  {
    name: 'ControlNet (OpenPose & Tile variants by xinsir)',
    license: 'Apache-2.0',
    url: 'https://huggingface.co/xinsir/controlnet-openpose-sdxl-1.0',
    note: 'Pose-guided generation and tile refinement conditioning models.',
  },
  { name: 'flash_attn', license: 'BSD-3-Clause', url: 'https://github.com/Dao-AILab/flash-attention/blob/main/LICENSE' },
  { name: 'kornia', license: 'Apache-2.0', url: 'https://github.com/kornia/kornia/blob/main/LICENSE' },
  { name: 'spconv (sparse convolution)', license: 'Apache-2.0', url: 'https://github.com/traveller59/spconv/blob/master/LICENSE' },
  { name: 'xatlas', license: 'MIT', url: 'https://github.com/jpcy/xatlas' },
  {
    name: 'Kaolin (kaolin.render.mesh.rasterize)',
    license: 'Apache-2.0',
    url: 'https://github.com/NVIDIAGameWorks/kaolin/blob/master/LICENSE',
    note: 'Only the Apache-2.0 CUDA rasterizer is used; the kaolin.non_commercial namespace is NOT imported.',
  },
  { name: 'fast_simplification', license: 'MIT', url: 'https://github.com/pyvista/fast-simplification' },
  { name: 'NumPy', license: 'BSD-3-Clause', url: 'https://github.com/numpy/numpy/blob/main/LICENSE.txt' },
  { name: 'SciPy', license: 'BSD-3-Clause', url: 'https://github.com/scipy/scipy/blob/main/LICENSE.txt' },
  { name: 'Pillow (PIL)', license: 'HPND', url: 'https://github.com/python-pillow/Pillow/blob/main/LICENSE' },
  { name: 'rembg', license: 'MIT', url: 'https://github.com/danielgatis/rembg/blob/main/LICENSE.txt' },
  {
    name: 'Blender (external dependency — not bundled)',
    license: 'GPL-3.0',
    url: 'https://www.blender.org/about/license/',
    note: 'Invoked as an external subprocess; not bundled or linked, so the GPL does not propagate to MyFabmesh.AI. Install separately from blender.org.',
  },
];

export default function LicensesPage() {
  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '32px 24px', lineHeight: 1.65 }}>
      <h1>Third-Party Licenses</h1>
      <p style={{ color: 'var(--text-2)' }}>Last updated: 2026-06-16</p>

      <p>
        MyFabmesh.AI is built on third-party open-source software and AI model
        weights. Each component below is distributed under its own license; the
        full license text is available at the linked URL. This page is provided
        to satisfy the attribution requirements of those licenses.
      </p>

      <p>
        MyFabmesh.AI redistributes <strong>no</strong> third-party 3D assets,
        character models, skeletons, animations, or textures. All bundled rig
        templates are CC0, authored by the FabMesh team — you may use, modify
        and redistribute them without restriction.
      </p>

      <p style={{ color: 'var(--text-2)' }}>
        <strong>Built with DINOv3</strong> (Meta Platforms) — see the DINOv3
        entry below.
      </p>

      <h2>Bundled models &amp; libraries</h2>
      <ul>
        {COMPONENTS.map((c) => (
          <li key={c.name} style={{ marginBottom: 10 }}>
            <strong>{c.name}</strong> — {c.license} —{' '}
            <a href={c.url} target="_blank" rel="noopener noreferrer">
              license text
            </a>
            {c.note ? (
              <div style={{ color: 'var(--text-2)', fontSize: 14 }}>{c.note}</div>
            ) : null}
          </li>
        ))}
      </ul>

      <p style={{ marginTop: 32, fontSize: 13 }}>
        <a href="/legal/terms">Terms of Service</a> &middot;{' '}
        <a href="/legal/privacy">Privacy Policy</a> &middot;{' '}
        <a href="/">Home</a>
      </p>
    </main>
  );
}
