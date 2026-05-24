// OpenNext config for Cloudflare Workers deployment.
//
// https://opennext.js.org/cloudflare
//
// Used by `npx @opennextjs/cloudflare build` during Cloudflare Pages /
// Workers build. Produces .open-next/ folder that wrangler.toml's
// main = ".open-next/worker.js" points to.
//
// Defaults are fine for our app — no incremental cache (we'd need R2 KV
// for that, can add later), no image optimization on Cloudflare (Next
// images are served from R2/Replicate origins directly).

import { defineCloudflareConfig } from '@opennextjs/cloudflare';

export default defineCloudflareConfig({
  // Use the default in-memory cache. For prod scale, wire R2/KV here.
  // incrementalCache: r2IncrementalCache,
});
