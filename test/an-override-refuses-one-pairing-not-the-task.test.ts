// test/an-override-refuses-one-pairing-not-the-task.test.ts — W1-T5353.
//
// A CREDIT OVERRIDE REFUSES ONE (task, pull request) PAIRING, NEVER THE TASK. The override used to be
// applied to the RESULT of `derivePrPrecedence`, which returns at its first credited rung — and the
// durable merge-credit.json rung answers first. So with the store holding the overridden PR, a LATER
// legitimate merge carrying the task's anchored trailer was never consulted: the projection read
// queued, the daemon re-dispatched, the rebuild merged, and the task still read queued, forever
// (`recordCredit` never replaces an occupied source).
//
// The fix makes the override a per-pairing EXCLUSION inside the walk. Each case below pins one rung.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveStatus } from "../src/lib/status.js";
import type { CreditStore, GitHub, PrRef } from "../src/lib/status.js";
import type { Task } from "../src/lib/plan.js";

const ID = "W1-T444";
const url = (n: number): string => `https://github.com/craigoley/remudero/pull/${n}`;
const task = (): Task =>
  ({ id: ID, title: ID, repo: "remudero", type: "implement", depends_on: [], status: "queued" }) as unknown as Task;

const ledgerFile = (): string => {
  const p = join(mkdtempSync(join(tmpdir(), "rmd-t5353-")), "ledger.ndjson");
  writeFileSync(p, "");
  return p;
};

const OVERRIDE_100 = `- task: ${ID}
  pr: 100
  action: remove-credit
  reason: "built the wrong thing"
  author_class: operator
`;

/** A merged PR off this task's own run branch whose body carries the anchored trailer. */
const mergedPr = (n: number): PrRef => ({ number: n, url: url(n), state: "MERGED", headRefName: `run-${ID}-17900000000${n}` });

interface GatewayShape {
  /** What `findMergedByTrailer` answers — the single newest trailer hit. */
  trailer?: number;
  /** What `findMergedByTrailerAll` answers, newest first. */
  trailerAll?: number[];
  /** What `findMergedByHeadBranch` answers. */
  headBranch?: number[];
  /** PRs `prByRef` resolves (all merged). */
  known?: number[];
}

function gateway(shape: GatewayShape): GitHub {
  const trailered = new Set([...(shape.trailer !== undefined ? [shape.trailer] : []), ...(shape.trailerAll ?? [])]);
  const num = (u: string): number => Number(u.split("/").pop());
  return {
    prByRef: (ref: string | number) => {
      const n = typeof ref === "number" ? ref : num(ref);
      return (shape.known ?? []).includes(n) ? mergedPr(n) : null;
    },
    findMergedByTrailer: () => (shape.trailer === undefined ? null : mergedPr(shape.trailer)),
    ...(shape.trailerAll ? { findMergedByTrailerAll: () => shape.trailerAll!.map(mergedPr) } : {}),
    ...(shape.headBranch ? { findMergedByHeadBranch: () => shape.headBranch!.map(mergedPr) } : {}),
    headRefName: (u: string) => mergedPr(num(u)).headRefName,
    prBody: (u: string) => (trailered.has(num(u)) ? `Fix.\n\nRemudero-Task: ${ID}\n` : "Fix."),
  } as unknown as GitHub;
}

const entry = (source: "trailer" | "head-branch", n: number) => ({ source, prUrl: url(n), prNumber: n, prState: "MERGED" });

function derive(opts: { store: CreditStore; gh: GitHub; override?: string; ledger?: Array<Record<string, unknown>> }) {
  const writes: CreditStore[] = [];
  const out = deriveStatus(task(), {
    ledgerPath: ledgerFile(),
    github: opts.gh,
    readCreditStore: () => opts.store,
    writeCreditStore: (s: CreditStore) => writes.push(s),
    readCreditOverrideFile: () => opts.override ?? "",
    ...(opts.ledger ? { readLedger: () => opts.ledger } : {}),
  } as never);
  return { out, writes };
}

/** Every PR number any write persisted for this task, across both durable sources. */
const persisted = (writes: CreditStore[]): number[] =>
  writes.flatMap((s) => [s[ID]?.trailer?.prNumber, s[ID]?.["head-branch"]?.prNumber]).filter((n): n is number => n !== undefined);

test("W1-T5353 store {trailer: #100} + override (task, 100) + a later merged trailered #200 credits #200", () => {
  const store: CreditStore = { [ID]: { trailer: entry("trailer", 100) } };
  // CONTROL: without the override the durable #100 answers, so the case is not vacuous.
  const control = derive({ store, gh: gateway({ trailer: 200 }) });
  assert.equal(control.out.prNumber, 100, "control: the durable rung answers first");

  const { out } = derive({ store, gh: gateway({ trailer: 200 }), override: OVERRIDE_100 });
  assert.equal(out.merged, true, "THE CLAIM: the later legitimate merge still credits the task");
  assert.equal(out.status, "merged");
  assert.equal(out.prNumber, 200);
  assert.equal(out.source, "trailer");
  assert.equal(out.creditOverride, undefined, "a task that IS credited carries no override decoration");
});

