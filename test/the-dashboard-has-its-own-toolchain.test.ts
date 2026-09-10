import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// ── W1-T3177 — THE TOOLCHAIN SPLIT, ASSERTED FROM THE NODE SIDE ───────────────────────────────
//
// Two acceptance criteria live here: the root tsconfig no longer globs `apps/*/src` and the
// dashboard carries its own browser-shaped config, the two typechecking INDEPENDENTLY; and the
// dashboard's suite runs as its own CI job while the existing `node --test` invocation stays
// byte-identical. The screen's own two criteria are in apps/dashboard/src/__tests__/series.test.tsx,
// under Vitest — deliberately, because they cannot honestly be asserted from here.

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const json = (p: string) => JSON.parse(read(p)) as Record<string, unknown>;

/** CODE ONLY, comment LINES removed. Two measured reasons for this exact shape.
 *
 *  It exists because a source-text assertion over the raw file is satisfied by the COMMENT
 *  EXPLAINING the call: `assert.match(vite, /compiler: true/)` still passed after
 *  `react({ compiler: true })` was mutated to `react()`, because the comment above it names the
 *  option. That is the always-true assertion, and it is why every source-text claim below reads
 *  this rather than `read()`.
 *
 *  And it is LINE-BASED rather than a `/\*…\*\/` regex because that regex ate `/**\/` INSIDE a glob
 *  string — `"src/**\/*.{test,spec}.{ts,tsx}"` became `"src*.{test,spec}.{ts,tsx}"` — so the
 *  stripper corrupted the very text it was meant to let an assertion read. A line filter cannot
 *  reach inside a string literal. */
const code = (p: string) =>
  read(p)
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join("\n");

test("W1-T3177: the root tsconfig no longer globs apps/*/src", () => {
  const root = json("tsconfig.json");
  const include = root.include as string[];
  assert.ok(Array.isArray(include));
  assert.equal(
    include.filter((g) => g.startsWith("apps/")).length,
    0,
    `the root config is Node-shaped and must not reach a browser SPA; include still has: ${include.join(", ")}`,
  );
  // packages/*/src MUST stay — api-client is consumed under Node rules as well as in the bundle,
  // so this is not "drop everything outside src/", it is one deliberate removal.
  assert.ok(include.includes("packages/*/src/**/*.ts"));
  assert.ok(include.includes("src/**/*.ts"));
  assert.ok(include.includes("test/**/*.ts"));
});

test("W1-T3177: the dashboard carries a BROWSER-shaped config that contradicts the root's, so neither borrows the other's module resolution", () => {
  const root = json("tsconfig.json").compilerOptions as Record<string, unknown>;
  const dash = json("apps/dashboard/tsconfig.json").compilerOptions as Record<string, unknown>;

  // The three settings a browser SPA needs and a Node config cannot carry.
  assert.equal(dash.moduleResolution, "bundler");
  assert.equal(dash.jsx, "react-jsx");
  assert.deepEqual(dash.types, ["vite/client"]);
  // tsc still emits the legacy v0 entry for test/dashboard-loads.test.ts; the package script
  // passes --noEmit when it is acting as the React type gate.
  assert.equal(dash.outDir, "build");
  assert.equal(dash.rootDir, "../..");

  // AND THE CONTRADICTION IS THE POINT — if these ever agree, one config is being borrowed and the
  // "typecheck independently" claim is empty.
  assert.notEqual(root.moduleResolution, dash.moduleResolution);
  assert.notEqual(root.module, dash.module);
  assert.equal(root.jsx, undefined, "the root config has no jsx and must not gain one");
  assert.deepEqual(root.types, ["node"]);

  // The Vite entry is excluded from the legacy tsc emit because src/main.ts and src/main.tsx both
  // map to build/apps/dashboard/src/main.js. Vite owns the React entry; tsc owns the v0 page.
  assert.deepEqual(json("apps/dashboard/tsconfig.json").exclude, ["src/main.tsx", "build", "node_modules"]);
});

test("W1-T3177: the dashboard declares the ruled toolchain, and its vitest config sits where the proof dialect looks for it", () => {
  const pkg = json("apps/dashboard/package.json");
  const deps = pkg.dependencies as Record<string, string>;
  const dev = pkg.devDependencies as Record<string, string>;
  assert.match(deps.react ?? "", /^\^19\./, "React 19 was the operator's ruling, not React 18");
  assert.match(deps["react-dom"] ?? "", /^\^19\./);
  assert.ok(deps.recharts, "Recharts is the ruled charting library");
  assert.ok(deps["@tanstack/react-query"], "TanStack Query is the ruled data layer");
  assert.ok(dev.vite && dev.vitest, "Vite builds and Vitest tests this package");
  // THE REACT COMPILER'S REAL DEPENDENCY. plugin-react v6 drives it through oxc, so the babel
  // plugin is NOT what enables it — declaring the babel one instead is an unused dep and a
  // compiler that never runs.
  assert.ok(dev["oxc-transform-react"], "the React Compiler needs oxc-transform-react on this plugin version");
  assert.equal(dev["babel-plugin-react-compiler"], undefined, "there is no babel step in this toolchain");
  const vite = code("apps/dashboard/vite.config.ts");
  assert.match(vite, /react\(\{\s*compiler:\s*true\s*\}\)/, "the React Compiler is ON from day one (operator ruling)");
  assert.match(vite, /outDir:\s*"build"/, "the mount probes apps/dashboard/build/index.html");
  assert.match(vite, /base:\s*"\/console\/"/, "assets are served behind the /console/ mount");

  // src/lib/review.ts NAMES this exact path as DASHBOARD_VITEST_CONFIG and executes dashboard proofs
  // with `--config <it>`. If the file moves, every dashboard proof in the plan silently stops
  // resolving, so the two are asserted against each other here rather than left to agree by luck.
  assert.match(
    code("src/lib/review.ts"),
    /const DASHBOARD_VITEST_CONFIG = "apps\/dashboard\/vite\.config\.ts";/,
    "the proof dialect's pinned config path and the real file must be the same string",
  );
});

