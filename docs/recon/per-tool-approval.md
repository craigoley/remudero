# Recon: per-tool approval (W1-T3668)

Measured 2026-09-17 against this repo's HEAD (`3b8a5765b`). Compares the current two-grain
approval model against three ideas Pizza Bot shipped 2026-09-13 (SKILL.md `interruptOn`,
`edit` as a first-class decision, a durable mid-run pause), per the task's own rationale.

## What the current grain actually is, measured — not restated

**PER ROUTE.** `HIGH_TIER_WRITE_PATHS` (`src/lib/console-shell-client.ts:346`) is a client-side
array the console's `postJson` helper checks before every write: a path in the list is routed
through `POST /v1/confirm` (issue a nonce) before the real write, everything else goes straight
through. At HEAD it holds **eight** paths, not the five the rationale's 2026-09-16 snapshot
named:

```
/v1/manual/approve, /v1/drain/kick, /v1/drain/run, /v1/inbox/approve, /v1/skills/run,
/v1/policy/provider-routing, /v1/policy/provider-routing/clear, /v1/merge-hold
```

The comment that documents this array from the *server* side (`src/lib/serve.ts:3800-3805`,
`assembleServeServer`) still says "the same five paths" and lists only the original five — it
was never updated when `/v1/policy/provider-routing`, `/v1/policy/provider-routing/clear` and
`/v1/merge-hold` were added as `tier: "high"` routes. That comment is now itself factually wrong
about the array it is describing. The eight-path array happens to still match the *count* of
routes actually declared `tier: "high"` in the route table (`src/lib/panel-actions.ts` ×4,
`src/lib/panel-graph.ts` ×1, `src/lib/panel-skill-run.ts` ×1, `src/lib/serve.ts` ×2 — the
provider-routing pair) — but nothing enforces that the two lists *name the same paths*, only
that a route with no declared tier fails to build (`assertWriteTiersComplete`,
`src/lib/serve.ts:3712`). The only checks that catch a HIGH-tier route missing from the
client-side array are ad hoc per-path `assert.match` greps added one at a time as each route
landed (`test/console-merge-hold-control.test.ts:263`,
`test/provider-routing-console-controls.test.ts:573`) — there is no test that walks the server's
`tier: "high"` route set and asserts every one of those paths is present in
`HIGH_TIER_WRITE_PATHS`. So the drift the rationale predicted ("it drifts from the routes it
names by construction") has already happened once, silently, in the one place a human reads the
number back (the comment) — a near-miss rather than a caught failure only because count and
membership have not yet diverged.

**PER SKILL.** `GET /v1/skills` (`src/lib/panel-skills.ts`) resolves
`.remudero/skills/*.yaml` fresh on every request via `loadSkillRegistry`
(`src/lib/skill.ts:113`) and returns each entry's `tools[]` and one `permission_profile` string
(`src/lib/skill.ts:36-51`, `validateSkill`). Every skill in the registry today —
`design-review`, `feedback`, `plan`, `refactor`, `retro`, `review`, `setup` — declares exactly
one `permission_profile` for its whole `tools` list (`.remudero/skills/*.yaml`): six declare
`architect`, one (`design-review`) declares `architect-browser` because it alone is granted
`mcp__playwright__*` browser tools. There is no per-tool field anywhere in the schema
(`Skill` interface, `src/lib/skill.ts:36-51`; `validateSkill`, `src/lib/skill.ts:81-94`) — a
skill can widen or narrow its whole `tools` list, or swap its whole `permission_profile`, but it
cannot say "ask before `Write`, never ask before `Read`" within one skill. This is the exact gap
the rationale names.

Two more measurements narrow what adopting `interruptOn` would actually cost here:

1. **`permission_profile` is declarative metadata today, not a switch.** `grep -rn
   "permission_profile" src/ --include=*.ts` outside `skill.ts` and its own tests turns up
   nothing — no code resolves `"architect"` or `"architect-browser"` to a distinct settings
   file. Every real worker spawn across `src/run-task.ts`, `src/spike.ts` and
   `src/lib/sweep.ts` renders the **same** committed template,
   `settings/worker.json` (twelve call sites, all `templatePath: join(repoRoot, "settings",
   "worker.json")`, none passing a different template). The registry's `tools[]`/
   `permission_profile` pair is read by `rmd skill
   list` and the dashboard's skill-run buttons; it is not the list that actually gates a
   dispatched worker's tool access — those are separate hard-coded constants
   (`PLAN_WORKER_TOOLS`, `FIX_WORKER_TOOLS`, `resolveDispatchLaneToolBound(...)`, etc., all in
   `src/run-task.ts`). `panel-skill-run.ts`'s own header confirms this split: `POST
   /v1/skills/run` "wires exactly ONE skill+mode pair" (`{ skill: "plan", mode: "clarify" }`)
   and "any other skill/mode combination fails loud with a 400" — invoking any other registry
   skill still means spawning a worker outside this route entirely, off the same hard-coded
   tool constants, never off `permission_profile`.
2. **Every worker runs `permissionMode: "bypassPermissions"`** (`grep -c 'permissionMode:
   "bypassPermissions"' src/run-task.ts src/spike.ts` — 15 and 4 occurrences respectively, 19
   total, zero exceptions; `src/lib/sweep.ts` sets none directly, deferring to the spawn
   functions it calls). The Agent SDK's `ask` rule
   family in a settings file's `permissions.ask` — the native mechanism `interruptOn` would map
   onto — is a no-op under `bypassPermissions`; nothing in `Options` passed to `query()`
   (`src/lib/worker.ts:2146-2163`) supplies a `canUseTool` callback either. `settings/worker.json`
   ships `"ask": []` today and the deny-floor is hook-enforced specifically *because* the SDK's
   own permission prompt is bypassed. So the SDK-level hook this idea would ride does not fire in
   this codebase's current dispatch mode at all — turning it on requires leaving
   `bypassPermissions`, and every worker is spawned detached with stdout captured, no
   interactive terminal attached to answer a prompt (`buildContainedSpawnFn`,
   `src/lib/worker.ts:2157-2162`). That is the same "nobody is on the other end" problem the
   rationale's third idea names explicitly; it turns out to gate the first idea too, not only
   the third.

