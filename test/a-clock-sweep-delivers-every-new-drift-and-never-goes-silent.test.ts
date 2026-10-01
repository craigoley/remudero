import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { ghShim } from "./helpers/gh-shim.js";

// `scripts/**` is outside tsconfig's `include`; load the REAL modules through a dynamic specifier
// so these assertions run against the files the workflow executes (the idiom of
// test/clock-sweep.test.ts and test/needs-human-issue.test.ts).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptUrl = (name: string): string => pathToFileURL(join(REPO_ROOT, "scripts", name)).href;

type Entry = { suite: string; fuse: number | null; detail: string };
type Delivered = { source: string; title: string; body: string; anyLabel?: boolean };
type DeliverFn = (args: Delivered) => { action: string; number?: number; url?: string };

const deliverMod = (await import(scriptUrl("clock-sweep-deliver.mjs"))) as {
  parseNewDrift: (reportText: string) => Entry[];
  issueFor: (entry: Entry, ctx: { runUrl?: string; when?: string }) => { source: string; title: string; body: string };
  deliverNewDrift: (opts: {
    reportText: string;
    deliverFn?: DeliverFn;
    env?: Record<string, string>;
    log?: (m: string) => void;
    error?: (m: string) => void;
  }) => number;
  main: (opts: {
    argv?: string[];
    env?: Record<string, string>;
    readFile?: (p: string) => string;
    deliverFn?: DeliverFn;
    log?: (m: string) => void;
    error?: (m: string) => void;
  }) => number;
};
const issueMod = (await import(scriptUrl("needs-human-issue.mjs"))) as {
  deliver: (
    input: { source: string; title: string; body: string; label?: string; repo?: string; anyLabel?: boolean },
    exec: (file: string, args: string[]) => string,
  ) => { action: string; number?: number; url?: string; marker: string };
  markerFor: (source: string) => string;
};
const sweepMod = (await import(scriptUrl("clock-sweep.mjs"))) as {
  main: (opts: {
    argv?: string[];
    run?: (suite: string, days: number) => { failed: boolean; output?: string };
    derive?: () => string[];
    touchedAt?: () => Map<string, number>;
    ceiling?: number;
    recorded?: string[];
    log?: (m: string) => void;
    write?: (m: string) => void;
  }) => number;
};
const { parseNewDrift, issueFor, deliverNewDrift, main: deliverMain } = deliverMod;
const { deliver, markerFor } = issueMod;

const WORKFLOW = readFileSync(join(REPO_ROOT, ".github", "workflows", "clock-sweep.yml"), "utf8");

/** The text of the workflow step whose `name:` starts with `name`. */
function stepBlock(name: string): string {
  const parts = WORKFLOW.split(/\n {6}- /);
  const hit = parts.find((p) => p.startsWith(`name: ${name}`));
  assert.ok(hit, `workflow step "${name}" must exist`);
  return hit;
}

/** A report in the shape scripts/clock-sweep.mjs prints, with a detail block per suite. */
function report(suites: Array<{ name: string; fuse?: number; noBlock?: boolean }>): string {
  const out = ["clock-sweep — shift +400d", "", `WALL-CLOCK DRIFT — ${suites.length} suite(s) pass today and FAIL in the future.`];
  for (const s of suites) {
    if (s.noBlock) continue;
    out.push(
      "",
      `  test/${s.name}.test.ts`,
      `    fails by      : +${s.fuse ?? 7} days from now`,
      `    failing test  : ${s.name} case`,
      "    detail        :",
      `      assertion failed in ${s.name}`,
      "      ",
      "      a blank line inside the detail",
    );
  }
  out.push("", `NEW DRIFT — ${suites.length} suite(s) NOT in scripts/clock-sweep-baseline.json's recorded set:`);
  for (const s of suites) out.push(`  test/${s.name}.test.ts`);
  out.push("A suite that STARTED drifting is a regression at any count.", "", "AT CEILING — 11 drifting suite(s).");
  return out.join("\n");
}

