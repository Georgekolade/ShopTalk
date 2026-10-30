import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
      { source: "/api/:path+/", destination: "http://127.0.0.1:8000/api/:path+/" },
      { source: "/api/:path*", destination: "http://127.0.0.1:8000/api/:path*" },
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
