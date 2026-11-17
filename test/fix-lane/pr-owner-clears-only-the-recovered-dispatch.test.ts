import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { staleFixDispatchRecoveryId, STALE_FIX_DISPATCH_RECEIPT_STEP } from "#src/lib/stale-fix-dispatch-recovery.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { derivePrOwnerVerdict, fixBranchClaimKey, prOwnerCommand } from "#src/run-task.js";

type Row = Record<string, unknown>;

const PR = 7712;
const TASK = "W1-TOWNER";
const RUN = "FIX-RUN-1";
const ROUND = `${RUN}:1:1790000000000`;
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const BRANCH = `run-${TASK}-1790000000000`;
const REPO = "acme/remudero";
const T0 = Date.parse("2026-11-10T10:00:00.000Z");
const HOUR = 3_600_000;
const at = (ms: number) => new Date(ms).toISOString();

const dispatch = (ms: number, fields: Row = {}): Row => ({
  ts: at(ms), step: "fix.dispatch", task_id: TASK, run_id: RUN, round_id: ROUND, pr_number: PR, head_sha: HEAD, strike: 1, mode: "ci", ...fields,
});

function receipt(ms: number, outcome: "released" | "held", auth: string, fields: Row = {}): Row {
  const identity = { task_id: TASK, prior_run_id: RUN, prior_round_id: ROUND, pr_number: PR, head_sha: HEAD, base_sha: BASE, branch: BRANCH, repo: REPO, ...fields };
  const id = staleFixDispatchRecoveryId({
    repo: identity.repo as string, prNumber: identity.pr_number as number, taskId: identity.task_id as string,
    dispatchRunId: identity.prior_run_id as string, dispatchRoundId: identity.prior_round_id as string,
    headSha: identity.head_sha as string, baseSha: identity.base_sha as string, branch: identity.branch as string, authorizationId: auth,
  });
  return {
    ts: at(ms), step: STALE_FIX_DISPATCH_RECEIPT_STEP, recovery_id: id, ...identity, authorization_id: auth,
    preservation: { state: "published", recoveryRef: `refs/rmd-recovery/${TASK}`, sha: "c".repeat(40) },
    actor: "operator", reason: "recovered", outcome, ...(outcome === "held" ? { hold_reason: "process_alive" } : {}),
  };
}

const sweepWait = (ms: number): Row => ({ ts: at(ms), step: "sweep.disposed", task_id: TASK, run_id: "SWEEP-1", pr_number: PR, disposition: "wait", head_sha: HEAD });

