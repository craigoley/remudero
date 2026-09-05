import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_DRAFT_DISALLOWED_TOOLS, runDraftRung, DAEMON_DRAFT_BATCH_CAP } from "../src/lib/inbox.js";
import type { Proposal } from "../src/lib/inbox.js";

const REPO_ROOT = join(import.meta.dirname, "..");

// ── W1-T2591: THE DRAFT CAP IS A BATCH SIZE, NOT A CONCURRENCY LIMIT ────────────────────────
//
// The throughput half of this task shipped as #3588 (W1-T2664) the day after it was filed:
// `runDraftRung` runs an indexed worker pool, so a batch of N finishes in about the time of the
// SLOWEST draft rather than the sum. This suite pins that, and then pins the half #3588 did not
// address and made load-bearing by shipping.
//
// THE SAFETY HALF. `draftProposalBatch` materialises ONE worktree per batch and hands that same
// `worktreePath` to every lane as `cwd`. Before the pool, exactly one worker was in it at a time;
// after, up to DAEMON_DRAFT_BATCH_CAP are. The prompt tells each one "You have NO Write/Edit/Bash
// tools — you cannot touch a file or run git", and MEASURED 2026-09-04 that was the only thing
// standing between them and the checkout: `settings/worker.json` carries `allow: []` and a `deny`
// list of four READ paths, nothing about Write/Edit/Bash, and the spawn passes
// `permissionMode: "bypassPermissions"`.
//
// The operator ratified enforcing the claim rather than splitting the worktree — the rung needs no
// mutation (the plan text arrives IN the prompt; the outcome is parsed from the TRANSCRIPT), and
// per-lane worktrees multiply checkout disk by the cap on a host that hit 100% full on 2026-09-01.

const proposal = (id: string): Proposal => ({ id, summary: `proposal ${id}`, evidenceAnchors: [] }) as unknown as Proposal;

/** A spawn that records overlap: how many drafts were in flight at the busiest moment. */
function overlappingSpawn(durationMs: number) {
  let inFlight = 0;
  let peak = 0;
  const spawn = async (): Promise<unknown> => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, durationMs));
    inFlight -= 1;
    return {
      sessionId: "S",
      costUsd: 0,
      text: "=== FRAGMENT ===\n- id: PLACEHOLDER-1\n=== END FRAGMENT ===",
      blocks: [],
      subtype: "success",
      isError: false,
    };
  };
  return { spawn, peak: () => peak };
}

// ── criterion 1: N drafts take about one draft's time, not N ────────────────────────────────

test("W1-T2591: a batch of N drafts finishes in about the time of one draft rather than N of them", async () => {
  const n = 4;
  const each = 60;
  const rec = overlappingSpawn(each);
  const started = Date.now();
  await runDraftRung(
    Array.from({ length: n }, (_, i) => proposal(`P${i}`)),
    "tasks: []",
    { spawn: rec.spawn as never, log: () => {} } as never,
    "RUN",
  );
  const elapsed = Date.now() - started;
  // The sequential shape this task measured would take n * each. The pool takes about `each`.
  assert.ok(elapsed < n * each * 0.75, `expected ~${each}ms, not the sequential ~${n * each}ms; got ${elapsed}ms`);
  assert.ok(rec.peak() > 1, `drafts must actually overlap; peak in-flight was ${rec.peak()}`);
});

test("W1-T2591: concurrency never exceeds the shipped cap, so the cap still bounds the batch", async () => {
  const rec = overlappingSpawn(20);
  const n = DAEMON_DRAFT_BATCH_CAP + 3;
  await runDraftRung(
    Array.from({ length: n }, (_, i) => proposal(`P${i}`)),
    "tasks: []",
    { spawn: rec.spawn as never, log: () => {} } as never,
    "RUN",
  );
  assert.ok(rec.peak() <= DAEMON_DRAFT_BATCH_CAP, `peak ${rec.peak()} must not exceed the cap ${DAEMON_DRAFT_BATCH_CAP}`);
});

// ── criterion 2: the shared worktree is shown safe, not asserted safe ───────────────────────

