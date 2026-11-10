import type { NextConfig } from "next";

// Set NEXT_PUBLIC_BASE_PATH (e.g. /hold4me) at build time to serve the app under a sub-path.
const nextConfig: NextConfig = { basePath: process.env.NEXT_PUBLIC_BASE_PATH || "" };

export default nextConfig;
