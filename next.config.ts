import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // AGENTS.md is edited only on the user's instruction; stop `next dev` from writing to it.
  agentRules: false,
  // Starter projects are read at request time by /projects and the editor (src/ui/starters.server.ts).
  outputFileTracingIncludes: {
    '/projects': ['./content/starters/**/*'],
    '/projects/[id]': ['./content/starters/**/*'],
  },
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
