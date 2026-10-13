// test/a-check-proof-child-runs-the-precompiled-entry-when-current.test.ts — W1-T8775.
//
// The plan-PR preflight launches its check-proof child through childEntryArgv: the precompiled bundle under
// plain node when scripts/build-child-entries.mjs vouches for it, tsx on the source entry otherwise. These
// tests drive the real build against a fixture tree and assert on the argv the helper returns and on what
// childEntryIsCurrent refuses. Decision record: docs/adr/0006-precompiled-daemon-child-entries.md.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { childEntryArgv } from "../src/lib/child-entry-argv.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "build-child-entries.mjs");

interface ManifestEntry { name: string; source: string; bundle: string; bytes: number; sha256: string }
interface Manifest { schema: number; sourceHash: string; recipe: number; esbuild: string; entries: ManifestEntry[] }
interface BuildModule {
  CHILD_ENTRIES: readonly { name: string; source: string }[];
  OUT_DIR: string;
  MANIFEST_NAME: string;
  buildChildEntries(opts: { root: string; entries: { name: string; source: string }[] }): Promise<Manifest>;
  childEntryIsCurrent(root: string, name: string): { current: boolean; reason: string; bundle?: string };
}
const loadBuild = async (): Promise<BuildModule> => (await import(pathToFileURL(SCRIPT).href)) as BuildModule;

const NAME = "check-proof-main";
const SOURCE = "src/check-proof-main.ts";
const ARGS = ["grep: x in y.txt", "--base", "origin/main"];
const MARKER = "BUNDLE-RAN-OK";

/** A minimal tree whose check-proof entry prints a marker and its arguments. */
function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-child-argv-tree-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{ "name": "fixture", "type": "module" }\n');
  writeFileSync(join(root, "package-lock.json"), '{ "lockfileVersion": 3 }\n');
  writeFileSync(join(root, SOURCE), `console.log(JSON.stringify({ marker: "${MARKER}", args: process.argv.slice(2) }));\n`);
  return root;
}

async function builtTree(): Promise<{ root: string; mod: BuildModule; bundle: string; manifestPath: string }> {
  const mod = await loadBuild();
  const root = makeTree();
  await mod.buildChildEntries({ root, entries: [{ name: NAME, source: SOURCE }] });
  const bundle = join(root, mod.OUT_DIR, `${NAME}.mjs`);
  return { root, mod, bundle, manifestPath: join(root, mod.OUT_DIR, mod.MANIFEST_NAME) };
}

/** A copy of a built tree, so one test can mutate several without rebuilding. */
function cloneTree(from: string, copies: string[]): string {
  const to = mkdtempSync(join(tmpdir(), "rmd-child-argv-copy-"));
  copies.push(to);
  cpSync(from, to, { recursive: true });
  return to;
}

const editManifest = (path: string, edit: (m: Manifest) => unknown): void =>
  writeFileSync(path, JSON.stringify(edit(JSON.parse(readFileSync(path, "utf8")) as Manifest)));

test("W1-T8775: a current check-proof bundle is spawned without tsx", async () => {
  const { root, mod, bundle } = await builtTree();
  try {
    const launch = childEntryArgv(root, NAME, SOURCE, ARGS);
    assert.equal(launch.kind, "bundle");
    assert.equal(launch.reason, "source-hash-match");
    assert.deepEqual(launch.argv, [bundle, ...ARGS], "the bundle path, then the caller's arguments, nothing before it");
    assert.ok(!launch.argv.includes("--import"), "a bundle runs under plain node: no loader import");
    assert.ok(!launch.argv.some((a) => /tsx/.test(a)), "no tsx anywhere in the argv");
    assert.equal(mod.childEntryIsCurrent(root, NAME).current, true);
    const r = spawnSync(process.execPath, launch.argv, { encoding: "utf8", cwd: tmpdir() });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { marker: MARKER, args: ARGS });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T8775: a stale or missing bundle falls back to tsx and names why", async () => {
  const { root, bundle } = await builtTree();
  const bare = makeTree();
  const copies: string[] = [];
  try {
    const expectTsx = (tree: string, reason: string): void => {
      const launch = childEntryArgv(tree, NAME, SOURCE, ARGS);
      assert.equal(launch.kind, "tsx");
      assert.equal(launch.reason, reason);
      assert.equal(launch.argv[0], "--import");
      assert.match(launch.argv[1]!, /tsx/);
      assert.equal(launch.argv[2], join(tree, SOURCE), "the source entry, resolved in the tree");
      assert.deepEqual(launch.argv.slice(3), ARGS);
    };
    // No manifest at all: a fresh worktree has no dist/.
    expectTsx(bare, "no-manifest");

    // A manifest that does not list the asked-for entry.
    assert.equal(childEntryArgv(root, "never-built", SOURCE, ARGS).reason, "entry-not-built");

    // A listed entry whose bundle file is gone.
    const gone = cloneTree(root, copies);
    rmSync(join(gone, "dist", "child-entries", `${NAME}.mjs`));
    expectTsx(gone, "bundle-missing");

    // A source edit after the build, and an added file, are both a changed source.
    const edited = cloneTree(root, copies);
    writeFileSync(join(edited, SOURCE), "console.log('edited');\n");
    expectTsx(edited, "source-changed");
    const added = cloneTree(root, copies);
    writeFileSync(join(added, "src", "added.ts"), "export const added = 1;\n");
    expectTsx(added, "source-changed");

    assert.equal(existsSync(bundle), true, "positive control: the untouched tree still has its bundle");
    assert.equal(childEntryArgv(root, NAME, SOURCE, ARGS).kind, "bundle", "positive control: the untouched tree is current");
  } finally {
    for (const d of [bare, root, ...copies]) rmSync(d, { recursive: true, force: true });
  }
});