test("W1-T2591: concurrent drafts do not share a worktree unless that sharing is shown to be safe", () => {
  // The sharing is real: one worktree, every lane. What makes it SAFE is that no lane is offered
  // a tool that can write into it — enforced at the spawn, not promised in a sentence.
  const src = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  const start = src.indexOf("export async function draftProposalBatch(");
  assert.ok(start >= 0, "control: draftProposalBatch must exist");
  const body = src.slice(start, start + 4000);
  assert.match(body, /createDaemonLaneWorktree\(/, "control: the batch really does materialise ONE worktree — the sharing this guards");
  assert.match(body, /disallowedTools: INBOX_DRAFT_DISALLOWED_TOOLS/, "and every lane's spawn must carry the enforced tool list");
});

test("W1-T2591: every write path the prompt disclaims is actually disallowed", () => {
  for (const tool of ["Write", "Edit", "Bash"]) {
    assert.ok(INBOX_DRAFT_DISALLOWED_TOOLS.includes(tool), `the prompt disclaims ${tool}, so it must be enforced`);
  }
  // A write path the prompt's own sentence predates — the list enforces the CLAIM, not its wording.
  assert.ok(INBOX_DRAFT_DISALLOWED_TOOLS.includes("NotebookEdit"), "NotebookEdit writes too");
  // NEGATIVE CONTROL: read-shaped tools are NOT disallowed. Blocking them would be a different,
  // larger change to a paid path, and the rung reads nothing anyway — the plan arrives in the prompt.
  for (const tool of ["Read", "Grep", "Glob"]) {
    assert.ok(!INBOX_DRAFT_DISALLOWED_TOOLS.includes(tool), `${tool} cannot mutate the shared worktree and is not this task's business`);
  }
});

test("W1-T2591: the prompt's claim and the enforced list cannot drift apart silently", () => {
  const inbox = readFileSync(join(REPO_ROOT, "src", "lib", "inbox.ts"), "utf8");
  // The sentence this list exists to enforce. If it is reworded, this fails and whoever reworded
  // it has to look at the list — which is the point: prose and enforcement in one file.
  assert.match(inbox, /You have NO/, "the prompt must still make the claim the list enforces");
  assert.match(inbox, /Write\/Edit\/Bash tools/, "and name the tools it disclaims");
});

test("W1-T2591: settings alone would NOT have enforced this — the measurement the remedy rests on", () => {
  const settings = JSON.parse(readFileSync(join(REPO_ROOT, "settings", "worker.json"), "utf8")) as {
    permissions?: { allow?: string[]; deny?: string[] };
  };
  const deny = settings.permissions?.deny ?? [];
  assert.ok(deny.length > 0, "control: the deny list is non-empty, so this query can see its corpus");
  for (const tool of ["Write", "Edit", "Bash"]) {
    assert.ok(
      !deny.some((rule) => rule.startsWith(`${tool}(`) || rule === tool),
      `settings/worker.json does not deny ${tool} — which is why the enforcement lives at the spawn`,
    );
  }
  assert.deepEqual(settings.permissions?.allow ?? [], [], "and `allow` is empty, so nothing narrows the tool set there either");
});

test("W1-T2591: the enforced list is threaded to the SDK, not merely passed at the call site", () => {
  // WITHOUT THIS, THE WIRING IS UNPROVEN. An earlier draft of this suite asserted only that
  // `draftProposalBatch` passes `disallowedTools` — and deleting the line in `spawnWorker` that
  // hands it to the SDK changed NO test. That is the #339/W1-T281 class: a proof that reads one
  // end of a wire passes on an entirely unbuilt one.
  const worker = readFileSync(join(REPO_ROOT, "src", "lib", "worker.ts"), "utf8");
  const decl = /\n(?:export )?(?:async )?function spawnWorker/.exec(worker);
  assert.ok(decl, "control: a declaration of spawnWorker must exist");
  const start = decl!.index + 1;
  const nextFn = [...worker.slice(start + 1).matchAll(/\n(?:export )?(?:async )?function /g)].map((m) => start + 1 + m.index);
  const body = worker.slice(start, nextFn.length ? Math.min(...nextFn) : worker.length);
  assert.match(
    body,
    /options\.disallowedTools\s*=/,
    "spawnWorker must assign the caller's list onto the SDK options object — the other end of the wire",
  );

  // AND THE FIELD MUST STILL BE THE ONE THE SDK READS. If the SDK renames it, our assignment goes
  // nowhere silently — the same failure with neither end changed.
  const sdk = readFileSync(join(REPO_ROOT, "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.d.ts"), "utf8");
  assert.match(sdk, /disallowedTools\?:\s*string\[\]/, "the SDK must still declare disallowedTools");
});

test("W1-T2591: an unrestricted spawn is unchanged — the option is omitted, never set to undefined", () => {
  const worker = readFileSync(join(REPO_ROOT, "src", "lib", "worker.ts"), "utf8");
  // Every other lane (implement, plan, triage, fix) MUST keep its tools. The assignment is
  // guarded, so their options object is byte-identical to what it was before this task.
  assert.match(
    worker,
    /if \(args\.disallowedTools && args\.disallowedTools\.length > 0\) options\.disallowedTools/,
    "the assignment must be guarded so an unrestricted caller's options are untouched",
  );
});

// ── criterion 3: the batch stays inside the sweep's bound at the shipped cap ─────────────────

test("W1-T2591: the batch stays within the sweep wall-clock bound at the shipped cap", async () => {
  // The pool's whole point: at the cap, elapsed approaches the SLOWEST draft, not their sum. A
  // full cap-sized batch of 300ms drafts must not cost cap * 300ms, which is what crossed the
  // sweep's await bound on 2026-09-02 and motivated #3588.
  const each = 40;
  const rec = overlappingSpawn(each);
  const started = Date.now();
  await runDraftRung(
    Array.from({ length: DAEMON_DRAFT_BATCH_CAP }, (_, i) => proposal(`P${i}`)),
    "tasks: []",
    { spawn: rec.spawn as never, log: () => {} } as never,
    "RUN",
  );
  const elapsed = Date.now() - started;
  const sequential = DAEMON_DRAFT_BATCH_CAP * each;
  assert.ok(elapsed < sequential * 0.75, `a cap-sized batch must not cost the sequential ${sequential}ms; got ${elapsed}ms`);
});
