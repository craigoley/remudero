import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Result = { failed: boolean; output?: string };
// `scripts/**` is outside tsconfig's `include`, so the module loads through a cast dynamic import.
const mod = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "clock-sweep.mjs")).href)) as {
  SPAWN_REACHING: ReadonlyMap<string, string>;
  classifySweep: (r: Map<string, Result>, artifacts: Map<string, string>, ceiling: number, recorded: string[]) => { newDrift: unknown[]; staleExclusions: unknown[]; ok: boolean };
  deriveCandidates: (dir?: string) => string[];
  exclusionFindings: (suites: string[], keys: string[]) => { stale: string[]; ambiguous: string[] };
  exclusionProblems: (suites: string[], spawn?: Map<string, string>, artifacts?: Map<string, string>) => { stale: string[]; ambiguous: string[] };
  listSuites: (dir?: string) => string[];
  readTouchedAt: (cwd: string, exec: () => string) => Map<string, number>;
  runnableCandidates: (c: string[]) => string[];
  main: (opts: Record<string, unknown>) => number;
};
const { SPAWN_REACHING, classifySweep, deriveCandidates, exclusionFindings, exclusionProblems, listSuites, readTouchedAt, runnableCandidates, main } = mod;

/** A test body the sweep's own population criterion selects: an age-judging token plus a date literal. */
const SWEPT_BODY = 'const lastActivityAt = "2026-07-19T12:00:00Z";\n';

function tree(files: Record<string, string>): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-nested-sweep-"));
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
  }
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("W1-T9870: a nested test is a clock-sweep candidate", () => {
  const t = tree({
    "flat.test.ts": SWEPT_BODY,
    "learning/nested.test.ts": SWEPT_BODY,
    "console-api/serve/deeper.test.ts": SWEPT_BODY,
    "learning/not-aged.test.ts": "// no age token, no date\n",
    "fixtures/skipped.test.ts": SWEPT_BODY,
  });
  try {
    assert.deepEqual(deriveCandidates(t.dir), ["console-api/serve/deeper", "flat", "learning/nested"]);
    assert.deepEqual(listSuites(t.dir), ["console-api/serve/deeper", "flat", "learning/nested", "learning/not-aged"]);
  } finally {
    t.done();
  }
  // And the diff parser accepts a nested path, so a nested suite is ordered by its own history.
  const log = "1700000200\ntest/learning/nested.test.ts\n\n1700000100\ntest/flat.test.ts\n";
  const touched = readTouchedAt("/ignored", () => log);
  assert.equal(touched.get("learning/nested"), 1700000200);
  assert.equal(touched.get("flat"), 1700000100);
});

test("W1-T9870: a stem exclusion still matches a moved file", () => {
  const spawnKey = [...SPAWN_REACHING.keys()][0];
  // The never-run set is subtracted wherever the file sits: a move into a folder never un-excludes it.
  assert.deepEqual(runnableCandidates([spawnKey, `learning/${spawnKey}`, "console-api/serve/other"]), ["console-api/serve/other"]);

  // The recorded drift set matches by basename too, so a moved drifter is not NEW drift.
  const moved = new Map([["learning/cost-governor", { failed: true, output: "" }]]);
  const r = classifySweep(moved, new Map(), 5, ["cost-governor"]);
  assert.equal(r.newDrift.length, 0);
  assert.equal(r.ok, true);

  // A known artifact that moved is still matched, and still surfaces as stale when it passes.
  const artifacts = new Map([["moved-artifact", "compares a shifted Date.now() against a clock the probe cannot shift"]]);
  const stale = classifySweep(new Map([["sre/moved-artifact", { failed: false, output: "" }]]), artifacts, 5, []);
  assert.equal(stale.staleExclusions.length, 1);
  assert.equal(stale.ok, false);

  // Every real spawn-reaching exclusion names exactly one file in the real tree today.
  assert.deepEqual(exclusionProblems(listSuites()), { stale: [], ambiguous: [] });
});

test("W1-T9870: an exclusion matching no file is reported stale", () => {
  const suites = ["a/one", "b/twin", "c/twin", "lonely"];
  const found = exclusionFindings(suites, ["one", "twin", "lonely", "ghost"]);
  assert.deepEqual(found.stale, ["ghost"]);
  assert.deepEqual(found.ambiguous, ["twin"]);

  const problems = exclusionProblems(suites, new Map([["ghost", "reason"], ["twin", "reason"], ["lonely", "reason"]]), new Map());
  assert.equal(problems.stale.length, 1);
  assert.match(problems.stale[0], /"ghost" is stale/);
  assert.equal(problems.ambiguous.length, 1);
  assert.match(problems.ambiguous[0], /"twin" is ambiguous/);
});

test("W1-T9870: an ambiguous exclusion fails the sweep and a stale one is only reported", () => {
  const key = [...SPAWN_REACHING.keys()][0];
  const run = () => ({ failed: false, output: "" });
  const drive = (allSuites: () => string[]) => {
    const lines: string[] = [];
    const code = main({ argv: [], run, derive: () => ["alpha"], ceiling: 0, recorded: [], touchedAt: () => new Map(), readSuite: () => "", allSuites, log: (m: string) => lines.push(m), write: () => {} });
    return { code, text: lines.join("\n") };
  };
  const ambiguous = drive(() => [`a/${key}`, `b/${key}`]);
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.text, /ambiguous/);
  const stale = drive(() => ["alpha"]);
  assert.equal(stale.code, 0);
  assert.match(stale.text, /EXCLUSION PROBLEM.*stale/);
});
