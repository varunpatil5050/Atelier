import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Allow the dev server to be reached through a cloudflared tunnel host when
  // sharing the IDE (Next 15.3+ otherwise blocks cross-origin dev requests).
  allowedDevOrigins: ["*.trycloudflare.com"],
};

export default nextConfig;
