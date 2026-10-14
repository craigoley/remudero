// test/a-daemon-child-entry-is-precompiled.test.ts — W1-T7729.
//
// The child-entry build (scripts/build-child-entries.mjs) bundles a daemon child entry so it can
// run without tsx, whose transform cache is keyed on the absolute path and misses in every fresh
// worktree. A bundle is only safe if it is keyed to the source it was built from, so these tests
// drive the real build against fixture trees and assert on what it wrote and how it judges
// currency. Decision record: docs/adr/0006-precompiled-daemon-child-entries.md.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "build-child-entries.mjs");

interface ManifestEntry { name: string; source: string; bundle: string; bytes: number }
interface Manifest { schema: number; sourceHash: string; recipe: number; esbuild: string; entries: ManifestEntry[] }
interface Currency { current: boolean; reason: string }
interface BuildModule {
  OUT_DIR: string;
  MANIFEST_NAME: string;
  buildChildEntries(opts: { root: string; entries: { name: string; source: string }[] }): Promise<Manifest>;
  sourceHash(root: string): string;
  childEntryIsCurrent(root: string, name: string): Currency;
}

const loadBuild = async (): Promise<BuildModule> => (await import(pathToFileURL(SCRIPT).href)) as BuildModule;

const ENTRIES = [{ name: "fixture-child", source: "src/child.ts" }];

/** A minimal tree: an entry with a main-module guard, and a lib module that derives a path from
 *  its own `import.meta.url`, the shape 40-odd real src modules use. */
