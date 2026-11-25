import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { successfulReporterSetupFixture } from "#test/helpers/reporter-setup.js";

// W1-T14816 — a gate check run that the light-gates job posts carries the failing step's error
// lines as output[text] and links the job that ran its steps. These tests run the REAL ci.yml
// reporting step under bash with a recording `gh` stub, and the real scripts/bundled-gate-report.mjs.

type Constituent = { id: string; outcome: string; report?: string };
type Mod = {
  TEXT_LINES_PER_STEP: number;
  TEXT_CHAR_CAP: number;
  failureLines: (report: string | undefined) => string[];
  describeFailingText: (checkName: string, constituents: Constituent[], opts?: { jobUrl?: string }) => string;
  main: (argv: string[], opts?: { env?: Record<string, string | undefined>; log?: (s: string) => void }) => number;
};
// `scripts/**` is outside tsconfig's include, so the module is loaded INSIDE each test: on a tree
// without text mode each test fails rather than the file failing to load.
const loadModule = async (): Promise<Mod> => (await import(pathToFileURL(join(REPO_ROOT, "scripts", "bundled-gate-report.mjs")).href)) as Mod;

const RULE_CHECKS_RED = [
  "TAP version 13",
  "ok 1 - test/a-passing-rule.test.ts",
  "\u001b[31mnot ok 2 - test/a-regex-has-both-arms.test.ts\u001b[39m",
  "  ---",
  "  error: 'REDIRECT_RE has no test that drives its no-match arm'",
  "##[error]rule-checks: 1 suite(s) failed",
].join("\n");

interface PostedCall { argv: string; name: string; conclusion: string; externalId: string; title: string; summary: string; detailsUrl: string; text?: string }

