import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "../src/lib/service.js";
import {
  buildClarifyGrill,
  buildPanelSkillRunRoutes,
  buildRunSkillRoute,
  groundClarifyRequest,
  type PanelSkillRunDeps,
} from "../src/lib/panel-skill-run.js";
import { buildFeedbackInboxRoute, buildSubmitFeedbackRoute, type PanelGraphDeps } from "../src/lib/panel-graph.js";
import { readFeedbackEntry } from "../src/lib/feedback.js";
import { skillsDir } from "../src/lib/skill.js";
import { lintTask } from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";

// ── W3-T8 round 3: invoking Refine runs the plan --mode=clarify skill and shows the grill ──
// inline (MASTER-PLAN §5B/§7) — the review gate's UNMET acceptance claim from rounds 1 and 2.
//
// Acceptance (plan/tasks.yaml):
//   "invoking Refine from the panel runs the plan --mode=clarify skill and shows the grill
//   inline" — proof: "clicking Refine triggers plan --mode=clarify; its grill questions render
//   inline in the panel and the answer flows back — paste the ledger line + the inline grill"
//
// Round 2 grounded the grill in lib/task-linter.ts's §5C linter alone — a DIFFERENT subsystem
// than the "plan" skill's own declared `grounding_sources`, which the review gate correctly
// called a semantic downgrade. Round 3 fixes the root cause: `groundClarifyRequest` loads
// `.remudero/skills/plan.yaml` (the SAME primitive `rmd skill list` uses) and searches every file
// ITS OWN `grounding_sources` names for the target task — proven below both as a pure function
// and end to end.
//
// Proven below, end to end, over REAL createService()/fetch() plumbing (never a mock):
//   1. POST /v1/skills/run { skill: "plan", mode: "clarify", taskId } — Refine — GROUNDS via the
//      plan skill's OWN registry-declared sources (`groundClarifyRequest`) plus the
//      already-merged §5C linter, and parks the result as a `grilling` plan/feedback/<id>.yaml
//      entry, ledgering `panel.skill_invoked`.
//   2. GET /v1/feedback (W3-T6, already merged) renders that `grilling` entry inline — the
//      panel's existing inbox IS the inline grill render (W3-T6's own established
//      interpretation, reused here rather than re-invented).
//   3. POST /v1/feedback { replyTo: <the grilling id> } (W3-T6, already merged) is the answer
//      flowing back — a fresh entry whose raw text is prefixed with the back-reference.
//
// See src/lib/panel-skill-run.ts's header for why this composes ALREADY-MERGED W1-T41/W3-T6
// primitives, PLUS the plan skill's own registry-declared grounding_sources, instead of
// re-implementing W1-T45/W1-T42's own (still unmerged) scope.

const READ_TOKEN = "skillrun-read-token";
const WRITE_TOKEN = "skillrun-write-token";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-panel-skill-run-"));
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

function writeSkillYaml(root: string, name: string): void {
  const dir = skillsDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.yaml`),
    "tools:\n  - Read\npermission_profile: implement\noutput_contract: a PR\ngrounding_sources:\n  - plan/tasks.yaml\ngate: ci + remudero-review\ntier: G-17\n",
  );
}

/** A minimal, valid plan/tasks.yaml with ONE task, `overrides` merged onto its acceptance/risk/etc. */
function writePlanWithTask(root: string, overrides: Record<string, unknown> = {}): string {
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  const task = {
    id: "W9-T1",
    title: "Example task",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    origin: "architect",
    acceptance: [{ claim: "does the thing", proof: "paste the ledger line" }],
    ...overrides,
  };
  writeFileSync(planPath, JSON.stringify([task]), { flag: "wx" });
  return planPath;
}

function depsFor(root: string, planPath: string): PanelSkillRunDeps {
  return { root, planPath, ledgerPath: ledgerPathFor(root) };
}

async function withService<T>(routes: ReturnType<typeof buildPanelSkillRunRoutes>, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes });
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

function get(base: string, path: string, token?: string) {
  return fetch(`${base}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
}

