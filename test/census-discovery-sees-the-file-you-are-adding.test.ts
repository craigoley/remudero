/**
 * W1-T3021 — THE CENSUS DRIFT GUARD IS BLIND, LOCALLY, TO THE FILE A PR IS ADDING.
 *
 * `discoverCensusCandidates` finds census-shaped suites with `git grep`, which searches TRACKED
 * content only. A new suite that is not yet in the index is therefore invisible on the author's
 * machine and visible in CI, where the tree is committed. The guard reports a clean zero locally
 * and reds the PR that adds the suite.
 *
 * MEASURED: #4380 failed all four ci-shards on `undisclosed census-shaped file(s):
 * test/rule-citation-gate-engine-portable.test.ts` after a local run of the same guard printed
 * clean — because at that moment the file was untracked.
 *
 * Every fixture here is a REAL git repository, because the defect IS a git flag: a faked spawn
 * would assert my belief about `--untracked` rather than git's behaviour.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CENSUS_DISCOVERY_PROBE_ARGV, discoverCensusCandidates } from "../src/lib/ci-parity.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { PreflightSpawn } from "../src/lib/commit-message.js";

const realSpawn: PreflightSpawn = (file, args, opts) => {
  try {
    return { status: 0, stdout: execFileSync(file, [...args], { cwd: opts?.cwd, encoding: "utf8" }), stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};

/** A census-shaped suite body: it must name BOTH an enumeration idiom and `src/` to be recognised. */
const CENSUS_SHAPED = 'const files = git(["ls-files"]); // walks src/ and asserts over it\n';

/** A real repo with one COMMITTED census-shaped suite and, optionally, further files on disk. */
function fixture(extra: { untracked?: Record<string, string>; ignored?: Record<string, string> } = {}): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t3021-`));
  const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" });
  git("init", "-q", ".");
  git("config", "user.email", "a@b.c");
  git("config", "user.name", "a");
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "test", "committed.test.ts"), CENSUS_SHAPED);
  git("add", "test/committed.test.ts");
  git("commit", "-qm", "init");
  for (const [rel, body] of Object.entries(extra.ignored ?? {})) {
    writeFileSync(join(root, ".gitignore"), Object.keys(extra.ignored ?? {}).join("\n") + "\n");
    writeFileSync(join(root, rel), body);
  }
  for (const [rel, body] of Object.entries(extra.untracked ?? {})) writeFileSync(join(root, rel), body);
  return root;
}

const found = (root: string): string[] =>
  discoverCensusCandidates(root, realSpawn, (p) => readFileSync(join(root, p), "utf8"))
    .map((c) => c.testFile)
    .sort();

// ── the defect ───────────────────────────────────────────────────────────────────────────────

test("W1-T3021: an UNTRACKED census-shaped suite is discovered — the #4380 shape, caught locally", () => {
  const root = fixture({ untracked: { "test/brand-new.test.ts": CENSUS_SHAPED } });
  assert.deepEqual(found(root), ["test/brand-new.test.ts", "test/committed.test.ts"]);
  rmSync(root, { recursive: true, force: true });
});

test("W1-T3021: CONTROL — the probe WITHOUT --untracked misses it, which is the defect this reproduces", () => {
  const root = fixture({ untracked: { "test/brand-new.test.ts": CENSUS_SHAPED } });
  const legacy: PreflightSpawn = (file, args, opts) =>
    realSpawn(file, [...args].filter((a) => a !== "--untracked"), opts);
  const legacyFound = discoverCensusCandidates(root, legacy, (p) => readFileSync(join(root, p), "utf8")).map((c) => c.testFile);
  assert.deepEqual(legacyFound, ["test/committed.test.ts"], "tracked only — the untracked suite is invisible");
  rmSync(root, { recursive: true, force: true });
});

// ── what must NOT change ─────────────────────────────────────────────────────────────────────

test("W1-T3021: a GITIGNORED census-shaped file is NOT discovered — scratch cannot enter the population", () => {
  const root = fixture({ ignored: { "test/scratch.test.ts": CENSUS_SHAPED } });
  assert.deepEqual(found(root), ["test/committed.test.ts"], "git grep --untracked honours .gitignore on its own");
  rmSync(root, { recursive: true, force: true });
});

test("W1-T3021: a fully COMMITTED tree — CI's shape — discovers exactly what it did before", () => {
  const root = fixture({ untracked: { "test/brand-new.test.ts": CENSUS_SHAPED } });
  execFileSync("git", ["-C", root, "add", "-A"], { encoding: "utf8" });
  execFileSync("git", ["-C", root, "-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-qm", "land"], { encoding: "utf8" });
  const legacy: PreflightSpawn = (file, args, opts) => realSpawn(file, [...args].filter((a) => a !== "--untracked"), opts);
  const withFlag = found(root);
  const without = discoverCensusCandidates(root, legacy, (p) => readFileSync(join(root, p), "utf8")).map((c) => c.testFile).sort();
  assert.deepEqual(withFlag, without, "no untracked files exist in CI, so the flag is a no-op exactly where the gate is authoritative");
  assert.deepEqual(withFlag, ["test/brand-new.test.ts", "test/committed.test.ts"]);
  rmSync(root, { recursive: true, force: true });
});

test("W1-T3021: a non-census file stays out however it is tracked — the recogniser is unchanged", () => {
  const root = fixture({ untracked: { "test/plain.test.ts": "assert.equal(1, 1);\n" } });
  assert.deepEqual(found(root), ["test/committed.test.ts"], "no enumeration idiom, no src/ mention, not a candidate");
  rmSync(root, { recursive: true, force: true });
});

test("W1-T3021: the probe still makes exactly ONE discovery call, and --untracked is part of it", () => {
  const calls: string[][] = [];
  const recording: PreflightSpawn = (file, args, opts) => {
    calls.push([file, ...args]);
    return realSpawn(file, args, opts);
  };
  const root = fixture();
  discoverCensusCandidates(root, recording, (p) => readFileSync(join(root, p), "utf8"));
  assert.equal(calls.length, 1, "one probe per discovery — the cost shape is unchanged");
  assert.deepEqual(calls[0].slice(1), [...CENSUS_DISCOVERY_PROBE_ARGV]);
  assert.ok(CENSUS_DISCOVERY_PROBE_ARGV.includes("--untracked"));
  rmSync(root, { recursive: true, force: true });
});