/** Run the REAL ci.yml reporting step with a `gh` stub that records each post and the text file it names. */
function runReporter(outcomes: Record<string, string>, reports: Record<string, string>, extraEnv: Record<string, string> = {}): { status: number | null; calls: PostedCall[]; stderr: string } {
  const workflow = parseYaml(readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8")) as {
    jobs: { commitlint: { steps: Array<{ env?: Record<string, string>; run?: string }> } };
  };
  const reporter = workflow.jobs.commitlint.steps.find((step) => step.run?.includes("report()"));
  assert.ok(reporter?.run && reporter.env, "ci.yml's commitlint job must carry the report() step");
  const root = mkdtempSync(join(tmpdir(), "rmd-posted-gate-text-"));
  try {
    const reportDir = join(root, "reports");
    const textDir = join(root, "texts");
    mkdirSync(reportDir);
    mkdirSync(textDir);
    for (const [id, text] of Object.entries(reports)) writeFileSync(join(reportDir, `${id}.log`), text);
    const stub = [
      "gh() {",
      "  local name='' a",
      "  for a in \"$@\"; do case \"$a\" in name=*) name=\"${a#name=}\" ;; esac; done",
      "  for a in \"$@\"; do case \"$a\" in 'output[text]=@'*) cp \"${a#output\\[text\\]=@}\" \"$GH_TEXT_DIR/$name.txt\" ;; esac; done",
      "  printf '%s\\n' \"$*\" >> \"$GH_LOG_FILE\"",
      "}",
      "sleep() { :; }",
      "",
    ].join("\n");
    const outcomeEnv = Object.fromEntries(Object.keys(reporter.env).filter((k) => k.startsWith("OUTCOME_")).map((k) => [k, outcomes[k] ?? "success"]));
    const logFile = join(root, "calls");
    writeFileSync(logFile, "");
    const run = spawnSync("bash", ["-c", stub + reporter.run], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        ...outcomeEnv,
        SETUP_OUTCOMES: successfulReporterSetupFixture(reporter.env),
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_SERVER_URL: "https://github.com",
        HEAD_SHA: "abc123",
        POSTING_JOB_ID: "139176074929",
        POSTING_RUN_ID: "45603893300",
        POSTING_RUN_ATTEMPT: "2",
        GATE_REPORT_DIR: reportDir,
        GH_LOG_FILE: logFile,
        GH_TEXT_DIR: textDir,
        ...extraEnv,
      },
    });
    const field = (line: string, key: string, next: string) => new RegExp(`-f ${key.replace(/[[\]]/g, "\\$&")}=(.*?) -f ${next.replace(/[[\]]/g, "\\$&")}=`).exec(line)?.[1] ?? "";
    const calls = readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((line) => {
      const name = field(line, "name", "head_sha");
      const textPath = join(textDir, `${name}.txt`);
      return {
        argv: line,
        name,
        conclusion: field(line, "conclusion", "output[title]"),
        externalId: field(line, "external_id", "status"),
        title: field(line, "output[title]", "output[summary]"),
        summary: field(line, "output[summary]", "details_url"),
        detailsUrl: /-f details_url=(\S+)/.exec(line)?.[1] ?? "",
        ...(existsSync(textPath) ? { text: readFileSync(textPath, "utf8") } : {}),
      };
    });
    return { status: run.status, calls, stderr: run.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const JOB_URL = "https://github.com/owner/repo/actions/runs/45603893300/job/139176074929";

test("W1-T14816 criterion 1: a failing gate's check run text carries its error lines", async () => {
  const mod = await loadModule();
  // The module: only failure-carrying lines, colour removed, under the failing step's id.
  assert.deepEqual(mod.failureLines(RULE_CHECKS_RED), [
    "not ok 2 - test/a-regex-has-both-arms.test.ts",
    "##[error]rule-checks: 1 suite(s) failed",
  ]);
  const text = mod.describeFailingText("rule-checks", [{ id: "rule-checks", outcome: "failure", report: RULE_CHECKS_RED }], { jobUrl: JOB_URL });
  assert.match(text, /step rule-checks: failure/);
  assert.match(text, /not ok 2 - test\/a-regex-has-both-arms\.test\.ts/);
  assert.doesNotMatch(text, /ok 1 - test\/a-passing-rule/, "a passing line is not a failure line");

  // A bundle names only its failing step, and a step with no log or an empty log says so.
  const bundled = mod.describeFailingText("comment-load-ratchet", [
    { id: "comment-load-ratchet", outcome: "success", report: "comment-load-ratchet: OK" },
    { id: "write-only-ledger-step", outcome: "failure", report: "write-only-ledger-step: BLOCKED -- 5 new row(s) nothing reads" },
    { id: "console-parity", outcome: "failure" },
    { id: "expiring-fixture-census", outcome: "failure", report: "  \n" },
  ]);
  assert.match(bundled, /step write-only-ledger-step: failure\n```text\nwrite-only-ledger-step: BLOCKED -- 5 new row\(s\) nothing reads\n```/);
  assert.match(bundled, /no report log for step console-parity/);
  assert.match(bundled, /report log for step expiring-fixture-census is empty/);
  assert.doesNotMatch(bundled, /step comment-load-ratchet:/, "a passing constituent adds no section");

  // Caps: at most TEXT_LINES_PER_STEP lines per step and TEXT_CHAR_CAP characters, the cut counted.
  const flood = Array.from({ length: mod.TEXT_LINES_PER_STEP + 7 }, (_, i) => `not ok ${i} - flood`).join("\n");
  const capped = mod.describeFailingText("rule-checks", [{ id: "rule-checks", outcome: "failure", report: flood }]);
  assert.equal(capped.split("\n").filter((l) => l.endsWith("- flood")).length, mod.TEXT_LINES_PER_STEP);
  assert.match(capped, /\n7 failure line\(s\) cut; the job's full log has them\.$/);
  const wide = Array.from({ length: mod.TEXT_LINES_PER_STEP }, (_, i) => `not ok ${i} ${"x".repeat(4000)}`).join("\n");
  const huge = mod.describeFailingText("depcruise", [{ id: "depcruise", outcome: "failure", report: wide }, { id: "cycle-ratchet", outcome: "failure", report: wide }]);
  assert.ok(huge.length <= mod.TEXT_CHAR_CAP, `text is ${huge.length} characters`);
  assert.match(huge, /failure line\(s\) cut/);

  // End to end through the real step: the post carries the text, the green posts carry no step section.
  const run = runReporter({ OUTCOME_RULE_CHECKS: "failure" }, { "rule-checks": RULE_CHECKS_RED });
  assert.equal(run.status, 0, run.stderr);
  const posted = run.calls.find((c) => c.name === "rule-checks");
  assert.ok(posted?.text, `rule-checks must be posted with output[text]: ${posted?.argv}`);
  assert.match(posted.text, /step rule-checks: failure/);
  assert.match(posted.text, /not ok 2 - test\/a-regex-has-both-arms\.test\.ts/);
  assert.match(posted.text, /##\[error\]rule-checks: 1 suite\(s\) failed/);
  for (const call of run.calls.filter((c) => c.name !== "rule-checks")) assert.doesNotMatch(call.text ?? "", /^step /m, `${call.name} passed`);

  // A text-mode failure never stops the post: with the script unable to run, every gate still posts.
  const broken = runReporter({ OUTCOME_RULE_CHECKS: "failure" }, { "rule-checks": RULE_CHECKS_RED }, { NODE_OPTIONS: "--no-such-flag" });
  assert.equal(broken.status, 0, broken.stderr);
  assert.equal(broken.calls.find((c) => c.name === "rule-checks")?.conclusion, "failure");
  assert.equal(broken.calls.find((c) => c.name === "rule-checks")?.text, undefined);
  assert.equal(broken.calls.length, run.calls.length);
});

test("W1-T14816 criterion 2: the posted check run links to the hosting job", async () => {
  const mod = await loadModule();
  assert.match(mod.describeFailingText("leak-grep", [{ id: "leak-grep", outcome: "success" }], { jobUrl: JOB_URL }), new RegExp(`^Job that ran this check's step\\(s\\): ${JOB_URL.replace(/[/.]/g, "\\$&")}$`));
  const out: string[] = [];
  assert.equal(mod.main(["--text", "--job-url", JOB_URL, "rule-checks", "failure"], { env: {}, log: (s) => out.push(s) }), 0);
  assert.match(out[0] ?? "", new RegExp(`^Job that ran this check's step\\(s\\): ${JOB_URL.replace(/[/.]/g, "\\$&")}\n`));

  // Every post, red or green, sets details_url to the light-gates job that ran its steps, and the
  // text names the same job (the link survives where GitHub keeps its own details_url).
  const run = runReporter({ OUTCOME_CLAIMS: "failure" }, {});
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.calls.length >= 16, `expected every gate posted, saw ${run.calls.length}`);
  for (const call of run.calls) {
    assert.equal(call.detailsUrl, JOB_URL, `${call.name} links its job`);
    assert.ok(call.text?.startsWith(`Job that ran this check's step(s): ${JOB_URL}`), `${call.name} text names its job`);
  }
});

test("W1-T14816 criterion 3: name, conclusion and external_id are unchanged", async () => {
  // The same reporter run, red and green: the name set, each conclusion, external_id, title and
  // summary are exactly what the post carried before text mode existed.
  const red = runReporter({ OUTCOME_RULE_CHECKS: "failure", OUTCOME_WRITE_ONLY_LEDGER_STEP: "failure" }, { "rule-checks": RULE_CHECKS_RED });
  const green = runReporter({}, {});
  assert.equal(red.status, 0, red.stderr);
  assert.equal(green.status, 0, green.stderr);
  assert.deepEqual(red.calls.map((c) => c.name).sort(), green.calls.map((c) => c.name).sort());
  for (const call of [...red.calls, ...green.calls]) {
    assert.equal(call.externalId, "run:45603893300:2:job:139176074929", `${call.name} external_id`);
    const failing = red.calls.includes(call) && (call.name === "rule-checks" || call.name === "comment-load-ratchet");
    assert.equal(call.conclusion, failing ? "failure" : "success", `${call.name} conclusion`);
    assert.match(call.summary, new RegExp(`^W1-T4399: reported by this job's ${call.name} step\\(s\\) \\(outcome\\(s\\): .+\\)$`), `${call.name} summary`);
  }
  assert.equal(red.calls.find((c) => c.name === "rule-checks")?.title, "rule-checks");
  assert.equal(red.calls.find((c) => c.name === "comment-load-ratchet")?.title, "write-only-ledger-step");
  assert.equal(red.calls.find((c) => c.name === "comment-load-ratchet")?.summary,
    "W1-T4399: reported by this job's comment-load-ratchet step(s) (outcome(s): comment-load-ratchet=success expiring-fixture-census=success console-parity=success write-only-ledger-step=failure)");

  // The title mode itself is untouched by the new flags.
  const mod = await loadModule();
  const out: string[] = [];
  mod.main(["comment-load-ratchet", "comment-load-ratchet=success", "write-only-ledger-step=failure"], { env: {}, log: (s) => out.push(s) });
  assert.deepEqual(out, ["write-only-ledger-step"]);
});
