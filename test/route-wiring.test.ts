import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { declaredConsoleRoutes } from "./helpers/declared-routes.js";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import { drainNowFilePath, kickFilePath, pauseFilePath, stopFilePath } from "../src/lib/fleet-control.js";
import type { Plan } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
import type { RatifyCliGateway } from "../src/lib/panel-graph.js";
import { dailyCostCeilingOverridePath } from "../src/lib/policy.js";

// ── WHAT THIS SUITE ADDS, AND WHY IT IS NOT test/route-registration.test.ts AGAIN.
//
// #1105's suite proves every declared route is MOUNTED — it probes anonymously and reads 404-vs-401.
// That is decisive about existence and says NOTHING about behaviour: `service.ts` resolves the route
// (:201) and 404s (:203) BEFORE checking the token (:207), so a 401 proves only that the router
// found an entry. A route can be mounted and still wired to the wrong deps.
//
// THAT IS NOT HYPOTHETICAL. Production hands `buildServeServer` TWO different roots
// (run-task.ts: `fleetControlRoot: config.root`, `questionsRoot: repoRoot`) and serve.ts routes
// exactly one builder — `buildAnswerQuestionRoute` — at the second one. #1105's author found that
// mounting `buildPanelActionRoutes` wholesale, which passes ONE deps to all eleven builders, "would
// have been a bug — it would silently re-root POST /v1/questions/answer". Every route below would
// still answer 200 with its root swapped; the operator's answer would just land where the worker
// never reads it.
//
// So this suite asserts, per route, WHERE THE EFFECT LANDED — the right root, the right gateway,
// the right ledger path — by giving every dep a DISTINCT injected value and checking both that the
// effect appears at the right one and that it does NOT appear at the other.
//
// HOW THE PRODUCTION-ASSEMBLY GUARANTEE IS MADE (and it is not by assertion). Every test here goes
// through `withProductionServer`, which calls `buildServeServer` — the same function
// `src/run-task.ts`'s serve command calls, with the same `ServeDeps` shape. The PROOF that this is
// the real registration path and not a hand-assembled server is the falsifier: deleting a route's
// line from `serve.ts` turns these tests red. A suite that built its own service from a builder
// could not notice that — which is exactly how six `/v1/drain/feedback` tests passed against a route
// the console never mounted.
//
// NOTHING REAL IS WRITTEN. Every root is a fresh mkdtemp, the ledger is a temp file, and the GitHub
// issue gateway is a recorder. Note this safety does NOT come from the live-write guard: that guard
// covers OUTWARD calls (gh pr create/merge, gh issue create, git push — see its call sites) and does
// not police filesystem writes under `state/`. `deps.issues.close` in particular reaches
// `gh issue close` in production and is NOT guarded, which is precisely why it is injected here.

const READ_TOKEN = "route-wiring-read-token";
const WRITE_TOKEN = "route-wiring-write-token";

// ── PRIORITY. Criterion: WHAT AN OPERATOR LOSES IF THE CONTROL SILENTLY DOES NOTHING, OR THE WRONG
// THING. A control that reports success while its effect lands somewhere nothing reads is worse than
// a panel that renders stale, because the operator acts on the false confirmation.
//
//   1. POST /v1/control/stop              the operator believes the fleet is halted; it keeps spending
//   2. POST /v1/control/resume            the fleet stays halted and recovery needs hand-editing files
//   3. POST /v1/escalation/mark-handled   the ONLY external, irreversible effect — closes a real issue
//   4. POST /v1/drain/kick                dispatches a task: real spend, or a dead button
//   5. POST /v1/drain/run                 same, fleet-wide
//   6. POST /v1/questions/answer          the MEASURED misrooting hazard; a blocked worker never unblocks
//   7. POST /v1/policy/daily-cost-ceiling(/clear)   W1-T364: the operator believes he moved the spend
//      ceiling; a misrooted write leaves dailyCostCeilingReloader (run-task.ts, repoRoot-scoped)
//      never seeing it — the exact display-vs-enforcement lie the task's own design note names, the
//      same asymmetry class as #6 (a THIRD route rooted at questionsRoot, not fleetControlRoot).
//
// Covered here: all seven. Deliberately deferred (see COVERAGE_DEBT below): the lower-consequence
// write routes, which either need a plan/inbox fixture or cannot strand the fleet.

/** Write routes not yet wiring-tested, each with the reason. The ledger test below fails when a NEW
 *  write route appears in neither this list nor the covered set — so a route added tomorrow surfaces
 *  immediately rather than joining a silent backlog. */
