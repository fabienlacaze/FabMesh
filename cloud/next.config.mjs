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
};
export default nextConfig;
