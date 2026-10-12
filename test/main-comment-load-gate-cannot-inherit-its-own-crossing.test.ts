/**
 * W1-T5623. The main push lane ran `comment-load-signal -- --base HEAD^`, and the ratchet calls a
 * count already present at the base INHERITED. A crossing commit whose own push run was superseded
 * (the `ci-refs/heads/main` concurrency group cancels it) was therefore never measured, and every
 * later main run read the excess as HEAD^'s and said OK. MEASURED 2026-10-04: src/lib/ledger.ts at
 * 755 over a recorded 753 since #8987/#8989, with no main run ever red.
 *
 * `--strict` is the main lane's reading: on main the commit under test IS the base, so nothing is
 * inherited and every file over its recorded ceiling is a violation.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { gitRepo } from "./helpers/git-repo.js";

const SCRIPT = fileURLToPath(new URL("../scripts/comment-load-ratchet.mjs", import.meta.url));
const WORKFLOW = fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url));
const { main } = (await import(pathToFileURL(SCRIPT).href)) as { main: (argv: string[]) => number };

/**
 * The incident's shape as a three-commit main: `src/a.ts` recorded at 1 comment line, a CROSSING
 * commit that takes it to 3, then an unrelated commit on top. HEAD^ already carries the 3.
 */
function mainWithAnUnmeasuredCrossing(): { root: string; commitAll: (message: string) => void; cleanup: () => void } {
  const repo = gitRepo({ kind: "comment-load-strict" });
  const root = repo.dir;
  const commitAll = (message: string): void => {
    repo.git("add", "-A");
    repo.git("commit", "-qm", message);
  };
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "// one\nconst a = 1;\n");
  writeFileSync(join(root, "src", "b.ts"), "const b = 1;\n");
  writeFileSync(join(root, "scripts", "comment-load-baseline.json"), `${JSON.stringify({ "src/a.ts": 1 }, null, 2)}\n`);
  commitAll("recorded");
  writeFileSync(join(root, "src", "a.ts"), "// one\n// two\n// three\nconst a = 1;\n");
  commitAll("the crossing, whose push run was superseded");
  writeFileSync(join(root, "src", "b.ts"), "const b = 2;\n");
  commitAll("a later main commit");
  return { root, commitAll, cleanup: () => repo.cleanup() };
}

/** Run `main(argv)` with console output captured, restoring both writers whatever happens. */
function runInProcess(argv: string[]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    return { code: main(argv), out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

test("--strict: a file over its ceiling fails even when HEAD^ already carried that count", () => {
  const { root, cleanup } = mainWithAnUnmeasuredCrossing();
  try {
    const { code, err } = runInProcess(["--root", root, "--base", "HEAD^", "--no-record", "--strict"]);
    assert.equal(code, 1, "main itself is over a recorded ceiling, so the main lane must be red");
    assert.match(err, /src\/a\.ts: 3 comment lines > ceiling 1/);
  } finally {
    cleanup();
  }
});

test("CONTROL: the same fixture WITHOUT --strict reads the crossing as inherited and exits 0", () => {
  // This is the defect's own reading, kept for PRs: a branch must not answer for main's growth.
  // It proves the fixture really holds the over-ceiling count at HEAD^ -- the strict red above is
  // the flag's doing, not the fixture's.
  const { root, cleanup } = mainWithAnUnmeasuredCrossing();
  try {
    const { code, out } = runInProcess(["--root", root, "--base", "HEAD^", "--no-record"]);
    assert.equal(code, 0);
    assert.match(out, /already carried 3 at the merge base -- inherited/);
  } finally {
    cleanup();
  }
});

test("--strict --json reports the crossing as a violation and inherits nothing", () => {
  const { root, cleanup } = mainWithAnUnmeasuredCrossing();
  try {
    const { code, out } = runInProcess(["--root", root, "--base", "HEAD^", "--strict", "--json"]);
    assert.equal(code, 1);
    const report = JSON.parse(out) as { violations: Array<{ path: string }>; inherited_from_base: unknown[] };
    assert.deepEqual(report.violations.map((v) => v.path), ["src/a.ts"]);
    assert.deepEqual(report.inherited_from_base, []);
  } finally {
    cleanup();
  }
});

test("--strict leaves a main under every ceiling green, and records nothing on a strict run", () => {
  const { root, commitAll, cleanup } = mainWithAnUnmeasuredCrossing();
  const baseline = join(root, "scripts", "comment-load-baseline.json");
  try {
    writeFileSync(baseline, `${JSON.stringify({ "src/a.ts": 3 }, null, 2)}\n`);
    commitAll("record the crossing");
    const before = readFileSync(baseline, "utf8");
    const { code, out } = runInProcess(["--root", root, "--base", "HEAD^", "--no-record", "--strict"]);
    assert.equal(code, 0, out);
    assert.match(out, /comment-load-ratchet: OK/);
    assert.equal(readFileSync(baseline, "utf8"), before, "the gate form never writes the ledger");
  } finally {
    cleanup();
  }
});

test("the ci main lane runs comment-load-signal with --strict", () => {
  const jobs = (parseYaml(readFileSync(WORKFLOW, "utf8")) as {
    jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
  }).jobs;
  const script = (jobs.ci?.steps ?? []).find((s) => s.name === "Test")?.run ?? "";
  const call = script.split("\n").find((line) => line.includes("run_main_ceiling_gate comment-load-signal"));
  assert.ok(call, "the main lane must measure comment-load");
  assert.match(call, /\s--strict(\s|$)/, "without --strict a superseded crossing commit excuses itself forever");
});