test("W1-T5353 store {head-branch: #100} (unquarantined) + override (task, 100) + merged trailered #200 credits #200", () => {
  const store: CreditStore = { [ID]: { "head-branch": entry("head-branch", 100) } };
  const control = derive({ store, gh: gateway({ trailer: 200 }) });
  assert.equal(control.out.prNumber, 100, "control: the durable head-branch entry answers first");

  const { out } = derive({ store, gh: gateway({ trailer: 200 }), override: OVERRIDE_100 });
  assert.equal(out.merged, true);
  assert.equal(out.prNumber, 200);
});

test("W1-T5353 a task whose ONLY credit is overridden still reads queued, carrying the override's reason", () => {
  const store: CreditStore = { [ID]: { trailer: entry("trailer", 100) } };
  const { out } = derive({ store, gh: gateway({}), override: OVERRIDE_100 });
  assert.equal(out.merged, false);
  assert.equal(out.status, "queued");
  assert.equal(out.source, "none");
  assert.deepEqual(out.creditOverride, { reason: "built the wrong thing", pr: 100 });
});

test("W1-T5353 the durable rung tries the SIBLING source when the preferred one is overridden", () => {
  const store: CreditStore = { [ID]: { trailer: entry("trailer", 100), "head-branch": entry("head-branch", 150) } };
  const { out } = derive({ store, gh: gateway({}), override: OVERRIDE_100 });
  assert.equal(out.merged, true);
  assert.equal(out.prNumber, 150);
  assert.equal(out.source, "head-branch");
});

test("W1-T5353 rung (c) skips an overridden trailer hit and takes the next findMergedByTrailerAll candidate", () => {
  const { out, writes } = derive({ store: {}, gh: gateway({ trailer: 100, trailerAll: [100, 200] }), override: OVERRIDE_100 });
  assert.equal(out.merged, true);
  assert.equal(out.prNumber, 200);
  assert.ok(!persisted(writes).includes(100), "the overridden pairing is never persisted");
  assert.ok(persisted(writes).includes(200), "the legitimate one is");
});

test("W1-T5353 no rung persists an overridden pairing — trailer and head-branch both name only #100", () => {
  const { out, writes } = derive({ store: {}, gh: gateway({ trailer: 100, headBranch: [100] }), override: OVERRIDE_100 });
  assert.equal(out.merged, false, "the only credit was overridden");
  assert.equal(out.creditOverride?.pr, 100, "and the board still says why");
  assert.deepEqual(persisted(writes), [], "nothing about #100 reaches merge-credit.json");
});

test("W1-T5353 rung (c2) skips an overridden head-branch hit and credits the next merged one", () => {
  const { out } = derive({ store: {}, gh: gateway({ headBranch: [100, 300] }), override: OVERRIDE_100 });
  assert.equal(out.merged, true);
  assert.equal(out.prNumber, 300);
  assert.equal(out.source, "head-branch");
});

test("W1-T5353 rungs (a) ledger and (b) pr field skip an overridden merged pairing", () => {
  const ledger = [{ step: "pr.opened", task_id: ID, pr_url: url(100), ts: "2026-10-01T00:00:00Z" }];
  const viaLedger = derive({ store: {}, gh: gateway({ known: [100], trailer: 200 }), override: OVERRIDE_100, ledger });
  assert.equal(viaLedger.out.prNumber, 200, "(a): the ledger's #100 does not answer");
  assert.equal(viaLedger.out.merged, true);

  const viaField = deriveStatus({ ...task(), pr: 100 } as unknown as Task, {
    ledgerPath: ledgerFile(),
    github: gateway({ known: [100], trailer: 200 }),
    readCreditStore: () => ({}),
    writeCreditStore: () => {},
    readCreditOverrideFile: () => OVERRIDE_100,
  } as never);
  assert.equal(viaField.prNumber, 200, "(b): the pr field's #100 does not answer");
  assert.equal(viaField.merged, true);
});

test("W1-T5353 an override never grants: an uncredited task with an override row stays uncredited, with no decoration", () => {
  const { out } = derive({ store: {}, gh: gateway({}), override: OVERRIDE_100 });
  assert.equal(out.merged, false);
  assert.equal(out.creditOverride, undefined, "no pairing was excluded, so nothing claims an override applied");
});

test("W1-T5353 BACKSTOP: a dark cycle carrying forward a prior credit by the overridden pairing still reads it refused", () => {
  // Under a failed read the walk carries the PRIOR projection forward unexamined (W1-T179), so no rung ever
  // sees the pairing to skip it — the post-walk check is what refuses it there.
  const darkGateway = { ...gateway({}), readFailed: () => true } as unknown as GitHub;
  const out = deriveStatus(task(), {
    ledgerPath: ledgerFile(),
    github: darkGateway,
    readCreditStore: () => ({}),
    writeCreditStore: () => {},
    readCreditOverrideFile: () => OVERRIDE_100,
    previousProjection: () => ({ taskId: ID, status: "merged", merged: true, source: "trailer", prNumber: 100, prUrl: url(100) }),
  } as never);
  assert.equal(out.merged, false);
  assert.equal(out.creditOverride?.pr, 100);
});