// ── buildClarifyGrill: pure, grounded in the REAL §5C linter ────────────────────────────────

test("buildClarifyGrill: a linter-flagged task gets its REAL violations back as clarifying questions", () => {
  const task = {
    id: "W9-T2",
    title: "Cross-cutting thing",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    origin: "architect",
    files: ["src/lib/daemon.ts"],
    acceptance: [{ claim: "touches the daemon and launchd", proof: "paste the ledger line" }],
  } as unknown as Task;
  const lint = lintTask(task);
  assert.equal(lint.ok, false); // sizing: daemon + launchd = 2 subsystems at risk:medium
  const grill = buildClarifyGrill(task, lint);
  assert.match(grill, /W9-T2/);
  assert.match(grill, /\[sizing\]/);
  assert.match(grill, /distinct subsystems/);
});

test("buildClarifyGrill: a clean task still gets ONE task-specific question, never a canned no-op string", () => {
  const task = {
    id: "W9-T3",
    title: "Clean task",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    origin: "architect",
    acceptance: [{ claim: "does the thing", proof: "paste the ledger line" }],
  } as unknown as Task;
  const lint = lintTask(task);
  assert.equal(lint.ok, true);
  const grill = buildClarifyGrill(task, lint);
  assert.match(grill, /W9-T3/);
  assert.match(grill, /which acceptance criterion/i);
});

test("buildClarifyGrill: with grounding notes, leads with what the plan skill's OWN sources actually said (round 3 fix)", () => {
  const task = {
    id: "W9-T3",
    title: "Clean task",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    origin: "architect",
    acceptance: [{ claim: "does the thing", proof: "paste the ledger line" }],
  } as unknown as Task;
  const lint = lintTask(task);
  const grill = buildClarifyGrill(task, lint, [{ source: "MASTER-PLAN.md", excerpts: ["§9: W9-T3 folds into the mount-tier work"] }]);
  assert.match(grill, /Grounded against the plan skill's own sources/);
  assert.match(grill, /\.remudero\/skills\/plan\.yaml grounding_sources/);
  assert.match(grill, /\[MASTER-PLAN\.md\] §9: W9-T3 folds into the mount-tier work/);
});

test("buildClarifyGrill: with NO grounding hits, says so plainly rather than silently omitting the step", () => {
  const task = {
    id: "W9-T3",
    title: "Clean task",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    origin: "architect",
    acceptance: [{ claim: "does the thing", proof: "paste the ledger line" }],
  } as unknown as Task;
  const lint = lintTask(task);
  const grill = buildClarifyGrill(task, lint, []);
  assert.match(grill, /no existing mention of W9-T3 found/);
});

// ── groundClarifyRequest: GROUND via the "plan" skill's OWN registry-declared sources ───────
// (round 3 fix — round 2 grounded in lib/task-linter.ts's §5C linter instead, a different
// subsystem than what `.remudero/skills/plan.yaml` itself declares under `grounding_sources`,
// which the review gate called a semantic downgrade.)

test("groundClarifyRequest: finds a real mention of the task in a grounding_sources file", () => {
  const root = tmpRoot();
  writeSkillYaml(root, "plan"); // grounding_sources: [plan/tasks.yaml] (test fixture default)
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "- id: W9-T9\n  title: mentioned here\n");
  const task = { id: "W9-T9", title: "mentioned here" } as unknown as Task;

  const notes = groundClarifyRequest(root, task);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].source, "plan/tasks.yaml");
  assert.match(notes[0].excerpts[0], /W9-T9/);
});

test("groundClarifyRequest: no mention anywhere -> an empty list, never a throw", () => {
  const root = tmpRoot();
  writeSkillYaml(root, "plan");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "- id: W9-OTHER\n  title: unrelated\n");
  const task = { id: "W9-T9", title: "not here" } as unknown as Task;

  assert.deepEqual(groundClarifyRequest(root, task), []);
});

