import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "../src/lib/service.js";
import { buildPanelGraphRoutes, type PanelGraphDeps, type RatifyCliGateway } from "../src/lib/panel-graph.js";
import { classifyProposal, refusalReason, renderInbox, type Proposal, type ReadinessContext } from "../src/lib/inbox.js";
import type { TraceGithub } from "../src/lib/trace.js";
import type { GitHub } from "../src/lib/status.js";

// ── W1-T2604: "THE CONSOLE INBOX CAN ONLY SAY YES" ──────────────────────────────────────────
//
// /v1/inbox exposed exactly TWO actions (approve, reframe): a proposal that is self-withdrawn,
// refused, already satisfied on main, or a duplicate had no path out except being approved into
// a task nobody wants. This suite proves the fix, one claim per acceptance criterion:
//
//   1. an operator can decline a READY proposal from the console, and it leaves the ready queue
//   2. a decline is an operator act recorded with its reason, never inferred from the
//      proposal's own wording
//   3. declining writes no plan task and no branch, so it can never file the work it refuses
//   4. a not-ready proposal shows the failing predicate the classifier already names, rather
//      than a bare not_ready

const READ_TOKEN = "decline-read-token";
const WRITE_TOKEN = "decline-write-token";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-inbox-decline-"));
}

/** A `tmpRoot()` that is ALSO a real git repo, for the POST /v1/inbox/approve gate this suite's
 *  claim-4 control needs: that write-scoped route's tier-HIGH gate reads the plan via
 *  `loadPlanAtRef` (`git show HEAD:plan/tasks.yaml`), never the working tree -- see
 *  test/panel-graph.test.ts's own `gitTmpRoot`/`commitAll` for the identical precedent. */
function gitTmpRoot(): string {
  const root = tmpRoot();
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root, stdio: "pipe" });
  return root;
}

function commitAll(root: string): void {
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["commit", "--quiet", "-m", "test fixture"], { cwd: root, stdio: "pipe" });
}

function ledgerPathFor(root: string): string {
  return join(root, "state", "ledger.ndjson");
}

function readLedgerLines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function fakeGithub(): TraceGithub {
  return { prView: () => null };
}