function corpusDir(rows: Row[], live: Row[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12115-owner-`));
  const text = (list: Row[]) => list.map((row) => JSON.stringify(row)).join("\n") + (list.length ? "\n" : "");
  writeFileSync(join(dir, "ledger.2026-11-09T00-00-00-000Z.ndjson.gz"), gzipSync(Buffer.from(text(rows))));
  writeFileSync(join(dir, "ledger.ndjson"), text(live));
  return dir;
}

/** The verdict through the streaming projection and through the synchronous injected corpus. */
async function both(rows: Row[], opts: { live?: Row[]; claim?: boolean } = {}): Promise<{ projection: string; injected: string }> {
  const dir = corpusDir(rows, opts.live);
  try {
    if (opts.claim) {
      mkdirSync(join(dir, "inflight"), { recursive: true });
      writeFileSync(join(dir, "inflight", `${fixBranchClaimKey("acme", "remudero", BRANCH)}.lock`),
        JSON.stringify({ pid: process.pid, run_id: "FIX-LIVE", startedAt: new Date().toISOString() }));
    }
    const projection: string[] = [];
    await prOwnerCommand([String(PR)], { stateDir: dir, write: (text) => projection.push(text) });
    const injected: string[] = [];
    await prOwnerCommand([String(PR)], {
      stateDir: dir,
      readLedger: () => ({
        rows: [...rows, ...(opts.live ?? [])], archiveFiles: [join(dir, "ledger.2026-11-09T00-00-00-000Z.ndjson.gz")],
        liveFileRead: true, ok: true, unread: [], filesRead: 2,
      }),
      write: (text) => injected.push(text),
    });
    return { projection: projection.join("\n"), injected: injected.join("\n") };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const verdictOf = (out: string): string => /^rmd pr-owner #\d+ — (\w+)/.exec(out)?.[1] ?? "none";

async function assertBoth(rows: Row[], expected: string[], opts: { live?: Row[]; claim?: boolean } = {}): Promise<{ projection: string; injected: string }> {
  const out = await both(rows, opts);
  assert.ok(expected.includes(verdictOf(out.projection)), `projection: ${out.projection}`);
  assert.equal(verdictOf(out.injected), verdictOf(out.projection), `injected path disagrees:\n${out.injected}\n${out.projection}`);
  return out;
}

test("W1-T12115 later matching release clears owner", async () => {
  const released = receipt(T0 + HOUR, "released", "auth-1");
  const cleared = await assertBoth([dispatch(T0), released], ["FREE"]);
  for (const out of [cleared.projection, cleared.injected]) {
    assert.match(out, new RegExp(`fix.dispatch ${RUN} released by recovery receipt ${released.recovery_id as string}`));
    assert.match(out, /recovery_receipt: .*actor=operator, ts=2026-11-10T11:00:00.000Z, preservation=refs\/rmd-recovery\/W1-TOWNER/);
    assert.doesNotMatch(out, /recovery_shadow/);
  }
  // Without the receipt the dispatch still owns the PR.
  await assertBoth([dispatch(T0)], ["OWNED"]);
  // Older held rows, under any authorization, are superseded by the one later release; the archive holds the receipts.
  await assertBoth([dispatch(T0), receipt(T0 + 600_000, "held", "auth-0"), receipt(T0 + 900_000, "held", "auth-2"), released], ["FREE"]);
  // A byte-identical released row replayed (live beside archive) coalesces.
  await assertBoth([dispatch(T0), released], ["FREE"], { live: [released] });
  // A plan-only PR (plan-gate fix round, no sweep row) clears the same way.
  await assertBoth([dispatch(T0, { mode: "plan-gate" }), released], ["FREE"]);
});

test("W1-T12115 conflicting receipts hold owner", async () => {
  const released = receipt(T0 + HOUR, "released", "auth-1");
  // held-only, and a release that is not later than its dispatch
  await assertBoth([dispatch(T0), receipt(T0 + HOUR, "held", "auth-1")], ["OWNED"]);
  await assertBoth([dispatch(T0 + 2 * HOUR), released], ["OWNED"]);
  await assertBoth([dispatch(T0 + HOUR), released], ["OWNED"]);
  // a newer dispatch makes the PR OWNED again
  await assertBoth([dispatch(T0), released, dispatch(T0 + 2 * HOUR, { run_id: "FIX-RUN-2", round_id: "FIX-RUN-2:1:1790000009999" })], ["OWNED"]);
  // a receipt for another run, round, task, head or PR
  for (const other of [{ prior_run_id: "OTHER" }, { prior_round_id: `${RUN}:2:1790000000001` }, { task_id: "W1-TOTHER" }, { head_sha: "d".repeat(40) }, { pr_number: PR + 1 }]) {
    await assertBoth([dispatch(T0), receipt(T0 + HOUR, "released", "auth-1", other)], ["OWNED"]);
  }
  // a held row stamped at or after the release, even under another authorization
  await assertBoth([dispatch(T0), released, receipt(T0 + HOUR, "held", "auth-2")], ["UNKNOWN"]);
  await assertBoth([dispatch(T0), released, receipt(T0 + 2 * HOUR, "held", "auth-2")], ["UNKNOWN"]);
  // two distinct released receipts, even with different authorization_ids
  await assertBoth([dispatch(T0), released, receipt(T0 + 2 * HOUR, "released", "auth-2")], ["UNKNOWN"]);
  // a future-stamped receipt: a lone future release never clears; a future hold after an older release is UNKNOWN
  const future = Date.now() + 365 * 24 * HOUR;
  await assertBoth([dispatch(T0), receipt(future, "released", "auth-1")], ["OWNED", "UNKNOWN"]);
  await assertBoth([dispatch(T0), released, receipt(future, "held", "auth-2")], ["UNKNOWN"]);
  // an unreadable receipt row for the PR
  await assertBoth([dispatch(T0), released, { ...receipt(T0 + 2 * HOUR, "held", "auth-3"), recovery_id: "forged" }], ["UNKNOWN"]);
  await assertBoth([dispatch(T0), { ...released, actor: "" }], ["OWNED", "UNKNOWN"]);
  // a released receipt never hides a live branch claim or an active sweep disposition
  const claimed = await assertBoth([dispatch(T0), released], ["OWNED"], { claim: true });
  assert.match(claimed.projection, /live fix branch claim held by pid/);
  await assertBoth([dispatch(T0), released, sweepWait(T0 + 2 * HOUR)], ["OWNED"]);
  await assertBoth([dispatch(T0, { mode: "plan-gate" }), released, sweepWait(T0 + 2 * HOUR)], ["OWNED"]);
  // derivePrOwnerVerdict is the synchronous twin
  const direct = derivePrOwnerVerdict(PR, {
    rows: [dispatch(T0), released], archiveFiles: ["x.ndjson.gz"], liveFileRead: true, ok: true, unread: [], filesRead: 1,
  });
  assert.equal(direct.verdict, "FREE");
});