test("groundClarifyRequest: no registry / no plan.yaml -> an empty list, never a throw", () => {
  const root = tmpRoot();
  const task = { id: "W9-T9", title: "whatever" } as unknown as Task;
  assert.deepEqual(groundClarifyRequest(root, task), []);
});

test("groundClarifyRequest: against the SHIPPED .remudero/skills/plan.yaml + real MASTER-PLAN.md — W3-T8 really is grounded in its own §5B/§7 text", () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const task = { id: "W3-T8", title: "Panel skill actions" } as unknown as Task;
  const notes = groundClarifyRequest(repoRoot, task);
  const masterPlanNote = notes.find((n) => n.source === "MASTER-PLAN.md");
  assert.ok(masterPlanNote, "expected a MASTER-PLAN.md grounding hit for W3-T8 (§5B names it directly)");
  assert.match(masterPlanNote!.excerpts.join("\n"), /W3-T8/);
});

// ── POST /v1/skills/run: scope + validation ──────────────────────────────────────────────────

test("POST /v1/skills/run is write-scoped: a read-only token gets 403", async () => {
  const root = tmpRoot();
  writeSkillYaml(root, "plan");
  const planPath = writePlanWithTask(root);
  await withService(buildPanelSkillRunRoutes(depsFor(root, planPath)), async (base) => {
    const res = await post(base, "/v1/skills/run", READ_TOKEN, { skill: "plan", mode: "clarify", taskId: "W9-T1" });
    assert.equal(res.status, 403);
  });
});

test("POST /v1/skills/run: a skill not in the registry -> 400, no side effect", async () => {
  const root = tmpRoot();
  const planPath = writePlanWithTask(root);
  await withService(buildPanelSkillRunRoutes(depsFor(root, planPath)), async (base) => {
    const res = await post(base, "/v1/skills/run", WRITE_TOKEN, { skill: "not-a-real-skill", mode: "clarify", taskId: "W9-T1" });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; detail: string };
    assert.equal(body.error, "invalid_request");
    assert.match(body.detail, /not in the registry/);
  });
});

test("POST /v1/skills/run: a registered skill with no run implementation -> 400 naming exactly what is not wired, never a silent no-op", async () => {
  const root = tmpRoot();
  writeSkillYaml(root, "retro");
  const planPath = writePlanWithTask(root);
  await withService(buildPanelSkillRunRoutes(depsFor(root, planPath)), async (base) => {
    const res = await post(base, "/v1/skills/run", WRITE_TOKEN, { skill: "retro" });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; detail: string };
    assert.match(body.detail, /retro/);
    assert.match(body.detail, /no run implementation/);
  });
});

test("POST /v1/skills/run: plan/clarify without taskId -> 400 (Refine targets one task)", async () => {
  const root = tmpRoot();
  writeSkillYaml(root, "plan");
  const planPath = writePlanWithTask(root);
  await withService(buildPanelSkillRunRoutes(depsFor(root, planPath)), async (base) => {
    const res = await post(base, "/v1/skills/run", WRITE_TOKEN, { skill: "plan", mode: "clarify" });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail: string };
    assert.match(body.detail, /taskId is required/);
  });
});

test("POST /v1/skills/run: plan/clarify against an unknown task id -> 404", async () => {
  const root = tmpRoot();
  writeSkillYaml(root, "plan");
  const planPath = writePlanWithTask(root);
  await withService(buildPanelSkillRunRoutes(depsFor(root, planPath)), async (base) => {
    const res = await post(base, "/v1/skills/run", WRITE_TOKEN, { skill: "plan", mode: "clarify", taskId: "NOPE" });
    assert.equal(res.status, 404);
  });
});

// ── the literal acceptance proof: Refine -> grill parked -> ledger line -> inline render ────

