import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "source-size-ratchet.mjs");
const CI_YML = join(REPO_ROOT, ".github", "workflows", "ci.yml");
const DEPCRUISE = join(REPO_ROOT, ".dependency-cruiser.cjs");

/**
 * test/source-size-baseline-is-enforced.test.ts — W1-T2883.
 *
 * W1-T2488 built a per-file line ceiling and nothing ever ran it. MEASURED on a clean main at
 * 6e31c5d2, before this task: `.github/workflows/ci.yml` contained the string `source-size-ratchet`
 * ZERO times, no workflow ran the script under any name, and `npm run source-size-ratchet` read
 * BLOCKED on SEVEN files — up to +478 lines over ceiling. A recorded ceiling nothing enforces is
 * dead configuration that drifts, and it had.
 *
 * Every assertion below drives the REAL CLI as a subprocess over a throwaway fixture tree, so what
 * is proven is the shipped behaviour and not a re-derivation of it.
 */

/** A throwaway tree with one baselined source file of `lines` lines and a recorded `ceiling`. */
function fixture(lines: number, ceiling: number): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}source-size-`));
  mkdirSync(join(root, "src", "lib"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "src", "lib", "subject.ts"), `${"const x = 1;\n".repeat(lines)}`);
  writeFileSync(
    join(root, "scripts", "source-size-baseline.json"),
    `${JSON.stringify({ "src/lib/subject.ts": ceiling }, null, 2)}\n`,
  );
  return root;
}

function runRatchet(root: string): { status: number; out: string } {
  const r = spawnSync(
    process.execPath,
    [SCRIPT, "--root", root, "--baseline", join(root, "scripts", "source-size-baseline.json")],
    { encoding: "utf8" },
  );
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

test("W1-T2883: the baseline mode REFUSES growth by one line and ACCEPTS a file at exactly its ceiling", () => {
  const over = fixture(101, 100);
  const exact = fixture(100, 100);
  const under = fixture(99, 100);
  try {
    const blocked = runRatchet(over);
    assert.notEqual(blocked.status, 0, `one line over its ceiling must exit non-zero:\n${blocked.out}`);
    assert.match(blocked.out, /BLOCKED/);
    assert.match(blocked.out, /src\/lib\/subject\.ts/, "the refusal must NAME the file that grew");

    // Exactly at the ceiling is the boundary: an off-by-one in the comparison would fail here and
    // nowhere else, which is why this case is separate from the one below.
    const at = runRatchet(exact);
    assert.equal(at.status, 0, `a file at exactly its ceiling must pass:\n${at.out}`);

    // A DECREASE is always accepted — the ratchet only ever tightens.
    assert.equal(runRatchet(under).status, 0);
  } finally {
    for (const r of [over, exact, under]) rmSync(r, { recursive: true, force: true });
  }
});

test("W1-T2883: the enforcing mode runs as a PR check in ci.yml, under its own job, on the real script", () => {
  // PARSED, NOT GREPPED. A text scan of the job body reads its COMMENTS too — measured: the first
  // version of this test failed because the job's own comment explains why `source-size-signal` is
  // a different thing, and the scan counted that mention as the job running it. Parsing sees only
  // what the runner sees.
  const ci = parseYaml(readFileSync(CI_YML, "utf8")) as {
    jobs: Record<string, { if?: string; steps: Array<{ name?: string; run?: string }> }>;
  };
  const job = ci.jobs["source-size"];
  assert.ok(job, "the job key must exist so the ci-parity registration that already names it is true");

  const runs = job.steps.map((step) => step.run ?? "").filter(Boolean);
  assert.ok(
    runs.some((r) => /npm run --silent source-size-ratchet/.test(r)),
    `the job must RUN the enforcing script; saw ${JSON.stringify(runs)}`,
  );
  // It must NOT run the signal mode: that reports growth and never fails, so a job wired to it
  // would be green on a file that had grown past its ceiling.
  assert.equal(
    runs.some((r) => /source-size-signal/.test(r)),
    false,
    "the signal mode never fails; this job must run the ratchet",
  );
  // PR-only, and unconditional within that — the fail-closed shape the jobs around it use. A
  // path-filtered required check that can go silently absent is the #102 deadlock class.
  assert.match(job.if ?? "", /github\.event_name == 'pull_request'/);
  assert.equal(JSON.stringify(job).includes('"paths"'), false, "no path filter — a required check must never be conditionally absent");

  // Positive control: the parse found the real corpus, so an absent job could never read as present.
  assert.ok(Object.keys(ci.jobs).length >= 15, `sanity: ci.yml must carry its real job set, saw ${Object.keys(ci.jobs).length}`);
});

test("W1-T2883: src/lib is forbidden from importing src/cli before the first file lands there", () => {
  const cfg = readFileSync(DEPCRUISE, "utf8");
  const ruleStart = cfg.indexOf('name: "lib-no-spike-or-cli"');
  assert.notEqual(ruleStart, -1);
  const rule = cfg.slice(ruleStart, cfg.indexOf("},", cfg.indexOf("to:", ruleStart)));
  assert.match(rule, /\^src\/cli\//, "the rule's `to:` must cover src/cli/");
  assert.match(rule, /severity: "error"/, "the boundary is an error, not a warning — it has no legacy violations to grandfather");
  // The directory genuinely does not exist yet; that is the point of pre-declaring the boundary.
  assert.equal(
    spawnSync("test", ["-d", join(REPO_ROOT, "src", "cli")], { encoding: "utf8" }).status,
    1,
    "src/cli/ must NOT exist yet — if it does, this rule stopped being a pre-declaration and the comment is stale",
  );
});

test("W1-T2883: the parity entry's EXPLICIT form is load-bearing — the helper shorthand would make this PR instrument-entangled", async () => {
  const { detectInstrumentEntanglement } = await import("../src/lib/review.js");
  const files = [
    ".github/workflows/ci.yml",
    "src/lib/ci-parity.ts",
    "scripts/source-size-baseline.json",
  ];
  const ciAdd = [
    "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml",
    "index 1111111..2222222 100644",
    "--- a/.github/workflows/ci.yml",
    "+++ b/.github/workflows/ci.yml",
    "@@ -1260,0 +1261,2 @@",
    "+  source-size:",
    "+    runs-on: ubuntu-latest",
    "diff --git a/src/lib/ci-parity.ts b/src/lib/ci-parity.ts",
    "index 3333333..4444444 100644",
    "--- a/src/lib/ci-parity.ts",
    "+++ b/src/lib/ci-parity.ts",
    "@@ -1220,0 +1221,1 @@",
  ].join("\n");

  // Standing rule 25's introducing-commit carve-out (isIntroducingCiYmlJob) keys on an ADDED
  // ci-parity line carrying `job: "<name>"` beside the added ci.yml job key. The EXPLICIT object
  // form emits that line.
  const explicitForm = detectInstrumentEntanglement(files, `${ciAdd}\n+    job: "source-size",`);
  assert.equal(explicitForm.entangled, false, "the explicit form must satisfy the carve-out");

  // npmScriptEntry's shorthand emits no such line, so the identical change would be REFUSED as a
  // workflow edited beside product code. This is why the entry above is not written with it, and
  // tidying it into the helper would make the next PR touching both files unmergeable.
  const helperForm = detectInstrumentEntanglement(files, `${ciAdd}\n+  npmScriptEntry("source-size", "source-size-ratchet"),`);
  assert.equal(helperForm.entangled, true, "the shorthand must NOT satisfy the carve-out — if it now does, this comment is stale");

  // And the shipped table really does register the job on the enforcing script, asserted through
  // the RUNTIME value rather than by reading ci-parity.ts as text — W1-T2905's census refuses a
  // test that reads a src/ file as source, and it caught this assertion's first form.
  const { CI_PARITY_TABLE } = await import("../src/lib/ci-parity.js");
  const entry = CI_PARITY_TABLE.find((e) => e.job === "source-size");
  assert.ok(entry, "ci.yml's source-size job must have a CI_PARITY_TABLE entry, or preflight --ci-parity cannot mirror it");
  assert.equal(entry.mirrored, true, "the job is mirrored locally, not excluded with a reason");
  // Positive control: the lookup can miss, so finding the entry means something.
  assert.equal(CI_PARITY_TABLE.find((e) => e.job === "no-such-job-exists"), undefined);
});
