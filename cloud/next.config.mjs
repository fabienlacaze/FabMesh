/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'replicate.delivery' },
      { protocol: 'https', hostname: 'pub-*.r2.dev' },
    ],
  },
  experimental: {
    serverActions: { bodySizeLimit: '20mb' },
  },
  // The desktop renderer is served from public/app/. Map both /app
  // and /app/ to /app/index.html so URLs feel natural.
  async rewrites() {
    return [
      { source: '/app',  destination: '/app/index.html' },
      { source: '/app/', destination: '/app/index.html' },
    ];
  },
};
export default nextConfig;
