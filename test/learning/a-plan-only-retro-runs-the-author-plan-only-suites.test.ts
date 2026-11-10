// W1-T11337 — a retro whose prepublish diff is PLAN_ONLY runs the author lane's plan-only suite
// selection (`diff-class --list-plan-only-suites`, ~34 suites) instead of the changed-path
// plan-reading lane (272-639 suites). Hosted CI keeps the full plan-reading set as the gate.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  runRetroPrepublishPreflight,
  type RetroChangedFiles,
  type RetroPrepublishRunner,
} from "#src/lib/retro-preflight.js";

const provenance = { provider: "claude" as const, model: "architect", servedModel: null, effort: "high", sessionId: "retro-11337" };
const ok = (stdout = "", stderr = "") => ({ status: 0, signal: null, stdout, stderr });
const ONLY = "test/plan-only-a.test.ts\ntest/plan-only-b.test.ts\n";
const READING = "test/plan-only-a.test.ts\ntest/plan-only-b.test.ts\ntest/reader-c.test.ts\ntest/reader-d.test.ts\ntest/reader-e.test.ts\n";

interface Row { step: string; extra: Record<string, unknown> }

interface Fake { diffClass: string; planOnly?: ReturnType<typeof ok> }

function fake({ diffClass, planOnly = ok(ONLY) }: Fake) {
  const calls: string[][] = [];
  const listed: string[] = [];
  const run: RetroPrepublishRunner = (_command, args) => {
    calls.push(args);
    const at = args.indexOf("--changed-files");
    if (at >= 0) listed.push(readFileSync(args[at + 1]!, "utf8"));
    if (args.includes("--list-plan-only-suites")) return planOnly;
    if (args.includes("--list-plan-reading-suites")) {
      return at >= 0
        ? ok(READING, "diff-class: plan-reading selected_count=5 previous_count=9\n")
        : ok(READING, "diff-class: plan-reading selected_count=9 previous_count=9\n");
    }
    if (args.includes("scripts/diff-class.mjs")) return ok(`${diffClass}\n`);
    return ok("# tests 1\n# pass 1\n");
  };
  return { run, calls, listed };
}

async function preflight(run: RetroPrepublishRunner, changed: RetroChangedFiles) {
  const rows: Row[] = [];
  const slotRoot = mkdtempSync(join(tmpdir(), "rmd-test-retro-11337-slot-"));
  const result = await runRetroPrepublishPreflight({
    worktreePath: "/tmp/retro-11337-worktree",
    provenance,
    remotePrExisted: false,
    repair: async () => {},
    regenerateHarnessArtifacts: () => {},
    log: (step, row) => { if (step !== "retro.preflight_started") rows.push({ step, extra: row }); },
    deps: {
      run,
      changedFiles: async () => changed,
      testSlot: { dir: join(slotRoot, "slots"), slots: 1, load: () => ({ cores: 8, load1: 0 }),
        memoryHeadroom: () => undefined, binaryExists: () => false, log: () => {} },
    },
  });
  return { result, rows };
}

const suiteRun = (calls: string[][]) => calls.find((args) => args.includes("scripts/test-with-retry.mjs"))!;

test("W1-T11337: a PLAN_ONLY retro diff runs exactly the plan-only suites and ledgers mode plan-only", async () => {
  const { run, calls, listed } = fake({ diffClass: "PLAN_ONLY" });
  const { result, rows } = await preflight(run, { files: ["plan/tasks.d/a.yaml", "plan/tasks.d/b.yaml"] });

  assert.equal(result.ok, true);
  assert.equal(result.suiteCount, 2);
  const planOnlyListing = calls.find((args) => args.includes("--list-plan-only-suites"))!;
  assert.ok(planOnlyListing.includes("--changed-files"), "the plan-only listing reads the same changed-file list");
  assert.ok(listed.every((text) => text === "plan/tasks.d/a.yaml\nplan/tasks.d/b.yaml\n"));
  const run1 = suiteRun(calls);
  assert.ok(run1.includes("test/plan-only-a.test.ts") && run1.includes("test/plan-only-b.test.ts"));
  assert.ok(!run1.includes("test/reader-c.test.ts"), "plan-reading-only suites are left to hosted CI");
  assert.equal(rows[0]!.step, "retro.preflight_passed");
  assert.equal(rows[0]!.extra.suite_selection, "plan-only");
  assert.equal(rows[0]!.extra.suite_selection_reason, "diff class PLAN_ONLY (author plan-only selection)");
  assert.equal(rows[0]!.extra.suite_count, 2);
  assert.equal(rows[0]!.extra.broad_suite_count, 5, "the plan-reading count it replaced");
  assert.equal(rows[0]!.extra.changed_path_count, 2);
});

test("W1-T11337: DOCS_ONLY and SOURCE diffs and an unreadable change list keep the plan-reading enumeration", async () => {
  const docs = fake({ diffClass: "DOCS_ONLY" });
  const d = await preflight(docs.run, { files: ["docs/ORIENTATION.md"] });
  assert.ok(!docs.calls.some((args) => args.includes("--list-plan-only-suites")));
  assert.equal(d.rows[0]!.extra.suite_selection, "changed-paths");
  assert.equal(d.result.suiteCount, 5);

  const source = fake({ diffClass: "SOURCE" });
  const s = await preflight(source.run, { files: ["src/x.ts"] });
  assert.ok(!source.calls.some((args) => args.includes("--list-plan-only-suites")));
  assert.equal(s.rows[0]!.extra.suite_selection, "broad");

  const unreadable = fake({ diffClass: "PLAN_ONLY" });
  const u = await preflight(unreadable.run, { unreadable: "no git" });
  assert.ok(!unreadable.calls.some((args) => args.includes("--list-plan-only-suites")));
  assert.equal(u.rows[0]!.extra.suite_selection, "broad");
});

test("W1-T11337: a failed or empty plan-only listing falls back to the plan-reading lane and never runs zero suites", async () => {
  const failed = fake({ diffClass: "PLAN_ONLY", planOnly: { status: 1, signal: null, stdout: "", stderr: "boom" } });
  const f = await preflight(failed.run, { files: ["plan/tasks.d/a.yaml"] });
  assert.equal(f.result.suiteCount, 5);
  assert.equal(f.rows[0]!.extra.suite_selection, "changed-paths");
  assert.match(String(f.rows[0]!.extra.suite_selection_reason), /plan-only listing failed \(exit 1\); plan-reading fallback/);

  const empty = fake({ diffClass: "PLAN_ONLY", planOnly: ok("") });
  const e = await preflight(empty.run, { files: ["plan/tasks.d/a.yaml"] });
  assert.equal(e.result.suiteCount, 5);
  assert.match(String(e.rows[0]!.extra.suite_selection_reason), /plan-only listing empty; plan-reading fallback/);
});

test("W1-T11337: an unconfirmed process cleanup on the plan-only listing is a failure, never a fallback run", async () => {
  const dirty = fake({ diffClass: "PLAN_ONLY", planOnly: { ...ok(ONLY), cleanupError: new Error("group survived") } });
  const d = await preflight(dirty.run, { files: ["plan/tasks.d/a.yaml"] });
  assert.equal(d.result.ok, false);
  assert.ok(!dirty.calls.some((args) => args.includes("--list-plan-reading-suites")), "no plan-reading fallback after an unconfirmed cleanup");
  assert.ok(!dirty.calls.some((args) => args.includes("scripts/test-with-retry.mjs")), "no suite run");
});
