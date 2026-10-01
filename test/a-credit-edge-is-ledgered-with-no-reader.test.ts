// Arch Phase 4 design §5, GET write 1 (P4-T14's edge half): GET /v1/account-usage appended
// account.credit_state on each credit-state edge it saw, so an edge was recorded only if someone happened to
// read, and the read wrote the ledger. Serve's slow lane now records the edge each pass while it holds the
// home lease, and the GET writes nothing.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildAccountUsageRoute, CREDIT_STATE_STEP } from "../src/lib/account-usage.js";
import { runSlowLaneWorker, type SlowLaneMessage } from "../src/lib/read-model-slow-lane.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const CAPTURED = new URL("./fixtures/account-usage/claude-json.json", import.meta.url);

function world(): { root: string; ledgerPath: string; accountFilePath: string; setState: (state: string) => void } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}credit-edge-`));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, `${JSON.stringify({ ts: "2026-09-22T11:00:00.000Z", run_id: "R-1", task_id: "W1-T1", step: "run.start" })}\n`);
  const accountFilePath = join(root, "claude.json");
  const setState = (state: string): void => {
    const captured = JSON.parse(readFileSync(CAPTURED, "utf8")) as { cachedUsageUtilization: Record<string, unknown> };
    captured.cachedUsageUtilization.creditState = state;
    writeFileSync(accountFilePath, JSON.stringify(captured));
  };
  setState("subscription");
  return { root, ledgerPath, accountFilePath, setState };
}

function edges(ledgerPath: string): Array<Record<string, unknown>> {
  return readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => r.step === CREDIT_STATE_STEP);
}

/** The lane's body in this thread, its passes fired by hand. */
function lane(config: Parameters<typeof runSlowLaneWorker>[1]) {
  let onMessage: ((msg: { type?: string; held?: unknown }) => void) | undefined;
  const posted: SlowLaneMessage[] = [];
  let next: (() => void) | undefined;
  const handle = runSlowLaneWorker({ on: (_event, run) => (onMessage = run), postMessage: (m) => void posted.push(m as SlowLaneMessage) }, config, {
    schedule: (run) => {
      next = run;
      return () => void (next = undefined);
    },
  });
  const passes = (): number => posted.filter((m) => m.type === "unit" && m.unit === "credit-edge").length;
  const settle = async (want: number): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (passes() < want && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(passes(), want, "the credit-edge unit ran");
  };
  return { handle, posted, lease: () => onMessage?.({ type: "lease", held: true }), fire: () => next?.(), settle };
}

test("a credit state change is ledgered once by the slow lane with no reader", async () => {
  const w = world();
  const l = lane({ accountUsage: { ledgerPath: w.ledgerPath, root: w.root, accountFilePath: w.accountFilePath }, intervalMs: 60_000 });
  try {
    l.lease();
    await l.settle(1);
    assert.deepEqual(edges(w.ledgerPath).map((r) => [r.state, r.previous]), [["subscription", undefined]], "the first known state is recorded with no reader");
    l.fire();
    await l.settle(2);
    assert.equal(edges(w.ledgerPath).length, 1, "an unchanged state appends nothing");
    w.setState("credits");
    l.fire();
    await l.settle(3);
    assert.deepEqual(edges(w.ledgerPath).map((r) => [r.state, r.previous]), [["subscription", undefined], ["credits", "subscription"]], "the edge is recorded once");
    assert.ok(l.posted.some((m) => m.type === "log" && m.step === "account.credit_edge_recorded" && m.extra.state === "credits"));
  } finally {
    l.handle.stop();
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("a slow lane with no account usage config records no credit edge", async () => {
  const w = world();
  const l = lane({ intervalMs: 60_000 });
  try {
    l.lease();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(l.posted.filter((m) => m.type === "unit").length, 0);
    assert.deepEqual(edges(w.ledgerPath), []);
  } finally {
    l.handle.stop();
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("the account usage get route reports the credit state and writes nothing", async () => {
  const w = world();
  w.setState("credits");
  const route = buildAccountUsageRoute({ ledgerPath: w.ledgerPath, root: w.root, accountFilePath: w.accountFilePath, resolveCeiling: () => ({ usd: 150, provenance: "default", committedDefaultUsd: 150 }) });
  const server = createServer((req, res) => void route.handler(req, res, { params: {} } as never));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const before = readFileSync(w.ledgerPath, "utf8");
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/account-usage`);
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { creditState?: string }).creditState, "credits");
    }
    assert.equal(readFileSync(w.ledgerPath, "utf8"), before, "the GET appended to the ledger");
  } finally {
    server.close();
    rmSync(w.root, { recursive: true, force: true });
  }
});
