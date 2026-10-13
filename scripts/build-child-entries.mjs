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
// W1-T8775: the check-proof spawn site in src/lib/plan-pr-emitter.ts runs a bundle through
// src/lib/child-entry-argv.ts when childEntryIsCurrent holds, and tsx otherwise.
import { createHash } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync,
  rmSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The child entries this build emits. `check-proof-main` is W1-T7728's narrow entry; W1-T8775 switches its spawn site. */
export const CHILD_ENTRIES = Object.freeze([
  { name: "run-task", source: "src/run-task.ts" },
  { name: "check-proof-main", source: "src/check-proof-main.ts" },
]);
/** Output directory, relative to the tree root. It lies under the gitignored `dist/`. */
export const OUT_DIR = "dist/child-entries";
export const MANIFEST_NAME = "manifest.json";
/** Bump this when the bundling recipe changes: a bundle from an older recipe must stop matching. */
export const RECIPE_VERSION = 2;
/** The manifest layout this file writes and the only one {@link childEntryIsCurrent} accepts (2: per-entry `sha256`). */
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

/** SHA-256 of a bundle's bytes: a source hash says what a bundle was built FROM, never what the file now holds. */
export const payloadDigest = (bytes) => createHash("sha256").update(bytes).digest("hex");

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
    const payload = readIfPresent(outfile) ?? Buffer.alloc(0);
    if (payload.length === 0) throw new Error(`child entry ${entry.name}: esbuild reported success but wrote no bundle at ${outfile}`);
    built.push({ name: entry.name, source: entry.source, bundle, bytes: payload.length, sha256: payloadDigest(payload) });
  }
  const hashAfter = sourceHash(root, esbuild.version);
  if (hashAfter !== hashBefore) throw new Error("src/ changed while the child entries were being built; rerun the build");
  const manifest = { schema: MANIFEST_SCHEMA, sourceHash: hashBefore, recipe: RECIPE_VERSION, esbuild: esbuild.version, entries: built };
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
export function childEntryIsCurrent(root, name, { outDir = OUT_DIR } = {}) {
  try {
    return judgeChildEntry(resolve(root), name, outDir);
  } catch (err) {
    return notCurrent(`validation-error: ${String(err?.code ?? err?.message ?? err).slice(0, 80)}`);
  }
}

function judgeChildEntry(root, name, outDir) {
  if (typeof name !== "string" || !ENTRY_NAME.test(name)) return notCurrent("entry-name-invalid");
  const manifest = readChildEntryManifest(root, outDir);
  if (!manifest) return notCurrent("no-manifest");
  if (typeof manifest !== "object" || Array.isArray(manifest)) return notCurrent("manifest-invalid");
  if (manifest.schema !== MANIFEST_SCHEMA || manifest.recipe !== RECIPE_VERSION) return notCurrent("manifest-unsupported");
  if (!Array.isArray(manifest.entries) || !SHA256_HEX.test(String(manifest.sourceHash))) return notCurrent("manifest-invalid");
  const entry = manifest.entries.find((e) => e && typeof e === "object" && e.name === name);
  if (!entry) return notCurrent("entry-not-built");
  const declared = CHILD_ENTRIES.find((e) => e.name === name);
  if (!isSafeRelativePath(entry.source) || (declared && declared.source !== entry.source)) return notCurrent("entry-source-invalid");
  if (entry.bundle !== `${name}.mjs`) return notCurrent("bundle-name-invalid");
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
  // No top-level await: src/lib/child-entry-argv.ts require()s this module, which a TLA module refuses.
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