test("W1-T8775: the child-entry build declares the check-proof entry", async () => {
  const mod = await loadBuild();
  const names = mod.CHILD_ENTRIES.map((e) => e.name);
  assert.ok(names.includes("run-task"), "run-task is still built");
  assert.deepEqual(mod.CHILD_ENTRIES.find((e) => e.name === NAME), { name: NAME, source: SOURCE });
  assert.ok(existsSync(join(REPO_ROOT, SOURCE)), "the declared source exists in the repository");
  // The manifest the build writes carries a payload digest per entry, which the schema-1 manifest lacked.
  const { root } = await builtTree();
  try {
    const manifest = JSON.parse(readFileSync(join(root, mod.OUT_DIR, mod.MANIFEST_NAME), "utf8")) as Manifest;
    assert.equal(manifest.schema, 2);
    assert.match(manifest.entries[0]!.sha256, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T8775: a corrupted bundle payload falls back before execution", async () => {
  const { root, mod, bundle } = await builtTree();
  try {
    const original = readFileSync(bundle, "utf8");
    assert.ok(original.includes(MARKER), "positive control: the payload carries the marker to flip");
    const corrupted = original.replace(MARKER, "BUNDLE-RAN-NO"); // same length: size alone cannot catch it
    assert.equal(corrupted.length, original.length);
    writeFileSync(bundle, corrupted);

    const verdict = mod.childEntryIsCurrent(root, NAME);
    assert.equal(verdict.current, false);
    assert.equal(verdict.reason, "bundle-digest-mismatch");
    const launch = childEntryArgv(root, NAME, SOURCE, ARGS);
    assert.equal(launch.kind, "tsx");
    assert.equal(launch.reason, "bundle-digest-mismatch");
    assert.ok(!launch.argv.includes(bundle), "the corrupted bundle is not in the argv to execute");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T8775: a currency check that throws falls back to tsx and names why", () => {
  const root = makeTree();
  try {
    const thrown = childEntryArgv(root, NAME, SOURCE, ARGS, () => {
      throw new Error("boom: cannot read manifest");
    });
    assert.equal(thrown.kind, "tsx");
    assert.equal(thrown.reason, "currency-check-unavailable: boom: cannot read manifest");
    assert.equal(thrown.argv[0], "--import");
    assert.equal(thrown.argv[2], join(root, SOURCE));
    assert.deepEqual(thrown.argv.slice(3), ARGS);

    // A non-Error throw is stringified, and a long message is cut to 80 characters.
    const nonError = childEntryArgv(root, NAME, SOURCE, ARGS, () => {
      throw "x".repeat(200); // eslint-disable-line no-throw-literal
    });
    assert.equal(nonError.kind, "tsx");
    assert.equal(nonError.reason, `currency-check-unavailable: ${"x".repeat(80)}`);

    // A check that answers (even "current" without a bundle path) is not the throwing arm.
    const noBundle = childEntryArgv(root, NAME, SOURCE, ARGS, () => ({ current: true, reason: "source-hash-match" }));
    assert.equal(noBundle.kind, "tsx");
    assert.equal(noBundle.reason, "source-hash-match");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T8775: invalid bundle metadata and paths fall back safely", async () => {
  const copies: string[] = [];
  const { root, mod } = await builtTree();
  try {
    const out = (tree: string): string => join(tree, mod.OUT_DIR);
    const refused = (label: string, tree: string, reason: RegExp): void => {
      const verdict = mod.childEntryIsCurrent(tree, NAME);
      assert.equal(verdict.current, false, `${label}: must not be current`);
      assert.match(verdict.reason, reason, label);
      assert.equal(verdict.bundle, undefined, `${label}: no bundle path is offered`);
      const launch = childEntryArgv(tree, NAME, SOURCE, ARGS);
      assert.equal(launch.kind, "tsx", `${label}: falls back to tsx`);
      assert.equal(launch.argv[0], "--import", label);
    };
    const mutated = (edit: (m: Manifest) => unknown): string => {
      const tree = cloneTree(root, copies);
      editManifest(join(out(tree), mod.MANIFEST_NAME), edit);
      return tree;
    };

    // A manifest path that climbs out of the output directory, to a file that exists and matches.
    const escaped = cloneTree(root, copies);
    writeFileSync(join(out(escaped), "..", "escaped.mjs"), readFileSync(join(out(escaped), `${NAME}.mjs`)));
    editManifest(join(out(escaped), mod.MANIFEST_NAME), (m) => ({ ...m, entries: m.entries.map((e) => ({ ...e, bundle: "../escaped.mjs" })) }));
    refused("traversal in bundle", escaped, /^bundle-name-invalid$/);

    refused("absolute bundle path", mutated((m) => ({ ...m, entries: m.entries.map((e) => ({ ...e, bundle: join(out(root), `${NAME}.mjs`) })) })), /^bundle-name-invalid$/);
    refused("source traversal", mutated((m) => ({ ...m, entries: m.entries.map((e) => ({ ...e, source: "../../etc/passwd" })) })), /^entry-source-invalid$/);
    refused("source differs from the declared one", mutated((m) => ({ ...m, entries: m.entries.map((e) => ({ ...e, source: "src/other.ts" })) })), /^entry-source-invalid$/);
    refused("schema 1 manifest", mutated((m) => ({ ...m, schema: 1 })), /^manifest-unsupported$/);
    refused("other recipe", mutated((m) => ({ ...m, recipe: 99 })), /^manifest-unsupported$/);
    refused("manifest is an array", mutated(() => []), /^manifest-invalid$/);
    refused("entries is not an array", mutated((m) => ({ ...m, entries: "nope" })), /^manifest-invalid$/);
    refused("source hash is not a digest", mutated((m) => ({ ...m, sourceHash: 7 })), /^manifest-invalid$/);
    refused("null entry", mutated((m) => ({ ...m, entries: [null, 3, ...m.entries.map((e) => ({ ...e, name: "other" }))] })), /^entry-not-built$/);
    refused("missing digest", mutated((m) => ({ ...m, entries: m.entries.map(({ sha256: _drop, ...e }) => e) })), /^entry-metadata-invalid$/);
    refused("non-numeric size", mutated((m) => ({ ...m, entries: m.entries.map((e) => ({ ...e, bytes: "12" })) })), /^entry-metadata-invalid$/);
    refused("size mismatch", mutated((m) => ({ ...m, entries: m.entries.map((e) => ({ ...e, bytes: e.bytes + 1 })) })), /^bundle-size-mismatch$/);

    // A manifest that is not JSON.
    const garbled = cloneTree(root, copies);
    writeFileSync(join(out(garbled), mod.MANIFEST_NAME), "{ not json");
    refused("unparseable manifest", garbled, /^no-manifest$/);

    // A symlinked bundle, even one whose target holds the exact bytes.
    const linked = cloneTree(root, copies);
    const target = join(linked, "elsewhere.mjs");
    writeFileSync(target, readFileSync(join(out(linked), `${NAME}.mjs`)));
    rmSync(join(out(linked), `${NAME}.mjs`));
    symlinkSync(target, join(out(linked), `${NAME}.mjs`));
    refused("symlinked bundle", linked, /^bundle-not-regular-file$/);

    // A FIFO in the bundle's place must be refused without being opened (an open would block forever).
    const fifo = cloneTree(root, copies);
    rmSync(join(out(fifo), `${NAME}.mjs`));
    assert.equal(spawnSync("mkfifo", [join(out(fifo), `${NAME}.mjs`)]).status, 0, "mkfifo is available");
    refused("fifo bundle", fifo, /^bundle-not-regular-file$/);

    // A FIFO in the manifest's place.
    const fifoManifest = cloneTree(root, copies);
    rmSync(join(out(fifoManifest), mod.MANIFEST_NAME));
    assert.equal(spawnSync("mkfifo", [join(out(fifoManifest), mod.MANIFEST_NAME)]).status, 0);
    refused("fifo manifest", fifoManifest, /^no-manifest$/);

    // A directory in the bundle's place.
    const dir = cloneTree(root, copies);
    rmSync(join(out(dir), `${NAME}.mjs`));
    mkdirSync(join(out(dir), `${NAME}.mjs`));
    refused("directory bundle", dir, /^bundle-not-regular-file$/);

    // An output directory that is a symlink out of the tree.
    const outside = mkdtempSync(join(tmpdir(), "rmd-child-argv-outside-"));
    copies.push(outside);
    const redirected = cloneTree(root, copies);
    spawnSync("cp", ["-r", out(redirected) + "/.", outside]);
    rmSync(out(redirected), { recursive: true });
    symlinkSync(outside, out(redirected));
    const viaLink = mod.childEntryIsCurrent(redirected, NAME);
    assert.equal(viaLink.current === true && viaLink.bundle?.startsWith(outside), false, "a bundle outside the tree is never offered");

    // An entry name that is not a plain name is refused before any path is built.
    for (const bad of ["../x", "a/b", "", "UPPER", "-x"]) assert.equal(mod.childEntryIsCurrent(root, bad).reason, "entry-name-invalid", bad);
  } finally {
    for (const d of [root, ...copies]) rmSync(d, { recursive: true, force: true });
  }
});