/** A fake `gh` over the open-issue set: label-filtered lists see `labelled`, an unfiltered list sees `all`. */
function fakeGh(labelled: Array<{ number: number; body: string }>, all: Array<{ number: number; body: string }>) {
  const calls: string[][] = [];
  const exec = (_file: string, args: string[]): string => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") return JSON.stringify(args.includes("--label") ? labelled : all);
    if (args[1] === "create") return `https://github.com/o/r/issues/${900 + calls.length}\n`;
    return "";
  };
  return { calls, exec };
}

test("W1-T5033: a cancelled sweep still reaches the delivery step", () => {
  const aggregate = stepBlock("Open or update a needs-human issue on drift");
  assert.match(aggregate, /\n {8}if: \(failure\(\) \|\| cancelled\(\)\) && github\.event_name != 'pull_request'\n/);
  assert.match(aggregate, /SWEEP_OUTCOME: \$\{\{ steps\.sweep\.outcome \}\}/, "the outcome rides env, never interpolated into the script");
  assert.match(aggregate, /--preamble/);
  assert.match(aggregate, /test -s sweep-report\.txt \|\|/, "the empty-report fallback is kept");
  const fanOut = stepBlock("Open one needs-human issue per NEW drifting suite");
  assert.match(fanOut, /\n {8}if: failure\(\) && github\.event_name != 'pull_request'\n/);
  assert.match(fanOut, /node scripts\/clock-sweep-deliver\.mjs --report sweep-report\.txt/);
  // the pull_request event stays excluded everywhere and the timeout backstop is untouched
  assert.ok(!/cancelled\(\)[^\n]*\n[^\n]*\n/.test(stepBlock("Upload the sweep report")), "the upload step is not conditioned on cancelled()");
  assert.match(WORKFLOW, /timeout-minutes: 30\n/);
});

test("W1-T5033: each new drifting suite opens its own needs-human issue beside an open shared thread", () => {
  const shared = { number: 5513, body: `${markerFor("clock-sweep")}\nthe aggregate thread` };
  const gh = fakeGh([shared], [shared]);
  const lines: string[] = [];
  const code = deliverNewDrift({
    reportText: report([{ name: "alpha-suite", fuse: 14 }, { name: "bravo-suite", fuse: 30 }]),
    deliverFn: (a) => deliver(a, gh.exec),
    env: { RUN_URL: "https://github.com/o/r/actions/runs/1", RUN_WHEN: "schedule" },
    log: (m) => lines.push(m),
    error: (m) => lines.push(m),
  });
  assert.equal(code, 0);
  const creates = gh.calls.filter((a) => a[0] === "issue" && a[1] === "create");
  const comments = gh.calls.filter((a) => a[0] === "issue" && a[1] === "comment");
  assert.equal(creates.length, 2, "two new suites are two issues");
  assert.equal(comments.length, 0, "never a comment on the old shared thread");
  const bodies = creates.map((a) => a[a.indexOf("--body") + 1]);
  assert.ok(bodies[0].includes("<!-- needs-human:clock-sweep:alpha-suite -->"));
  assert.ok(bodies[1].includes("<!-- needs-human:clock-sweep:bravo-suite -->"));
  assert.ok(!bodies[0].includes("<!-- needs-human:clock-sweep -->"), "the per-suite marker is not the aggregate marker");
  assert.ok(creates.every((a) => a.includes("--label") && a[a.indexOf("--label") + 1] === "needs-human"));
  assert.match(creates[0][creates[0].indexOf("--title") + 1], /^clock-sweep: alpha-suite drifts on the wall clock \(fails by \+14 days\)$/);
});

test("W1-T5033: a relabelled per-suite issue is commented on, never duplicated", () => {
  const triaged = { number: 7059, body: `${markerFor("clock-sweep:alpha-suite")}\nearlier report` };
  // The needs-human label was removed by a human: only the UNFILTERED listing still sees it.
  const gh = fakeGh([], [triaged]);
  const code = deliverNewDrift({
    reportText: report([{ name: "alpha-suite" }]),
    deliverFn: (a) => deliver(a, gh.exec),
    env: {},
    log: () => {},
    error: () => {},
  });
  assert.equal(code, 0);
  const list = gh.calls.find((a) => a[1] === "list")!;
  assert.ok(!list.includes("--label"), "the per-suite lookup drops the label filter");
  assert.equal(list[list.indexOf("--limit") + 1], "1000");
  assert.deepEqual(gh.calls.filter((a) => a[1] === "create"), [], "never a duplicate issue");
  const comment = gh.calls.find((a) => a[1] === "comment")!;
  assert.equal(comment[2], "7059");
});

