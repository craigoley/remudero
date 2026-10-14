import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

type World = {
  root: string; instance: string; install: string; launcher: string;
  git: (cwd: string, args: string[]) => string;
};
type Shape = {
  key: string;
  apply: (world: World) => void;
  observe: (state: { status: string; branch: string; ahead: string }) => boolean;
};
type Result = {
  shape: string; ran: boolean; healthy: boolean; unchanged?: boolean; unitsConverged?: boolean;
  beforeHead?: string; afterHead?: string; targetHead?: string; detail: string;
};
const scriptUrl = new URL("../scripts/operator-dirt-drill.mjs", import.meta.url).href;
const { DIRT_SHAPES, runDrill, main, snapshotTree } = await import(scriptUrl) as {
  DIRT_SHAPES: Shape[];
  runDrill: (shapes?: Shape[]) => { ok: boolean; results: Result[] };
  main: (argv: string[], log: (line: string) => void) => number;
  snapshotTree: (root: string) => unknown;
};

test("W1-T926: the drill dirties an instance checkout in every recorded shape and the install head still advances", () => {
  assert.deepEqual(DIRT_SHAPES.map((shape) => shape.key), [
    "untracked-exhaust", "tracked-modification", "scratch", "off-main", "diverged",
  ]);
  const outcome = runDrill();
  assert.equal(outcome.results.length, 5);
  for (const result of outcome.results) {
    assert.equal(result.ran, true, result.detail);
    assert.equal(result.healthy, true, `${result.shape}: ${result.detail}`);
    assert.equal(result.unchanged, true, "instance files and git metadata must remain byte-for-byte intact");
    assert.notEqual(result.beforeHead, result.targetHead);
    assert.equal(result.afterHead, result.targetHead);
    assert.equal(result.unitsConverged, true, "the new installer's fixture marker proves actual convergence");
  }
  assert.equal(outcome.ok, true);
});

test("W1-T926: the drill acts only on disposable fixtures without an explicit live flag", () => {
  const outside = mkdtempSync(join(tmpdir(), "rmd-dirt-drill-outside-"));
  try {
    writeFileSync(join(outside, "keep"), "must survive\n");
    const before = snapshotTree(outside);
    for (const args of [
      ["--live"], ["--install-root", outside], ["--live", "--install-root", outside],
      ["--kickstart"], ["--bootout"], ["--install"], [outside],
    ]) {
      const lines: string[] = [];
      assert.equal(main(args, (line) => lines.push(line)), 2);
      assert.match(lines.join("\n"), /REFUSED.*disposable fixtures/);
      assert.deepEqual(snapshotTree(outside), before);
    }
    assert.throws(() => runDrill({ installRoot: outside } as unknown as Shape[]), /external roots are refused/);
    assert.equal(main(["--help"], () => {}), 0);
    assert.deepEqual(snapshotTree(outside), before);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("W1-T926: a sixth dirt shape is one data row, not new drill logic", () => {
  const sixth: Shape = {
    key: "binary-scratch-with-link",
    apply: ({ instance }) => {
      mkdirSync(join(instance, "extra"));
      writeFileSync(join(instance, "extra/data"), Buffer.from([0, 255, 10]));
      chmodSync(join(instance, "extra/data"), 0o755);
      symlinkSync("../DECISIONS.md", join(instance, "extra/link"));
    },
    observe: ({ status }) => status.includes("?? extra/"),
  };
  const outcome = runDrill([...DIRT_SHAPES, sixth]);
  assert.equal(outcome.results.length, 6);
  assert.equal(outcome.ok, true, JSON.stringify(outcome.results));
  assert.equal(outcome.results[5].shape, sixth.key);
  assert.equal(outcome.results[5].unchanged, true);
});

test("W1-T926: an unreachable fixture is reported separately from a failed exercise and is cleaned up", () => {
  let root = "";
  const outcome = runDrill([{
    key: "setup-error",
    apply: (world) => { root = world.root; throw new Error("deliberate setup failure"); },
    observe: () => true,
  }]);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.results[0].ran, false);
  assert.match(outcome.results[0].detail, /deliberate setup failure/);
  assert.ok(root, "fixture setup must reach the failing shape");
  assert.equal(existsSync(root), false);
  assert.throws(() => runDrill([]), /nonempty dirt-shape table/);
});

test("W1-T926: a shape that was never established cannot produce a passing drill", () => {
  const outcome = runDrill([{ key: "missing-shape", apply: () => {}, observe: () => false }]);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.results[0].ran, false);
  assert.match(outcome.results[0].detail, /fixture did not establish missing-shape/);
});

test("W1-T926: the drill detects a launcher regressed to the instance checkout", () => {
  let root = "";
  const outcome = runDrill([{
    ...DIRT_SHAPES[0],
    apply: (world) => {
      root = world.root;
      DIRT_SHAPES[0].apply(world);
      const source = readFileSync(world.launcher, "utf8");
      const from = `CHECKOUT=${world.install}`;
      assert.ok(source.includes(from), "mutant must replace the launcher's actual checkout assignment");
      writeFileSync(world.launcher, source.replace(from, `CHECKOUT=${world.instance}`));
    },
  }]);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.results[0].ran, true);
  assert.equal(outcome.results[0].unchanged, false, "the wrong checkout's git metadata changes even if no tracked file does");
  assert.notEqual(outcome.results[0].afterHead, outcome.results[0].targetHead);
  assert.equal(existsSync(root), false);
});

test("W1-T926: the drill detects the all-files dirty guard blocking untracked install exhaust", () => {
  const outcome = runDrill([{
    ...DIRT_SHAPES[0],
    apply: (world) => {
      DIRT_SHAPES[0].apply(world);
      const source = readFileSync(world.launcher, "utf8");
      assert.ok(source.includes("--untracked-files=no"), "mutant must replace a real guard");
      writeFileSync(world.launcher, source.replaceAll("--untracked-files=no", "--untracked-files=normal"));
    },
  }]);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.results[0].ran, true);
  assert.equal(outcome.results[0].unchanged, true);
  assert.notEqual(outcome.results[0].afterHead, outcome.results[0].targetHead);
  assert.match(outcome.results[0].detail, /DIRTY/);
});

test("W1-T926: snapshots notice binary bytes, executable modes, empty directories and symlink targets", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-dirt-snapshot-"));
  try {
    const file = join(root, "binary");
    writeFileSync(file, Buffer.from([0, 1]));
    const baseline = snapshotTree(root);
    writeFileSync(file, Buffer.from([0, 2]));
    assert.notDeepEqual(snapshotTree(root), baseline);
    const changedBytes = snapshotTree(root);
    chmodSync(file, 0o755);
    assert.notDeepEqual(snapshotTree(root), changedBytes);
    const changedMode = snapshotTree(root);
    mkdirSync(join(root, "empty"));
    assert.notDeepEqual(snapshotTree(root), changedMode);
    symlinkSync("missing-target", join(root, "link"));
    const linked = snapshotTree(root);
    rmSync(join(root, "link"));
    symlinkSync("another-target", join(root, "link"));
    assert.notDeepEqual(snapshotTree(root), linked);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
