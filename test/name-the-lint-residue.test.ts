/**
 * W1-T2736 — LINT-PLAN COMPUTED THE IDS OF THE ONLY REAL WORK IT FOUND AND THREW THEM AWAY.
 *
 * `lintPlanCommand` destructured `{ withImpl, without }` from `classifyFailingMergeEvidence` and
 * used `.length` on both, so the whole-plan headline could say the residue was three ids and never
 * which three. W1-T1260 measured the cost: the check name is not a locator either — 57 tasks carry
 * a blocking `[declared-scope]` and two of those 57 were the residue — so locating them meant
 * re-implementing the verb's own split by hand.
 *
 * Every test here drives the REAL verb through its injected evidence reader, never a re-exported
 * formatter: the defect was in what the shipped line PRINTS, so that is what is asserted.
 *
 * DISPLAY ONLY is a claim about what did NOT change, and is asserted as such below — the failing
 * count, the exit code and every pre-existing summary substring survive byte-identical.
 */
import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { lintPlanCommand } from "../src/run-task.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The `%s%x00%b%x01` wire shape `defaultMergeEvidenceLog` produces. */
function dumpOf(...entries: Array<[subject: string, body?: string]>): string {
  return entries.map(([s, b]) => `${s}\x00${b ?? ""}`).join("\x01") + "\x01";
}

/** A task that FAILS the linter (its proof is prose, not a whitelisted dialect), so it lands in
 *  the failing set the split classifies. */
function fixtureTask(id: string): string {
  return [
    `- id: ${id}`,
    `  title: "fixture task ${id}"`,
    "  repo: remudero",
    "  origin: architect",
    "  depends_on: []",
    "  type: implement",
    "  verify: auto",
    "  status: queued",
    "  attempts: 0",
    "  files: [test/name-the-lint-residue.test.ts]",
    "  acceptance:",
    '    - claim: "the thing holds"',
    '      proof: "the existing suite passes unchanged, verified by hand"',
    "",
  ].join("\n");
}

function buildFixture(tasks: string): { tasksPath: string; dir: string } {
  const dir = mkdtempSync(join(REPO_ROOT, "test", ".tmp-residue-lint-"));
  mkdirSync(join(dir, "plan"), { recursive: true });
  const tasksPath = join(dir, "plan", "tasks.yaml");
  writeFileSync(tasksPath, tasks, "utf8");
  return { tasksPath, dir };
}

async function runLintPlan(
  args: string[],
  deps: Parameters<typeof lintPlanCommand>[1],
): Promise<{ exitCode: number; stdout: string }> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  console.log = (m: string) => logs.push(m);
  console.error = () => {};
  console.warn = () => {};
  try {
    const exitCode = await lintPlanCommand(args, deps);
    return { exitCode, stdout: logs.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
  }
}

/** Credits `credited` via a commit-body trailer; every other id stays residue. */
const evidenceCrediting = (...credited: string[]) => ({
  readMergeEvidenceLog: () => ({
    dump: dumpOf(...credited.map((id): [string, string] => [`feat(x): shipped ${id}`, `Remudero-Task: ${id}`])),
    ref: "origin/main",
  }),
});

// ── criterion 1: the ids are named beside the count that summarises them ─────────────────────