function fakeStatusGithub(): GitHub {
  return { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
}

/** Records every call rather than spawning a real `bin/rmd` child process -- proves claim 3
 *  (no plan task, no branch) by proving this gateway is NEVER invoked by decline. */
function fakeRatifyGateway(): RatifyCliGateway & { approved: string[]; reframed: string[] } {
  const approved: string[] = [];
  const reframed: string[] = [];
  return {
    approved,
    reframed,
    approve(proposalId: string) {
      approved.push(proposalId);
    },
    reframe(proposalId: string) {
      reframed.push(proposalId);
    },
  };
}

function emptyPlanPath(root: string): string {
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(planPath, "[]\n");
  return planPath;
}

function depsFor(root: string, planPath: string, ratify: RatifyCliGateway = fakeRatifyGateway()): PanelGraphDeps {
  return { root, inboxRoot: root, planPath, ledgerPath: ledgerPathFor(root), github: fakeGithub(), statusGithub: fakeStatusGithub(), ratify };
}

async function withService<T>(deps: PanelGraphDeps, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes: buildPanelGraphRoutes(deps) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function post(base: string, path: string, token: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(base: string, path: string, token: string) {
  return fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
}

/** A lint-clean, dep-clean, no-external-deps fragment, so classifying it READY needs no merged-
 *  dependency fixture machinery -- mirrors test/panel-graph.test.ts's own READY_FRAGMENT. */
const READY_FRAGMENT = `
- id: W1-T900
  title: "drafted task one"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  status: queued
  attempts: 0
  origin: architect
  files: [src/lib/example.ts]
  acceptance:
    - claim: "the candidate does the thing"
      proof: "unit test: fixture X -> observable Y"
`;

/** Seeds a proposal that classifies READY (a cached, lint-clean, dep-clean draft). Its title
 *  announces its own disposition -- exactly the shape the task's rationale measured (5 of 52
 *  READY proposals self-declared WITHDRAWN/REFUSED/ALREADY-SATISFIED) -- to prove claim 2:
 *  that prose is NEVER what makes it decline; only the route call does. */
function seedReadyProposal(root: string, proposalId: string, summary: string): void {
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    join(root, "state", "inbox-proposals.json"),
    JSON.stringify({ proposals: [{ id: proposalId, summary, evidenceAnchors: [] }] }),
  );
  writeFileSync(
    join(root, "state", "inbox-drafts.json"),
    JSON.stringify({
      [proposalId]: {
        proposalId,
        fragmentYaml: READY_FRAGMENT,
        stampLine: `- ${proposalId} (plan) — RATIFIED 2026-09-02 -> W1-T900.`,
        anchorFingerprint: "",
      },
    }),
  );
}

/** Seeds a proposal with no cached draft -- classifies not_ready ("no drafted candidate
 *  available yet"), the ordinary not-drafted case (mirrors test/panel-graph.test.ts). */
function seedNotReadyProposal(root: string, proposalId: string, summary: string): void {
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    join(root, "state", "inbox-proposals.json"),
    JSON.stringify({ proposals: [{ id: proposalId, summary, evidenceAnchors: [] }] }),
  );
}

// ── Claim 1: an operator can decline a READY proposal, and it leaves the ready queue ────────

test("POST /v1/inbox/decline: a READY proposal is declined and no longer appears in GET /v1/inbox's ready queue", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  seedReadyProposal(root, "P900", "a duplicate of work already shipped");

  await withService(depsFor(root, planPath), async (base) => {
    // Before declining: the proposal IS in the ready queue.
    const before = (await (await get(base, "/v1/inbox", READ_TOKEN)).json()) as { ready: Array<{ proposalId: string }> };
    assert.deepEqual(
      before.ready.map((r) => r.proposalId),
      ["P900"],
    );

    const res = await post(base, "/v1/inbox/decline", WRITE_TOKEN, { proposalId: "P900", reason: "duplicate of W1-T2452, already merged" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, proposalId: "P900", declined: true });

    // After declining: it has LEFT the ready queue.
    const after = (await (await get(base, "/v1/inbox", READ_TOKEN)).json()) as { ready: Array<{ proposalId: string }> };
    assert.deepEqual(after.ready, []);
  });
});

// ── Claim 2: a decline is an operator act recorded with its reason, never inferred from the
// proposal's own wording ─────────────────────────────────────────────────────────────────────

test("POST /v1/inbox/decline: a READY proposal whose OWN title announces 'WITHDRAWN' still classifies ready until the operator explicitly declines it -- the reason is never inferred from prose", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  seedReadyProposal(root, "P901", "WITHDRAWN: operator no longer wants this");

  await withService(depsFor(root, planPath), async (base) => {
    // The title alone never declines it -- it is still READY, still approvable.
    const before = (await (await get(base, "/v1/inbox", READ_TOKEN)).json()) as { ready: Array<{ proposalId: string }> };
    assert.deepEqual(
      before.ready.map((r) => r.proposalId),
      ["P901"],
      "a proposal's own title text must never, by itself, remove it from the ready queue",
    );
  });

  // A decline attempt with NO reason is refused -- an operator act needs a named reason.
  await withService(depsFor(root, planPath), async (base) => {
    const noReason = await post(base, "/v1/inbox/decline", WRITE_TOKEN, { proposalId: "P901" });
    assert.equal(noReason.status, 400);
  });

  await withService(depsFor(root, planPath), async (base) => {
    const res = await post(base, "/v1/inbox/decline", WRITE_TOKEN, { proposalId: "P901", reason: "operator confirms: withdrawn, do not ratify" });
    assert.equal(res.status, 200);
  });

  // The ledger carries the operator's OWN reason, verbatim, attributed to the write bearer --
  // never a copy of the proposal's title.
  const lines = readLedgerLines(ledgerPathFor(root));
  const line = lines.find((l) => l.step === "panel.proposal_declined");
  assert.ok(line, "must ledger panel.proposal_declined");
  assert.equal(line!.task_id, "P901");
  assert.equal(line!.reason, "operator confirms: withdrawn, do not ratify");
  assert.notEqual(line!.reason, "WITHDRAWN: operator no longer wants this");
  assert.ok(typeof line!.origin === "string" && (line!.origin as string).length > 0, "must attribute the operator's own bearer as origin");
});