function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-child-entry-tree-"));
  mkdirSync(join(root, "src", "lib"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{ "name": "fixture", "type": "module" }\n');
  writeFileSync(join(root, "package-lock.json"), '{ "lockfileVersion": 3 }\n');
  writeFileSync(
    join(root, "src", "lib", "where.ts"),
    [
      'import { dirname, join } from "node:path";',
      'import { fileURLToPath } from "node:url";',
      "export const whereUrl: string = import.meta.url;",
      'export const repoRoot: string = join(dirname(fileURLToPath(import.meta.url)), "..", "..");',
      'export const note: string = "import.meta.url inside a string stays text";',
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "src", "child.ts"),
    [
      'import { fileURLToPath } from "node:url";',
      'import { whereUrl, repoRoot, note } from "./lib/where.ts";',
      "const isMain: boolean = process.argv[1] === fileURLToPath(import.meta.url);",
      "if (isMain) console.log(JSON.stringify({ entryUrl: import.meta.url, whereUrl, repoRoot, note }));",
      "",
    ].join("\n"),
  );
  return root;
}

test("W1-T7729: the image runs the child-entry build after it copies the source", () => {
  const lines = readFileSync(join(REPO_ROOT, "deploy", "Dockerfile"), "utf8").split("\n");
  const copyAll = lines.findIndex((l) => /^COPY\b.*\s\.\s+\.\s*$/.test(l));
  const build = lines.findIndex((l) => /^RUN\b.*node scripts\/build-child-entries\.mjs/.test(l));
  const userNode = lines.findIndex((l) => /^USER node\s*$/.test(l));
  assert.ok(copyAll >= 0, "deploy/Dockerfile has no `COPY ... . .` instruction");
  assert.ok(build >= 0, "deploy/Dockerfile never runs scripts/build-child-entries.mjs");
  assert.ok(build > copyAll, `the child-entry build (line ${build + 1}) must follow COPY . . (line ${copyAll + 1}), or it bundles no source`);
  assert.ok(userNode < 0 || build < userNode, "the build must run before `USER node`, since /app is root-owned");
  // The whole RUN instruction (continuation lines included) must not swallow a failed build.
  let end = build;
  while (lines[end]?.trimEnd().endsWith("\\")) end += 1;
  const run = lines.slice(build, end + 1).join("\n");
  assert.doesNotMatch(run, /\|\|\s*(true|:)\b|;\s*true\b|set \+e/, "the child-entry build step must fail the image build when no bundle is produced");
  assert.match(run, /exit 1/, "the step must exit nonzero loudly when the build fails");
});

test("W1-T7729: a child-entry build that cannot produce a bundle exits nonzero", () => {
  const root = makeTree();
  try {
    writeFileSync(join(root, "src", "run-task.ts"), "export const broken = ;\n");
    const r = spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /CHILD-ENTRY BUILD FAILED/);
    assert.equal(existsSync(join(root, "dist", "child-entries", "manifest.json")), false, "a failed build must leave no manifest vouching for it");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T8775: the build CLI run under plain node writes every declared bundle with its digest and a manifest", () => {
  const root = makeTree();
  try {
    // The CLI builds the declared CHILD_ENTRIES, so the fixture supplies both sources.
    writeFileSync(join(root, "src", "run-task.ts"), 'export const runTask: string = "run-task";\nconsole.log(runTask);\n');
    writeFileSync(join(root, "src", "check-proof-main.ts"), 'export const checkProof: string = "check-proof-main";\nconsole.log(checkProof);\n');
    const r = spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    const manifest = JSON.parse(readFileSync(join(root, "dist", "child-entries", "manifest.json"), "utf8")) as Manifest & {
      entries: (ManifestEntry & { sha256: string })[];
    };
    assert.deepEqual(manifest.entries.map((e) => e.name), ["run-task", "check-proof-main"]);
    for (const e of manifest.entries) {
      const bytes = readFileSync(join(root, "dist", "child-entries", e.bundle));
      assert.ok(bytes.length > 0, `${e.name} bundle is empty`);
      assert.equal(e.bytes, bytes.length, `${e.name} manifest byte count matches the file`);
      assert.match(e.sha256, /^[0-9a-f]{64}$/);
      assert.match(r.stdout, new RegExp(`built dist/child-entries/${e.bundle} \\(${bytes.length} bytes\\) from ${e.source}`));
    }
    assert.match(r.stdout, new RegExp(`source hash ${manifest.sourceHash}`));
    const check = spawnSync(process.execPath, [SCRIPT, "--root", root, "--check"], { encoding: "utf8" });
    assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
    assert.match(check.stdout, /run-task: current\ncheck-proof-main: current/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T7729: a child-entry bundle records its source hash and a changed source no longer matches it", async () => {
  const mod = await loadBuild();
  const built = makeTree();
  const same = mkdtempSync(join(tmpdir(), "rmd-child-entry-same-"));
  const changed = mkdtempSync(join(tmpdir(), "rmd-child-entry-changed-"));
  const added = mkdtempSync(join(tmpdir(), "rmd-child-entry-added-"));
  try {
    const manifest = await mod.buildChildEntries({ root: built, entries: ENTRIES });
    const onDisk = JSON.parse(readFileSync(join(built, mod.OUT_DIR, mod.MANIFEST_NAME), "utf8")) as Manifest;
    assert.deepEqual(onDisk, manifest);
    assert.match(onDisk.sourceHash, /^[0-9a-f]{64}$/);
    assert.equal(onDisk.sourceHash, mod.sourceHash(built), "the manifest names the hash of the source it was built from");
    assert.deepEqual(onDisk.entries.map((e) => [e.name, e.source, e.bundle]), [["fixture-child", "src/child.ts", "fixture-child.mjs"]]);
    assert.ok(onDisk.entries[0].bytes > 0);
    assert.deepEqual(mod.childEntryIsCurrent(built, "fixture-child"), { current: true, reason: "source-hash-match", bundle: join(built, mod.OUT_DIR, "fixture-child.mjs") });

    // The same source at another absolute path still matches: the key that tsx's cache lacks.
    cpSync(built, same, { recursive: true });
    assert.equal(mod.childEntryIsCurrent(same, "fixture-child").current, true);

    // A tree whose src/ changed, carrying the old bundle and manifest, no longer matches.
    cpSync(built, changed, { recursive: true });
    writeFileSync(join(changed, "src", "lib", "where.ts"), 'export const whereUrl = "edited"; export const repoRoot = ""; export const note = "";\n');
    const stale = mod.childEntryIsCurrent(changed, "fixture-child");
    assert.equal(stale.current, false, "a bundle must not match a tree whose src/ changed");
    assert.equal(stale.reason, "source-changed");

    // Adding a file under src/ is a change too, even if no entry imports it yet.
    cpSync(built, added, { recursive: true });
    writeFileSync(join(added, "src", "lib", "new.ts"), "export const fresh = 1;\n");
    assert.equal(mod.childEntryIsCurrent(added, "fixture-child").reason, "source-changed");

    assert.equal(mod.childEntryIsCurrent(built, "never-built").reason, "entry-not-built");
  } finally {
    for (const d of [built, same, changed, added]) rmSync(d, { recursive: true, force: true });
  }
});

test("W1-T7729: a bundled child runs without tsx and each module keeps its own import.meta.url", async () => {
  const mod = await loadBuild();
  const root = makeTree();
  try {
    await mod.buildChildEntries({ root, entries: ENTRIES });
    const bundle = join(root, mod.OUT_DIR, "fixture-child.mjs");
    const r = spawnSync(process.execPath, [bundle], { encoding: "utf8", cwd: tmpdir() });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { entryUrl: string; whereUrl: string; repoRoot: string; note: string };
    assert.equal(out.entryUrl, pathToFileURL(join(root, "src", "child.ts")).href, "the entry's main-module guard held and it saw its source URL");
    assert.equal(out.whereUrl, pathToFileURL(join(root, "src", "lib", "where.ts")).href, "a lib module resolves import.meta.url to its own source file");
    assert.equal(out.repoRoot, root, "a path derived from import.meta.url lands in the tree the bundle sits in");
    assert.equal(out.note, "import.meta.url inside a string stays text");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
