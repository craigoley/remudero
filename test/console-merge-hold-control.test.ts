import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { computeBoardSnapshot, type BoardDeps } from "../src/lib/board.js";
import { buildMergeHoldRoute } from "../src/lib/panel-actions.js";
import { automergeHoldFromLedger } from "../src/lib/review.js";
import { buildServeRoutes, buildServeServer, renderShellHtml, type ServeDeps } from "../src/lib/serve.js";
import { readLedgerLines } from "../src/lib/status.js";

const READ_TOKEN = "merge-hold-read-token";
const WRITE_TOKEN = "merge-hold-write-token";
const TAILNET_CAP = "remudero:console";

function fakeGithub() {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    readFailed: () => false,
  };
}

function boardDeps(lines: Array<Record<string, unknown>>): BoardDeps & { reads: { count: number } } {
  const reads = { count: 0 };
  return {
    plan: { tasks: [], byId: new Map() },
    ledgerPath: "/not-read-directly/ledger.ndjson",
    github: fakeGithub(),
    readLedger: () => {
      reads.count += 1;
      return lines;
    },
    reads,
  };
}

test("standing fleet and PR holds ride the one atomic board snapshot and disappear after release", () => {
  const prLines = [
    { step: "automerge.hold_engaged", task_id: "W1-T2719", pr_number: 3708, by: "craig", reason: "read this head manually" },
  ];
  const prDeps = boardDeps(prLines);
  const held = computeBoardSnapshot(prDeps);
  assert.equal(prDeps.reads.count, 1, "board and status-board projection share one parsed ledger read");
  assert.deepEqual(held.mergeHeld, [
    { prNumber: 3708, taskId: "W1-T2719", by: "craig", reason: "read this head manually" },
  ]);

  const releasedDeps = boardDeps([
    ...prLines,
    { step: "automerge.hold_released", task_id: "W1-T2719", pr_number: 3708, by: "craig", reason: "manual read complete" },
  ]);
  assert.deepEqual(computeBoardSnapshot(releasedDeps).mergeHeld, []);
  assert.equal(releasedDeps.reads.count, 1);

  const fleetDeps = boardDeps([
    { step: "automerge.hold_engaged", task_id: "FLEET", by: "craig", reason: "incident freeze" },
  ]);
  assert.deepEqual(computeBoardSnapshot(fleetDeps).mergeHeld, [{ by: "craig", reason: "incident freeze" }]);
});

function rootFixture(): { root: string; ledgerPath: string; deps: ServeDeps } {
  const root = mkdtempSync(join(tmpdir(), "rmd-console-merge-hold-"));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(ledgerPath, "");
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const github = fakeGithub();
  const deps = {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github },
    panelGraph: {
      root,
      planPath,
      ledgerPath,
      github: { prView: () => null },
      statusGithub: github,
      ratify: { approve() {}, reframe() {} },
    },
    ledgerPath,
    issues: { close() {} },
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    identity: { trustedLocalAddress: "127.0.0.1", capability: TAILNET_CAP },
    githubAppRefresh: { start: () => ({ armed: false }) },
    log: () => {},
  } as unknown as ServeDeps;
  return { root, ledgerPath, deps };
}

function headers(): Record<string, string> {
  return {
    authorization: `Bearer ${WRITE_TOKEN}`,
    "content-type": "application/json",
    "tailscale-app-capabilities": JSON.stringify({ [TAILNET_CAP]: {} }),
  };
}

function identityOnlyHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "tailscale-app-capabilities": JSON.stringify({ [TAILNET_CAP]: {} }),
  };
}

async function withServer<T>(deps: ServeDeps, run: (base: string) => Promise<T>): Promise<T> {
  const server = buildServeServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

async function issueNonce(base: string, path: string, body: unknown): Promise<string> {
  const payload = JSON.stringify(body);
  const response = await fetch(`${base}/v1/confirm`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ method: "POST", path, payload }),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { nonce: string }).nonce;
}

async function confirmedPost(base: string, path: string, body: unknown): Promise<Response> {
  const payload = JSON.stringify(body);
  const nonce = await issueNonce(base, path, body);
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...headers(), "x-confirm-nonce": nonce },
    body: payload,
  });
}

