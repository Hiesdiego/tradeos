import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    "4987-197-211-52-78.ngrok-free.app",
    "53fd-197-211-52-78.ngrok-free.app",
  ],
  pageExtensions: ["ts", "tsx"],
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