const COVERAGE_DEBT: ReadonlyMap<string, string> = new Map([
  ["POST /v1/quiet-hours", "schedule window; a failure delays dispatch, never strands it"],
  ["POST /v1/manual/approve", "needs a plan fixture with a verify:human task"],
  ["POST /v1/inbox/approve", "needs an inbox-proposals fixture; ratify gateway already injected"],
  ["POST /v1/inbox/reframe", "needs an inbox-proposals fixture; ratify gateway already injected"],
  ["POST /v1/feedback", "capture-only; no fleet effect"],
  ["POST /v1/feedback/preview", "W1-T350: files nothing (no root-scoped side effect to mis-root) — behavior covered in test/panel-graph.test.ts and the console idiom in test/serve.test.ts"],
  ["POST /v1/feedback/decision", "needs a feedback-landing fixture (real git bridge)"],
  ["POST /v1/operator-notes/add", "advisory note; no fleet effect"],
  ["POST /v1/drain/feedback", "covered by test/route-registration.test.ts (mount + write scope)"],
  [
    "POST /v1/escalation/reply",
    "W1-T2496: capture-only (files a feedback entry + a thread message), same shape as POST /v1/feedback " +
      "above — no fleet-effect root to mis-wire. Covered by test/a-prose-reply-reaches-the-fleet-as-an-input.test.ts.",
  ],
  ["POST /v1/skills/run", "covered by test/skill-run-route-registered.test.ts"],
]);

const COVERED: ReadonlySet<string> = new Set([
  "POST /v1/control/stop",
  "POST /v1/control/resume",
  "POST /v1/control/pause",
  "POST /v1/escalation/mark-handled",
  "POST /v1/drain/kick",
  "POST /v1/drain/run",
  "POST /v1/questions/answer",
  "POST /v1/policy/daily-cost-ceiling",
  "POST /v1/policy/daily-cost-ceiling/clear",
]);

// ── Production-shaped assembly ───────────────────────────────────────────────

interface Harness {
  base: string;
  /** `config.root` in production — fleet-control flag files and dispatch markers land here. */
  fleetRoot: string;
  /** `repoRoot` in production — plan/questions.ndjson lands here. A DIFFERENT directory, on purpose. */
  questionsRoot: string;
  ledgerPath: string;
  /** Every issue URL the route asked the gateway to close. */
  closed: string[];
}

function fakeGitHub(): GitHub {
  return { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
}
function fakeTraceGithub(): TraceGithub {
  return { prView: () => null };
}
function fakeRatifyGateway(): RatifyCliGateway {
  return { approve: () => {}, reframe: () => {} };
}
function planOf(): Plan {
  return { tasks: [], byId: new Map() };
}

/**
 * Assemble the console the way `rmd serve` does — `buildServeServer`, the same `ServeDeps` shape
 * `src/run-task.ts` builds — but with every dep pointed at an injected, distinguishable target.
 *
 * THE TWO ROOTS ARE DIFFERENT DIRECTORIES, mirroring production (`config.root` vs `repoRoot`). That
 * difference is the whole instrument: a misrooted route writes into the other one and every
 * assertion below notices.
 */
async function withProductionServer<T>(fn: (h: Harness) => Promise<T>): Promise<T> {
  const fleetRoot = mkdtempSync(join(tmpdir(), "rmd-wiring-fleet-"));
  const questionsRoot = mkdtempSync(join(tmpdir(), "rmd-wiring-questions-"));
  const ledgerRoot = mkdtempSync(join(tmpdir(), "rmd-wiring-ledger-"));

  mkdirSync(join(ledgerRoot, "state"), { recursive: true });
  const ledgerPath = join(ledgerRoot, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  mkdirSync(join(questionsRoot, "plan"), { recursive: true });
  const planPath = join(questionsRoot, "plan", "tasks.yaml");
  writeFileSync(planPath, "[]\n");

  const closed: string[] = [];
  const issues: IssueCloser = { close: (url: string) => void closed.push(url) };

  const deps: ServeDeps = {
    board: { plan: planOf(), ledgerPath, github: fakeGitHub() },
    panelGraph: {
      root: questionsRoot,
      planPath,
      ledgerPath,
      github: fakeTraceGithub(),
      statusGithub: fakeGitHub(),
      ratify: fakeRatifyGateway(),
    },
    ledgerPath,
    issues,
    fleetControlRoot: fleetRoot,
    questionsRoot,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    // W1-T500: enforcement is on and the bearer token is pinned `low`; these routes are MIDDLE and
    // HIGH, so the request must arrive the way the operator's does — over the tailnet, whose
    // grantor declares `writeTier: "high"`.
    identity: { trustedLocalAddress: "127.0.0.1", capability: TAILNET_CAP },
    pollMs: 50,
    log: () => {},
  };

  const server = buildServeServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn({ base: `http://127.0.0.1:${port}`, fleetRoot, questionsRoot, ledgerPath, closed });
  } finally {
    server.close();
  }
}

/** The ACL app-capability the tailnet grantor looks for. */
const TAILNET_CAP = "remudero:console";

/** HIGH-tier routes also need the server-issued second factor — confirm, then replay with it. */
const HIGH_TIER = new Set(["/v1/manual/approve", "/v1/drain/kick", "/v1/drain/run", "/v1/inbox/approve", "/v1/skills/run"]);

async function post(
  base: string,
  path: string,
  body: unknown,
  token = WRITE_TOKEN,
  /** BEARER-ONLY: omit the tailnet grant, which is consulted FIRST and would hand READ_WRITE to
   *  the read token — deleting the scope assertion this flag exists to protect. */
  opts: { tailnet?: boolean } = {},
): Promise<Response> {
  const payload = JSON.stringify(body ?? {});
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    ...(opts.tailnet === false ? {} : { "tailscale-app-capabilities": JSON.stringify({ [TAILNET_CAP]: {} }) }),
  };
  if (HIGH_TIER.has(path)) {
    const confirmed = await fetch(`${base}/v1/confirm`, {
      method: "POST",
      headers,
      body: JSON.stringify({ method: "POST", path, payload }),
    });
    if (!confirmed.ok) return confirmed;
    const { nonce } = (await confirmed.json()) as { nonce: string };
    headers["x-confirm-nonce"] = nonce;
  }
  return fetch(`${base}${path}`, { method: "POST", headers, body: payload });
}

