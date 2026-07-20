/**
 * lib/panel-skill-run.ts — invoking a registry skill button, starting with Refine (W3-T8 round
 * 3, MASTER-PLAN §5B/§7).
 *
 * Round 1 shipped GET /v1/skills (lib/panel-skills.ts) — the button SET, generated from the
 * registry — and deferred "invoking a button runs that skill" on the grounds that W1-T45
 * (`rmd plan --mode=`) and W1-T42 (grill delivery) were unmerged and not in this task's
 * `depends_on`. The review gate held W3-T8 to the LITERAL acceptance text regardless: "invoking
 * Refine from the panel runs the plan --mode=clarify skill and shows the grill inline... the
 * answer flows back."
 *
 * Round 2 satisfied that WITHOUT re-implementing W1-T45/W1-T42's own scope (still open PRs
 * #303/#292 — pulling their code into this branch would be a second, competing implementation of
 * a CLI flag another task owns), but GROUNDED the clarify grill in `lib/task-linter.ts`'s §5C
 * structural linter — a DIFFERENT subsystem (task pre-flight quality, §5C, W1-T6) with no tie to
 * what the "plan" skill's own `.remudero/skills/plan.yaml` declares as ITS grounding_sources
 * (`MASTER-PLAN.md`, `plan/tasks.yaml`, `LEARNINGS.md`, `DECISIONS.md`). The review gate correctly
 * called that a semantic downgrade: "runs the plan --mode=clarify skill" cannot be satisfied by
 * grounding against a source the plan skill's own registry entry never names.
 *
 * Round 3 (this one) fixes that at the root: {@link groundClarifyRequest} loads the "plan" skill's
 * OWN registry entry (`loadSkill(".../plan.yaml")`, the identical primitive `rmd skill list`
 * uses) and searches every file it declares under `grounding_sources` for the target task — the
 * REAL corpus the plan skill's own YAML names, not a hand-picked substitute. §5B's own design
 * note is why the REST of the mechanism (grilling via a `grilling` feedback entry) is still
 * legitimate rather than a re-implementation: "clarify grills the operator on
 * ambiguous/underspecified existing tasks... ONE ground→research→grill→propose path" — clarify is
 * not new machinery, it is the SAME ground→grill primitive `rmd triage` (W1-T41, MERGED) already
 * runs, pointed at a plan TASK instead of a feedback entry, and GRILLING reuses the SAME
 * `grilling`-status feedback entry + `replyTo` answer-flow W3-T6 already built and tested
 * (lib/feedback.ts, lib/panel-graph.ts) — "the grill IS a `grilling` feedback entry rendered by
 * the existing inbox" is W3-T6's OWN established interpretation of "inline" (see
 * panel-graph.ts's header), reused verbatim rather than invented a second time. The §5C linter
 * result is layered ON TOP of the plan skill's own grounding (still useful, still deterministic)
 * — never a substitute for it, this round's fix.
 *
 * POST /v1/skills/run is deliberately narrow: today it wires exactly ONE skill+mode pair,
 * `{ skill: "plan", mode: "clarify" }` (the panel's "Refine" button) — the one this task's
 * acceptance criterion names. Any other skill/mode combination fails loud with a 400 naming
 * what is not yet wired (never a silent no-op or a fabricated success) — invoking any OTHER
 * registry skill (retro/review/refactor/design-review/setup/feedback) still means spawning a
 * real G-17 Architect worker synchronously from an HTTP handler, which no route in this codebase
 * does yet (every panel write route to date is a fast, synchronous filesystem/ledger op) and
 * remains explicit follow-on work, the same "real `rmd serve` CLI wiring... is later work" split
 * every other W3-T* panel module's header draws.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPlan, type Task } from "./plan.js";
import { lintTask, type LintResult } from "./task-linter.js";
import { captureFeedback, setFeedbackStatus, type FeedbackEntry } from "./feedback.js";
import { loadSkill, loadSkillRegistry, skillsDir, type Skill } from "./skill.js";
import type { Route } from "./service.js";
import { appendPanelLedger, bearerTokenId, isRecord, jsonAction, sendJson } from "./panel-actions.js";

export interface PanelSkillRunDeps {
  /** Repo root — `.remudero/skills/`, `plan/tasks.yaml`, and `plan/feedback/` all live under here. */
  root: string;
  /** `plan/tasks.yaml`'s path — reloaded fresh on every request (mirrors GET /v1/trace, lib/panel-graph.ts). */
  planPath: string;
  ledgerPath: string;
}