// ── Claim 3: declining writes no plan task and no branch ─────────────────────────────────────

test("POST /v1/inbox/decline: never calls the RatifyCliGateway (no branch) and never touches plan/tasks.yaml (no plan task)", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  seedReadyProposal(root, "P902", "a ready proposal");
  const planBefore = readFileSync(planPath, "utf8");
  const ratify = fakeRatifyGateway();

  await withService(depsFor(root, planPath, ratify), async (base) => {
    const res = await post(base, "/v1/inbox/decline", WRITE_TOKEN, { proposalId: "P902", reason: "no longer needed" });
    assert.equal(res.status, 200);
  });

  assert.deepEqual(ratify.approved, [], "decline must never hand off to RatifyCliGateway.approve -- no branch");
  assert.deepEqual(ratify.reframed, [], "decline must never hand off to RatifyCliGateway.reframe");
  assert.equal(readFileSync(planPath, "utf8"), planBefore, "declining must never write plan/tasks.yaml -- no plan task");
});

// ── Claim 4: a not-ready proposal shows the failing predicate rather than a bare not_ready ──

test("GET /v1/inbox: a not-ready proposal rides along in `notReady`, naming the EXACT failing predicate classifyProposal computed -- never a bare not_ready", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  seedNotReadyProposal(root, "P903", "no draft yet");

  await withService(depsFor(root, planPath), async (base) => {
    const body = (await (await get(base, "/v1/inbox", READ_TOKEN)).json()) as {
      ready: unknown[];
      notReady: Array<{ proposalId: string; summary: string; reasons: Array<{ predicate: string; detail: string }> }>;
    };
    assert.deepEqual(body.ready, []);
    assert.equal(body.notReady.length, 1);
    const [item] = body.notReady;
    assert.equal(item.proposalId, "P903");
    assert.ok(item.reasons.length > 0, "the failing predicate(s) must be named, never an empty/bare reason");
    assert.equal(item.reasons[0].predicate, "drafted");
    assert.match(item.reasons[0].detail, /not-drafted: no drafted candidate available yet/);
  });
});

test("POST /v1/inbox/approve on a not-ready proposal still refuses 409 naming the SAME failing predicate (unchanged, still not a bare not_ready)", async () => {
  const root = gitTmpRoot();
  const planPath = emptyPlanPath(root);
  seedNotReadyProposal(root, "P904", "no draft yet");
  commitAll(root);

  await withService(depsFor(root, planPath), async (base) => {
    const res = await post(base, "/v1/inbox/approve", WRITE_TOKEN, { proposalId: "P904" });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string; detail: string };
    assert.equal(body.error, "not_ready");
    assert.match(body.detail, /\[drafted\] not-drafted: no drafted candidate available yet/);
  });
});

// ── Edge cases worth locking down alongside the four claims ──────────────────────────────────

test("POST /v1/inbox/decline: an unknown proposal id -> 404, no ledger line written", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({ proposals: [] }));

  await withService(depsFor(root, planPath), async (base) => {
    const res = await post(base, "/v1/inbox/decline", WRITE_TOKEN, { proposalId: "P905", reason: "x" });
    assert.equal(res.status, 404);
  });
  assert.deepEqual(readLedgerLines(ledgerPathFor(root)), []);
});

test("POST /v1/inbox/decline: read token is refused with 403, the write route requires a write scope like approve/reframe", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  seedReadyProposal(root, "P906", "a ready proposal");

  await withService(depsFor(root, planPath), async (base) => {
    const res = await post(base, "/v1/inbox/decline", READ_TOKEN, { proposalId: "P906", reason: "x" });
    assert.equal(res.status, 403);
  });
});

test("POST /v1/inbox/decline: declining twice is refused 409 the second time, naming the already-recorded reason", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  seedReadyProposal(root, "P907", "a ready proposal");

  await withService(depsFor(root, planPath), async (base) => {
    const first = await post(base, "/v1/inbox/decline", WRITE_TOKEN, { proposalId: "P907", reason: "duplicate" });
    assert.equal(first.status, 200);

    const second = await post(base, "/v1/inbox/decline", WRITE_TOKEN, { proposalId: "P907", reason: "trying again" });
    assert.equal(second.status, 409);
    const body = (await second.json()) as { error: string; detail: string };
    assert.equal(body.error, "already_declined");
    assert.match(body.detail, /duplicate/);
  });
});

