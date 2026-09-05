import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@frontier/contracts",
    "@frontier/shared",
    "@frontier/simulation",
    "@frontier/llm",
  ],
  /**
   * The Claude Agent SDK must stay a real `node_modules` package at runtime.
   *
   * Without this, Next inlines `sdk.mjs` into a server chunk and rewrites the
   * `import.meta.url` it uses to find its own directory into an **absolute path
   * literal from the build machine**. The SDK resolves its platform binary —
   * `@anthropic-ai/claude-agent-sdk-linux-arm64/claude`, a ~213 MB executable it
   * spawns as a subprocess — relative to that path, so a chunk built in one
   * directory and run from another throws `Native CLI binary for linux-arm64 not
   * found` at the first role call, long after a green build.
   *
   * Marking it external keeps a plain `require('@anthropic-ai/claude-agent-sdk')`
   * in the emitted chunk, which resolves through the deployed node_modules tree
   * wherever that tree happens to live. It also keeps a 1.4 MB SDK bundle out of
   * every route chunk that touches the gateway.
   */
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
};

export default nextConfig;
