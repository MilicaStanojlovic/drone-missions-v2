import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces `.next/standalone` — a self-contained server bundle (only the
  // production `node_modules` it actually traced, plus a minimal
  // `server.js`) instead of requiring a full `node_modules` install in the
  // runtime image. This is what `Dockerfile`'s runner stage copies and
  // runs; see that file's comments for the full build/run split.
  output: "standalone",
};

export default nextConfig;
