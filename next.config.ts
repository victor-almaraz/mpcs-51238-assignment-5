import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: '/dsl-sandbox.js',
        headers: [
          { key: 'Content-Security-Policy', value: "default-src 'none'; script-src 'self' 'unsafe-eval'" },
        ],
      },
    ];
  },
};

export default nextConfig;
