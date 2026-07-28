// Builds a single self-contained HTML file that plays offline.
//
// The match server in `server/game.js` has no Node dependencies, so the offline
// build swaps `transport.js` for `transport-local.js`, which runs that exact
// Room in the browser tab. Same city generator, same bots, same storm, same
// server-side hit detection — just no socket and no other humans.
//
//   node tools/build-standalone.mjs [outfile]
//
// Output defaults to dist/spoodermin-standalone.html.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] || path.join(ROOT, 'dist', 'spoodermin-standalone.html');

// The client imports shared modules by absolute URL (`/shared/...`) because
// that is how the dev server serves them; map those back onto the filesystem,
// and redirect the transport to its offline twin.
const resolvePlugin = {
  name: 'spoodermin-paths',
  setup(build) {
    build.onResolve({ filter: /^\/shared\// }, (args) => ({
      path: path.join(ROOT, args.path),
    }));
    build.onResolve({ filter: /(^|\/)transport\.js$/ }, (args) => {
      if (args.kind === 'entry-point') return null;
      return { path: path.join(ROOT, 'public', 'js', 'transport-local.js') };
    });
  },
};

const result = await esbuild.build({
  entryPoints: [path.join(ROOT, 'public', 'js', 'main.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  legalComments: 'none',
  plugins: [resolvePlugin],
  write: false,
  logLevel: 'info',
});

const js = result.outputFiles[0].text;
const css = await fs.readFile(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
const html = await fs.readFile(path.join(ROOT, 'public', 'index.html'), 'utf8');

// Lift just the body markup out of index.html; the import map, the stylesheet
// link and the module script are all replaced by inlined content.
const body = html
  .slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'))
  .replace(/<script type="module"[\s\S]*?<\/script>/g, '')
  .trim();

// Offline build: there is no server to connect to, so the copy should not
// promise one. Everything else about the page is identical.
const offlineBody = body
  .replace('not connected', 'single-player vs. AI heroes')
  .replace(
    'Every building, hero and web is generated in code — no external assets.',
    'Everything — city, heroes, webs, even the match server — runs inside this page.'
  );

const page = `<title>SPOODERMIN — Web-Slinger Battle Royale</title>
<style>
${css}
</style>
${offlineBody}
<script>
${js}
</script>
`;

await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, page);
const kb = (Buffer.byteLength(page) / 1024).toFixed(0);
console.log(`\n  wrote ${path.relative(ROOT, OUT)} (${kb} KB)\n`);