test("POST /v1/skills/run Refine (plan/clarify): parks a `grilling` feedback entry grounded in the REAL linter, ledgers panel.skill_invoked with origin", async () => {
  const root = tmpRoot();
  writeSkillYaml(root, "plan");
  const planPath = writePlanWithTask(root, {
    files: ["src/lib/daemon.ts"],
    acceptance: [{ claim: "touches the daemon and launchd", proof: "paste the ledger line" }],
  });
  const deps = depsFor(root, planPath);
  await withService(buildPanelSkillRunRoutes(deps), async (base) => {
    const res = await post(base, "/v1/skills/run", WRITE_TOKEN, { skill: "plan", mode: "clarify", taskId: "W9-T1" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; skill: string; mode: string; taskId: string; feedback: { id: string; status: string; raw: string } };
    assert.equal(body.ok, true);
    assert.equal(body.skill, "plan");
    assert.equal(body.mode, "clarify");
    assert.equal(body.taskId, "W9-T1");
    assert.equal(body.feedback.status, "grilling");
    assert.match(body.feedback.raw, /W9-T1/);
    assert.match(body.feedback.raw, /\[sizing\]/);

    // The entry really is durable and reads back `grilling` (not just the response body).
    const onDisk = readFeedbackEntry(root, body.feedback.id);
    assert.equal(onDisk.status, "grilling");
    assert.equal(onDisk.origin, "ui");
  });

  const lines = readLedgerLines(deps.ledgerPath);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "panel.skill_invoked");
  assert.equal(lines[0].task_id, "W9-T1");
  assert.equal(lines[0].skill, "plan");
  assert.equal(lines[0].mode, "clarify");
  assert.ok(typeof lines[0].origin === "string" && (lines[0].origin as string).length > 0);
  assert.ok(typeof lines[0].feedback_id === "string");
});

test("end to end: Refine's grill renders inline via GET /v1/feedback, then POST /v1/feedback replyTo answers it — the answer flows back", async () => {
  const root = tmpRoot();
  writeSkillYaml(root, "plan");
  const planPath = writePlanWithTask(root);
  const skillRunDeps = depsFor(root, planPath);
  const graphDeps: PanelGraphDeps = {
    root,
    planPath,
    ledgerPath: skillRunDeps.ledgerPath,
    github: { prView: () => null },
  };
  const routes = [...buildPanelSkillRunRoutes(skillRunDeps), buildFeedbackInboxRoute(graphDeps), buildSubmitFeedbackRoute(graphDeps)];

  await withService(routes, async (base) => {
    // 1. Invoking Refine grills.
    const runRes = await post(base, "/v1/skills/run", WRITE_TOKEN, { skill: "plan", mode: "clarify", taskId: "W9-T1" });
    assert.equal(runRes.status, 200);
    const { feedback } = (await runRes.json()) as { feedback: { id: string } };

    // 2. GET /v1/feedback (W3-T6, already merged) renders it INLINE, in the SAME inbox every
    // other grill uses — this IS "the grill inline" (W3-T6's own established interpretation).
    const inboxRes = await get(base, "/v1/feedback?status=grilling", READ_TOKEN);
    assert.equal(inboxRes.status, 200);
    const inbox = (await inboxRes.json()) as { entries: Array<{ id: string; status: string; raw: string }> };
    assert.equal(inbox.entries.length, 1);
    assert.equal(inbox.entries[0].id, feedback.id);
    assert.equal(inbox.entries[0].status, "grilling");

    // 3. POST /v1/feedback { replyTo } (W3-T6, already merged) — the operator's answer flows
    // back, captured as a fresh entry back-referencing the grill.
    const answerRes = await post(base, "/v1/feedback", WRITE_TOKEN, { text: "decompose it into one task per subsystem", replyTo: feedback.id });
    assert.equal(answerRes.status, 200);
    const answered = (await answerRes.json()) as { ok: boolean; entry: { origin: string; raw: string } };
    assert.equal(answered.ok, true);
    assert.equal(answered.entry.origin, "ui");
    assert.match(answered.entry.raw, new RegExp(`answer to feedback#${feedback.id}`));
    assert.match(answered.entry.raw, /decompose it into one task per subsystem/);
  });
});
