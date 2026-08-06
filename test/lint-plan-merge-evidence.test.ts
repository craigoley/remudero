/**
 * The lint-plan failing-split (state/recon-open-failing-composition.md, 2026-08-06).
 *
 * The defect: the default headline's bare failing count is a technically-true aggregate that
 * misleads — 167 of 176 failing tasks had merged implementations and could never re-dispatch,
 * yet "176 open failing" priced them all as open work and drove operator decisions on that
 * price. The fix under test: the headline splits the count by merge evidence, the classifier's
 * RULE prints beside the numbers, and any evidence failure prints as an explicit
 * "merge-evidence unavailable" marker — never as a silently wrong split.
 *
 * Three layers, matching the change's own seams:
 *   (i)  classifyFailingMergeEvidence — pure over a git-log dump; every classifier rule
 *        (trailer, subject citation, filing exclusion, id boundary, case) asserted directly.
 *   (ii) defaultMergeEvidenceLog — the REAL reader, run against this repo's actual object
 *        store (the #978 rule: when every test injects a fake, the default is dead code),
 *        plus one test per refusal arm (non-repo throw, shallow-clone refusal).
 *   (iii) lintPlanCommand — the printed line, via an injected reader: split present, rule
 *        line present, unavailable marker on a throwing reader with the exit code unchanged,
 *        and the zero-failing run carrying NO split and NO rule line.
 */
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  classifyFailingMergeEvidence,
  defaultMergeEvidenceLog,
  LINT_FILING_SUBJECT_RE,
  lintPlanCommand,
} from "../src/run-task.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Builds a `%s%x00%b%x01`-format dump from (subject, body) pairs — the exact wire shape
 *  defaultMergeEvidenceLog produces, so the pure classifier is tested over the real format. */
function dumpOf(...entries: Array<[subject: string, body?: string]>): string {
  return entries.map(([s, b]) => `${s}\x00${b ?? ""}`).join("\x01") + "\x01";
}

// ── (i) the pure classifier ──────────────────────────────────────────────────────────────────

test("classifier: a Remudero-Task trailer on a non-filing commit is merge evidence", () => {
  const dump = dumpOf(["feat(x): land the thing (#900)", "body text\n\nRemudero-Task: W1-T77"]);
  const { withImpl, without } = classifyFailingMergeEvidence(["W1-T77", "W1-T78"], dump);
  assert.deepEqual(withImpl, ["W1-T77"]);
  assert.deepEqual(without, ["W1-T78"]);
});

test("classifier: an implementing-subject citation is merge evidence, case-insensitively", () => {
  const dump = dumpOf(["fix(daemon): stop the leak (w1-t52)", ""]);
  const { withImpl } = classifyFailingMergeEvidence(["W1-T52"], dump);
  assert.deepEqual(withImpl, ["W1-T52"]);
});

test("classifier: chore(plan)-family filing subjects are NOT evidence — a filing cites, it does not implement", () => {
  // The same id cited only by filings must land in `without`; this is the classifier's one
  // judgment boundary and the reason the printed line names the rule.
  const dump = dumpOf(
    ["chore(plan): file W1-T310 — the next thing", ""],
    ["chore(triage): feedback about W1-T310", ""],
    ["chore(feedback): W1-T310 noted", ""],
    ["docs(plan): reflow around W1-T310", ""],
  );
  const { without } = classifyFailingMergeEvidence(["W1-T310"], dump);
  assert.deepEqual(without, ["W1-T310"]);
  for (const s of ["chore(plan): x", "chore(triage): x", "chore(feedback): x", "docs(plan): x"])
    assert.ok(LINT_FILING_SUBJECT_RE.test(s), `${s} must classify as a filing subject`);
  assert.ok(!LINT_FILING_SUBJECT_RE.test("fix(plan-adjacent): x"), "an implementing subject must not");
});

test("classifier: id matching is delimiter-bounded — W1-T25 never rides W1-T250's commit", () => {
  const dump = dumpOf(["feat(gate): tighten the floor (W1-T250)", "Remudero-Task: W1-T250"]);
  const { without } = classifyFailingMergeEvidence(["W1-T25"], dump);
  assert.deepEqual(without, ["W1-T25"], "a prefix id must not inherit its extension's evidence");
});

test("classifier: an empty dump classifies every id as without evidence", () => {
  const { withImpl, without } = classifyFailingMergeEvidence(["W1-T1", "W1-T2"], "");
  assert.deepEqual(withImpl, []);
  assert.deepEqual(without, ["W1-T1", "W1-T2"]);
});

// ── (ii) the real default reader ─────────────────────────────────────────────────────────────

