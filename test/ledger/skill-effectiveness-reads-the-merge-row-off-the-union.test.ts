import assert from "node:assert/strict";
import { test } from "node:test";
import { readOnlyInspectionCommand } from "#src/lib/read-only-inspection.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

// W1-T10764: `buildSkillEffectivenessReport` credits a run whose PR a `verdict.merged` row names, but only if the
// caller's union read hands it that row. Every effectiveness caller filtered the union to `skills.selection` and
// `verdict`, so the join never saw a merge in production. This drives a real caller over a real ledger directory.

const SKILL = "fixture-skill";
const PR_URL = "https://github.com/acme/widgets/pull/601";

test("W1-T10764: rmd inspect's effectiveness read carries the merge row off the ledger union", (t) => {
  // The run's rows sit in a rotated archive and the sweep's merge, under its own run id, in the live ledger.
  const { dir } = writeLedger([
    { ts: "2026-10-20T11:00:00.000Z", run_id: "DAEMON-1793000000000", task_id: "W1-T6", step: "verdict.merged",
      verdict: "merged", pr_number: 601, pr_url: PR_URL, source: "sweep.credit_backfill" },
  ], {
    scope: t,
    rotations: [{
      at: "2026-10-20T10:45:00.000Z",
      gz: true,
      rows: [
        { ts: "2026-10-20T10:00:00.000Z", run_id: "W1-T6-1", task_id: "W1-T6", step: "skills.selection",
          task_type: "implement", approved_eligible_names: [SKILL], selected_names: [SKILL], budget_omitted_names: [],
          withheld_names: [] },
        { ts: "2026-10-20T10:30:00.000Z", run_id: "W1-T6-1", task_id: "W1-T6", step: "verdict", verdict: "handed_off",
          pr_url: PR_URL, reason: "pr_open_yield", lane: "run-task" },
      ],
    }],
  });
  const out: string[] = [];
  const err: string[] = [];
  t.mock.method(console, "log", (line: string) => out.push(line));
  t.mock.method(console, "error", (line: string) => err.push(line));
  assert.equal(readOnlyInspectionCommand(["--state-dir", dir, "skill", "effectiveness", SKILL]), 0, err.join("\n"));
  const selected = out.join("\n").split("\n").find((line) => line.startsWith("selected: "));
  assert.ok(selected, out.join("\n"));
  assert.match(selected, /; merged_runs=1;/);
  assert.match(selected, /; outcomes=merged=1$/);
});

test("W1-T10764: rmd inspect's effectiveness read carries a pr.terminal-only merge off the ledger union", (t) => {
  // The direct merge records only a `pr.terminal` row (task_id SWEEP, no run's task), which is most merges.
  const { dir } = writeLedger([
    { ts: "2026-10-20T11:00:00.000Z", task_id: "SWEEP", step: "pr.terminal", pr_url: PR_URL, pr_number: 601,
      state: "merged", source: "automerge.direct_merge" },
  ], {
    scope: t,
    rotations: [{
      at: "2026-10-20T10:45:00.000Z",
      gz: true,
      rows: [
        { ts: "2026-10-20T10:00:00.000Z", run_id: "W1-T6-1", task_id: "W1-T6", step: "skills.selection",
          task_type: "implement", approved_eligible_names: [SKILL], selected_names: [SKILL], budget_omitted_names: [],
          withheld_names: [] },
        { ts: "2026-10-20T10:30:00.000Z", run_id: "W1-T6-1", task_id: "W1-T6", step: "verdict", verdict: "handed_off",
          pr_url: PR_URL, reason: "pr_open_yield", lane: "run-task" },
      ],
    }],
  });
  const out: string[] = [];
  const err: string[] = [];
  t.mock.method(console, "log", (line: string) => out.push(line));
  t.mock.method(console, "error", (line: string) => err.push(line));
  assert.equal(readOnlyInspectionCommand(["--state-dir", dir, "skill", "effectiveness", SKILL]), 0, err.join("\n"));
  const selected = out.join("\n").split("\n").find((line) => line.startsWith("selected: "));
  assert.ok(selected, out.join("\n"));
  assert.match(selected, /; merged_runs=1;/);
});
