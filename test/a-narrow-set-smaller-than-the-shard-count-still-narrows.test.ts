import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const script = fileURLToPath(new URL("../scripts/test-tier-manifest.mjs", import.meta.url));
type Manifest = { thresholdMs: number; files: Record<string, number> };
const { selectPlanReadingShard, main } = await import(new URL("../scripts/test-tier-manifest.mjs", import.meta.url).href) as {
  selectPlanReadingShard: (
    text: unknown, files: string[], manifest: Manifest, shard: { index: number; count: number },
  ) => { selection: string; candidates: string[]; files: string[]; predictedDurationMs: number };
  main: (args: string[], options?: {
    spawn?: (command: string, args: string[]) => { status: number };
  }) => number;
};
const files = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"];
const manifest: Manifest = { thresholdMs: 5000, files: Object.fromEntries(files.map((file, i) => [file, 300 - i * 100])) };
const candidates = files.join("\n") + "\n";

test("test/a-narrow-set-smaller-than-the-shard-count-still-narrows.test.ts: three candidates run exactly once across eight narrow shards", () => {
  for (const durations of [manifest, { thresholdMs: 5000, files: {} }]) {
    const selections = Array.from({ length: 8 }, (_, i) =>
      selectPlanReadingShard(candidates, files, durations, { index: i + 1, count: 8 }),
    );
    assert.deepEqual(selections.map((entry) => entry.files.length), [1, 1, 1, 0, 0, 0, 0, 0]);
    assert.deepEqual(selections.flatMap((entry) => entry.files).sort(), files);
    for (const selection of selections) {
      assert.equal(selection.selection, "narrow");
      assert.deepEqual(selection.candidates, files);
    }
    assert.ok(selections.slice(3).every((entry) => entry.predictedDurationMs === 0));
  }
});

test("empty and unreadable candidate input still refuses on an otherwise empty shard", () => {
  for (const input of ["", "\n", "test/a.test.ts\n\n", undefined, null]) {
    assert.throws(() => selectPlanReadingShard(input, files, manifest, { index: 8, count: 8 }), /empty|blank|unreadable/);
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}narrow-shards-`));
  mkdirSync(join(root, "test"));
  mkdirSync(join(root, "scripts"));
  for (const file of [...files, "test/unselected.test.ts"]) writeFileSync(join(root, file), "");
  writeFileSync(join(root, "candidates.txt"), candidates);
  writeFileSync(join(root, "scripts/test-tier-manifest.json"), JSON.stringify(manifest));
  return root;
}

test("candidate execution spawns each selected suite once and passes five empty shards without spawning", (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const spawned: string[][] = [];
  for (let index = 1; index <= 8; index++) {
    const before = spawned.length;
    assert.equal(main(["--root", root, "--run-candidates", "candidates.txt", "--shard", `${index}/8`], {
      spawn: (_command, args) => {
        spawned.push(args.filter((arg) => arg.endsWith(".test.ts")));
        return { status: 0 };
      },
    }), 0);
    assert.equal(spawned.length - before, index <= 3 ? 1 : 0);
  }
  assert.deepEqual(spawned, files.map((file) => [file]));
});

test("the real candidate CLI reports narrow zero-suite selections and refuses unreadable or empty lists", (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const mode of ["--select-candidates", "--run-candidates"]) {
    const result = spawnSync(process.execPath, [script, "--root", root, mode, "candidates.txt", "--shard", "8/8"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /selection=narrow candidate_count=3 assigned_count=0 predicted_duration_ms=0/);
    if (mode === "--select-candidates") assert.equal(result.stdout, "");
    writeFileSync(join(root, "empty.txt"), "");
    for (const invalid of ["empty.txt", "missing.txt", "test"]) {
      const refused = spawnSync(process.execPath, [script, "--root", root, mode, invalid, "--shard", "8/8"], { encoding: "utf8" });
      assert.equal(refused.status, 1, refused.stderr);
      assert.match(refused.stderr, /candidate selection refused/);
    }
  }
});
