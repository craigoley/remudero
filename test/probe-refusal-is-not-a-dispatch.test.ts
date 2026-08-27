import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  DEFAULT_MAX_TASK_DISPATCHES,
  dispatchesEver,
  dispatchesWithoutNewOwnedPr,
  isDispatchBreakerTripped,
  isLifetimeDispatchCapExceeded,
} from "../src/lib/status.js";

// ── W1-T2423: A PROBE REFUSAL IS COUNTED AS A DISPATCH THAT PRODUCED NOTHING.
//
// `dispatchesWithoutNewOwnedPr` increments on `run.start`, and the containment and isolation
// preflights both refuse BEFORE any task worker runs — run-task.ts says so on each in terms
// ("before any task worker runs" / "before any task worker (recon/implement) runs", both FAIL
// CLOSED). So a refusal there tested nothing about the task's own ability to open a PR, yet it
// counted against a bound that measures exactly that.
//
// MEASURED on the fleet (2026-08-27, three-form union; per-form read control `dispatch.skipped`
// at 10 live + 2,075 rotated; 517 distinct verdict rows): `blocked_containment` reads 94 rows
// across 63 DISTINCT TASKS and W1-T1279's 5 is the maximum — the one task that ever reached the
// bound on probe refusals alone. It was refused for 84h 19m; the sixth run opened a PR in twelve
// minutes.
//
// THE DISCRIMINATOR IS ALREADY ON THE ROWS. W1-T2249 excluded only the transport class, keyed on
// `check === "spawn-transport-failure"` — a value stamped at WRITE time, which ZERO of those 517
// verdict rows carry, and which therefore makes any such exclusion FORWARD-ONLY over a
// backward-looking counter: it could never clear a breaker tripped before the symbol existed.
// W1-T2249 is cited, not re-litigated — its arm is a strict SUBSET of the rule below, so its
// behaviour is preserved rather than replaced.
//
// AND THE CONTRAST CASE IS THE TEST, NOT AN AFTERTHOUGHT. W1-T2323's five runs read
// `verdict: "no_pr"`, `check: null` — the worker RAN and produced nothing, five times. `no_pr`
// reads 35 distinct rows and W1-T2323's 5 is the maximum there too, so the corpus's only two
// tripped tasks sit on OPPOSITE sides of this line.

function runStart(taskId: string, runId: string): Record<string, unknown> {
  return { ts: `2026-08-24T00:00:00.000Z`, step: "run.start", task_id: taskId, run_id: runId };
}

function verdictRow(taskId: string, runId: string, verdict: string, check: string | null): Record<string, unknown> {
  return { ts: "2026-08-24T00:00:01.000Z", step: "verdict", task_id: taskId, run_id: runId, verdict, check };
}

/** W1-T1279 as the fleet actually recorded it: five containment refusals, every one
 *  `check: "outside-cwd-denial"` — never the transport symbol W1-T2249's arm requires. */
function w1t1279(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 5; i++) {
    const runId = `W1-T1279-${i}`;
    out.push(runStart("W1-T1279", runId));
    out.push(verdictRow("W1-T1279", runId, "blocked_containment", "outside-cwd-denial"));
  }
  return out;
}

/** W1-T2323 as the fleet actually recorded it: five runs that REACHED the worker and produced
 *  no PR. `check: null` — there is no containment refusal here at all. */
function w1t2323(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 5; i++) {
    const runId = `W1-T2323-${i}`;
    out.push(runStart("W1-T2323", runId));
    out.push(verdictRow("W1-T2323", runId, "no_pr", null));
  }
  return out;
}

test("W1-T2423: a run whose own verdict is blocked_containment does not count toward the dispatch breaker", () => {
  const lines = w1t1279();
  assert.equal(dispatchesWithoutNewOwnedPr(lines, "W1-T1279"), 0, "five probe refusals tested the host, not the task");
  assert.equal(isDispatchBreakerTripped(lines, "W1-T1279"), false, "and so the breaker must not be tripped by them");
});

test("W1-T2423: the five historical runs are excluded by their OWN VERDICT, not by any check symbol", () => {
  // The rows as written on 2026-08-24 — before `spawn-transport-failure` existed. A rule keyed on
  // that symbol reads them as ordinary dispatches forever; a rule keyed on the verdict does not.
  const lines = w1t1279();
  assert.ok(
    lines.every((l) => l.step !== "verdict" || l.check === "outside-cwd-denial"),
    "fixture fidelity: every verdict row carries the check the fleet actually wrote",
  );
  assert.equal(dispatchesWithoutNewOwnedPr(lines, "W1-T1279"), 0, "excluded despite carrying no transport symbol");

  // W1-T2249's own class is a STRICT SUBSET and still excluded — its behaviour is preserved.
  const transport = [runStart("W1-T2249F", "r0"), verdictRow("W1-T2249F", "r0", "blocked_containment", "spawn-transport-failure")];
  assert.equal(dispatchesWithoutNewOwnedPr(transport, "W1-T2249F"), 0, "the transport class stays excluded");
});

test("W1-T2423: the contrast task with five no-pr runs still trips at the same threshold", () => {
  const lines = w1t2323();
  assert.equal(
    dispatchesWithoutNewOwnedPr(lines, "W1-T2323"),
    DEFAULT_MAX_TASK_DISPATCHES,
    "the worker RAN five times and produced nothing — every one of these must still count",
  );
  assert.equal(isDispatchBreakerTripped(lines, "W1-T2323"), true, "this is exactly what the bound exists for");
});