## RECOMMENDATION

Adopt **one** of Pizza Bot's three ideas as scoped below; do not adopt the other two as
described.

- **ADOPT (partial, cheap): put the policy beside the skill, but keep it whole-skill, not
  per-tool.** Rename `permission_profile`'s role from "documentation nobody consumes" to
  "actually selects a settings template", and let a skill widen its `HIGH_TIER_WRITE_PATHS`-
  equivalent declaratively instead of via a fourth hard-coded array. Concretely: add an
  optional `askPaths: string[]` (or reuse `permission_profile` values as named bundles) to the
  `Skill` shape validated in `src/lib/skill.ts`, and thread it through the twelve
  `renderWorkerSettings` call sites so a skill's rendered `settings/worker.json` gets a
  skill-specific `permissions.ask` (or, until `bypassPermissions` is revisited, a skill-specific
  entry appended to the confirm-nonce path list a server-side route can consult instead of the
  one hand-maintained `HIGH_TIER_WRITE_PATHS`). Cost: one schema field + validation branch in
  `skill.ts` (small, already has a test fixture pattern per field), twelve call-site edits to
  pass the resolved profile through, and a new census-style test that walks `tier: "high"`
  routes against whatever replaces the array, closing the drift gap measured above. This does
  NOT require leaving `bypassPermissions` and does not require a live pause — it is a
  before-dispatch declaration, same grain the fleet already reviews through the PR that adds
  the skill file.
