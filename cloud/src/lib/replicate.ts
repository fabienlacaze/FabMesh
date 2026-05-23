import Replicate from 'replicate';

const TOKEN = process.env.REPLICATE_API_TOKEN!;
const MODEL = process.env.REPLICATE_MODEL ?? 'fishwowater/trellis2';
const VERSION = process.env.REPLICATE_VERSION ?? '';

export const replicate = new Replicate({ auth: TOKEN });

export interface GenerateInput {
  image: Blob | File | string;          // user upload (Blob) or URL
  asset_type: 'character' | 'creature' | 'vehicle' | 'building'
            | 'weapon' | 'prop' | 'environment' | 'icon' | 'custom';
  mode: 'lite' | 'standard' | 'full';
  seed?: number;
  rectify?: boolean;
  back_view?: boolean;
  smooth?: boolean;
  face_fix?: boolean;
  ultra_hd?: boolean;
  /** Premium "Fast" mode: schedule on H100 instead of L40S. */
  fast?: boolean;
}

/**
 * Map our internal asset_type / mode into the actual Replicate model
 * input. Today we either call our own pushed Cog, or fall back to
 * fishwowater/trellis2 if REPLICATE_MODEL points there. Both branches
 * accept different schemas — we adapt below.
 */
export async function createPrediction(input: GenerateInput) {
  const modelSlug = MODEL;
  let version = VERSION;
  if (!version) {
    // Resolve latest version of the model if not pinned.
    const model = await replicate.models.get(modelSlug.split('/')[0], modelSlug.split('/')[1]);
    version = model.latest_version?.id ?? '';
    if (!version) throw new Error(`No version found for ${modelSlug}`);
  }

  const isOurCog = modelSlug.includes('myfabmesh-cloud');

  const payload = isOurCog
    ? {
        image: input.image,
        asset_type: input.asset_type,
        mode: input.mode,
        seed: input.seed ?? 42,
        rectify: input.rectify ?? true,
        back_view: input.back_view ?? (input.asset_type === 'character' || input.asset_type === 'creature'),
        smooth: input.smooth ?? true,
        face_fix: input.face_fix ?? false,
        ultra_hd: input.ultra_hd ?? false,
      }
    : {
        // fishwowater/trellis2 schema (POC fallback)
        image: input.image,
        seed: input.seed ?? 42,
        generate_model: true,
        generate_video: false,
        preprocess_image: true,
        texture_size: input.mode === 'full' ? 2048 : 1024,
        decimation_target: input.mode === 'lite' ? 100_000
                          : input.mode === 'full' ? 1_500_000 : 500_000,
        sparse_structure_steps: input.mode === 'lite' ? 8 : 12,
        shape_slat_steps: input.mode === 'lite' ? 8 : 12,
        tex_slat_steps: input.mode === 'lite' ? 8 : 12,
      };

  // Note: Replicate's `predictions.create()` is async (returns immediately
  // with a "starting" prediction). We poll its `id` from the frontend via
  // /api/jobs/[id] until status = "succeeded" or "failed".
  const prediction = await replicate.predictions.create({
    version,
    input: payload as any,
  });
  return prediction;
}

export async function getPrediction(id: string) {
  return replicate.predictions.get(id);
}

/** Crédit cost for a given mode + flags. */
export function creditCost(input: Pick<GenerateInput, 'mode' | 'fast' | 'ultra_hd' | 'face_fix'>): number {
  let n = input.mode === 'lite' ? 1 : input.mode === 'standard' ? 1 : 2;
  if (input.fast) n += 1;
  if (input.ultra_hd) n += 1;
  if (input.face_fix) n += 1;
  return n;
}
