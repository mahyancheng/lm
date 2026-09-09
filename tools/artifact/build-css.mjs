/**
 * Compile the app's Tailwind 4 globals.css to plain CSS for the artifact
 * build. Must be run with cwd = apps/web (so the oxide scanner picks up the
 * app sources and @tailwindcss/postcss resolves):
 *   pnpm -C apps/web exec node ../../tools/artifact/build-css.mjs <out>
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const appRequire = createRequire(resolve(process.cwd(), 'package.json'));
const tailwindPath = appRequire.resolve('@tailwindcss/postcss');
const tailwind = appRequire('@tailwindcss/postcss');
// postcss is not a direct dependency of the app; resolve it through the
// tailwind plugin's own dependency chain (pnpm strict isolation).
const postcss = createRequire(tailwindPath)('postcss');

const out = process.argv[2];
if (!out) {
  console.error('usage: node build-css.mjs <out.css>');
  process.exit(1);
}

const input = resolve(process.cwd(), 'src/app/globals.css');
const css = await readFile(input, 'utf8');
const result = await postcss([tailwind()]).process(css, { from: input });
await mkdir(dirname(resolve(out)), { recursive: true });
await writeFile(resolve(out), result.css);
console.log(`css: ${result.css.length} bytes -> ${out}`);
