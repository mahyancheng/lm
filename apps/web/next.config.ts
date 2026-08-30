import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@frontier/contracts",
    "@frontier/shared",
    "@frontier/simulation",
    "@frontier/llm",
  ],
};

export default nextConfig;