test("W1-T5033: a report with no new drift delivers nothing", () => {
  const delivered: Delivered[] = [];
  const quiet = [
    "clock-sweep — shift +400d",
    "WALL-CLOCK DRIFT — 1 suite(s) pass today and FAIL in the future.",
    "",
    "  test/old-suite.test.ts",
    "    fails by      : +7 days from now",
    "",
    "AT CEILING — 1 drifting suite(s) matches the recorded ceiling of 1 exactly.",
  ].join("\n");
  for (const text of [quiet, "PASS — 10 suite(s) immune at +400d.", ""]) {
    const code = deliverNewDrift({ reportText: text, deliverFn: (a) => (delivered.push(a), { action: "create" }), env: {}, log: () => {}, error: () => {} });
    assert.equal(code, 0);
  }
  assert.deepEqual(delivered, []);
  assert.deepEqual(parseNewDrift(quiet), []);
});

test("W1-T5033: a failed delivery exits 1, names the suite, and does not stop the rest", () => {
  const seen: string[] = [];
  const errors: string[] = [];
  const code = deliverNewDrift({
    reportText: report([{ name: "alpha-suite" }, { name: "bravo-suite" }, { name: "charlie-suite" }]),
    deliverFn: (a) => {
      seen.push(a.source);
      if (a.source === "clock-sweep:bravo-suite") throw new Error("api down");
      return { action: "create", url: "u" };
    },
    env: {},
    log: () => {},
    error: (m) => errors.push(m),
  });
  assert.equal(code, 1);
  assert.deepEqual(seen, ["clock-sweep:alpha-suite", "clock-sweep:bravo-suite", "clock-sweep:charlie-suite"]);
  assert.ok(errors.some((e) => e.includes("bravo-suite") && e.includes("api down")), "the failing suite is named");
  // An unreadable report is exit 1, never a silent 0, and so is a missing --report.
  const noisy: string[] = [];
  assert.equal(
    deliverMain({ argv: ["--report", "/nonexistent/sweep-report.txt"], env: {}, log: () => {}, error: (m) => noisy.push(m) }),
    1,
  );
  assert.equal(deliverMain({ argv: [], env: {}, log: () => {}, error: (m) => noisy.push(m) }), 1);
  assert.ok(noisy.some((m) => /report/.test(m)));
});

/** Capture what scripts/clock-sweep.mjs prints when `fails` decides which shifts fail. */
function sweepOutput(fails: (days: number) => boolean): string {
  const lines: string[] = [];
  sweepMod.main({
    argv: [],
    derive: () => ["drifty"],
    touchedAt: () => new Map(),
    run: (_s, days) => ({ failed: fails(days), output: fails(days) ? "not ok 1 - a case\n" : "" }),
    ceiling: 0,
    recorded: [],
    log: (m) => lines.push(m),
    write: () => {},
  });
  return lines.join("\n");
}

test("W1-T5033: a failure at +0 days is reported as not clock drift", () => {
  const text = sweepOutput(() => true);
  assert.match(text, /fails by\s+: \+0 days - NOT CLOCK DRIFT: fails with no shift \(a runner or environment defect, for example a missing browser\)/);
  assert.ok(!/only at the full shift/.test(text), "a +0 fuse is not the full-shift case");
  assert.ok(!/\+7 days/.test(text), "no fuse rung below +0 is invented");
  const [entry] = parseNewDrift(text);
  assert.equal(entry.suite, "drifty");
  assert.equal(entry.fuse, 0);
  const issue = issueFor(entry, { runUrl: "https://github.com/o/r/actions/runs/1", when: "schedule" });
  assert.equal(issue.title, "clock-sweep: drifty fails with NO clock shift (a runner or environment defect, NOT clock drift)");
  assert.equal(issue.source, "clock-sweep:drifty");
});