test("POST /v1/inbox/decline: an already-RATIFIED proposal is refused 409 -- declining can never un-file a task that already exists", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  seedReadyProposal(root, "P908", "a ready proposal");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(ledgerPathFor(root), `${JSON.stringify({ run_id: "APPROVE-P908-1", task_id: "P908", step: "ratify.approved" })}\n`);

  await withService(depsFor(root, planPath), async (base) => {
    const res = await post(base, "/v1/inbox/decline", WRITE_TOKEN, { proposalId: "P908", reason: "too late" });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "already_ratified");
  });
});

test("GET /v1/inbox: a declined proposal is healed out of `ready`/`notReady` even though its registry entry is untouched -- decline is a state, never a delete", async () => {
  const root = tmpRoot();
  const planPath = emptyPlanPath(root);
  seedReadyProposal(root, "P909", "a ready proposal");

  await withService(depsFor(root, planPath), async (base) => {
    await post(base, "/v1/inbox/decline", WRITE_TOKEN, { proposalId: "P909", reason: "superseded" });
    const body = (await (await get(base, "/v1/inbox", READ_TOKEN)).json()) as { ready: unknown[]; notReady: unknown[] };
    assert.deepEqual(body.ready, []);
    assert.deepEqual(body.notReady, []);
  });

  // The registry file itself is UNCHANGED -- still names the proposal, unlike a ratified one
  // which GET /v1/inbox prunes off disk.
  const registry = JSON.parse(readFileSync(join(root, "state", "inbox-proposals.json"), "utf8")) as { proposals: Array<{ id: string }> };
  assert.deepEqual(
    registry.proposals.map((p) => p.id),
    ["P909"],
    "declining must never delete the proposal from the registry",
  );
});

// ── Unit coverage for the two read-side renderers a declined classification reaches ────────
//
// The route-level tests above only ever observe a decline through GET /v1/inbox's `ready`/
// `notReady` arrays, which never render a `declined` classification directly. `renderInbox`
// (the digest/CLI text) and `refusalReason` (the 409 an approve-on-declined would surface) each
// have their own `state === "declined"` branch that no test anywhere else exercises; both are
// covered directly here against a `classifyProposal` result built the same way inbox.test.ts's
// own fixtures are.

function declinedClassification(reason: string | undefined): ReturnType<typeof classifyProposal> {
  const proposal: Proposal = { id: "P-DECLINED", summary: "a proposal an operator declined", evidenceAnchors: [] };
  const ctx: ReadinessContext = {
    plan: { tasks: [], byId: new Map() },
    isMerged: () => false,
    grepAnchorTrue: () => true,
    openProposalIds: new Set(),
    isRatified: () => false,
    isDeclined: () => reason,
  };
  return classifyProposal(proposal, undefined, ctx);
}

test("classifyProposal + renderInbox: a declined proposal is named DECLINED with its operator reason, never silently dropped", () => {
  const result = declinedClassification("superseded by W1-T900");
  assert.equal(result.state, "declined");
  assert.equal(result.declinedReason, "superseded by W1-T900");

  const text = renderInbox([result]);
  assert.match(text, /1 declined\./);
  assert.match(text, /DECLINED — P-DECLINED \(superseded by W1-T900\)/);
});

test("classifyProposal + renderInbox: a declined proposal with no recorded reason still renders a fallback, never a blank parenthetical", () => {
  const result = declinedClassification("declined by an operator");
  const text = renderInbox([result]);
  assert.match(text, /DECLINED — P-DECLINED \(declined by an operator\)/);
});

test("refusalReason: a declined proposal is refused naming DECLINED and its reason, exactly like RETIRED's own sibling branch", () => {
  const result = declinedClassification("duplicate of a proposal just ratified");
  assert.equal(
    refusalReason(result),
    "P-DECLINED is DECLINED (duplicate of a proposal just ratified) — never approvable",
  );
});