- **REJECTED as described: per-tool `interruptOn` inside a running worker's own SKILL.md
  frontmatter.** A fleet that reviews every change through a pull request already puts a human
  in the loop on the thing `interruptOn` protects — the call the skill is *about* to make — one
  layer earlier, at the PR that grants the skill that tool in the first place. Wiring a live
  per-tool ask into a headless, detached, `bypassPermissions` worker buys a SECOND gate on the
  same decision, at the cost of: leaving `bypassPermissions` (defeats the reason it was chosen —
  see `src/lib/worker.ts:2751`'s deny-floor discussion of prompts leaking under it), building a
  synchronous responder for a detached process with no attached terminal (`buildContainedSpawnFn`
  captures stdout only), and duplicating the skill-grant review the PR already performs. The
  fleet's actual failure mode is not "a worker called a tool nobody expected it to have" — the
  YAML registry already enumerates the exact tool list per skill and that list is PR-reviewed
  before it can run anything — the failure mode this repo has actually hit (per the drift found
  above) is the *route-side* list falling out of sync with the *route table*, which the ADOPT
  item above addresses without a live pause.
- **REJECTED as its own initiative, but the underlying gap is real: `edit` as a first-class
  decision.** The mechanism already exists — `POST /v1/inbox/reframe`
  (`src/lib/console-shell-client.ts:282,2723`) lets an operator attach free-text feedback to a
  proposal instead of a bare approve/reject, and `board-review.ts` already treats a non-empty
  `reframeHistory` as a durable signal. But it is offered only at proposal-review time in the
  inbox, never as a third button beside the two-click arm/confirm pattern every HIGH-tier
  console control uses (`Confirm approve…`, `Confirm run…`, `Confirm STOP?` —
  `src/lib/console-shell-client.ts:2778,2859,3180` and siblings — all binary: do it or don't).
  Rejected as a NEW mechanism because one already ships and is under-surfaced, not because the
  idea is wrong; wiring it into the confirm banners is a UI-only change, out of this recon's one
  concern (see Follow-ups).
- **REJECTED: the durable mid-run pause (LangGraph-style checkpoint/resume from another
  device).** This is the rationale's own "expensive half," and the recon confirms why. Remudero
  has `resumeSessionId` (`src/lib/worker.ts:879`, threaded from `src/run-task.ts:9599` etc.),
  but every call site's own comments say what it actually is: "a FRESH session... this worker's
  job has nothing to resume from" (`src/run-task.ts:7278`) or an auto-retry round-trip
  (`src/run-task.ts:9599`) — never a human-suspended decision point revived hours later. Building
  that would mean serializing an in-flight `query()` session's full context at the SDK boundary,
  persisting it past this worktree's own teardown (this run's own dispatch instructions:
  "reapable... dirty files are your ONLY copy of the work until you commit it"), and resuming it
  on a possibly different host in the fleet — none of which exists today. A fleet that already
  reviews every change through a pull request does not need a worker to sit parked waiting for a
  human inside a live session: the PR itself IS the durable, resumable, multi-device artifact —
  it persists past the worktree, is reviewable from any device, and a rejected/edited PR is
  exactly the "come back to it later" primitive Pizza Bot's checkpoint provides, already built
  and already the fleet's normal unit of work.

## Follow-ups

- action: surface `POST /v1/inbox/reframe` (or an equivalent) as a third confirm-banner option
  next to the existing binary arm/confirm controls, so `edit` becomes visible where an operator
  is already looking rather than only in the separate inbox view — out of scope for this recon,
  which is read-only.
- task: add a census test that walks every route with `tier: "high"` in the assembled route
  table and asserts each of its paths is present in `HIGH_TIER_WRITE_PATHS`, closing the drift
  this recon measured (the array's count currently matches by coincidence, not by any assertion,
  and the server-side comment describing it is already stale).
- research: decide whether `permission_profile` should be deleted (it currently selects nothing)
  or wired to actually pick a rendered settings template per skill — this recon found it inert
  but did not decide its fate, since that is the ADOPT item's own follow-on implementation, not
  this recon's payload.

RECOMMENDATION: adopt the whole-skill, before-dispatch declaration; REJECTED: per-tool
`interruptOn` inside a live `bypassPermissions` session, a brand-new `edit` mechanism (one
already exists, under-surfaced), and a durable mid-run checkpoint/resume (the PR already is one).