test("W1-T2423: the two tripped tasks in the corpus separate — one clears, one does not", () => {
  // Both histories in ONE ledger, as they really are, so the rule cannot pass by only ever seeing
  // one shape at a time.
  const lines = [...w1t1279(), ...w1t2323()];
  assert.equal(isDispatchBreakerTripped(lines, "W1-T1279"), false, "false positive clears");
  assert.equal(isDispatchBreakerTripped(lines, "W1-T2323"), true, "true positive does not");
});

test("W1-T2423: a run that reached the worker and produced no PR still counts exactly as it does today", () => {
  // Every non-pre-worker verdict the corpus actually carries, plus a run with NO verdict row at
  // all (a crash): all of them still count. Unknown must never read as excused.
  for (const v of ["no_pr", "blocked_ci", "blocked", "pr_attribution_failed", "failed"]) {
    const lines = [runStart("W1-TX", "r0"), verdictRow("W1-TX", "r0", v, null)];
    assert.equal(dispatchesWithoutNewOwnedPr(lines, "W1-TX"), 1, `${v} must still count`);
  }
  assert.equal(dispatchesWithoutNewOwnedPr([runStart("W1-TX", "r0")], "W1-TX"), 1, "a run with no verdict row still counts");
});

test("W1-T2423: an isolation refusal is the same statement and is excluded on the same reasoning", () => {
  const lines = [runStart("W1-TISO", "r0"), verdictRow("W1-TISO", "r0", "blocked_isolation", "inherited-functions")];
  assert.equal(dispatchesWithoutNewOwnedPr(lines, "W1-TISO"), 0, "the isolation preflight also refuses before the worker");
});

test("W1-T2423: the exclusion is not an allow-list of check symbols and adds no new symbol", () => {
  // A check value nobody has ever written, and a row with NO check field at all. Both excluded:
  // the verdict alone decides, so no future probe reason needs registering anywhere.
  const novel = [runStart("W1-TN", "r0"), verdictRow("W1-TN", "r0", "blocked_containment", "a-reason-invented-tomorrow")];
  assert.equal(dispatchesWithoutNewOwnedPr(novel, "W1-TN"), 0, "an unknown check is still a pre-worker refusal");
  const noCheck = [runStart("W1-TN2", "r0"), { ts: "t", step: "verdict", task_id: "W1-TN2", run_id: "r0", verdict: "blocked_containment" }];
  assert.equal(dispatchesWithoutNewOwnedPr(noCheck, "W1-TN2"), 0, "a row with no check at all is still excluded");
  // And structurally: the counter compares no `check` value at all any more. Asserted on the
  // EXECUTABLE text, not the file — the doc above the rule still cites W1-T2249's symbol to
  // explain why its arm is subsumed, and a test that forbade the prose would forbid the citation.
  const src = readFileSync(new URL("../src/lib/status.ts", import.meta.url), "utf8");
  const executable = src
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("*") && !l.trimStart().startsWith("//") && !l.trimStart().startsWith("/*"))
    .join("\n");
  assert.equal(executable.includes("line.check ==="), false, "no check-symbol comparison survives — the verdict is the whole rule");
  assert.equal(executable.includes('"spawn-transport-failure"'), false, "and no check symbol is declared as a constant to match on");
});

test("W1-T2423: the reset rule is unchanged and a fresh owned PR still zeroes the streak", () => {
  const lines = [
    ...w1t2323(),
    { ts: "2026-08-27T21:11:57.575Z", step: "pr.opened", task_id: "W1-T2323", pr_url: "u" },
    runStart("W1-T2323", "after"),
  ];
  assert.equal(dispatchesWithoutNewOwnedPr(lines, "W1-T2323"), 1, "pr.opened resets, then the later run counts");
  const merged = [
    ...w1t2323(),
    { ts: "2026-08-27T22:00:00.000Z", step: "verdict.merged", task_id: "W1-T2323" },
  ];
  assert.equal(dispatchesWithoutNewOwnedPr(merged, "W1-T2323"), 0, "a merge credit still resets too");
});

test("W1-T2423: the lifetime dispatch cap is untouched and still counts every run", () => {
  const lines = w1t1279();
  assert.equal(dispatchesEver(lines, "W1-T1279"), 5, "the lifetime counter counts EVERY run.start, refusals included");
  assert.equal(
    isLifetimeDispatchCapExceeded(lines, "W1-T1279", 5),
    true,
    "the independent lifetime backstop still fires — this task narrows the STREAK counter only",
  );
});

test("W1-T2423: the bound stays five and nothing added resets a breaker or paces a call", () => {
  assert.equal(DEFAULT_MAX_TASK_DISPATCHES, 5, "this task must not raise the dispatch bound");
  const src = readFileSync(new URL("../src/lib/status.ts", import.meta.url), "utf8");
  const counter = src.slice(src.indexOf("export function dispatchesWithoutNewOwnedPr"));
  const body = counter.slice(0, counter.indexOf("\n}\n") + 3);
  for (const banned of ["setTimeout", "setInterval", "sleep", "await "]) {
    assert.equal(body.includes(banned), false, `the counter must stay a synchronous pure read — found ${banned}`);
  }
});
