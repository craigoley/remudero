#!/usr/bin/env node
// scripts/build-child-entries.mjs — W1-T7729. Decision record: docs/adr/0006-precompiled-daemon-child-entries.md.
//
// Bundles the declared daemon child entries with the esbuild that tsx already installs, so a child
// can run under plain `node` with no tsx loader and no path-keyed transform cache. Each bundle is
// written beside a manifest naming the SOURCE HASH it was built from. A consumer must compare that
// hash with the tree it is about to run in and fall back to tsx on any mismatch.
//
//   node scripts/build-child-entries.mjs [--root <dir>]          build; exit 1 loudly on any failure
//   node scripts/build-child-entries.mjs [--root <dir>] --check  exit 0 iff every bundle is current
//
// No spawn site runs a bundle yet. That switch is a follow-up task filed in the ADR.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The child entries this build emits. W1-T7728's narrow check-proof entry joins when it lands. */
export const CHILD_ENTRIES = Object.freeze([{ name: "run-task", source: "src/run-task.ts" }]);
/** Output directory, relative to the tree root. It lies under the gitignored `dist/`. */
export const OUT_DIR = "dist/child-entries";
export const MANIFEST_NAME = "manifest.json";
/** Bump this when the bundling recipe changes: a bundle from an older recipe must stop matching. */
export const RECIPE_VERSION = 1;
/** Inputs besides `src/` that change what a bundle contains. A missing file hashes as absent. */
export const HASHED_ROOT_FILES = Object.freeze(["package-lock.json", "package.json", "tsconfig.json"]);

const SELF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadEsbuild(root) {
  root = resolve(root);
  // Resolve esbuild from the tree being built, then from this script's own tree. tsx depends on
  // esbuild, so `npm ci` (dependencies only) always installs it.
  for (const base of [root, SELF_ROOT]) {
    try {
      return createRequire(join(base, "package.json"))("esbuild");
    } catch (err) {
      if (err?.code !== "MODULE_NOT_FOUND") throw err;
    }
  }
  throw new Error(`esbuild is not installed under ${root} or ${SELF_ROOT}; run npm ci first (tsx depends on it)`);
}

function listFiles(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) listFiles(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * The content hash a bundle is keyed to: every file under `<root>/src` (relative path and bytes),
 * the HASHED_ROOT_FILES, the recipe version and the esbuild version. Any edit, add, delete or
 * rename under src/ changes it. The absolute path of the tree does NOT enter it, so two worktrees
 * holding the same source share one hash. That absolute-path key is exactly what makes tsx's cache
 * miss in every fresh worktree.
 */
export function sourceHash(root, esbuildVersion = loadEsbuild(root).version) {
  root = resolve(root);
  const h = createHash("sha256");
  h.update(`recipe:${RECIPE_VERSION}\0esbuild:${esbuildVersion}\0`);
  const srcDir = join(root, "src");
  if (!existsSync(srcDir)) throw new Error(`no src/ directory under ${root}`);
  for (const file of listFiles(srcDir)) {
    const rel = relative(root, file).split(sep).join("/");
    const st = lstatSync(file);
    h.update(`file:${rel}\0`);
    h.update(st.isSymbolicLink() ? `symlink:${readlinkSync(file)}` : readFileSync(file));
    h.update("\0");
  }
  for (const name of HASHED_ROOT_FILES) {
    const p = join(root, name);
    h.update(`root:${name}\0`);
    h.update(existsSync(p) ? readFileSync(p) : "<absent>");
    h.update("\0");
  }
  return h.digest("hex");
}

/**
 * An esbuild plugin that keeps every module's own `import.meta.url`. A bundle otherwise collapses
 * all of them to the bundle's URL, and 40-odd src modules derive repo-root, script and worker paths
 * from it. Each module gets a module-scoped constant pointing at ITS OWN source file, located
 * relative to the bundle, so the bundle resolves paths inside the tree it sits in. The `define`
 * below binds `import.meta.url` to that constant lexically, so string literals are untouched.
 */
function moduleUrlPlugin(bundleDir) {
  return {
    name: "rmd-module-url",
    setup(build) {
      // src/ also holds .mjs modules (e.g. src/lib/reservation-chain.mjs), so JS gets the prelude too.
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, (args) => {
        const rel = relative(bundleDir, args.path).split(sep).join("/");
        const prelude = `const __rmd_module_url = new URL(${JSON.stringify(rel)}, __rmd_bundle_url).href;\n`;
        const ts = /\.[cm]?tsx?$/.test(args.path);
        const loader = args.path.endsWith("x") ? (ts ? "tsx" : "jsx") : ts ? "ts" : "js";
        const text = readFileSync(args.path, "utf8");
        // A hashbang must stay the first line, so the prelude goes after it.
        const cut = text.startsWith("#!") ? text.indexOf("\n") + 1 || text.length : 0;
        return { contents: text.slice(0, cut) + prelude + text.slice(cut), loader };
      });
    },
  };
}

