/// <reference types="vitest" />
//
// W1-T3177 — the dashboard's build AND its test runner, in one file.
//
// NAMED ONCE, AND src/lib/review.ts KNOWS THIS PATH. `DASHBOARD_VITEST_CONFIG` there is the string
// "apps/dashboard/vite.config.ts", and the proof dialect executes a dashboard `unit test:` proof as
// `vitest run --config <that path> <file>`. Renaming or moving this file silently breaks every
// dashboard proof in the plan, so it stays put.
//
// outDir `build`: the SAME directory the previous tsc build emitted to, because that is the path
// `consoleBuildStatus` (src/lib/serve.ts) probes for index.html. Keeping it means the static mount
// W1-T3175 shipped needs no change to serve this bundle instead of the old one.
//
// base "/console/": the mount serves this tree under that prefix, so asset URLs must be written
// relative to it. A default "/" base emits /assets/... and every hashed file 404s behind the mount.
// `defineConfig` from vitest/config, not vite: the vite export's type has no `test` key, so the
// block below would typecheck as an unknown property even though vitest reads it.
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const dashboardRoot = fileURLToPath(new URL(".", import.meta.url));

function dashboardIndexHtmlPlugin(): Plugin {
  return {
    name: "remudero-dashboard-index-html",
    generateBundle(_options, bundle) {
      const cssLinks = Object.values(bundle)
        .filter((entry) => entry.type === "asset" && entry.fileName.endsWith(".css"))
        .map((entry) => `    <link rel="stylesheet" href="/console/${entry.fileName}" />`)
        .join("\n");
      this.emitFile({
        type: "asset",
        fileName: "index.html",
        source: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Remudero console</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
${cssLinks}
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/console/main.js"></script>
  </body>
</html>
`,
      });
    },
  };
}

export default defineConfig({
  // SELF-ROOTING, and this is load-bearing rather than tidy. Vite's `root` defaults to
  // process.cwd(), and the proof executor (src/lib/review.ts) runs
  // `vitest run --config apps/dashboard/vite.config.ts <file>` FROM THE REPO ROOT. With the default,
  // `include: ["src/**/..."]` then resolved against the repo's own src/, matched nothing, and every
  // dashboard proof graded `fail` while the same suite passed from this directory. Pinning root to
  // this file's own directory makes the config give the same answer from any cwd.
  root: dashboardRoot,
  base: "/console/",
  plugins: [
    dashboardIndexHtmlPlugin(),
    // The React Compiler, ON from day one (operator ruling, 2026-09-08). It memoises for us, so
    // hand-written useMemo/useCallback in this tree is the exception and carries a stated reason.
    // `compiler: true` is plugin-react v6's own switch and drives it through oxc-transform-react;
    // the older `babel: { plugins: [["babel-plugin-react-compiler"]] }` form is not an option on
    // this plugin version at all -- it typechecks as an unknown property and does nothing.
    react({ compiler: true }),
  ],
  build: {
    outDir: "build",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: new URL("src/main.tsx", import.meta.url).pathname,
      output: {
        entryFileNames: "main.js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  test: {
    environment: "happy-dom",
    globals: false,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // The repo's own runner globs `test/**/*.test.ts` and never reaches this tree; this globs only
    // under src/ and never reaches the repo's. The two suites cannot collect each other's files,
    // which is what makes them a SECOND job rather than a competing one.
    setupFiles: ["src/__tests__/setup.ts"],
  },
});
