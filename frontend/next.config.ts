import type { NextConfig } from "next";

// Server-side only: where this Next.js server reaches the Django API.
// Browser calls stay same-origin (/api/*) and are rewritten below.
// Local dev: http://127.0.0.1:8000. Docker/Coolify: http://backend:8000.
const backendInternalUrl =
  process.env.BACKEND_INTERNAL_URL ?? "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the production Docker image.
  output: "standalone",
  allowedDevOrigins: ["127.0.0.1", "localhost", "curly-framing-pennant.ngrok-free.dev"],
  // Django owns trailing slashes (/api/auth/token/). Next.js must not 308
  // them away or login POSTs ping-pong between the two servers and die.
  skipTrailingSlashRedirect: true,
  async rewrites() {
    // Phone testing over one ngrok tunnel: the browser calls same-origin
    // /api/* and Next.js forwards to the local backend. No CORS involved.
    // Slashed URLs must stay slashed or Django 301s them back in a loop,
    // so the trailing-slash rule runs first.
    return [
      { source: "/api/:path+/", destination: `${backendInternalUrl}/api/:path+/` },
      { source: "/api/:path*", destination: `${backendInternalUrl}/api/:path*` },
    ];
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