test("the mounted merge-hold route is high-tier, nonce-gated, bearer-attributed and returns production read-back", async () => {
  const { root, ledgerPath, deps } = rootFixture();
  const direct = buildMergeHoldRoute({ ledgerPath });
  assert.deepEqual([direct.method, direct.path, direct.scope, direct.tier], ["POST", "/v1/merge-hold", "write", "high"]);
  assert.ok(buildServeRoutes(deps).some((route) => route.path === direct.path));

  await withServer(deps, async (base) => {
    const input = { action: "engage", reason: "hold for a manual squash decision", prNumber: 3708, taskId: "W1-T2719" };
    const noNonce = await fetch(`${base}${direct.path}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(input),
    });
    assert.equal(noNonce.status, 403);
    assert.equal(readFileSync(ledgerPath, "utf8"), "", "missing nonce writes nothing");

    const stale = await fetch(`${base}${direct.path}`, {
      method: "POST",
      headers: { ...headers(), "x-confirm-nonce": "expired-or-unknown" },
      body: JSON.stringify(input),
    });
    assert.equal(stale.status, 403);
    assert.equal(readFileSync(ledgerPath, "utf8"), "", "stale nonce writes nothing");

    const payload = JSON.stringify(input);
    const identityNonceResponse = await fetch(`${base}/v1/confirm`, {
      method: "POST",
      headers: identityOnlyHeaders(),
      body: JSON.stringify({ method: "POST", path: direct.path, payload }),
    });
    assert.equal(identityNonceResponse.status, 200, "tailnet identity can satisfy the consequence tier");
    const identityNonce = ((await identityNonceResponse.json()) as { nonce: string }).nonce;
    const noBearerProvenance = await fetch(`${base}${direct.path}`, {
      method: "POST",
      headers: { ...identityOnlyHeaders(), "x-confirm-nonce": identityNonce },
      body: payload,
    });
    assert.equal(noBearerProvenance.status, 403);
    assert.deepEqual(await noBearerProvenance.json(), { error: "bearer_provenance_required" });
    assert.equal(readFileSync(ledgerPath, "utf8"), "", "an identity-only caller cannot create an unattributable hold");

    const engaged = await confirmedPost(base, direct.path, input);
    assert.equal(engaged.status, 200);
    assert.deepEqual(await engaged.json(), {
      action: "engage",
      scope: "PR #3708",
      written: true,
      current: {
        by: createHash("sha256").update(WRITE_TOKEN).digest("hex").slice(0, 12),
        reason: input.reason,
      },
    });
    const line = readLedgerLines(ledgerPath).at(-1);
    assert.equal(line?.by, createHash("sha256").update(WRITE_TOKEN).digest("hex").slice(0, 12));
    assert.equal(line?.origin, undefined, "the existing writer owns the ledger shape; no console-only decision is appended");
    assert.deepEqual(automergeHoldFromLedger(readLedgerLines(ledgerPath), 3708), {
      by: line?.by,
      reason: input.reason,
    });

    const released = await confirmedPost(base, direct.path, { action: "release", reason: "manual decision complete", prNumber: 3708, taskId: "W1-T2719" });
    assert.equal(released.status, 200);
    assert.equal(automergeHoldFromLedger(readLedgerLines(ledgerPath), 3708), undefined);

    const before = readLedgerLines(ledgerPath).length;
    const alreadyClear = await confirmedPost(base, direct.path, { action: "release", reason: "confirm still clear", prNumber: 3708 });
    assert.equal(alreadyClear.status, 200);
    assert.deepEqual(await alreadyClear.json(), { action: "release", scope: "PR #3708", written: false });
    assert.equal(readLedgerLines(ledgerPath).length, before, "an already-clear release is the writer's idempotent no-op");
  });
  assert.equal(existsSync(root), true);
});

test("malformed merge-hold bodies are refused before any append", async () => {
  const { ledgerPath, deps } = rootFixture();
  const bad = [
    null,
    {},
    { action: "merge", reason: "no" },
    { action: "engage", reason: "   " },
    { action: "engage", reason: "bad pr", prNumber: 0 },
    { action: "engage", reason: "bad pr", prNumber: 1.5 },
    { action: "engage", reason: "bad task", prNumber: 1, taskId: "task-1" },
    { action: "engage", reason: "task has no PR", taskId: "W1-T1" },
    { action: "engage", reason: "unknown key", merge: true },
  ];
  await withServer(deps, async (base) => {
    for (const body of bad) {
      const response = await confirmedPost(base, "/v1/merge-hold", body);
      assert.equal(response.status, 400, JSON.stringify(body));
    }
  });
  assert.equal(readFileSync(ledgerPath, "utf8"), "");
});

test("the console renders fleet and PR controls, exact confirmations and no merge or lifecycle primitive", () => {
  const html = renderShellHtml();
  for (const marker of [
    'id="merge-hold-fleet"',
    'id="merge-hold-fleet-reason"',
    'id="merge-hold-fleet-btn"',
    "function needsMeMergeHeldRowHtml",
    "function mergeHoldActionHtml",
    'postJson("/v1/merge-hold"',
  ]) assert.match(html, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const confirmationSource = html.match(/function mergeHoldConfirmationText\(action, scope, reason\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(confirmationSource);
  const confirmation = new Function(
    `${confirmationSource}\nreturn mergeHoldConfirmationText(arguments[0], arguments[1], arguments[2]);`,
  ) as (action: string, scope: string, reason: string) => string;
  assert.equal(
    confirmation("engage", "the whole fleet", "incident freeze"),
    "Confirm ENGAGE automatic-merge hold for the whole fleet — reason: incident freeze?",
  );
  assert.equal(
    confirmation("release", "PR #3708", "manual read complete"),
    "Confirm RELEASE automatic-merge hold for PR #3708 — reason: manual read complete?",
  );
  assert.match(html, /latestMergeHeld = statusSnap\.mergeHeld \?\? \[\]/);
  assert.match(html, /HIGH_TIER_WRITE_PATHS[\s\S]*\/v1\/merge-hold/);
  assert.match(
    html,
    /for \(const r of latestBlockedPrs[\s\S]*needsMeBlockedPrRowHtml\(r\) \+ mergeHoldActionHtml\(r\.prNumber\)/,
    "every live blocked-PR queue row carries the existing hold control",
  );
  const mergeHoldHandler = html.match(/\/\/ ── W1-T2719:[\s\S]*?\/\/ ── UP NEXT/)?.[0];
  assert.ok(mergeHoldHandler);
  assert.match(mergeHoldHandler, /response && response\.ok[\s\S]*await refreshAll\(\)/);
  assert.doesNotMatch(mergeHoldHandler, /postJson\("\/v1\/(?:merge"|control\/(?:start|stop|restart)"|deploy")/);
});
