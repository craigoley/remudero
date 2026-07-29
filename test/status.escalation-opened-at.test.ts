// test/status.escalation-opened-at.test.ts — W1-T159 (GLANCE layer): the strip's "needs-me older
// than 24h" anomaly emphasis needs a real timestamp for "when did this become a needs-human
// item". NEEDS ME rows had been keying their own age off StatusProjection.startedAt (the
// TRIGGERING run's start), which is the WRONG event whenever the escalation fires well after
// that run began, or a later redispatch overwrites startedAt while the escalation itself stays
// open. This proves deriveStatus threads the escalation.issue_opened ledger line's OWN `ts`
// through as `escalationOpenedAt`, distinct from (and here, deliberately earlier than) `startedAt`.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Task } from "../src/lib/plan.js";
import { deriveStatus, type GitHub, type PrRef } from "../src/lib/status.js";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-TX",
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued",
    attempts: 0,
    ...over,
  };
}

function fakeGitHub(issuesByUrl: Record<string, { state: string; title?: string } | null> = {}): GitHub & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    issueByUrl(url: string) {
      calls.push(`issueByUrl:${url}`);
      return issuesByUrl[url] ?? null;
    },
  } as GitHub & { calls: string[] };
}

function ledgerFile(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-escalation-opened-at-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

test("W1-T159: an OPEN escalation carries escalationOpenedAt — the escalation.issue_opened ledger line's own ts, not the run's startedAt", () => {
  const issueUrl = "https://github.com/o/r/issues/9";
  const github = fakeGitHub({ [issueUrl]: { state: "OPEN", title: "[BLOCKED] W1-TX: needs a decision" } });
  const ledgerPath = ledgerFile([
    // The run that PRECEDED the escalation started hours before the escalation itself fired —
    // startedAt (below, via the dangling in-flight scan) must NOT be conflated with this.
    { ts: "2026-07-20T00:00:00.000Z", run_id: "r1", task_id: "W1-TX", step: "run.start" },
    { ts: "2026-07-20T04:00:00.000Z", run_id: "r1", task_id: "W1-TX", step: "escalation.issue_opened", issue_url: issueUrl, class: "BLOCKED" },
    { ts: "2026-07-20T04:00:01.000Z", run_id: "r1", task_id: "W1-TX", step: "verdict", verdict: "blocked_review" },
  ]);
  const proj = deriveStatus(task(), { ledgerPath, github, now: () => Date.parse("2026-07-21T08:00:00.000Z") });
  assert.equal(proj.needsHuman, true);
  assert.equal(proj.escalationOpenedAt, "2026-07-20T04:00:00.000Z", "must be the escalation line's OWN ts");
  assert.notEqual(proj.escalationOpenedAt, proj.startedAt, "the escalation opened 4h AFTER the run started -- never the same timestamp here");
});

test("W1-T159: escalationOpenedAt is absent when there is no open escalation at all — sparse like needsHuman itself", () => {
  const github = fakeGitHub();
  const ledgerPath = ledgerFile([{ ts: "2026-07-20T00:00:00.000Z", run_id: "r1", task_id: "W1-TX", step: "run.start" }]);
  const proj = deriveStatus(task(), { ledgerPath, github, now: () => Date.parse("2026-07-20T00:05:00.000Z") });
  assert.equal(proj.needsHuman, undefined);
  assert.equal(proj.escalationOpenedAt, undefined);
});
