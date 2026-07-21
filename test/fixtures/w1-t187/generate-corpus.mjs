#!/usr/bin/env node
// W1-T187 production-scale corpus generator — COMMITTED, deterministic, no Math.random/Date.now.
//
// Regenerates the three fixture files this task's acceptance criteria require:
//   plan.json     — >= 200 tasks (TASK_COUNT below)
//   ledger.ndjson — >= 18,000 NDJSON lines (LEDGER_LINE_COUNT below), the SAME shape
//                   readLedgerLines (src/lib/status.ts) parses: one JSON object per line.
//   github.json   — the PR-state map a fake GitHub gateway resolves against, keyed by PR url.
//
// Every task cycles through SIX derivation buckets (merged / running-open-PR / blocked-closed-PR
// / queued-no-evidence / in-flight-ledger-only-recent / orphaned-stale-dispatch) so the corpus
// exercises deriveStatus's full precedence ladder (source (a) ledger pr.opened, the liveness
// bound, needs-human via escalation, armed-awaiting-merge) — not a corpus of 220 identical
// "queued" rows, which would make the equivalence test between the hoisted and per-task ledger
// reads trivially true regardless of whether the hoist is actually correct.
//
// Run: `node test/fixtures/w1-t187/generate-corpus.mjs` from the repo root to regenerate.
// Deterministic: same output every run, byte-for-byte, so a diff after regenerating is a real
// generator change, not fixture drift.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// ── Scale (must satisfy the acceptance criteria's ">= 200 tasks, >= 18,000 ledger lines") ──
export const TASK_COUNT = 220;
const NOISE_LINE_COUNT = 17800; // task-less "daemon.tick"/"sweep.tick" bulk, mirrors production's
// mostly-non-task ledger volume (W1-T197's note: six daemon.* lines every 86s into the SAME
// ledger) -- combined with the ~500 per-task lines below this clears 18,000 with margin.

// A fixed instant, never Date.now() — every corpus consumer injects this as `deps.now` so the
// liveness-bound / recent-vs-orphaned split is exactly reproducible.
export const FIXED_NOW_ISO = "2026-07-20T12:00:00.000Z";
const FIXED_NOW_MS = Date.parse(FIXED_NOW_ISO);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const isoMinutesAgo = (m) => new Date(FIXED_NOW_MS - m * MINUTE).toISOString();

function taskId(i) {
  return `W1-C${String(i).padStart(4, "0")}`;
}

function prUrl(i) {
  return `https://github.com/craigoley/remudero/pull/${20000 + i}`;
}

const tasks = [];
const ledgerLines = [];
const prByUrl = {};
const autoMergeArmedUrls = [];
let runningBucketCount = 0;

