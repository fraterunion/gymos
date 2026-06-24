import type { NextConfig } from 'next';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const monorepoRoot = path.join(fileURLToPath(new URL('.', import.meta.url)), '../..');

const ADMIN_ORIGIN = 'https://admin.arestrainingclub.com';

const nextConfig: NextConfig = {
  turbopack: {
    root: monorepoRoot,
  },
  async redirects() {
    return [
      {
        source: '/admin',
        destination: ADMIN_ORIGIN,
        permanent: true,
      },
      {
        source: '/admin/:path*',
        destination: `${ADMIN_ORIGIN}/:path*`,
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
