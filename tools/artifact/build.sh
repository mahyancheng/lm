#!/usr/bin/env bash
# Build the single-file artifact page of Frontier Capital (demo mode).
# Usage: tools/artifact/build.sh <out-dir>
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:?usage: build.sh <out-dir>}"
mkdir -p "$OUT"

# 1. CSS — Tailwind 4 compile with the app as cwd so sources are scanned.
(cd "$ROOT/apps/web" && pnpm exec node "$ROOT/tools/artifact/build-css.mjs" "$OUT/app.css")

# 2. JS — bundle the real app with next/* shimmed and @ aliased.
NODE_PATH="$ROOT/apps/web/node_modules" npx --yes esbuild "$ROOT/tools/artifact/entry.tsx" \
  --bundle --minify --format=iife --platform=browser --target=es2020 \
  --jsx=automatic \
  --banner:js='var process={env:{NODE_ENV:"production"}};' \
  --alias:@="$ROOT/apps/web/src" \
  --alias:next/link="$ROOT/tools/artifact/shims/next-link.tsx" \
  --alias:next/navigation="$ROOT/tools/artifact/shims/next-navigation.ts" \
  --outfile="$OUT/app.js" \
  --log-level=warning

# 3. HTML — inline both into the artifact page.
node - "$OUT" << 'EOF'
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const out = process.argv[2];
const css = readFileSync(join(out, 'app.css'), 'utf8');
const js = readFileSync(join(out, 'app.js'), 'utf8');
const html = `<title>Frontier Capital</title>
<style>
${css}
</style>
<div id="root"></div>
<script>
${js.replace(/<\/script>/gi, '<\\/script>')}
</script>
`;
writeFileSync(join(out, 'frontier-capital.html'), html);
console.log('html:', readFileSync(join(out, 'frontier-capital.html')).length, 'bytes');
EOF