test("defaultMergeEvidenceLog: the REAL reader returns this repo's history with the ref named", () => {
  // No fake: this shells actual git against the checkout running the test. The repo's history
  // is guaranteed to carry at least one Remudero-Task trailer (the dominant merge idiom here).
  const { dump, ref } = defaultMergeEvidenceLog(REPO_ROOT);
  assert.equal(ref, "origin/main");
  assert.ok(dump.includes("\x01"), "dump must be %x01-delimited");
  assert.ok(/remudero-task: w\d+-t\d+/i.test(dump), "real history must contain at least one trailer");
});

test("defaultMergeEvidenceLog: an unusable git dir throws rather than returning an empty dump", () => {
  // A dir under the repo tree would resolve to THIS repo via upward discovery, so the fixture
  // plants a broken `.git` pointer — git fails loudly, and the verb's catch arm gets a reason.
  const dir = mkdtempSync(join(REPO_ROOT, "test", ".tmp-evid-nonrepo-"));
  try {
    writeFileSync(join(dir, ".git"), "gitdir: /nonexistent-xyzzy-gitdir\n", "utf8");
    assert.throws(() => defaultMergeEvidenceLog(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defaultMergeEvidenceLog: a SHALLOW clone is refused by name — truncated history must never classify", () => {
  const src = mkdtempSync(join(REPO_ROOT, "test", ".tmp-evid-src-"));
  const dest = join(src, "shallow-clone");
  try {
    const git = (args: string[], cwd: string) =>
      execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    git(["init", "-q", "-b", "main"], src);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "seed"], src);
    git(["clone", "-q", "--depth", "1", `file://${src}`, dest], src);
    assert.throws(
      () => defaultMergeEvidenceLog(dest),
      /shallow/,
      "the refusal must name shallowness, so the verb's unavailable marker carries the reason",
    );
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

// ── (iii) the printed line, through the verb ─────────────────────────────────────────────────

/** Same fixture idiom as test/lint-plan-open-only.test.ts: a dirty task trips proof-dialect
 *  (BLOCKING) deterministically; a clean one carries an executable proof naming THIS file. */
function fixtureTask(id: string, clean: boolean): string {
  const proof = clean
    ? "unit test: test/lint-plan-merge-evidence.test.ts"
    : "the existing suite passes unchanged, verified by hand";
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
    "  acceptance:",
    '    - claim: "the thing holds"',
    `      proof: "${proof}"`,
    "",
  ].join("\n");
}

function buildFixture(tasks: string): { tasksPath: string; dir: string } {
  const dir = mkdtempSync(join(REPO_ROOT, "test", ".tmp-evid-lint-"));
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

test("headline: the failing count carries the split and the classifier's rule prints beside it", async () => {
  const { tasksPath, dir } = buildFixture(fixtureTask("FIX-EVID-MERGED", false) + fixtureTask("FIX-EVID-OPEN", false));
  try {
    const { exitCode, stdout } = await runLintPlan(["--plan", tasksPath], {
      readMergeEvidenceLog: () => ({
        dump: dumpOf(["feat(x): shipped it", "Remudero-Task: FIX-EVID-MERGED"]),
        ref: "origin/main",
      }),
    });
    assert.equal(exitCode, 1, "blocking violations must still exit 1 — the split is display only");
    assert.match(stdout, /2 open failing \(1 with a merged implementation, 1 with none\)/);
    assert.match(
      stdout,
      /failing-split evidence: a Remudero-Task trailer or commit-subject citation on origin\/main/,
      "the rule must travel with the figure — a split whose rule is invisible is the same defect one level down",
    );
    assert.match(stdout, /filing subjects excluded/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("headline: an evidence failure prints an explicit unavailable marker and never a wrong split", async () => {
  const { tasksPath, dir } = buildFixture(fixtureTask("FIX-EVID-OPEN", false));
  try {
    const { exitCode, stdout } = await runLintPlan(["--plan", tasksPath], {
      readMergeEvidenceLog: () => {
        throw new Error("shallow clone — truncated history would misread absent commits as absent evidence");
      },
    });
    assert.equal(exitCode, 1, "an evidence failure must not change the exit code");
    assert.match(stdout, /1 open failing \(merge-evidence unavailable: shallow clone/);
    assert.doesNotMatch(stdout, /with a merged implementation/, "no split may print without evidence");
    assert.doesNotMatch(stdout, /failing-split evidence:/, "no rule line without a split");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("headline: a clean plan prints no split, no rule line, and never invokes the reader", async () => {
  const { tasksPath, dir } = buildFixture(fixtureTask("FIX-EVID-CLEAN", true));
  try {
    let readerCalls = 0;
    const { exitCode, stdout } = await runLintPlan(["--plan", tasksPath], {
      readMergeEvidenceLog: () => {
        readerCalls++;
        return { dump: "", ref: "origin/main" };
      },
    });
    assert.equal(exitCode, 0);
    assert.match(stdout, /0 open failing,/, "the zero-failing headline keeps its exact pre-split shape");
    assert.doesNotMatch(stdout, /merge-evidence|failing-split/);
    assert.equal(readerCalls, 0, "a run with nothing failing must not pay for a history scan");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