function bundleBanner(bundleDir, entryPath) {
  const entryRel = relative(bundleDir, entryPath).split(sep).join("/");
  // `process.argv[1]` is set to the SOURCE entry, so a main-module guard such as run-task.ts's
  // `fileURLToPath(import.meta.url) === process.argv[1]` holds exactly as it does under tsx.
  return [
    'import { fileURLToPath as __rmd_fileURLToPath } from "node:url";',
    "const __rmd_bundle_url = import.meta.url;",
    `process.argv[1] = __rmd_fileURLToPath(new URL(${JSON.stringify(entryRel)}, __rmd_bundle_url));`,
  ].join("\n");
}

function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** Build every declared entry into `<root>/<outDir>` and write the manifest last. Throws on any failure. */
export async function buildChildEntries({ root = SELF_ROOT, entries = CHILD_ENTRIES, outDir = OUT_DIR } = {}) {
  root = resolve(root);
  const esbuild = loadEsbuild(root);
  const bundleDir = resolve(root, outDir);
  mkdirSync(bundleDir, { recursive: true });
  // Remove the old manifest first, so a failed rebuild leaves no manifest vouching for half-written bundles.
  rmSync(join(bundleDir, MANIFEST_NAME), { force: true });
  const hashBefore = sourceHash(root, esbuild.version);
  const built = [];
  for (const entry of entries) {
    const entryPath = resolve(root, entry.source);
    if (!existsSync(entryPath)) throw new Error(`child entry ${entry.name}: source ${entry.source} does not exist under ${root}`);
    const bundle = `${entry.name}.mjs`;
    const outfile = join(bundleDir, bundle);
    await esbuild.build({
      absWorkingDir: root,
      entryPoints: [entryPath],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      logLevel: "silent",
      banner: { js: bundleBanner(bundleDir, entryPath) },
      define: { "import.meta.url": "__rmd_module_url" },
      plugins: [moduleUrlPlugin(bundleDir)],
    });
    const bytes = existsSync(outfile) ? statSync(outfile).size : 0;
    if (bytes === 0) throw new Error(`child entry ${entry.name}: esbuild reported success but wrote no bundle at ${outfile}`);
    built.push({ name: entry.name, source: entry.source, bundle, bytes });
  }
  const hashAfter = sourceHash(root, esbuild.version);
  if (hashAfter !== hashBefore) throw new Error("src/ changed while the child entries were being built; rerun the build");
  const manifest = { schema: 1, sourceHash: hashBefore, recipe: RECIPE_VERSION, esbuild: esbuild.version, entries: built };
  writeAtomic(join(bundleDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** The manifest at `<root>/<outDir>`, or null when there is none or it cannot be parsed. */
export function readChildEntryManifest(root = SELF_ROOT, outDir = OUT_DIR) {
  const path = join(resolve(root, outDir), MANIFEST_NAME);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    process.stderr.write(`build-child-entries: unreadable manifest at ${path}: ${err.message}\n`);
    return null;
  }
}

/**
 * Whether a bundle for `name` exists AND was built from the source now in `root`. Any doubt reads
 * as not current, so a caller falls back to tsx. A bundle is never assumed current.
 */
export function childEntryIsCurrent(root, name, { outDir = OUT_DIR } = {}) {
  root = resolve(root);
  const manifest = readChildEntryManifest(root, outDir);
  if (!manifest) return { current: false, reason: "no-manifest" };
  const entry = manifest.entries?.find((e) => e.name === name);
  if (!entry) return { current: false, reason: "entry-not-built" };
  const bundle = join(resolve(root, outDir), entry.bundle);
  if (!existsSync(bundle)) return { current: false, reason: "bundle-missing" };
  const now = sourceHash(root);
  if (manifest.sourceHash !== now) return { current: false, reason: "source-changed", built: manifest.sourceHash, now };
  return { current: true, reason: "source-hash-match", bundle };
}

async function main(argv) {
  const rootAt = argv.indexOf("--root");
  const root = rootAt >= 0 ? resolve(argv[rootAt + 1] ?? ".") : SELF_ROOT;
  if (argv.includes("--check")) {
    const results = CHILD_ENTRIES.map((e) => ({ name: e.name, ...childEntryIsCurrent(root, e.name) }));
    for (const r of results) process.stdout.write(`${r.name}: ${r.current ? "current" : `STALE (${r.reason})`}\n`);
    return results.every((r) => r.current) ? 0 : 1;
  }
  try {
    const manifest = await buildChildEntries({ root });
    for (const e of manifest.entries) process.stdout.write(`built ${OUT_DIR}/${e.bundle} (${e.bytes} bytes) from ${e.source}\n`);
    process.stdout.write(`source hash ${manifest.sourceHash}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`CHILD-ENTRY BUILD FAILED: ${err?.message ?? err}\n`);
    if (Array.isArray(err?.errors)) for (const e of err.errors.slice(0, 10)) process.stderr.write(`  ${e.location?.file ?? "?"}:${e.location?.line ?? "?"} ${e.text}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
