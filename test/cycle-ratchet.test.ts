import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// scripts/cycle-ratchet.mjs is a plain .mjs file outside tsconfig's `include`, so it is driven
// HERE AS A SUBPROCESS rather than imported — the same shape test/coverage-ratchet.test.ts and
// test/task-id-existence-check.test.ts already use for their own gates. Driving the CLI also
// makes every case below a real EXIT CODE, which is what CI actually consumes.
//
// EVERY FIXTURE IS WRITTEN UNDER `mkdtemp`, NEVER INTO THE TRACKED TREE: a test that rewrites a
// tracked file is observed by every other worker in the same concurrent run (W1-T2291), and this
// suite must not add a member to that family while proving a gate about the tree's own shape.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "cycle-ratchet.mjs");
const BASELINE = join(REPO_ROOT, "scripts", "cycle-baseline.json");

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-cycle-ratchet-"));
}

/** A cruise result carrying exactly the given rings, in dependency-cruiser's own shape. */
function cruiseFixture(root: string, rings: string[][], ruleName = "no-circular"): string {
  const path = join(root, "cruise.json");
  writeFileSync(
    path,
    JSON.stringify({
      summary: {
        violations: rings.map((r) => ({
          type: "cycle",
          from: r[0],
          rule: { severity: "warn", name: ruleName },
          cycle: r.slice(1).concat(r[0]).map((name) => ({ name })),
        })),
      },
    }),
  );
  return path;
}

function baselineFixture(root: string, body: string): string {
  const path = join(root, "baseline.json");
  writeFileSync(path, body);
  return path;
}

function run(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: "utf8" });
}

test("the shipped tree passes its own ceiling, and the cruise is not vacuous over an empty set", () => {
  const printed = run(["--print"]);
  assert.equal(printed.status, 0, printed.stderr);
  const count = Number(/(\d+) distinct cycle\(s\)/.exec(printed.stdout)?.[1]);
  assert.ok(count > 0, `sanity: the cruise must find SOME cycle or this gate proves nothing; saw ${count}`);
  const gate = run([]);
  assert.equal(gate.status, 0, `the tree must pass its own ceiling:\n${gate.stdout}\n${gate.stderr}`);
  assert.match(gate.stdout, /cycle-ratchet: OK/);
});

test("THE FALSIFIER: one ring MORE than the ceiling exits non-zero and names the delta", () => {
  const root = tmpRoot();
  const ceiling = JSON.parse(readFileSync(BASELINE, "utf8")).maxCycles as number;
  const rings = Array.from({ length: ceiling + 1 }, (_, i) => [`src/lib/planted-${i}-a.ts`, `src/lib/planted-${i}-b.ts`]);
  const over = run(["--json", cruiseFixture(root, rings), "--baseline", BASELINE]);
  assert.notEqual(over.status, 0, "one cycle over the ceiling must BLOCK");
  assert.match(over.stderr, /cycle-ratchet: BLOCKED/);
  assert.match(over.stderr, /\(\+1\)/, "the failure must name the delta, not just fail");
  // …and exactly AT the ceiling passes, so the block above is the COUNT and not the fixture.
  const at = run(["--json", cruiseFixture(root, rings.slice(1)), "--baseline", BASELINE]);
  assert.equal(at.status, 0, `at the ceiling must pass:\n${at.stdout}\n${at.stderr}`);
});

test("BELOW the ceiling passes and says so — cutting a cycle without ratcheting down is never a failure", () => {
  const root = tmpRoot();
  const one = run(["--json", cruiseFixture(root, [["a.ts", "b.ts"]]), "--baseline", BASELINE]);
  assert.equal(one.status, 0);
  assert.match(one.stdout, /below; ratchet .* DOWN/, "a gain must be reported so it can be held");
});

test("the same ring reported from two entry points counts ONCE — the ceiling is a property of the graph", () => {
  const root = tmpRoot();
  const doubled = cruiseFixture(root, [
    ["a.ts", "b.ts", "c.ts"],
    ["b.ts", "c.ts", "a.ts"],
  ]);
  const r = run(["--json", doubled, "--baseline", baselineFixture(root, '{"maxCycles":1}')]);
  assert.equal(r.status, 0, `two reports of one ring must not count twice:\n${r.stdout}\n${r.stderr}`);
});

test("a DIFFERENT ring over the same modules is not collapsed — rotations dedupe, distinct rings do not", () => {
  const root = tmpRoot();
  const two = cruiseFixture(root, [
    ["a.ts", "b.ts", "c.ts"],
    ["a.ts", "c.ts", "b.ts"],
  ]);
  const r = run(["--json", two, "--baseline", baselineFixture(root, '{"maxCycles":1}')]);
  assert.notEqual(r.status, 0, "two genuinely different rings must count twice");
});

test("violations from another rule are ignored — the ceiling counts cycles, not warnings", () => {
  const root = tmpRoot();
  const other = cruiseFixture(root, [["x.ts", "y.ts"]], "lib-no-spike-or-cli");
  const r = run(["--json", other, "--baseline", baselineFixture(root, '{"maxCycles":0}')]);
  assert.equal(r.status, 0, `a non-cycle violation must not consume the cycle ceiling:\n${r.stderr}`);
});

test("a malformed ceiling is REFUSED, never silently disarmed — W1-T1277's four-ratchet failure mode", () => {
  const root = tmpRoot();
  const json = cruiseFixture(root, [["a.ts", "b.ts"]]);
  for (const bad of ['{"maxCycles":"13"}', '{"maxCycles":13.5}', '{"maxCycles":-1}', "{}", "not json"]) {
    const r = run(["--json", json, "--baseline", baselineFixture(root, bad)]);
    assert.notEqual(r.status, 0, `a ratchet must refuse ${bad} rather than pass`);
    assert.match(r.stderr, /cycle-ratchet:/);
  }
  const good = run(["--json", json, "--baseline", baselineFixture(root, '{"maxCycles":13}')]);
  assert.equal(good.status, 0, "the falsifier: a WELL-FORMED ceiling is accepted");
});

test("no-circular stays `warn` — the ratchet holds NET GROWTH and must never make an existing ring blocking", () => {
  const config = readFileSync(join(REPO_ROOT, ".dependency-cruiser.cjs"), "utf8");
  const at = config.indexOf('name: "no-circular"');
  assert.ok(at > 0, "sanity: the rule must still be named in the config");
  assert.match(config.slice(at - 400, at + 200), /severity:\s*"warn"/,
    "raising no-circular to `error` would fail every PR touching a module in an existing ring");
});

test("the ratchet is wired into CI's depcruise job and into package.json", () => {
  assert.match(readFileSync(join(REPO_ROOT, "package.json"), "utf8"), /"cycle-ratchet":\s*"node scripts\/cycle-ratchet\.mjs"/);
  const ci = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ci, /run: npm run --silent cycle-ratchet/, "an unwired gate proves nothing");
});