for (let i = 0; i < TASK_COUNT; i++) {
  const id = taskId(i);
  const bucket = i % 6;
  const risk = ["low", "medium", "high"][i % 3];
  const type = ["implement", "recon", "diagnose", "review", "manual"][i % 5];
  const verify = i % 9 === 0 ? "human" : "auto";
  const startedAt = isoMinutesAgo(220 - i); // earlier tasks dispatched earlier, 1 min apart

  tasks.push({
    id,
    title: `W1-T187 corpus task ${i} (bucket ${bucket})`,
    repo: "remudero",
    depends_on: [],
    type,
    verify,
    risk,
    status: "queued", // decorative, per plan.ts's own contract — deriveStatus never trusts it
    attempts: bucket === 5 ? 1 : 0,
  });

  const runStart = { step: "run.start", task_id: id, run_id: `${id}-r1`, ts: startedAt };

  if (bucket === 0) {
    // MERGED via ledger pr.opened -- rung (a), terminal, deriveStatus returns early.
    const url = prUrl(i);
    ledgerLines.push(runStart);
    ledgerLines.push({ step: "implement.done", task_id: id, run_id: `${id}-r1`, ts: isoMinutesAgo(219 - i) });
    ledgerLines.push({ step: "pr.opened", task_id: id, run_id: `${id}-r1`, ts: isoMinutesAgo(218 - i), pr_url: url });
    ledgerLines.push({ step: "verdict", task_id: id, run_id: `${id}-r1`, ts: isoMinutesAgo(217 - i), verdict: "merged" });
    prByUrl[url] = { number: 20000 + i, url, state: "MERGED" };
  } else if (bucket === 1) {
    // RUNNING -- an OPEN PR, still in flight (no verdict yet).
    const url = prUrl(i);
    ledgerLines.push(runStart);
    ledgerLines.push({ step: "implement.done", task_id: id, run_id: `${id}-r1`, ts: isoMinutesAgo(219 - i) });
    ledgerLines.push({ step: "pr.opened", task_id: id, run_id: `${id}-r1`, ts: isoMinutesAgo(218 - i), pr_url: url });
    prByUrl[url] = { number: 20000 + i, url, state: "OPEN" };
    // Every 4th RUNNING task (by bucket-local count, not global i -- i%6===1 and i%8===0 never
    // intersect within this range, since 8 mod 6 = 2 cycles 0/2/4 and never lands on 1) gets
    // auto-merge armed, so the corpus actually exercises armedAwaitingMerge.
    if (runningBucketCount % 4 === 0) autoMergeArmedUrls.push(url);
    runningBucketCount++;
    if (i % 7 === 0) ledgerLines.push({ step: "escalation.issue_opened", task_id: id, run_id: `${id}-r1`, ts: isoMinutesAgo(1), issue_url: `https://github.com/craigoley/remudero/issues/${30000 + i}` });
  } else if (bucket === 2) {
    // BLOCKED -- a CLOSED (never merged) PR.
    const url = prUrl(i);
    ledgerLines.push(runStart);
    ledgerLines.push({ step: "pr.opened", task_id: id, run_id: `${id}-r1`, ts: isoMinutesAgo(218 - i), pr_url: url });
    ledgerLines.push({ step: "verdict", task_id: id, run_id: `${id}-r1`, ts: isoMinutesAgo(217 - i), verdict: "blocked_illformed" });
    prByUrl[url] = { number: 20000 + i, url, state: "CLOSED" };
    if (i % 7 === 0) ledgerLines.push({ step: "escalation.issue_opened", task_id: id, run_id: `${id}-r1`, ts: isoMinutesAgo(1), issue_url: `https://github.com/craigoley/remudero/issues/${30000 + i}` });
  } else if (bucket === 3) {
    // QUEUED -- no ledger evidence at all, no PR.
    if (i % 7 === 0) ledgerLines.push({ step: "escalation.issue_opened", task_id: id, run_id: `${id}-r1`, ts: isoMinutesAgo(1), issue_url: `https://github.com/craigoley/remudero/issues/${30000 + i}` });
  } else if (bucket === 4) {
    // IN-FLIGHT, LEDGER-ONLY: run.start well within the 30-minute liveness bound, no PR yet.
    const recentStart = isoMinutesAgo(5);
    ledgerLines.push({ step: "run.start", task_id: id, run_id: `${id}-r1`, ts: recentStart });
    ledgerLines.push({ step: "recon.done", task_id: id, run_id: `${id}-r1`, ts: isoMinutesAgo(3) });
    if (i % 7 === 0) ledgerLines.push({ step: "escalation.issue_opened", task_id: id, run_id: `${id}-r1`, ts: isoMinutesAgo(1) });
  } else {
    // ORPHANED: run.start OUTSIDE the 30-minute liveness bound, no PR, no recent activity --
    // the W1-T1 crash-era spin-loop shape (a stale dispatch that must NOT render as running).
    const staleStart = isoMinutesAgo(2 * 60 + 21); // 2h21m ago, well past DEFAULT_LIVENESS_BOUND_MS
    ledgerLines.push({ step: "run.start", task_id: id, run_id: `${id}-r1`, ts: staleStart });
    if (i % 7 === 0) ledgerLines.push({ step: "escalation.issue_opened", task_id: id, run_id: `${id}-r1`, ts: isoMinutesAgo(2 * 60 + 20) });
  }
}

// ── NOISE: task-less bulk lines (daemon ticks, sweep ticks, ci polling) that inflate the
// ledger to production scale without touching any task's derivation -- readLedgerLines still
// parses every one of them, which is exactly the cost this task's defect measured.
const NOISE_STEPS = ["daemon.tick", "sweep.tick", "ci.polling", "pr.polling"];
for (let n = 0; n < NOISE_LINE_COUNT; n++) {
  ledgerLines.push({
    step: NOISE_STEPS[n % NOISE_STEPS.length],
    ts: new Date(FIXED_NOW_MS - (NOISE_LINE_COUNT - n) * 1000).toISOString(),
    seq: n,
  });
}

const githubFixture = {
  prByUrl,
  autoMergeArmedUrls,
};

writeFileSync(join(HERE, "plan.json"), JSON.stringify(tasks, null, 2) + "\n");
writeFileSync(join(HERE, "ledger.ndjson"), ledgerLines.map((l) => JSON.stringify(l)).join("\n") + "\n");
writeFileSync(join(HERE, "github.json"), JSON.stringify(githubFixture, null, 2) + "\n");

console.log(`tasks: ${tasks.length}`);
console.log(`ledger lines: ${ledgerLines.length}`);
console.log(`PRs: ${Object.keys(prByUrl).length}, auto-merge-armed: ${autoMergeArmedUrls.length}`);
