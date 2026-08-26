import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

// ── W1-T2909-class: COVERAGE FAILURES MUST DESCRIBE THEMSELVES ──────────────
//
// A red `coverage-ratchet` check run carried ONE annotation, in full: `Process completed with exit
// code 1.` The uncovered-line list existed only in the job log, and the log blob is unreachable
// from a proxied reader (`/actions/jobs/<id>/logs` 302s to blob.core.windows.net; the CONNECT
// tunnel 403s) — so a blocked PR could not be diagnosed without a human on an unproxied machine.
//
// The channel these tests pin is the WORKFLOW COMMAND, which GitHub turns into a check-run
// annotation readable at `/check-runs/<id>/annotations` (200 through the same proxy that refuses
// the blob). `output.summary` is NOT the channel: no job can write it — it belongs to whoever
// created the check run — and it reads empty on every run here.
//
// BOTH SCRIPTS ARE PINNED BY THE SAME BATTERY so the two gates cannot drift apart in how they
// report. Nothing here asserts on what BLOCKS: the gate's exit codes and thresholds are covered by
// test/{coverage-ratchet,diff-coverage}.test.ts and are untouched by this surface.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(__dirname, "..", "scripts");

type ReportModule = {
  formatCiReport: (tool: string, headline: string, details: string[], opts?: { cap?: number }) => string;
  encodeAnnotation: (text: string) => string;
  emitCiReport: (
    tool: string,
    report: string,
    opts: {
      blocked: boolean;
      env?: NodeJS.ProcessEnv;
      log?: (line: string) => void;
      append?: (path: string, text: string) => void;
    },
  ) => boolean;
};

async function load(script: string): Promise<ReportModule> {
  return (await import(pathToFileURL(join(SCRIPTS, script)).href)) as ReportModule;
}

const SCRIPT_NAMES = ["coverage-ratchet.mjs", "diff-coverage.mjs"] as const;

/** Capture what an emit would send to each channel, without touching the real env or disk. */
function capture(mod: ReportModule, tool: string, report: string, blocked: boolean, env: NodeJS.ProcessEnv) {
  const logged: string[] = [];
  const appended: Array<{ path: string; text: string }> = [];
  const emitted = mod.emitCiReport(tool, report, {
    blocked,
    env,
    log: (l) => logged.push(l),
    append: (path, text) => appended.push({ path, text }),
  });
  return { emitted, logged, appended };
}

for (const script of SCRIPT_NAMES) {
  const tool = script.replace(/\.mjs$/, "");

  test(`${tool}: a BLOCKED run puts every uncovered line inside the annotation message`, async () => {
    const mod = await load(script);
    const details = ["src/a.ts:12", "src/a.ts:13", "src/b.ts:99"];
    const report = mod.formatCiReport(tool, "BLOCKED -- reasons:", details);
    const { emitted, logged, appended } = capture(mod, tool, report, true, {
      RMD_CI_REPORT: "1",
      GITHUB_STEP_SUMMARY: "/tmp/does-not-need-to-exist",
    });

    assert.equal(emitted, true);
    assert.equal(logged.length, 1, "exactly one annotation carries the whole list");
    const line = logged[0]!;
    assert.ok(line.startsWith(`::error title=${tool}::`), `workflow command, got: ${line.slice(0, 40)}`);

    // The decoded annotation must contain EVERY line — this is the whole point of the change.
    const decoded = line
      .replace(`::error title=${tool}::`, "")
      .replace(/%0A/g, "\n")
      .replace(/%0D/g, "\r")
      .replace(/%25/g, "%");
    for (const d of details) assert.ok(decoded.includes(d), `annotation must name ${d}`);
    assert.equal(decoded, report, "the annotation round-trips to the report verbatim");

    // ...and the step summary carries the same text.
    assert.equal(appended.length, 1);
    for (const d of details) assert.ok(appended[0]!.text.includes(d), `summary must name ${d}`);
  });

  test(`${tool}: a CLEAN run emits no annotation and no uncovered lines`, async () => {
    const mod = await load(script);
    const report = mod.formatCiReport(tool, "OK -- nothing to report.", []);
    const { emitted, logged, appended } = capture(mod, tool, report, false, {
      RMD_CI_REPORT: "1",
      GITHUB_STEP_SUMMARY: "/tmp/does-not-need-to-exist",
    });

    assert.equal(emitted, true);
    // NEGATIVE: a green run must never produce a failure annotation.
    assert.equal(logged.length, 0, "a clean run writes no ::error annotation");
    assert.equal(appended.length, 1);
    const text = appended[0]!.text;
    assert.ok(text.includes("OK -- nothing to report."));
    assert.ok(!text.includes("BLOCKED"), "a clean summary never says BLOCKED");
    assert.ok(!/:\d+/.test(text.replace(/^### .*$/m, "")), "a clean summary carries no file:line entries");
  });

  test(`${tool}: without the opt-in nothing is written, even on a blocked run in Actions`, async () => {
    const mod = await load(script);
    const report = mod.formatCiReport(tool, "BLOCKED -- reasons:", ["src/a.ts:12"]);
    // The test-spawn case: this job runs the whole suite, and the gate suites spawn these scripts
    // over BLOCKING fixtures inheriting the job env. Keying on GITHUB_ACTIONS would publish those
    // fixture failures as real annotations, so the opt-in must be the ONLY trigger.
    const { emitted, logged, appended } = capture(mod, tool, report, true, {
      GITHUB_ACTIONS: "true",
      GITHUB_STEP_SUMMARY: "/tmp/does-not-need-to-exist",
    });
    assert.equal(emitted, false, "no RMD_CI_REPORT ⇒ the reporter is inert");
    assert.equal(logged.length, 0);
    assert.equal(appended.length, 0);
  });

  test(`${tool}: the opt-in with no step-summary path still annotates`, async () => {
    const mod = await load(script);
    const report = mod.formatCiReport(tool, "BLOCKED -- reasons:", ["src/a.ts:12"]);
    const { emitted, logged, appended } = capture(mod, tool, report, true, { RMD_CI_REPORT: "1" });
    assert.equal(emitted, true);
    assert.equal(logged.length, 1, "the annotation is the load-bearing channel, not the summary");
    assert.equal(appended.length, 0, "no summary path ⇒ no append attempted");
  });

  test(`${tool}: a capped list says what it dropped rather than truncating silently`, async () => {
    const mod = await load(script);
    const details = Array.from({ length: 7 }, (_, i) => `src/x.ts:${i + 1}`);
    const report = mod.formatCiReport(tool, "BLOCKED -- reasons:", details, { cap: 3 });
    assert.ok(report.includes("src/x.ts:3"), "the kept entries are listed");
    assert.ok(!report.includes("src/x.ts:4"), "entries past the cap are not listed");
    assert.ok(report.includes("4 more not listed (cap 3)"), "the drop is named — no silent caps");
  });

  test(`${tool}: percent is escaped BEFORE the newline escapes, so a coverage figure survives`, async () => {
    const mod = await load(script);
    // `%` first or `%0A` would itself be re-escaped into `%250A` and the annotation would show the
    // literal text instead of a line break. Coverage reasons are full of percentages.
    assert.equal(mod.encodeAnnotation("80.00%\nnext"), "80.00%25%0Anext");
    assert.equal(mod.encodeAnnotation("a\r\nb"), "a%0D%0Ab");
    assert.equal(mod.encodeAnnotation("plain"), "plain");
  });
}
