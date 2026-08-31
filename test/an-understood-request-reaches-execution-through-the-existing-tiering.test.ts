import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  proposalFromUnderstoodRequest,
  understoodRequestProposalId,
  classifyProposal,
  type ReadinessContext,
  type UnderstoodRequest,
} from "../src/lib/inbox.js";
import type { InterpretReplyResult } from "../src/lib/reply-interpreter.js";
import {
  routeRequestFanout,
  routeSpecialists,
  type RequestFanoutInput,
  type SpecialistPanelInput,
} from "../src/lib/specialist-panel.js";
import type { Plan } from "../src/lib/plan.js";

// ── W1-T2500: W1-T2499 leaves a thread "understood" (an empty unanswered set) and stops there
// by design -- it asks, it never acts. Nothing carried that state anywhere: the interpreter's
// work ended in a conversation. This suite proves the handoff this task adds: an understood
// request becomes a Proposal that enters the SAME tiering `classifyProposal` already runs every
// other proposal through (never a task filed directly, never auto-approved), and the fan-out
// decision for that request reuses the SAME deterministic, zero-model-call four-specialist
// router (specialist-panel.ts, §4B) rather than inventing a second one, or letting a model choose.
//
// Acceptance (plan/tasks.d/W1-T2500-...yaml), each proven by name below:
//   1. a thread with no unanswered clarifications emits a proposal into the existing tiering
//   2. nothing on this path files a task directly or auto-approves one
//   3. a thread with an unanswered clarification emits nothing and runs nothing
//   4. the fan-out decision is a pure predicate with no model call inside it
//   5. the same request always routes to the same set of workers
//   6. fan-out is bounded and a request that does not decompose spawns one worker
//   7. every parallel branch reports back onto the thread that asked
//   8. the four existing specialists keep their current triggers and rubrics
//   9. letting a model choose the worker set fails the pure-predicate assertion

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

function readSrc(relPath: string): string {
  return readFileSync(join(REPO_ROOT, "src", relPath), "utf8");
}

/** Extract one exported function's source text (from its `export function <name>` line up to
 *  the next top-level `export` or the next section banner) -- the same "assert on the ACTUAL
 *  source, not a description of it" discipline the reply-interpreter suite already uses for its
 *  own "names no dispatch primitive" checks. */
function extractFunctionSource(fileText: string, name: string): string {
  const start = fileText.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `could not find export function ${name}( in source`);
  const rest = fileText.slice(start);
  const nextExport = rest.indexOf("\nexport function", 1);
  const nextBanner = rest.indexOf("\n// ──", 1);
  const candidates = [nextExport, nextBanner].filter((i) => i >= 0);
  const end = candidates.length > 0 ? Math.min(...candidates) : rest.length;
  return rest.slice(0, end);
}

const emptyPlan: Plan = { tasks: [], byId: new Map() };

function baseReadinessContext(over: Partial<ReadinessContext> = {}): ReadinessContext {
  return {
    plan: emptyPlan,
    isMerged: () => true,
    grepAnchorTrue: () => true,
    openProposalIds: new Set(),
    isRatified: () => false,
    ...over,
  };
}

// ── 1/2/3: the proposal handoff ─────────────────────────────────────────────────────────────

test("a thread with no unanswered clarifications emits a proposal into the existing tiering", () => {
  const request: UnderstoodRequest = { threadId: "W1-T9202:BLOCKED", requestText: "please add retry to the flaky step" };
  const understood: InterpretReplyResult = { status: "understood" };

  const proposal = proposalFromUnderstoodRequest(request, understood);
  assert.ok(proposal, "an understood thread must emit a proposal");
  assert.equal(proposal!.id, understoodRequestProposalId(request.threadId));
  assert.match(proposal!.summary, /please add retry to the flaky step/);

  // Enters the EXISTING tiering -- the same classifyProposal every other proposal (P##, FD-…,
  // rule-efficacy:…) already runs through, unchanged.
  const classification = classifyProposal(proposal!, undefined, baseReadinessContext());
  assert.equal(classification.proposalId, proposal!.id);
  assert.ok(["not_ready", "ready", "deferred_with_trigger"].includes(classification.state));
});

test("nothing on this path files a task directly or auto-approves one", () => {
  const request: UnderstoodRequest = { threadId: "W1-T9202:BLOCKED", requestText: "please add retry" };
  const proposal = proposalFromUnderstoodRequest(request, { status: "understood" })!;

  // A freshly minted proposal has no draft yet, no trigger, and is not ratified -- so the
  // EXISTING tiering classifies it not_ready (missing a draft), never ready-to-approve and
  // never ratified outright. Filing a task or auto-approving would require a later, separate
  // rung (the draft rung, then `rmd approve`) -- neither of which this function calls.
  const classification = classifyProposal(proposal, undefined, baseReadinessContext());
  assert.equal(classification.state, "not_ready");
  assert.ok(classification.reasons.some((r) => r.predicate === "drafted"));
});