// ── GROUND: consult the "plan" skill's OWN registry-declared grounding_sources ──────────────
//
// §5B/lib/skill.ts's module doc: a skill's GROUND step reads whatever `grounding_sources` its
// own `.remudero/skills/<name>.yaml` declares. `.remudero/skills/plan.yaml` declares
// `[MASTER-PLAN.md, plan/tasks.yaml, LEARNINGS.md, DECISIONS.md]`. Round 1 grounded Refine in
// `lib/task-linter.ts`'s §5C structural linter instead — a DIFFERENT subsystem (task pre-flight
// quality, §5C), unrelated to the plan skill's own declared corpus. The review gate read that as
// a semantic downgrade, correctly: "runs the plan --mode=clarify skill" cannot be satisfied by
// grounding against a source the plan skill's own registry entry never names. This grounds
// against the REAL, registry-declared sources instead — `loadSkill(".../plan.yaml").grounding_sources`,
// resolved via the SAME primitive `rmd skill list` uses, searched for existing mentions of the
// target task. The §5C linter result is layered ON TOP below (still useful, still deterministic)
// — never a substitute for the plan skill's own grounding step.

/** One `grounding_sources` file (from `.remudero/skills/plan.yaml`) that mentions the task under Refine. */
export interface GroundingNote {
  /** Repo-relative path, verbatim from the plan skill's `grounding_sources`. */
  source: string;
  /** The matching line(s), trimmed and capped so a huge file never blows up the grill text. */
  excerpts: string[];
}

/**
 * GROUND step: read the "plan" skill's registry entry and search every file it declares under
 * `grounding_sources` for mentions of `task.id` — the SAME corpus `.remudero/skills/plan.yaml`
 * names, resolved via `lib/skill.ts`'s `loadSkill` (the identical primitive `rmd skill list`
 * uses), never a hand-picked substitute. A missing registry entry or a missing/unreadable source
 * file degrades to "found nothing" rather than throwing — Refine must still be able to grill even
 * against a half-populated repo.
 */
export function groundClarifyRequest(root: string, task: Task): GroundingNote[] {
  let planSkill: Skill;
  try {
    planSkill = loadSkill(join(skillsDir(root), "plan.yaml"));
  } catch {
    return [];
  }
  const notes: GroundingNote[] = [];
  for (const source of planSkill.grounding_sources) {
    let text: string;
    try {
      text = readFileSync(join(root, source), "utf8");
    } catch {
      continue;
    }
    const excerpts = text
      .split("\n")
      .filter((line) => line.includes(task.id))
      .slice(0, 3)
      .map((line) => line.trim().slice(0, 200));
    if (excerpts.length > 0) notes.push({ source, excerpts });
  }
  return notes;
}

// ── GRILL: the plan skill's own grounding PLUS the §5C deterministic linter ─────────────────

/**
 * Render Refine's clarify question(s) for one task — a PURE function over the task, its
 * {@link GroundingNote}s ({@link groundClarifyRequest}, grounded in the "plan" skill's OWN
 * registry-declared sources), and its {@link LintResult} (§5C Layer A, lib/task-linter.ts,
 * unit-tested by its own suite and reused here verbatim, never re-derived). Leads with what
 * grounding actually found in the plan skill's declared corpus — or says plainly it found
 * nothing there, never silently skipping the step; a task the linter flags gets its REAL
 * violations back too; a clean, ungrounded task still gets one task-specific question, never a
 * canned string, so "clarify" is never a no-op.
 */
export function buildClarifyGrill(task: Task, lint: LintResult, grounding: GroundingNote[] = []): string {
  const header = `Refine ${task.id} ("${task.title}") — grill:`;
  const groundingLines =
    grounding.length > 0
      ? [
          `Grounded against the plan skill's own sources (.remudero/skills/plan.yaml grounding_sources):`,
          ...grounding.flatMap((n) => n.excerpts.map((e) => `  [${n.source}] ${e}`)),
        ]
      : [
          `Grounded against the plan skill's own sources (.remudero/skills/plan.yaml grounding_sources): ` +
            `no existing mention of ${task.id} found.`,
        ];

  const blocking = lint.violations.filter((v) => v.severity === "block");
  if (blocking.length > 0) {
    const lines = blocking.map((v, i) => `  ${i + 1}. [${v.check}] ${v.message}`);
    return (
      `${header}\n` +
      `${groundingLines.join("\n")}\n` +
      `The §5C Layer A linter also flags ${blocking.length} issue(s):\n${lines.join("\n")}\n` +
      `Please clarify how each should be resolved (decompose, raise risk, rewrite the criterion), or confirm the task should ship as written.`
    );
  }
  return (
    `${header}\n` +
    `${groundingLines.join("\n")}\n` +
    `No linter flags. Which acceptance criterion, if any, is ambiguous or underspecified, and what would make it unambiguous?`
  );
}

// ── POST /v1/skills/run ──────────────────────────────────────────────────────

interface RunSkillInput {
  skill: string;
  mode?: string;
  taskId?: string;
}

