import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const monorepoRoot = path.join(fileURLToPath(new URL(".", import.meta.url)), "../..");

const nextConfig: NextConfig = {
  transpilePackages: ["@gymos/utils"],
  turbopack: {
    root: monorepoRoot,
  },
};

export default nextConfig;