/** Every ledger step recorded at the INJECTED ledger path. Empty ⇒ the route wrote to another one. */
function ledgerSteps(ledgerPath: string): Array<Record<string, unknown>> {
  return readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Assert nothing leaked into the root this route must NOT touch. */
function assertNothingUnder(root: string, label: string): void {
  const stateDir = join(root, "state");
  const planDir = join(root, "plan");
  assert.ok(
    !existsSync(join(stateDir, "STOP_REQUESTED")) &&
      !existsSync(join(stateDir, "PAUSED")) &&
      !existsSync(join(stateDir, "DRAIN_REQUESTED")) &&
      !existsSync(join(planDir, "questions.ndjson")),
    `a fleet-control or question artifact appeared under ${label} — the route is misrooted`,
  );
}

// ── The coverage ledger — new write routes cannot join a silent backlog ──────

test("every declared write route is either wiring-tested here or listed as explicit debt", () => {
  const declaredWrites = declaredConsoleRoutes()
    .filter((r) => r.method === "POST")
    .map((r) => `${r.method} ${r.path}`);

  assert.ok(declaredWrites.length >= 10, `expected the derivation to find the write routes, got ${declaredWrites.length}`);

  const unaccounted = declaredWrites.filter((k) => !COVERED.has(k) && !COVERAGE_DEBT.has(k));
  assert.deepEqual(
    unaccounted,
    [],
    "a write route exists that is neither wiring-tested nor listed in COVERAGE_DEBT with a reason — " +
      "add it to one or the other rather than leaving it silently uncovered",
  );
});

// ── 1. STOP — the highest-consequence control ────────────────────────────────

test("POST /v1/control/stop writes the stop flag under fleetControlRoot, not questionsRoot", async () => {
  await withProductionServer(async (h) => {
    const res = await post(h.base, "/v1/control/stop", { reason: "operator halted the fleet" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { stopped: true, reason: "operator halted the fleet" });

    // RIGHT ROOT: the flag lands where `rmd daemon`/`rmd drain` look for it.
    assert.ok(existsSync(stopFilePath(h.fleetRoot)), "the stop flag must be written under fleetControlRoot");
    // WRONG ROOT: and nowhere else. This is the assertion a re-rooting would trip.
    assert.ok(!existsSync(stopFilePath(h.questionsRoot)), "the stop flag must NOT be written under questionsRoot");
    assertNothingUnder(h.questionsRoot, "questionsRoot");

    // RIGHT LEDGER: the audit line lands at the injected ledger path, not some other one.
    const steps = ledgerSteps(h.ledgerPath);
    assert.equal(steps.filter((s) => s.step === "panel.stop_requested").length, 1);
  });
});

// ── 2. RESUME (and PAUSE, its precondition) ──────────────────────────────────

test("POST /v1/control/resume clears the pause flag under fleetControlRoot", async () => {
  await withProductionServer(async (h) => {
    const paused = await post(h.base, "/v1/control/pause", { reason: "holding" });
    assert.equal(paused.status, 200);
    assert.ok(existsSync(pauseFilePath(h.fleetRoot)), "pause must write its flag under fleetControlRoot");
    assert.ok(!existsSync(pauseFilePath(h.questionsRoot)), "pause must NOT write under questionsRoot");

    const res = await post(h.base, "/v1/control/resume", {});
    assert.equal(res.status, 200);
    assert.ok(
      !existsSync(pauseFilePath(h.fleetRoot)),
      "resume must CLEAR the flag under fleetControlRoot — a resume that clears a flag elsewhere " +
        "leaves the fleet halted with the console reporting success",
    );

    const steps = ledgerSteps(h.ledgerPath).map((s) => s.step);
    assert.ok(steps.includes("panel.pause_requested") && steps.includes("panel.resume_requested"));
  });
});

// ── 3. MARK HANDLED — the only external, irreversible effect ─────────────────

test("POST /v1/escalation/mark-handled closes exactly the issue named, through the injected gateway", async () => {
  await withProductionServer(async (h) => {
    const issueUrl = "https://github.com/craigoley/remudero/issues/4242";
    const res = await post(h.base, "/v1/escalation/mark-handled", { taskId: "W1-T100", issueUrl });
    assert.equal(res.status, 200);

    // RIGHT GATEWAY, RIGHT ARGUMENT. In production this reaches `gh issue close` (ghIssueCloser,
    // run-task.ts) and is NOT covered by the live-write guard, so a wrong URL closes a real issue.
    assert.deepEqual(h.closed, [issueUrl], "the route must ask the injected IssueCloser to close exactly that URL");

    const steps = ledgerSteps(h.ledgerPath).filter((s) => s.step === "panel.escalation_marked_handled");
    assert.equal(steps.length, 1);
    assert.equal(steps[0].issue_url, issueUrl);
  });
});

// ── 4 & 5. RUN and DRAIN NOW — the dispatch markers the daemon consumes ──────

test("POST /v1/drain/kick drops the KICK_REQUESTED marker under fleetControlRoot", async () => {
  await withProductionServer(async (h) => {
    const res = await post(h.base, "/v1/drain/kick", { taskId: "W1-T100" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { armed: true, taskId: "W1-T100" });

    // The daemon polls config.root — a marker under any other root is a dead button that
    // still reports "armed".
    assert.ok(existsSync(kickFilePath(h.fleetRoot, "W1-T100")), "the kick marker must land under fleetControlRoot");
    assert.ok(!existsSync(kickFilePath(h.questionsRoot, "W1-T100")), "and NOT under questionsRoot");

    assert.equal(ledgerSteps(h.ledgerPath).filter((s) => s.step === "console.kick_requested").length, 1);
  });
});

test("POST /v1/drain/run drops the DRAIN_REQUESTED marker under fleetControlRoot", async () => {
  await withProductionServer(async (h) => {
    const res = await post(h.base, "/v1/drain/run", {});
    assert.equal(res.status, 200);

    assert.ok(existsSync(drainNowFilePath(h.fleetRoot)), "the drain marker must land under fleetControlRoot");
    assert.ok(!existsSync(drainNowFilePath(h.questionsRoot)), "and NOT under questionsRoot");
    assertNothingUnder(h.questionsRoot, "questionsRoot");

    assert.equal(ledgerSteps(h.ledgerPath).filter((s) => s.step === "console.drain_requested").length, 1);
  });
});

// ── 6. ANSWER — the measured misrooting hazard, asserted in the OTHER direction ──

test("POST /v1/questions/answer writes questions.ndjson under questionsRoot, not fleetControlRoot", async () => {
  await withProductionServer(async (h) => {
    const res = await post(h.base, "/v1/questions/answer", { taskId: "W1-T100", answer: "yes, proceed" });
    assert.equal(res.status, 200);

    // THE ASYMMETRY THAT MATTERS. Nine write routes root at fleetControlRoot; this ONE roots at
    // questionsRoot, because `appendQuestionAnswer` (worker.ts) writes <repoRoot>/plan/questions.ndjson
    // and that is where the blocked worker reads. Mounting the aggregator wholesale would flip this
    // to fleetControlRoot, the answer would never be seen, and the worker would never unblock —
    // while the console reported ok:true.
    const answersPath = join(h.questionsRoot, "plan", "questions.ndjson");
    assert.ok(existsSync(answersPath), "the answer must be written under questionsRoot");
    assert.ok(
      !existsSync(join(h.fleetRoot, "plan", "questions.ndjson")),
      "the answer must NOT be written under fleetControlRoot — that is the misrooting this asserts against",
    );
    assert.match(readFileSync(answersPath, "utf8"), /yes, proceed/);

    const steps = ledgerSteps(h.ledgerPath).filter((s) => s.step === "panel.question_answered");
    assert.equal(steps.length, 1);
    assert.equal(steps[0].recorded_to_question_store, true);
  });
});

// ── 7. W1-T364 — the daily-cost-ceiling override write control ──────────────

test("POST /v1/policy/daily-cost-ceiling writes state/DAILY_COST_CEILING_OVERRIDE under panelGraph.root (questionsRoot here, repoRoot in production), not fleetControlRoot", async () => {
  await withProductionServer(async (h) => {
    const res = await post(h.base, "/v1/policy/daily-cost-ceiling", { usd: 900 });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { provenance: string; usd: number };
    assert.equal(body.provenance, "overridden");
    assert.equal(body.usd, 900);

    // THE ASYMMETRY THAT MATTERS, same class as POST /v1/questions/answer above:
    // dailyCostCeilingReloader (run-task.ts, W1-T363) resolves state/DAILY_COST_CEILING_OVERRIDE
    // against `repoRoot` on every daemon tick, and panelGraph.root IS repoRoot in production (this
    // route's own header). A write landing at fleetControlRoot instead would report ok:true to the
    // operator while the daemon's governor never saw it -- the exact display-vs-enforcement lie
    // W1-T364's own design note exists to close.
    assert.ok(existsSync(dailyCostCeilingOverridePath(h.questionsRoot)), "the override must be written under panelGraph.root (questionsRoot here)");
    assert.ok(
      !existsSync(dailyCostCeilingOverridePath(h.fleetRoot)),
      "the override must NOT be written under fleetControlRoot — that is the misrooting this asserts against",
    );

    const steps = ledgerSteps(h.ledgerPath).filter((s) => s.step === "console.ceiling_override_written");
    assert.equal(steps.length, 1);
    assert.equal(steps[0].to_usd, 900);
    assert.equal(steps[0].effective_usd, 900);
  });
});

test("POST /v1/policy/daily-cost-ceiling/clear removes state/DAILY_COST_CEILING_OVERRIDE under panelGraph.root, reverting to the committed default", async () => {
  await withProductionServer(async (h) => {
    const set = await post(h.base, "/v1/policy/daily-cost-ceiling", { usd: 900 });
    assert.equal(set.status, 200);
    assert.ok(existsSync(dailyCostCeilingOverridePath(h.questionsRoot)));

    const res = await post(h.base, "/v1/policy/daily-cost-ceiling/clear", {});
    assert.equal(res.status, 200);
    const body = (await res.json()) as { provenance: string };
    assert.equal(body.provenance, "default");
    assert.ok(!existsSync(dailyCostCeilingOverridePath(h.questionsRoot)), "the override file must be removed under panelGraph.root");

    const steps = ledgerSteps(h.ledgerPath).filter((s) => s.step === "console.ceiling_override_written");
    assert.equal(steps.length, 2, "one line for the set, one for the clear");
  });
});

// ── Scope, asserted once: these are write routes, and a read token is not enough ──

test("every wiring-covered write route rejects the read token", async () => {
  await withProductionServer(async (h) => {
    for (const key of COVERED) {
      const routePath = key.slice("POST ".length);
      const res = await post(
        h.base,
        routePath,
        { taskId: "W1-T100", issueUrl: "https://x/1", answer: "a" },
        READ_TOKEN,
        { tailnet: false },
      );
      await res.arrayBuffer();
      assert.equal(res.status, 403, `${key} must reject a read-only token`);
    }
    // A refused request is not a partial one: nothing was written anywhere.
    assert.equal(ledgerSteps(h.ledgerPath).length, 0, "a scope refusal must leave no ledger line");
    assertNothingUnder(h.fleetRoot, "fleetControlRoot");
    assertNothingUnder(h.questionsRoot, "questionsRoot");
  });
});