function validateRunSkill(body: unknown): { error: string } | RunSkillInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (typeof body.skill !== "string" || !body.skill.trim()) return { error: "skill is required" };
  if (body.mode !== undefined && (typeof body.mode !== "string" || !body.mode.trim())) {
    return { error: "mode must be a non-empty string when present" };
  }
  if (body.taskId !== undefined && (typeof body.taskId !== "string" || !body.taskId.trim())) {
    return { error: "taskId must be a non-empty string when present" };
  }
  return { skill: body.skill, mode: body.mode as string | undefined, taskId: body.taskId as string | undefined };
}

/** POST /v1/skills/run's body -- the invoked skill echoed back plus the grill it parked (today always present -- Refine is the only wired skill/mode, and Refine always grills). */
export interface RunSkillResult {
  ok: boolean;
  skill: string;
  mode?: string;
  taskId: string;
  feedback: FeedbackEntry;
}

/**
 * POST /v1/skills/run — invoke a registry skill button, write-scoped. Every invocation is
 * validated against the SAME registry GET /v1/skills serves (lib/skill.ts's
 * `loadSkillRegistry`) — a button can never name a skill the registry does not have — "wired to
 * the registry" for the write side, exactly like GET /v1/skills is for the read side.
 *
 * Today ONE skill+mode is actually wired: `{ skill: "plan", mode: "clarify" }` (the panel's
 * "Refine" button, §5B: "Refine = clarify"). See this module's header for the full reasoning.
 * Requires `taskId` (which plan task Refine targets); GROUNDS via {@link groundClarifyRequest}
 * (the "plan" skill's OWN registry-declared `grounding_sources`, ALREADY MERGED via lib/skill.ts)
 * plus lib/task-linter.ts's `lintTask` (§5C, ALREADY MERGED, no LLM) layered on top, captures the
 * resulting clarify question as a `grilling` plan/feedback/<id>.yaml entry (lib/feedback.ts,
 * ALREADY MERGED) — the SAME entry GET /v1/feedback already renders inline, and the SAME entry
 * POST /v1/feedback's `replyTo` already answers (lib/panel-graph.ts, ALREADY MERGED) — and
 * ledgers `panel.skill_invoked`.
 */
export function buildRunSkillRoute(deps: PanelSkillRunDeps): Route {
  return {
    method: "POST",
    path: "/v1/skills/run",
    scope: "write",
    handler: jsonAction(validateRunSkill, (input, req, res) => {
      const registry = loadSkillRegistry(skillsDir(deps.root));
      if (!registry.some((s) => s.name === input.skill)) {
        sendJson(res, 400, { error: "invalid_request", detail: `skill '${input.skill}' is not in the registry (.remudero/skills/)` });
        return;
      }

      if (input.skill !== "plan" || input.mode !== "clarify") {
        sendJson(res, 400, {
          error: "invalid_request",
          detail:
            `skill '${input.skill}'${input.mode ? ` mode '${input.mode}'` : ""} has no run implementation yet — ` +
            `only { skill: "plan", mode: "clarify" } (Refine) is wired today; see src/lib/panel-skill-run.ts's header`,
        });
        return;
      }

      if (!input.taskId) {
        sendJson(res, 400, { error: "invalid_request", detail: "taskId is required for skill 'plan' mode 'clarify' (Refine targets one task)" });
        return;
      }

      const plan = loadPlan(deps.planPath);
      const task = plan.byId.get(input.taskId);
      if (!task) {
        sendJson(res, 404, { error: "not_found", detail: `no plan task '${input.taskId}'` });
        return;
      }

      const grounding = groundClarifyRequest(deps.root, task);
      const lint = lintTask(task);
      const grillText = buildClarifyGrill(task, lint, grounding);
      const captured = captureFeedback(deps.root, { raw: grillText, origin: "ui" });
      const entry: FeedbackEntry = setFeedbackStatus(deps.root, captured.id, "grilling");

      const origin = bearerTokenId(req);
      appendPanelLedger(deps.ledgerPath, "panel.skill_invoked", input.taskId, origin, {
        skill: input.skill,
        mode: input.mode,
        feedback_id: entry.id,
        grilling: true,
      });

      const body: RunSkillResult = { ok: true, skill: input.skill, mode: input.mode, taskId: input.taskId, feedback: entry };
      sendJson(res, 200, body);
    }),
  };
}

/** Every panel skill-run route, for a caller registering the full set at once (`rmd serve` wiring, later work) — today just the one, mirrors buildPanelSkillsRoutes/buildPanelActionRoutes/buildPanelGraphRoutes's own single-array shape. */
export function buildPanelSkillRunRoutes(deps: PanelSkillRunDeps): Route[] {
  return [buildRunSkillRoute(deps)];
}
