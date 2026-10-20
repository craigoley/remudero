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
//   node scripts/build-child-entries.mjs [--root <dir>] --hash   print the tree's source hash; build nothing
//   node scripts/build-child-entries.mjs [--root <dir>] --out <d>  build into <d>, laid out as dist/child-entries
//
// W1-T8775: the check-proof spawn site in src/lib/plan-pr-emitter.ts runs a bundle through
// src/lib/child-entry-argv.ts when childEntryIsCurrent holds, and tsx otherwise.
// W1-T8776: src/lib/child-entry-store.ts runs `--hash` and `--out` in a child process to fill the shared
// store, and validates a stored build with this same childEntryIsCurrent (`outDir` = the stored directory).
import { createHash } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync,
  rmSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The child entries this build emits. `check-proof-main` is W1-T7728's narrow entry; W1-T8775 switches its spawn site. `run-child` is W1-T9082's (ADR 0007). */
export const CHILD_ENTRIES = Object.freeze([
  { name: "run-task", source: "src/run-task.ts" },
  { name: "check-proof-main", source: "src/check-proof-main.ts" },
  { name: "run-child", source: "src/run-child-main.ts" },
]);
/**
 * W1-T8777: the modules that start a worker thread from their own URL, each built as its own bundle so a bundled
 * parent can start it with no tsx loader. ADR 0006 decision 4 names the first four; `grep -rln "new Worker(" src`
 * is the live inventory of the rest. W1-T9722: the daemon's read-plane worker entry (src/lib/tick-read-worker.ts).
 */
export const WORKER_ENTRIES = Object.freeze([
  "src/lib/read-model-worker.ts", "src/lib/read-model-slow-lane.ts", "src/lib/status.ts", "src/lib/board-worker.ts",
  "src/lib/tick-read-worker.ts",
  // bundlemain: every other module that starts a worker from its own URL. A bundled main has no tsx loader, so each
  // needs its own bundle: the benchmark cohort cadence, the git credential socket threads, the config measurement, and
  // the console projection, repository telemetry and plan reload workers that serve-side views start.
  // test/daemon/the-daemon-main-starts-from-its-bundle.test.ts keeps this list complete.
  "src/lib/benchmark-cohort.ts", "src/lib/secret-boundary.ts", "src/lib/config-gardener.ts", "src/lib/console-projection-worker.ts",
  "src/lib/repo-dashboard-route.ts", "src/lib/serve-plan-reload.ts",
]);
/** A worker module's bundle file name: `src/lib/board-worker.ts` → `worker-lib-board-worker.mjs`. */
export const workerBundleName = (module) => `worker-${module.replace(/^src\//, "").replace(/\.[cm]?[jt]sx?$/, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.mjs`;
/** Output directory, relative to the tree root. It lies under the gitignored `dist/`. */
export const OUT_DIR = "dist/child-entries";
export const MANIFEST_NAME = "manifest.json";
/**
 * Bump this when the bundling recipe changes: a bundle from an older recipe must stop matching. 3: the bundled flag and
 * worker bundles. 4: keepNames, so a bundled function's stack frame carries its source name, not esbuild's renaming.
 */
export const RECIPE_VERSION = 5;
/** The manifest layout this file writes and the only one {@link childEntryIsCurrent} accepts (2: per-entry `sha256`). W1-T8777's
 *  `workers` list is additive: a manifest without one holds no worker bundle, and recipe 3 already retires older builds. */
export const MANIFEST_SCHEMA = 2;
/**
 * Inputs besides `src/` that change what a bundle contains. A missing file hashes as absent. This script is one:
 * src/lib/child-entry-argv.ts imports it, so a bundle carries its own copy of this validation.
 */
export const HASHED_ROOT_FILES = Object.freeze(["package-lock.json", "package.json", "scripts/build-child-entries.mjs", "tsconfig.json"]);

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

/** Every file under `dir`, sorted, each with whether it is a symlink (from readdir, so no lstat-then-read window). */
function listFiles(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) listFiles(p, out);
    else out.push({ path: p, symlink: ent.isSymbolicLink() });
  }
  return out;
}

