/** @type {import('next').NextConfig} */
//
// Static export config — Next.js produces `./out/` which the Cloudflare
// Worker (src/worker.ts) serves via env.ASSETS.fetch(). All `/api/*` routes
// have moved into the Worker, so we no longer need server runtime.
//
const nextConfig = {
  reactStrictMode: true,
  output: 'export',
  images: {
    unoptimized: true,                       // required for `output: 'export'`
    remotePatterns: [
      { protocol: 'https', hostname: 'replicate.delivery' },
      { protocol: 'https', hostname: 'pub-*.r2.dev' },
    ],
  },
  // No rewrites() — static export doesn't support them. The desktop renderer
  // under public/app/ is served as-is by env.ASSETS; the URL /app/ resolves
  // to /app/index.html via the Worker assets handler automatically.
  experimental: {
    serverActions: { bodySizeLimit: '20mb' },
  },
};
export default nextConfig;
