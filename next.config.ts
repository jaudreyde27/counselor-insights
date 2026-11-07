import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces a small self-contained server, which is what the Docker image
  // will run when we deploy (Phase 3).
  output: "standalone",
  poweredByHeader: false,
  // Files the app reads at run time by path. Without this the standalone (Docker)
  // build would leave them out. (The fictional fixtures are not needed in a deployed image.)
  outputFileTracingIncludes: {
    "/**": ["./config/**/*", "./prompts/**/*"],
  },
};

export default nextConfig;
