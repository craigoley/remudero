/**
 * lib/panel-skills.ts — the control panel's skill-registry action buttons (W3-T8, MASTER-PLAN
 * §5B/§7).
 *
 * §5B: "Each skill maps 1:1 to a future UI action (§7 shell, W3-T8) — the panel button IS the
 * registry entry." This module is the daemon-side half of that: ONE read-scoped route, GET
 * /v1/skills, that resolves `.remudero/skills/<name>.yaml` the SAME way `rmd skill list` does
 * (lib/skill.ts's `loadSkillRegistry`/`skillsDir`, W1-T44) and returns it as the button set a
 * panel client renders — one button per entry, GENERATED from the registry, never a per-skill
 * hard-coded component. Dropping a new `.remudero/skills/<name>.yaml` therefore adds a button
 * with zero UI code change (W3-T8's second acceptance claim), exactly the "config entry, not
 * new code" guarantee `rmd skill list` already gives the CLI (skill.ts's own header). Built the
 * SAME way every prior W3-T* panel module was built: a thin Route layer over EXISTING mechanism
 * (lib/service.ts's Route, lib/skill.ts's registry loader) plus lib/panel-actions.ts's shared
 * `sendJson` envelope — no second copy of that plumbing.
 *
 * SCOPE. This module ships the READ side only — the button SET, resolved live from the
 * registry (W3-T8's second acceptance claim in full: "each v1 skill appears as a panel button
 * resolved from the registry... adding a skill yaml adds a button with no UI code change").
 * INVOKING a button (round 2 of this task — "invoking Refine from the panel runs the plan
 * --mode=clarify skill and shows the grill inline") is the sibling module
 * lib/panel-skill-run.ts's POST /v1/skills/run — split out because the read/list route and the
 * write/invoke route have different scopes and different deps ({@link PanelSkillsDeps} only
 * needs `root`; the run route also needs `planPath`/`ledgerPath`), the same read/write module
 * split lib/board.ts (read) vs. lib/panel-actions.ts (write) already established. See
 * lib/panel-skill-run.ts's header for how "runs the plan --mode=clarify skill" is satisfied
 * without re-implementing W1-T45's own still-unmerged CLI work.
 */

import { loadSkillRegistry, skillsDir, type Skill } from "./skill.js";
import type { Route } from "./service.js";
import { sendJson } from "./panel-actions.js";

export interface PanelSkillsDeps {
  /** Repo root — `.remudero/skills/` lives under here (lib/skill.ts's `skillsDir`). */
  root: string;
}

/**
 * GET /v1/skills's body — one entry per registered skill, resolved fresh on every request (the
 * SAME "always current" contract GET /v1/trace holds, lib/panel-graph.ts) so a skill yaml
 * dropped in after the daemon started shows up on the very next request, no restart required.
 */
export interface SkillsListResult {
  skills: Skill[];
}

/**
 * GET /v1/skills — the panel's action-button set, read-scoped. A thin Route layer over the
 * EXISTING lib/skill.ts registry loader — the SAME primitive `rmd skill list` uses — so the
 * panel and the CLI can never drift into two different ideas of "what skills exist." A
 * malformed shard fails the WHOLE load (lib/skill.ts's `loadSkillRegistry` contract, fail loud
 * rather than a silent partial registry); left uncaught here so lib/service.ts's own handler
 * try/catch turns it into a 500 `internal_error`, the same net every other route in this
 * codebase relies on rather than re-deriving its own.
 */
export function buildSkillsRoute(deps: PanelSkillsDeps): Route {
  return {
    method: "GET",
    path: "/v1/skills",
    scope: "read",
    handler: (_req, res) => {
      const skills = loadSkillRegistry(skillsDir(deps.root));
      const body: SkillsListResult = { skills };
      sendJson(res, 200, body);
    },
  };
}

/** Every panel skills route, for a caller registering the full set at once (`rmd serve` wiring, later work) — today just the one, mirrors buildPanelActionRoutes/buildPanelGraphRoutes's own single-array shape. */
export function buildPanelSkillsRoutes(deps: PanelSkillsDeps): Route[] {
  return [buildSkillsRoute(deps)];
}
