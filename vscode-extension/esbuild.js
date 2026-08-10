// Extension-host bundle only — there's no custom webview UI to bundle here.
// The webview's own content is a tiny inline <iframe> wrapper generated in
// src/panel.ts; the real dashboard renders over real HTTP, served by
// local-api-server.mjs's static file route (see src-tauri/sidecar/).
const esbuild = require('esbuild');
const { rmSync } = require('node:fs');

const watch = process.argv.includes('--watch');

// rm -rf dist/ before every build — esbuild's outfile only writes what it
// produces, never removes a previous build's now-orphaned output. Bit a
// prior version of this extension once (stale webview assets silently
// riding along into a .vsix); cheap to avoid for good this time.
rmSync('dist', { recursive: true, force: true });

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: ['vscode'],
    sourcemap: true,
    minify: !watch,
  });

  if (watch) {
    await ctx.watch();
    console.log('[esbuild] watching...');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    console.log('[esbuild] build complete');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