test("W1-T3177: the two runners cannot collect each other's files, which is what makes this a second job and not a competing one", () => {
  const vite = code("apps/dashboard/vite.config.ts");
  assert.match(vite, /include:\s*\["src\/\*\*\/\*\.\{test,spec\}\.\{ts,tsx\}"\]/);
  // The repo's runner globs test/**/*.test.ts and nothing else; the dashboard's globs under src/.
  const rootPkg = json("package.json").scripts as Record<string, string>;
  assert.match(rootPkg.test ?? "", /"test\/\*\*\/\*\.test\.ts"/);
  assert.ok(!/apps/.test(rootPkg.test ?? ""), "the repo runner must not reach apps/");
  // ASSERTED AGAINST THE REAL CONFIG. An earlier draft tested a literal typed into this file, which
  // could never fail — the always-true-assertion trap, from the other direction.
  const includeLine = /include:\s*\[([^\]]*)\]/.exec(vite)?.[1] ?? "";
  assert.ok(includeLine.length > 0, "no include glob found in the dashboard vitest config");
  assert.ok(
    !includeLine.includes("test/") || includeLine.includes("src/**"),
    `the dashboard runner must stay under src/; found ${includeLine}`,
  );
  assert.ok(!/^\s*"test\//.test(includeLine), "the dashboard runner must not glob the repo's test/ root");
});

test("W1-T3177: the dashboard runs as its OWN ci job, typechecking separately from the build", () => {
  const ci = read(".github/workflows/ci.yml");
  const job = ci.slice(ci.indexOf("\n  dashboard:\n"));
  assert.ok(job.length > 0, "no `dashboard:` job in ci.yml");
  const body = job.slice(0, job.indexOf("\n  claims:"));
  assert.match(body, /run: npm run --silent test:dashboard/);
  // SEPARATE FROM THE BUILD ON PURPOSE: `vite build` transpiles per-file and does not typecheck, so
  // a build-only job goes green on a type error.
  assert.match(body, /run: npm run --silent typecheck:dashboard/);
  assert.match(body, /run: npm run --silent build:console/);
  const scripts = json("package.json").scripts as Record<string, string>;
  assert.equal(scripts["test:dashboard"], "npm --prefix apps/dashboard run test");
  assert.equal(scripts["typecheck:dashboard"], "npm --prefix apps/dashboard run typecheck");
});

test("W1-T3177: the existing node --test invocation is unchanged — this task added a runner, it did not touch the one that was here", () => {
  // FROZEN LITERALS, NOT A `git show origin/main` COMPARISON. The first draft shelled
  // `git show origin/main:.github/workflows/ci.yml`, and test/host-capability-fixtures.test.ts
  // refused it BY NAME as an undeclared `live-tree-git` fixture — correctly: `actions/checkout`
  // fetches shallow, so `origin/main` need not exist on a runner, and a fixture shelling git
  // plumbing passes on every dev machine and fails on CI for a reason that has nothing to do with
  // the change. The trade is deliberate and the drift risk is answered by the EXHAUSTIVE count
  // below: a new or edited runner invocation changes the set, so this fails and the literal must be
  // updated on purpose rather than drifting unnoticed.
  // `code()` strips `//`-style comments; YAML comments start with `#`, and six of them in this
  // workflow MENTION `npm run test:ci` in prose. Reading the raw file here would have counted those
  // as invocations — the comment-satisfied assertion again, in a third costume.
  const invocations = read(".github/workflows/ci.yml")
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .map((l) => l.trim())
    .filter((l) => /npm run test:ci|node --test/.test(l))
    .sort();
  assert.deepEqual(invocations, [
    "npm run test:ci",
    "run: node --test --import tsx --import ./test/setup/tmp-hygiene.ts test/containment.test.ts",
  ]);
  // AND THE DASHBOARD'S RUNNER IS NOT AMONG THEM — it is invoked through npm scripts, never by
  // extending the repo's own `node --test` line, which is the whole "second runner" claim.
  assert.ok(
    invocations.every((l) => !/vitest|dashboard/.test(l)),
    `the repo's node --test invocations must not mention the dashboard: ${invocations.join(" | ")}`,
  );
});

test("W1-T3177: the dashboard's vite config is SELF-ROOTING, so the proof executor's own invocation resolves the suite", () => {
  // MEASURED: src/lib/review.ts runs `vitest run --config apps/dashboard/vite.config.ts <file>` FROM
  // THE REPO ROOT. Vite's `root` defaults to process.cwd(), so without this the `src/**` include
  // resolved against the repo's own src/, matched nothing, and every dashboard proof graded `fail`
  // while the same suite passed from apps/dashboard. A config that answers differently per cwd makes
  // the whole dashboard proof dialect unusable, which is the thing W1-T3178 shipped to enable.
  const vite = code("apps/dashboard/vite.config.ts");
  assert.match(
    vite,
    /const dashboardRoot = fileURLToPath\(new URL\("\.", import\.meta\.url\)\)/,
    "the config must derive its root from its own file, not inherit the caller's cwd",
  );
  assert.match(
    vite,
    /root:\s*dashboardRoot/,
    "the config must pin its own root, not inherit the caller's cwd",
  );
  assert.match(vite, /import \{ fileURLToPath \} from "node:url"/);
});