test("W1-T2736: the whole-plan summary NAMES the residue ids beside the count", async () => {
  const { tasksPath, dir } = buildFixture(fixtureTask("RES-CREDITED") + fixtureTask("RES-OPEN"));
  try {
    const { exitCode, stdout } = await runLintPlan(["--plan", tasksPath], evidenceCrediting("RES-CREDITED"));
    assert.equal(exitCode, 1, "blocking violations still exit 1 — naming is display only");
    assert.match(
      stdout,
      /2 open failing \(1 with a merged implementation, 1 with none: RES-OPEN\)/,
      "the id the split already computed must appear beside the number that summarises it",
    );
    assert.doesNotMatch(stdout, /with none: RES-CREDITED/, "a CREDITED id is not residue and must never be named as one");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2736: the ids ride INSIDE the count's own line, so a `cmd 2>&1 > f` redirect cannot separate them from it", async () => {
  const { tasksPath, dir } = buildFixture(fixtureTask("RES-A") + fixtureTask("RES-B"));
  try {
    const { stdout } = await runLintPlan(["--plan", tasksPath], evidenceCrediting());
    const headline = stdout.split("\n").find((l) => l.includes("open failing")) ?? "";
    assert.ok(headline.includes("RES-A") && headline.includes("RES-B"), `ids must be on the count's own line: ${headline}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── criterion 1 (cap): more than the cap truncates with a count ──────────────────────────────

test("W1-T2736: more residue ids than the cap prints the cap and a `+N more` truncation count, never an unbounded flood", async () => {
  const ids = Array.from({ length: 20 }, (_, i) => `RES-${String(i).padStart(2, "0")}`);
  const { tasksPath, dir } = buildFixture(ids.map(fixtureTask).join(""));
  try {
    const { stdout } = await runLintPlan(["--plan", tasksPath], evidenceCrediting());
    const headline = stdout.split("\n").find((l) => l.includes("open failing")) ?? "";
    const named = ids.filter((id) => headline.includes(id));
    assert.ok(named.length > 0 && named.length < ids.length, `must truncate: named ${named.length} of ${ids.length}`);
    assert.match(headline, new RegExp(`\\+${ids.length - named.length} more`), `the truncation count must be exact: ${headline}`);
    assert.match(headline, /20 with none:/, "and the COUNT still reports the full residue, not the truncated list's length");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── criterion 2: the list carries the split's own limit ──────────────────────────────────────

test("W1-T2736: the named ids carry the split's two-of-four-credit-paths limit, so the list reads as a starting point and never as a verdict", async () => {
  const { tasksPath, dir } = buildFixture(fixtureTask("RES-OPEN"));
  try {
    const { stdout } = await runLintPlan(["--plan", tasksPath], evidenceCrediting());
    assert.match(stdout, /STARTING POINT for a credit check, never a verdict that work remains/);
    assert.match(stdout, /2 of 4 credit paths/, "the limit must be quantified, not gestured at");
    assert.match(stdout, /PR-body trailer/, "and must name the paths it misses");
    assert.match(stdout, /run-<id>-<epoch> head ref/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2736: no residue means no id list and no caveat — the qualifier appears only where there is something to qualify", async () => {
  const { tasksPath, dir } = buildFixture(fixtureTask("RES-CREDITED"));
  try {
    const { stdout } = await runLintPlan(["--plan", tasksPath], evidenceCrediting("RES-CREDITED"));
    assert.match(stdout, /1 open failing \(1 with a merged implementation, 0 with none\)/, "no colon, no ids");
    assert.doesNotMatch(stdout, /STARTING POINT/, "a caveat about an empty list is noise");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── criterion 3: display only — what did NOT change ──────────────────────────────────────────

test("W1-T2736: DISPLAY ONLY — the exit code and every pre-existing summary substring survive the naming byte-identical", async () => {
  const { tasksPath, dir } = buildFixture(fixtureTask("RES-CREDITED") + fixtureTask("RES-OPEN"));
  try {
    const { exitCode, stdout } = await runLintPlan(["--plan", tasksPath], evidenceCrediting("RES-CREDITED"));
    assert.equal(exitCode, 1, "unchanged");
    // The exact substrings test/lint-plan-merge-evidence.test.ts pins, re-asserted here so a
    // regression is caught by THIS task's own falsifier and not only by the suite it would break.
    assert.match(stdout, /2 open failing \(1 with a merged implementation, 1 with none/);
    assert.match(stdout, /failing-split evidence: a Remudero-Task trailer or commit-subject citation on origin\/main/);
    assert.match(stdout, /filing subjects excluded/);
    assert.match(stdout, /task\(s\) checked \(open tasks only\)/);
    assert.match(stdout, /merged-task record\(s\) behind --all/);
    assert.match(stdout, /read: /, "the W1-T120 read-identity assertion still prints");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2736: an evidence failure still prints the unavailable marker with NO ids and NO caveat — a wrong list is worse than no list", async () => {
  const { tasksPath, dir } = buildFixture(fixtureTask("RES-OPEN"));
  try {
    const { exitCode, stdout } = await runLintPlan(["--plan", tasksPath], {
      readMergeEvidenceLog: () => {
        throw new Error("shallow clone — truncated history would misread absent commits as absent evidence");
      },
    });
    assert.equal(exitCode, 1, "an evidence failure must not change the exit code");
    assert.match(stdout, /1 open failing \(merge-evidence unavailable: shallow clone/);
    assert.doesNotMatch(stdout, /with none:/, "no ids may print without evidence to classify them");
    assert.doesNotMatch(stdout, /STARTING POINT/, "and no caveat about a list that was never produced");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