test("W1-T5033: a suite that only fails shifted keeps its fuse and is not labelled unshifted", () => {
  const text = sweepOutput((days) => days >= 30);
  assert.match(text, /fails by\s+: \+30 days from now/);
  assert.ok(!/NOT CLOCK DRIFT/.test(text));
  const [entry] = parseNewDrift(text);
  assert.equal(entry.fuse, 30);
  const issue = issueFor(entry, { runUrl: "https://github.com/o/r/actions/runs/1", when: "schedule" });
  assert.equal(issue.title, "clock-sweep: drifty drifts on the wall clock (fails by +30 days)");
  assert.match(issue.body, /CLOSED BY THE FIXING PR/);
  assert.match(issue.body, /driftingSuitesAtCapture/);
  assert.match(issue.body, /https:\/\/github\.com\/o\/r\/actions\/runs\/1/);
});

test("W1-T5033: the shared one-thread-per-source delivery and its success-only resolver are unchanged", () => {
  const shared = { number: 5513, body: `${markerFor("clock-sweep")}\nthe aggregate thread` };
  const gh = fakeGh([shared], []);
  const result = deliver({ source: "clock-sweep", title: "t", body: "b" }, gh.exec);
  assert.equal(result.action, "comment");
  assert.equal(result.number, 5513);
  assert.deepEqual(gh.calls[0], ["issue", "list", "--state", "open", "--label", "needs-human", "--limit", "100", "--json", "number,body,title"]);
  // the aggregate step still names the shared source, and the resolver is still success-only
  assert.match(stepBlock("Open or update a needs-human issue on drift"), /--source clock-sweep \\\n/);
  const resolver = stepBlock("Close this job's needs-human issue once it recovers");
  assert.match(resolver, /\n {8}if: success\(\) && github\.event_name != 'pull_request'\n/);
  assert.match(resolver, /--resolved --source clock-sweep/);
});

test("W1-T5033: a missing detail block keeps the suite with no fuse", () => {
  const entries = parseNewDrift(report([{ name: "alpha-suite", fuse: 90 }, { name: "bravo-suite", noBlock: true }]));
  assert.deepEqual(entries.map((e) => [e.suite, e.fuse]), [["alpha-suite", 90], ["bravo-suite", null]]);
  assert.ok(entries[0].detail.includes("assertion failed in alpha-suite"));
  assert.ok(entries[0].detail.includes("a blank line inside the detail"));
  assert.equal(entries[1].detail, "");
  assert.match(issueFor(entries[1], {}).title, /^clock-sweep: bravo-suite drifts on the wall clock/);
});

test("W1-T5033: the CLI reads a real report and delivers through gh on PATH", () => {
  const shim = ghShim(
    [
      { when: "issue list", stdout: "[]" },
      { when: "issue create", stdout: "https://github.com/o/r/issues/1" },
    ],
    { kind: "clock-sweep-deliver" },
  );
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}clock-sweep-deliver-`));
  try {
    const reportPath = join(dir, "sweep-report.txt");
    writeFileSync(reportPath, report([{ name: "alpha-suite", fuse: 14 }]));
    const r = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "clock-sweep-deliver.mjs"), "--report", reportPath], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${shim.dir}:${process.env.PATH}`, RUN_URL: "https://github.com/o/r/actions/runs/9", RUN_WHEN: "schedule" },
    });
    assert.equal(r.status, 0, r.stderr);
    const calls = shim.calls();
    const list = calls.find((c) => c.startsWith("issue list"))!;
    assert.ok(list.includes("--limit 1000") && !list.includes("--label"), "the unfiltered lookup ran");
    const create = calls.find((c) => c.startsWith("issue create"))!;
    assert.ok(create.startsWith("issue create --title clock-sweep: alpha-suite drifts on the wall clock (fails by +14 days) --label needs-human --body"));
    assert.ok(calls.join("\n").includes("<!-- needs-human:clock-sweep:alpha-suite -->"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