test("proposalFromUnderstoodRequest source names no ratify/dispatch/task-filing primitive", () => {
  const src = readSrc("lib/inbox.ts");
  const fnSrc = extractFunctionSource(src, "proposalFromUnderstoodRequest");
  for (const forbidden of ["approveProposal(", "approveBatch(", "appendLedger(", "execFileSync(", "applyFragmentToPlanYaml(", "updateProposalRegistry("]) {
    assert.ok(!fnSrc.includes(forbidden), `proposalFromUnderstoodRequest must never call ${forbidden}`);
  }
});

test("a thread with an unanswered clarification emits nothing and runs nothing", () => {
  const request: UnderstoodRequest = { threadId: "W1-T9202:BLOCKED", requestText: "please add retry" };

  const clarifying: InterpretReplyResult = {
    status: "clarifying",
    question: { id: "which-step", question: "which step?", established: "the CI job is flaky" },
  };
  assert.equal(proposalFromUnderstoodRequest(request, clarifying), undefined);

  const exhausted: InterpretReplyResult = {
    status: "exhausted",
    unresolved: [{ id: "which-step", question: "which step?", established: "the CI job is flaky" }],
  };
  assert.equal(proposalFromUnderstoodRequest(request, exhausted), undefined);
});

// ── 4/5/6/7/8/9: the routed fan-out ──────────────────────────────────────────────────────────

function panelInput(over: Partial<SpecialistPanelInput> = {}): SpecialistPanelInput {
  return { diff: { files: [] }, ...over };
}

test("fan-out is bounded and a request that does not decompose spawns one worker", () => {
  const input: RequestFanoutInput = { threadId: "thread-1", panel: panelInput() };
  const branches = routeRequestFanout(input);
  assert.deepEqual(
    branches.map((b) => b.worker),
    ["general"],
  );
  assert.equal(branches[0].threadId, "thread-1");
});

test("the same request always routes to the same set of workers", () => {
  const input: RequestFanoutInput = {
    threadId: "thread-2",
    panel: panelInput({ diff: { files: [{ path: "src/lib/secret-store.ts" }] } }),
  };
  const first = routeRequestFanout(input);
  const second = routeRequestFanout(input);
  const third = routeRequestFanout(structuredClone(input));
  assert.deepEqual(first, second);
  assert.deepEqual(first, third);
});

test("the four existing specialists keep their current triggers and rubrics -- routeRequestFanout decomposes a request that trips all four, in the router's own fixed order", () => {
  const input: RequestFanoutInput = {
    threadId: "thread-3",
    panel: {
      diff: { files: [{ path: "src/lib/secret-store.ts" }, { path: "src/lib/sandbox-policy.ts" }] },
      task: { tddStrict: true, crossesLayerBoundary: true },
    },
  };

  // Same underlying router, called directly -- proves routeRequestFanout did not touch it.
  const directTriggers = routeSpecialists(input.panel);
  assert.deepEqual(
    directTriggers.map((t) => t.specialist),
    ["security", "testing", "design", "containment"],
  );

  const branches = routeRequestFanout(input);
  assert.deepEqual(
    branches.map((b) => b.worker),
    ["security", "testing", "design", "containment"],
  );
  assert.deepEqual(
    branches.map((b) => b.reason),
    directTriggers.map((t) => t.reason),
  );
});

test("every parallel branch reports back onto the thread that asked", () => {
  const input: RequestFanoutInput = {
    threadId: "thread-4",
    panel: {
      diff: { files: [{ path: "src/lib/secret-store.ts" }, { path: "src/lib/sandbox-policy.ts" }] },
      task: { tddStrict: true, crossesLayerBoundary: true },
    },
  };
  const branches = routeRequestFanout(input);
  assert.ok(branches.length > 1, "fixture must actually decompose into more than one branch");
  for (const b of branches) assert.equal(b.threadId, "thread-4");
});

test("the fan-out decision is a pure predicate with no model call inside it -- source has no await, spawn, or network call", () => {
  const src = readSrc("lib/specialist-panel.ts");
  const fnSrc = extractFunctionSource(src, "routeRequestFanout");
  for (const forbidden of ["await ", "spawnWorker(", "spawnSpecialistWorker(", "fetch(", "execFileSync(", "anthropic"]) {
    assert.ok(!fnSrc.toLowerCase().includes(forbidden.toLowerCase()), `routeRequestFanout must never reference ${forbidden}`);
  }
});

test("letting a model choose the worker set fails the pure-predicate assertion -- an injected model hint is ignored", () => {
  const input: RequestFanoutInput = { threadId: "thread-5", panel: panelInput() };
  const withoutHint = routeRequestFanout(input);

  // A model asked to "choose the worker set" could only ever reach this router by smuggling its
  // answer onto the input object -- there is no parameter that reads one. Even when a caller
  // tries exactly that, the router's output is identical: the only thing that can move the
  // answer is routeSpecialists's own pure diff/task predicate.
  const withHint = routeRequestFanout({
    ...input,
    modelChosenWorkers: ["security", "testing", "design", "containment"],
  } as RequestFanoutInput);

  assert.deepEqual(withHint, withoutHint);
});