/** A file's bytes, or null when it does not exist: one read, not an exists-then-read pair (js/file-system-race). */
function readIfPresent(path) {
  try {
    return readFileSync(path);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

/** Read-only, never through a final symlink (ELOOP), and a FIFO's open returns at once instead of blocking. */
const READ_REGULAR_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * Open `path` once and hand `use` the descriptor and its fstat, so the type check, the size and the bytes all
 * describe one open file and nothing re-resolves the path between check and read (js/file-system-race).
 * Throws `ELOOP` for a symlink and `ENOTREG` for anything that is not a regular file.
 */
function withRegularFile(path, use) {
  const fd = openSync(path, READ_REGULAR_FLAGS);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw Object.assign(new Error("not a regular file"), { code: "ENOTREG" });
    return use(fd, st);
  } finally {
    closeSync(fd);
  }
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
    const rel = relative(root, file.path).split(sep).join("/");
    h.update(`file:${rel}\0`);
    h.update(file.symlink ? `symlink:${readlinkSync(file.path)}` : readFileSync(file.path));
    h.update("\0");
  }
  for (const name of HASHED_ROOT_FILES) {
    h.update(`root:${name}\0`);
    h.update(readIfPresent(join(root, name)) ?? "<absent>");
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
        // On the module's first line, not a line of its own: a linked map then names each frame's real source line.
        const prelude = `const __rmd_module_url = new URL(${JSON.stringify(rel)}, __rmd_bundle_url).href; `;
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

function bundleBanner(bundleDir, entryPath, { worker = false } = {}) {
  const entryRel = relative(bundleDir, entryPath).split(sep).join("/");
  // W1-T8777: every bundle marks its isolate, so a module it holds can tell it has no tsx loader (bundledWorkerUrl).
  const marked = ["const __rmd_bundle_url = import.meta.url;", "globalThis.__rmd_bundled = true;"];
  // A worker keeps its parent's `process.argv`: a worker module's main-module guard must not see itself as the entry.
  if (worker) return marked.join("\n");
  // `process.argv[1]` is set to the SOURCE entry, so a main-module guard such as run-task.ts's
  // `fileURLToPath(import.meta.url) === process.argv[1]` holds exactly as it does under tsx.
  return [
    'import { fileURLToPath as __rmd_fileURLToPath } from "node:url";',
    ...marked,
    `process.argv[1] = __rmd_fileURLToPath(new URL(${JSON.stringify(entryRel)}, __rmd_bundle_url));`,
  ].join("\n");
}

/** SHA-256 of a bundle's bytes: a source hash says what a bundle was built FROM, never what the file now holds. */
export const payloadDigest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/**
 * Build every declared entry into `<root>/<outDir>` and write the manifest last. Throws on any failure.
 * W1-T8776: `layoutDir` (default `outDir`) is where the bundle will RUN from, and every bundle-relative path
 * is computed against it; `outDir` is only where the bytes land. The shared store builds into a private
 * directory laid out as `<root>/dist/child-entries`, so a copy materialized there resolves inside its tree.
 */
export async function buildChildEntries({ root = SELF_ROOT, entries = CHILD_ENTRIES, workers = WORKER_ENTRIES, outDir = OUT_DIR, layoutDir = outDir } = {}) {
  root = resolve(root);
  const esbuild = loadEsbuild(root);
  const bundleDir = resolve(root, outDir);
  const layout = resolve(root, layoutDir);
  mkdirSync(bundleDir, { recursive: true });
  // Remove the old manifest first, so a failed rebuild leaves no manifest vouching for half-written bundles.
  rmSync(join(bundleDir, MANIFEST_NAME), { force: true });
  const hashBefore = sourceHash(root, esbuild.version);
  /** One bundle, built in memory as if at its layout path, then written where outDir says: the bytes never depend on outDir. */
  const bundleOne = async (label, source, bundle, worker) => {
    const entryPath = resolve(root, source);
    if (!existsSync(entryPath)) throw new Error(`${label}: source ${source} does not exist under ${root}`);
    const outfile = join(bundleDir, bundle);
    const result = await esbuild.build({
      absWorkingDir: root,
      entryPoints: [entryPath],
      outfile: join(layout, bundle),
      write: false,
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      logLevel: "silent",
      banner: { js: bundleBanner(layout, entryPath, { worker }) },
      define: { "import.meta.url": "__rmd_module_url" },
      // esbuild renames a symbol that collides across the merged modules (`spawn` -> `spawn4`); keepNames restores each
      // function's own name, which V8 prints in a stack frame, so serve.memory names a bundled spawn site as tsx does.
      keepNames: true,
      // bundlemain (operator ruling 2026-10-19): a LINKED map beside each bundle, so a process started with
      // --enable-source-maps names its .ts frames; without sourcesContent, since a stack needs only the mappings.
      sourcemap: "linked",
      sourcesContent: false,
      plugins: [moduleUrlPlugin(layout)],
    });
    const output = result.outputFiles?.find((f) => f.path === join(layout, bundle));
    const map = result.outputFiles?.find((f) => f.path === join(layout, `${bundle}.map`));
    rmSync(outfile, { force: true });
    rmSync(`${outfile}.map`, { force: true });
    if (map) writeFileSync(`${outfile}.map`, map.contents);
    if (output) writeFileSync(outfile, output.contents);
    const payload = readIfPresent(outfile) ?? Buffer.alloc(0);
    if (payload.length === 0) throw new Error(`${label}: esbuild reported success but wrote no bundle at ${outfile}`);
    return { bundle, bytes: payload.length, sha256: payloadDigest(payload) };
  };
  const built = [];
  for (const entry of entries) {
    built.push({ name: entry.name, source: entry.source, ...(await bundleOne(`child entry ${entry.name}`, entry.source, `${entry.name}.mjs`, false)) });
  }
  const builtWorkers = [];
  // A tree that lacks a declared worker module (a fixture, a consumer checkout) builds the rest; the real tree holding
  // every one is a test's claim, and a bundled parent missing one refuses loudly at the start (bundledWorkerUrl).
  for (const module of workers.filter((declared) => existsSync(resolve(root, declared)))) {
    builtWorkers.push({ module, ...(await bundleOne(`worker entry ${module}`, module, workerBundleName(module), true)) });
  }
  const hashAfter = sourceHash(root, esbuild.version);
  if (hashAfter !== hashBefore) throw new Error("src/ changed while the child entries were being built; rerun the build");
  const manifest = { schema: MANIFEST_SCHEMA, sourceHash: hashBefore, recipe: RECIPE_VERSION, esbuild: esbuild.version, entries: built, workers: builtWorkers };
  writeAtomic(join(bundleDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** The manifest at `<root>/<outDir>`, or null when there is none or it cannot be parsed. */
export function readChildEntryManifest(root = SELF_ROOT, outDir = OUT_DIR) {
  const path = join(resolve(root, outDir), MANIFEST_NAME);
  try {
    // One non-blocking descriptor: a FIFO or device named manifest.json is refused, never read or waited on.
    return JSON.parse(withRegularFile(path, (fd) => readFileSync(fd, "utf8")));
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    process.stderr.write(`build-child-entries: unreadable manifest at ${path}: ${err.message}\n`);
    return null;
  }
}

const ENTRY_NAME = /^[a-z0-9][a-z0-9-]*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const notCurrent = (reason) => ({ current: false, reason });

/** A repo-relative source path: no absolute prefix, no empty, `.` or `..` segment, no backslash or NUL. */
const isSafeRelativePath = (p) =>
  typeof p === "string" && p.length > 0 && p.length < 256 && !isAbsolute(p) && !p.includes("\\") && !p.includes("\0") &&
  p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");

/**
 * Whether a bundle for `name` exists, is the file the manifest vouches for, AND was built from the source
 * now in `root`. Any doubt reads as not current, so a caller falls back to tsx: a bundle is never assumed
 * current, and this never throws. The checks run cheapest first. The bundle is opened once, non-blocking
 * and without following a symlink, and is read only after fstat says it is a regular file, so a FIFO or
 * device cannot block the caller.
 *
 * A matching digest is integrity, not authenticity: someone who can replace both the payload and the
 * manifest passes. The store is instance-owned, which is the boundary this relies on.
 */
export function childEntryIsCurrent(root, name, { outDir = OUT_DIR, treeHash } = {}) {
  try {
    return judgeChildEntry(resolve(root), name, outDir, treeHash);
  } catch (err) {
    return notCurrent(`validation-error: ${String(err?.code ?? err?.message ?? err).slice(0, 80)}`);
  }
}

/** `treeHash`, when given, is `sourceHash(root)` the caller already computed (W1-T8776: one hash per lookup, not per entry). */
function judgeChildEntry(root, name, outDir, treeHash) {
  if (typeof name !== "string" || !ENTRY_NAME.test(name)) return notCurrent("entry-name-invalid");
  const read = validManifest(root, outDir);
  if (!read.manifest) return read;
  const { manifest } = read;
  const entry = manifest.entries.find((e) => e && typeof e === "object" && e.name === name);
  if (!entry) return notCurrent("entry-not-built");
  const declared = CHILD_ENTRIES.find((e) => e.name === name);
  if (!isSafeRelativePath(entry.source) || (declared && declared.source !== entry.source)) return notCurrent("entry-source-invalid");
  if (entry.bundle !== `${name}.mjs`) return notCurrent("bundle-name-invalid");
  return judgeBundleFile(root, outDir, manifest, entry, treeHash, true);
}

/** A manifest that this build wrote, or why not: the checks every entry kind starts from. */
function validManifest(root, outDir) {
  const manifest = readChildEntryManifest(root, outDir);
  if (!manifest) return notCurrent("no-manifest");
  if (typeof manifest !== "object" || Array.isArray(manifest)) return notCurrent("manifest-invalid");
  if (manifest.schema !== MANIFEST_SCHEMA || manifest.recipe !== RECIPE_VERSION) return notCurrent("manifest-unsupported");
  if (!Array.isArray(manifest.entries) || !SHA256_HEX.test(String(manifest.sourceHash))) return notCurrent("manifest-invalid");
  return { manifest };
}

/** The bundle a manifest entry names: a regular file inside the output directory, of the size and digest recorded, built from `root`'s source when `verifySource`. */
function judgeBundleFile(root, outDir, manifest, entry, treeHash, verifySource) {
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || !SHA256_HEX.test(String(entry.sha256))) return notCurrent("entry-metadata-invalid");
  const dir = resolve(root, outDir);
  const bundle = join(dir, entry.bundle);
  let refusal;
  try {
    refusal = withRegularFile(bundle, (fd, st) => {
      if (realpathSync(bundle) !== join(realpathSync(dir), basename(bundle))) return notCurrent("bundle-path-escapes");
      if (st.size !== entry.bytes) return notCurrent("bundle-size-mismatch");
      if (payloadDigest(readFileSync(fd)) !== entry.sha256) return notCurrent("bundle-digest-mismatch");
      return null;
    });
  } catch (err) {
    if (err?.code === "ENOENT") return notCurrent("bundle-missing");
    if (err?.code === "ELOOP" || err?.code === "ENOTREG") return notCurrent("bundle-not-regular-file");
    throw err;
  }
  if (refusal) return refusal;
  if (!verifySource) return { current: true, reason: "bundle-intact", bundle };
  const now = treeHash ?? sourceHash(root);
  if (manifest.sourceHash !== now) return { current: false, reason: "source-changed", built: manifest.sourceHash, now };
  return { current: true, reason: "source-hash-match", bundle };
}

/**
 * W1-T8777: whether `<root>`'s build holds a sound bundle for the worker module `module` (a src/ path, as WORKER_ENTRIES lists).
 * `verifySource: false` is for a process that already runs bundled from this build: its workers must come from
 * the same build whatever the tree now holds, so only the bundle's integrity is judged. Never throws.
 */
export function workerBundle(root, module, { outDir = OUT_DIR, treeHash, verifySource = true } = {}) {
  try {
    root = resolve(root);
    if (!isSafeRelativePath(module) || !module.startsWith("src/")) return notCurrent("worker-module-invalid");
    const read = validManifest(root, outDir);
    if (!read.manifest) return read;
    const { manifest } = read;
    if (!Array.isArray(manifest.workers)) return notCurrent("manifest-invalid");
    const entry = manifest.workers.find((w) => w && typeof w === "object" && w.module === module);
    if (!entry) return notCurrent("worker-not-built");
    if (entry.bundle !== workerBundleName(module)) return notCurrent("bundle-name-invalid");
    return judgeBundleFile(root, outDir, manifest, entry, treeHash, verifySource);
  } catch (err) {
    return notCurrent(`validation-error: ${String(err?.code ?? err?.message ?? err).slice(0, 80)}`);
  }
}

// ── bundlemain: the daemon's own main starts from the run-task bundle (operator ruling 2026-10-19) ─────────────────

/** The `rmd` verbs whose long-lived main process bin/rmd starts from the run-task bundle when it is current. */
export const BUNDLED_MAIN_VERBS = Object.freeze(["daemon"]);
/** Written beside the bundle before a bundled main starts; settled by that main's first tick (ADR 0006 extension). */
export const MAIN_ATTEMPT_NAME = "main-attempt.json";
/** Present beside the bundle: every bundled main starts on tsx instead (the per-tree off switch). */
export const MAIN_OFF_NAME = "main-entry.off";
/** The env var bin/rmd hands the started main, `<kind>:<reason>`, so its boot row names the choice. */
export const MAIN_ENTRY_ENV = "RMD_MAIN_ENTRY";

const tsx = (reason) => ({ kind: "tsx", reason });

/** The attempt marker beside the bundle, or null when there is none or it cannot be read as one. */
export function readMainAttempt(root, outDir = OUT_DIR) {
  try {
    const parsed = JSON.parse(readFileSync(join(resolve(root, outDir), MAIN_ATTEMPT_NAME), "utf8"));
    return parsed && typeof parsed === "object" && typeof parsed.sourceHash === "string" ? parsed : null;
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    return { sourceHash: "unreadable", settled: false, reason: String(err?.code ?? err?.message ?? err).slice(0, 80) };
  }
}

/** A bundled main reached its first tick: its source hash is proven to boot, and later boots of it stay bundled. */
export function settleMainAttempt(root, outDir = OUT_DIR, now = () => new Date().toISOString()) {
  const attempt = readMainAttempt(root, outDir);
  if (!attempt || attempt.settled === true || attempt.sourceHash === "unreadable") return false;
  writeAtomic(join(resolve(root, outDir), MAIN_ATTEMPT_NAME), `${JSON.stringify({ ...attempt, settled: true, settledAt: now() })}\n`);
  return true;
}

/**
 * Which entry `rmd <verb>` starts from in `root`: the run-task bundle under plain node when it is current for the tree
 * AND every declared worker bundle is current AND its linked map is beside it AND no bundled boot of this source has
 * failed before its first tick; tsx on any doubt, with the reason. A stale or missing build is built once here first.
 * Never throws. A bundle choice writes the attempt marker; the main settles it at its first tick
 * ({@link settleMainAttempt}), so an unsettled attempt for the same source demotes the next boot to tsx.
 */
export async function mainEntry(root, verb, { outDir = OUT_DIR, build = buildChildEntries, now = () => new Date().toISOString() } = {}) {
  try {
    root = resolve(root);
    if (!BUNDLED_MAIN_VERBS.includes(verb)) return tsx("verb-not-bundled");
    const dir = resolve(root, outDir);
    if (existsSync(join(dir, MAIN_OFF_NAME))) return tsx("switched-off");
    let treeHash = sourceHash(root);
    let verdict = childEntryIsCurrent(root, "run-task", { outDir, treeHash });
    let built = false;
    // A current bundle without its map (a build from before recipe 5's maps) is rebuilt too: source maps stay on.
    if (!verdict.current || !existsSync(`${verdict.bundle}.map`)) {
      try {
        await build({ root, outDir, layoutDir: outDir });
      } catch (err) {
        return tsx(`build-failed: ${String(err?.message ?? err).slice(0, 120)}`);
      }
      built = true;
      treeHash = sourceHash(root);
      verdict = childEntryIsCurrent(root, "run-task", { outDir, treeHash });
      if (!verdict.current) return tsx(`stale-after-build: ${verdict.reason}`);
    }
    for (const module of WORKER_ENTRIES) {
      const worker = workerBundle(root, module, { outDir, treeHash });
      if (!worker.current) return tsx(`worker-not-bundled: ${module}: ${worker.reason}`);
    }
    if (!existsSync(`${verdict.bundle}.map`)) return tsx("map-missing");
    const attempt = readMainAttempt(root, outDir);
    if (attempt && attempt.sourceHash === treeHash && attempt.settled !== true) {
      return tsx(`demoted: a bundled ${attempt.verb ?? verb} boot of this source never reached its first tick`);
    }
    if (!attempt || attempt.sourceHash !== treeHash) {
      writeAtomic(join(dir, MAIN_ATTEMPT_NAME), `${JSON.stringify({ sourceHash: treeHash, verb, settled: false, at: now() })}\n`);
    }
    return { kind: "bundle", reason: built ? "built-at-boot" : verdict.reason, bundle: verdict.bundle };
  } catch (err) {
    return tsx(`resolver-error: ${String(err?.code ?? err?.message ?? err).slice(0, 80)}`);
  }
}

async function main(argv) {
  const rootAt = argv.indexOf("--root");
  const root = rootAt >= 0 ? resolve(argv[rootAt + 1] ?? ".") : SELF_ROOT;
  if (argv.includes("--hash")) {
    try {
      process.stdout.write(`source hash ${sourceHash(root)}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`CHILD-ENTRY HASH FAILED: ${err?.message ?? err}\n`);
      return 1;
    }
  }
  const mainAt = argv.indexOf("--main-entry");
  if (mainAt >= 0) {
    // bin/rmd reads one line, `<kind>\t<reason>\t<bundle>`, and execs the bundle only for kind `bundle`.
    const choice = await mainEntry(root, argv[mainAt + 1] ?? "");
    process.stdout.write(`${choice.kind}\t${choice.reason.replace(/[\t\n]/g, " ")}\t${choice.bundle ?? ""}\n`);
    return 0;
  }
  if (argv.includes("--check")) {
    const results = CHILD_ENTRIES.map((e) => ({ name: e.name, ...childEntryIsCurrent(root, e.name) }));
    for (const r of results) process.stdout.write(`${r.name}: ${r.current ? "current" : `STALE (${r.reason})`}\n`);
    return results.every((r) => r.current) ? 0 : 1;
  }
  try {
    const outAt = argv.indexOf("--out");
    const outDir = outAt >= 0 ? resolve(argv[outAt + 1] ?? ".") : OUT_DIR;
    const manifest = await buildChildEntries({ root, outDir, layoutDir: OUT_DIR });
    for (const e of manifest.entries) process.stdout.write(`built ${OUT_DIR}/${e.bundle} (${e.bytes} bytes) from ${e.source}\n`);
    for (const w of manifest.workers) process.stdout.write(`built ${OUT_DIR}/${w.bundle} (${w.bytes} bytes) from ${w.module} (worker)\n`);
    process.stdout.write(`source hash ${manifest.sourceHash}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`CHILD-ENTRY BUILD FAILED: ${err?.message ?? err}\n`);
    if (Array.isArray(err?.errors)) for (const e of err.errors.slice(0, 10)) process.stderr.write(`  ${e.location?.file ?? "?"}:${e.location?.line ?? "?"} ${e.text}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // No top-level await: src/lib/child-entry-argv.ts require()s this module, which a TLA module refuses.
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
