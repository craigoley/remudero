# REMUDERO — Master Plan (v1.9 · synced 2026-07-14 · ★ SETUP COMPLETE: repos live, auth cleared, push protection ON · scoped PAT deferred to WS-1 by decision (FF9) · ONLY OPEN STEP: WS-0 spike v5.1)

> **Remudero** — the wrangler in charge of the remuda: the hand who manages the worker herd and
> decides which mounts ride today. The orchestrator's own job title. CLI alias `rmd`.
> Domains purchased 2026-07-14. Naming saga + method: D-1.
> **Built in the open from day 1** (G-1) — instance specifics live in a gitignored `local/` overlay.
> **Fleet lives under one root** (§4A): workers are OS-sandboxed to their worktrees; the control
> panel (§7) is one daemon API with desktop + mobile as stateless projections.

## Mission

A plan-stewarding orchestration harness on top of Claude Code. A durable main agent runs the
plan → recon → prompt → implement → review → merge → plan-sync loop against headless Claude Code
workers in git worktrees, escalating to the human like a senior engineer would: rarely, batched,
with options and a recommendation. Open source; runs on a Claude Code subscription; GitHub-native.

**Differentiators vs. the field** (session managers like Claude Squad/Crystal/Vibe Kanban;
autonomous-PR tools like Composio AO; plan-lifecycle tools like ivy-tendril; native Agent Teams):

1. **Plan stewardship** — MASTER-PLAN.md + tasks.yaml in git is the product; the harness keeps it true.
2. **Provenance gate** — no claim enters a worker prompt without a cited source. Mechanized, not disciplined.
3. **Principles engine** — TDD/DRY/SOLID enforced as deterministic gates + reviewer rubric, not prompt vibes.
4. **Deterministic control plane** — scheduling, trust, budgets, and strikes are code; LLMs never own the loop.
5. **Escalation as GitHub issues** — decisions get provenance, threading, and an audit trail for free.
6. **Durable by design** — native Agent Teams is interactive/ephemeral with documented coordination gaps
   (leads stopping early, task-status lag); Remudero is a daemon that survives restarts and works for days.

## NET STATE

Design complete through v0.2. Nothing built. Manual pre-steps + grill answers (G-1..G-3) gate the
WS-0 spike; its six verdicts gate everything after it.

## FIELD FINDINGS (from the mini, 2026-07-14 — ground truth, not docs)

1. **★ RESOLVED — `ANTHROPIC_API_KEY` exported from `~/.zshrc` (lines 20 AND 21 — duplicate, same
   key both times, benign)**;
   Claude Code confirms it **takes precedence over the claude.ai login**. NOT set via
   `launchctl setenv` (checked: 0) ⇒ launchd-spawned processes do NOT inherit it. **PROOF (verdict 1
   GREEN)**: with ANTHROPIC_* stripped from the env, `claude -p` returns `ok` and the precedence
   warning DISAPPEARS ⇒ headless runs on subscription OAuth. ⇒ **Env sanitization is a control-plane
   primitive** (§9); `billing_mode` is a decision the harness makes, never an accident it inherits.
2. **★ SIDE FINDING (Craig's money, outside Remudero's scope)**: because the key is exported from
   the login shell, **every interactive `claude` session on the mini has been billing API rates
   instead of the Max 20x subscription.** Fix (separate task, do NOT delete the key — ClawApp/
   OpenClaw Python + Haiku need it): scope it to the LaunchAgent plists' EnvironmentVariables and
   crontab entries rather than exporting it from `.zshrc`.
3. **`claude` is a shell FUNCTION** (wraps the binary with `security unlock-keychain` when
   `$SSH_CONNECTION` is set). Real binary: `~/.npm-global/bin/claude` → `claude.exe` (same
   `.npm-global/bin` as the openclaw CLI). ⇒ daemon resolves the binary from **config, never PATH**;
   committed code carries no machine paths (path lives in `~/.config/remudero/config.json`, outside
   the tree).
4. **★ RESOLVED — launchd + keychain OAuth: PASS.** A launchd-spawned `claude` returned `ok` with
   EMPTY stderr ⇒ the keychain is reachable from the user-agent context; **WS-1's LaunchAgent
   architecture stands**. Nuance (do NOT delete env.ts on this basis): launchd never sources
   `.zshrc`, so that process had no ANTHROPIC_API_KEY and was clean *by accident of context* — a
   daemon started from a DEV SHELL inherits the key and would silently bill API. `buildWorkerEnv()`
   is what makes the dev path as safe as the launchd path. Residual: proven in a live session;
   **reboot-resilience (auto-login → session → unlocked keychain) is unverified ⇒ WS-7 chaos drill**,
   not an assumption.
5. Versions observed: Claude Code **2.1.209**, node **v22.22.3** (/opt/homebrew/bin/node), gh
   **2.92.0** authed as **cao825**. Pin CLI version as config (WS-7); node via engines/.nvmrc.
6. Paste-block discipline (self-inflicted, logged): **no inline `#` comments, no heredocs** in
   paste blocks for this operator's zsh — a violated standing rule cost a full setup block.
7. Workspace + deny-floor overlay live: `~/Remudero/{worktrees,state,logs,tmp}`;
   `~/.config/remudero/deny.local` = openclaw, LaunchAgents, health-status,
   `~/Library/Messages/chat.db` (path verified by `find`, not guessed).
8. **★ GitHub topology + fresh-repo defaults (generalizable — Setup Agent requirement)**:
   `craigoley` is an **Organization**, not a user; the agent account (cao825) is a member with
   `permissions.admin: true` on org repos it creates ⇒ no collaborator grant, no invitation flow.
   The Setup Agent (WS-4) must handle **org-vs-user namespaces** and verify access by reading
   `repos/{owner}/{repo}.permissions`, never by assuming an invite is needed. **Fresh repos ship
   with `allow_auto_merge: false` and secret scanning DISABLED** — an agent pipeline that arms
   `gh pr merge --auto` will silently fail to arm on a default repo. Scaffold MUST explicitly set:
   `allow_auto_merge: true`, `delete_branch_on_merge: true`, and (public repos)
   **secret_scanning + secret_scanning_push_protection: enabled** — push protection is a hard
   backstop under the leak-grep for repos where autonomous agents commit. Also note: cloning is
   **HTTPS-only** on this account (no SSH key); never rewrite a remote to `git@github.com`.
9. **★ Scoped PAT DEFERRED (WS-0 runs on ambient gh credentials).** Fine-grained PATs on an
   ORG-owned repo require the org to opt in first (Settings → Third-party Access → PATs) — until
   then `craigoley` isn't even selectable as resource owner. Decision: do NOT flip an org-wide
   setting (that namespace also holds the production fleet) as a 6am unblock. **Security delta,
   stated plainly**: WS-0 workers carry cao825's repo-scope reach instead of sandbox-only reach.
   Containment still rests on OS sandbox + deny-hook + worktree scoping — always the real boundary;
   the PAT was a blast-radius optimization. **Compensating control enabled instead: secret scanning
   + push protection ON for both public repos** — GitHub now rejects a committed credential
   outright, covering a failure mode PAT-scoping never addressed. Scoped-PAT injection via
   `buildWorkerEnv()` = **WS-1 hardening task**.

---

## Bootstrap ladder — Remudero builds Remudero

The dogfooding requirement, made structural. Each rung uses the previous rung to build the next:

- **L0 (now)**: the human loop — Craig + external Claude produce prompts; Claude Code executes them.
  Builds: the WS-0 spike.
- **L1 (ACTIVE — G-2 resolved)**: **proto-runner** — the spike's `spike.ts` generalizes into `run-task.ts`:
  takes ONE tasks.yaml entry, runs recon → provenance-linted prompt → implement → PR → verdict,
  Craig kicks each run manually. **v0 prompts are PRE-AUTHORED per task in tasks.yaml** (the L0
  partnership writes them; Promptsmith generation is itself a later WS-1 task). WS-1's own task list is then executed *through* the proto-runner,
  one task per kick. Dogfooding starts before the daemon exists.
- **L2**: the WS-1 daemon loops unattended; WS-2+ backlogs execute through it. The plan repo's
  tasks.yaml is the first plan Remudero stewards.
- **L3**: the flywheel (below) files improvement tasks on Remudero from Remudero's own ledger —
  the harness maintains itself, human approves plan-increment PRs.

Rule: no rung is built by hand if the rung below can build it.

---

## 1. Architecture — four planes

**Control plane** — deterministic TypeScript daemon (launchd/systemd-supervised). Owns: task DAG
scheduler, worktree lifecycle + GC, worker process supervision, PR watching + stuck-PR shepherd,
attempt/strike accounting, budget metering, escalation queue, notifier dispatch, **worker
environment construction** (explicit allowlist; ANTHROPIC_* stripped — §9) and **claude-binary
path resolution from config** (never PATH-dependent — FIELD FINDING 2), and the fleet control set: **Pause** (drain-and-hold: no new worker spawns; in-flight tasks run to FULL
completion — through verdict and merge — so state stays clean; watchers and shepherd keep
running), **Resume**, and **Stop** (hard kill: `STOP` file checked every tick + UI button).
`rmd pause|resume|stop` mirrors the panel. Zero LLM decisions. Crash recovery: all durable state
derives from git + GitHub; local queue/locks are rebuildable cache.

**Brain plane** — model calls at phase boundaries only. Two roles, one service, model-routed:
- **Architect** (Opus-class, extended thinking + web search): grill-me intake, plan authorship/revision,
  narrative plan syncs at workstream boundaries, escalation drafting, next-increment drafting when idle.
- **Promptsmith/Reviewer** (Sonnet-class, per-loop): renders task+recon into worker prompts
  (house format, provenance-linted), verdicts worker REPORTs and PR diffs against acceptance proofs,
  resolves DECISION_REQUESTs (auto-choose).

**Worker plane** — Agent SDK sessions (`query({ cwd: worktree, ... })`), typed by phase:
- **recon**: read-only tools; output contract = OBSERVED / INFERRED / COULDN'T-VERIFY sections; TTL'd.
- **implement**: full tools per permission profile; branch from latest origin/main; one concern; opens PR;
  ends with structured REPORT (changed / proven / inferred / open questions / PR_URL).
- **fix**: resume original session (round 1) → fresh session with distilled context (round 2).
- **diagnose**: evidence-only worker dispatched after two strikes; per-step telemetry; no patches.
- **reviewer**: fresh context, read-only + gh; adversarial audit vs. acceptance proofs + principles rubric.
Workers get **no MCP config** (MCP auto-approves under bypass — surface stays zero).

**Interface plane** — the **control panel**: one daemon API (REST + SSE, tailnet, bearer-scoped),
with every client a **stateless projection** of it — the web dashboard (desktop: served on the Mac,
opened in any browser; Tauri menu-bar wrapper banked), the Expo mobile app (G-5), and **remudero-mcp**
(so any Claude — claude.ai via custom connector, Claude Code sessions, the Architect — reads and
proposes against the same plan). Desktop↔mobile "sync" is free by construction: no state lives in
clients; state lives in git + the ledger; clients subscribe via SSE and reconcile optimistic updates.
Notifier adapters, reference-first per Q2/G-15 (nothing Craig-specific in the default path):
**imessage-local** — the daemon lives ON a Mac, so it sends iMessage-to-self natively via
osascript/Messages.app, zero extra infrastructure for the Mac+iPhone operator (one-time Automation
TCC grant; verify-under-launchd is a WS-1 check) → **github-issues** (universal, mobile-push free)
→ ntfy / Slack / Discord / email / webhook. BlueBubbles becomes a Craig-legacy optional overlay,
not a dependency. M2's Expo app brings true APNs push later.

## 2. Plan format & contracts

**Per product**: the design repo holds `MASTER-PLAN.md` (human narrative, this document's format)
and machine state:

```yaml
# plan/tasks.yaml (schema v1)
- id: F1-3
  title: Escalation issues + iMessage digest
  repo: remudero                # target repo
  depends_on: [F1-1, F1-2]    # may cross repos → ordered bundles
  type: implement             # recon|implement|diagnose|review|manual
  verify: auto                # auto|human  (human ⇒ draft PR + MANUAL escalation, never auto-merge)
  principles: {tdd: strict, dup_budget: default, fitness: default}   # overrides per task
  acceptance:
    - claim: "escalation lands as a labeled GitHub issue"
      proof: "issue URL + label visible via gh issue view"
    - claim: "daily digest sends"
      proof: "notifier ledger line + received message screenshot ref"
  status: queued              # queued|recon|prompted|running|review|fixing|diagnosing|blocked|merged|done
  attempts: 0                 # strikes: deterministic failures only
  session_id: null
  pr: null
  budget_usd: 3.00
```

**Plan-repo write discipline** (multi-writer safety): the control plane writes MACHINE FILES ONLY
(tasks.yaml status fields, questions.ndjson, DECISIONS.md appends, ledger pointers) via serialized
commits with pull-rebase-retry, **debounced to ≤1 commit/min** so a busy fleet doesn't spam a
public repo's history. Humans and the Architect edit narrative (MASTER-PLAN prose, LEARNINGS,
templates) via PRs. Field ownership is documented per file; a conflict between a machine commit and
a human edit resolves human-wins-on-narrative, machine-wins-on-status.

**Worker output contracts** (parsed from result JSON; malformed ⇒ one reformat retry ⇒ strike):
- `RECON REPORT` — OBSERVED (command + output), INFERRED, COULDN'T-VERIFY. Prompts may cite only OBSERVED.
- `REPORT` — changed / proven (proof pasted) / inferred / open questions / PR_URL.
- `DECISION_REQUEST` — options[], exactly one RECOMMENDED, reversibility note. Resolved machine-side.
- `QUESTION` — **non-blocking**: {question, current_assumption (the worker proceeds on this),
  impact_if_wrong: low|med, task}. Logged to the ledger + `plan/questions.ndjson`; surfaced as a
  batch-answerable backlog in the control panel and counted in the daily digest. Answers feed the
  Architect → plan/LEARNINGS updates; an answer contradicting a shipped assumption auto-files a
  corrective task. **Rule**: high-impact + hard-to-reverse is never a QUESTION — that's an
  escalation. Everything else: assume, log, keep moving.

**Provenance gate**: every CONTEXT claim in a rendered prompt carries `[src: recon#… | plan#… |
PR#/commit | URL]`. Deterministic linter blocks dispatch of uncited prompts. Recon TTL: prompts
never render from stale recon. Rule: **PROVENANCE OR IT DOESN'T GO IN A PROMPT.**

## 3. The loop (per task)

queued → **recon** → **prompt** (provenance-linted) → **running** (implement worker) → PR open →
**review** (reviewer verdict + CI) → merge (existing trusted-author auto-merge, base==main) →
**plan-sync** (status flip by control plane; narrative sync by Architect at workstream boundaries)
→ next task. Failure paths: red CI/changes-requested → **fixing** (resume, round 1; fresh, round 2)
→ two strikes → **diagnosing** (evidence worker) → one evidence-armed retry → **blocked** (escalate).

## 3A. Campaigns (cross-repo improvement cycles)

Injectable, reusable improvement sweeps — "recon and implement across all repos for X" as a
first-class object, not a hand-written batch of prompts. A campaign is a parameterized template in
`plan/campaigns/<name>.yaml`: repo selector, recon prompt template, implement prompt template,
**acceptance formula as a measurable delta against ledger/CI baselines** (coverage +N%, dup-budget
−N%, complexity ceiling −N, zero new deps with known CVEs), per-repo budget, priority.
The Architect instantiates it into ordinary tasks.yaml entries (per-repo recon → per-repo
implement), so campaigns inherit every existing guard — provenance gate, principles, two-strikes,
merge serialization — for free, and close with a campaign retro.

**v1 catalog**: tech-debt sweep · coverage-raise (ratchet bump) · dup-shrink / design-refactor pass
· dependency shepherding · doc-sync · security audit sweep · **platform-bump** (Claude Code/SDK
version — WS-7's release watcher feeds it). **Triggers**: standing (idle-groom now
drains low-priority campaign tasks before drafting new plan increments), scheduled (weekly
tech-debt hour in quiet-hours), and **retro-filed** (a retro finding that spans repos becomes a
campaign proposal on the plan-PR path). The principles engine (§5) is the fuel gauge: ratchets and
budgets provide the baselines campaigns move.

## 4. Autonomy doctrine

**The loop never waits on a human unless the plan says `verify: human`.**

- **Auto-choose**: DECISION_REQUESTs resolve to the RECOMMENDED option (Promptsmith may override with
  stated reasoning); logged to `DECISIONS.md` with rationale + rollback pointer (usually "revert PR#N").
  Sound because the PR boundary makes nearly everything reversible.
- **Hard-stop list** (deterministic, tiny): destructive ops against live data stores; spend beyond cap;
  force-push; secret handling; anything not PR-shaped. Only these pause for the human.
- **Permissions**: workers run bypassPermissions (Craig's instance). Floor = PreToolUse deny-hook
  (<1s, exit 2): protected paths + `git push --force` + `gh auth` mutation. Documented to block even
  under bypass; **known counter-report** (claude-code#20946, macOS async race) ⇒ Phase-0 planted-probe
  test is the falsifier. Fallback if probe fails: `dontAsk` + allowlist (identical zero-stall).
  **Zero ask rules in worker settings** (ask rules still prompt under bypass ⇒ hung headless worker).
  Verify in Phase 0: git commit/push via Bash doesn't trip protected-path prompts (.git/ etc.).
- **Loop hardening**: transient-vs-strike classification (SynthWatch pattern — network/gh-5xx/CI-flake
  retries with backoff, no strike); stuck-PR shepherd (auto-rebase, auto-fix from failing logs,
  auto-resolve conflicts via resumed session); timeouts resolve to action; **idle = groom** (promote
  banked items, shepherd dependabot, triage flakes, draft next plan increment as a plan-repo PR).
- **Interrupts collapse to a daily digest**; real-time pings only for MANUAL + hard-stop.
- **Escalation taxonomy** (GitHub issues, `needs-human` label, options + recommendation in body):
  BLOCKED (post-diagnose), MANUAL (secrets, repo creation, deploys, eyeball/playtest gates),
  HARD-STOP, PLAN (approval PRs for new plans/increments). DECISION and DIRECTION classes are
  absorbed by auto-choose and idle-groom respectively. **ASYNC-QUESTION** is deliberately NOT an
  escalation: it never blocks (see QUESTION contract, §2). The MANUAL queue doubles as **the
  human's to-do list** — rendered in the control panel with check-off (= closing the issue), so the
  agent's asks of Craig are as visible and workable as Craig's asks of the agent.

## 4A. Workspace containment (fleet-wide)

**Everything lives under one root** (`~/Remudero`, configurable `REMUDERO_ROOT`); the main agent
works inside it and cannot leave; workers get subfolders (worktrees) within it.

Layout: `$ROOT/projects/<product>/{repos,worktrees/<task-id>}` · `$ROOT/state` (ledger, queues) ·
`$ROOT/logs` · `$ROOT/tmp`.

**Workers — OS-enforced (Claude Code native sandbox; macOS Seatbelt, nothing to install)**: default
write scope is the working directory + session $TMPDIR, enforced by the OS on every Bash command
and all child processes — a worker with cwd = its worktree is confined by the kernel, not by trust.
Worker settings ship: `sandbox: { enabled: true, failIfUnavailable: true` (never silently
unsandboxed)`, filesystem: { denyRead: [~/.ssh/**, ~/.aws/**, ~/.config/remudero/**] },
allowedDomains: [github.com, api.github.com, codeload.github.com, registry.npmjs.org` + per-repo
profile additions`], excludedCommands: ["gh *"] }` — gh is documented to fail TLS verification
under Seatbelt, so it runs outside the sandbox (still inside bypass + deny-hook, carrying only the
scoped PAT). Spike verifies whether plain `git push` over HTTPS works through the sandbox proxy;
record which path won. **Both layers for secrets**: sandbox denyRead governs Bash/`cat` but does
NOT stop the Read tool — permission `deny: Read(...)` rules cover the same paths. Zero ask rules
stays load-bearing: content-scoped ask rules (e.g. `Bash(git push *)`) still prompt even for
sandboxed commands. The sandbox auto-denies writes to its own settings files.

**Defense-in-depth stack, named**: bypassPermissions (gate 1 off, per directive) → OS sandbox
(gate 2 ON: what a command can touch) → PreToolUse deny-hook (deterministic tripwire) → scoped PAT
(blast-radius cap). The earlier "bypass is for isolated environments" tension resolves the
documented way: bypass + sandbox is the pairing.

**Main agent (daemon)**: plain node process, no LLM tools — containment is a code-level path guard
(every filesystem op derives from $ROOT; ops outside throw; unit-tested + a golden task). If the
Architect ever grows local tools (in-harness grill-me recon), those run as sandboxed workers too.

**Spike verdict 7 (containment probe)**: a sandboxed bypass worker (i) writes inside its worktree;
(ii) is OS-DENIED writing to a sibling path outside cwd (proof: error text + file absent);
(iii) completes a push with ZERO prompts under pre-configured allowedDomains; (iv) the
FORBIDDEN_PROBE hook-block still fires through the sandbox. Fallback if sandbox can't run
prompt-free headless: containment via hook-only, recorded honestly in FINDINGS as the weaker floor.

## 5. Principles engine

Three layers, strongest first — instructions shape behavior; gates guarantee it:

1. **Deterministic gates** (hooks + CI):
   - **TDD**: per-worker TDD Guard-style PreToolUse enforcement (blocks implementation edits without a
     failing test; per-language test reporters) where the target repo's stack supports it; plus
     REPORT must paste **red→green proof** (failing run output, then passing) for `tdd: strict` tasks;
     plus CI: tests-changed-with-src-changed gate, **coverage ratchet** (never down, ratchets up),
     **mutation baseline** where established (SynthWatch pattern, Stryker for TS).
   - **DRY**: duplication budget via jscpd threshold gate; breach ⇒ CI red + auto-filed refactor task
     (feeds idle-groom).
   - **SOLID / architecture**: fitness functions via dependency-cruiser/import-lint rules — the games'
     purity gates generalized ("src/game imports no Three.js" → declarable layering rules); complexity
     budgets (eslint complexity, max-lines) as advisory-then-required per profile.
2. **Reviewer rubric** (judgment): SRP at PR granularity (one-concern already enforces), coupling/
   cohesion audit, "all callers audited" check (partial-fix drift), test-theater detection
   (assertions vs. snapshots-of-nothing), refactor-phase honesty. Documented finding from TDD Guard's
   author: mechanical test-first enforcement alone still yielded tight coupling and duplication —
   which is exactly why layer 2 exists and layer 3 alone is insufficient.
3. **Prompt layer**: Promptsmith injects the repo's principles profile into every prompt; weakest layer,
   never load-bearing.

**Per-repo profile** — `.remudero/principles.yaml`: `tdd: strict|encouraged|off`, `coverage_ratchet`,
`dup_threshold`, `fitness_rules[]`, `complexity`. OSS users tune; Promptsmith reads; CI enforces;
reviewer audits. Plan tasks may override per task. **The remudero repo itself runs the strictest
profile** (tdd strict, ratchet on) — the harness eats first, and every principles feature is proven
on its own codebase before anyone else's.

## 6. Open-source packaging

- **License**: Apache-2.0 (patent grant, enterprise-friendly). D-2.
- **Distribution**: npm — `npx remudero init` scaffolds `.remudero/` (config, principles.yaml, deny-floor
  hook, worker settings with zero ask rules) via a **first-run wizard**: tier auto-detect→confirm
  (§9 ladder), thinking posture, metering regime, quiet hours, permission profile, notifier, + optional fleet CI templates (claude-review + trusted-
  author auto-merge with base==main gate, ci-gate aggregator). Daemon: `remudero up` (launchd/systemd
  units generated). macOS + Linux; Windows via WSL note.
- **Config abstraction**: adapters for notify (ntfy/slack/discord/email/webhook/imessage), VCS
  (GitHub first; interface leaves room), model routing. No hardcoded accounts, ports, or paths.
- **Permission profiles**: `standard` (dontAsk + curated allowlist + deny-floor) — **OSS default**;
  `yolo` (bypassPermissions + deny-floor) — opt-in, documented with the honest tradeoffs. Craig's
  instance runs yolo. Shipping yolo as default would be indefensible for strangers' machines. D-4.
- **Auth stance**: works on Claude Code subscription OAuth today (programmatic usage draws from
  subscription limits; the separate Agent SDK credit pool was paused 2026-06-15 — re-verify at each
  release); API-key path documented for heavy/steady-state users. MeterGuard reads total_cost_usd
  per run regardless of billing mode.
- **Build-in-the-open hygiene (G-1)**: public from day 1 ⇒ LICENSE + README stub + .gitignore land
  in PR #1; instance specifics (accounts, hosts, protected-path lists, notifier config) live only in
  the gitignored `local/` overlay; committed docs and FINDINGS redact hostnames/IPs; secrets never
  enter the tree (PAT lives outside the repo); a leak-grep is part of spike acceptance.
- **Security disclosure**: honest README section — unattended agents + Bash = prompt-injection surface
  via deps/web; scoped fine-grained PAT per product (never account-wide login in workers); deny-floor
  is a tripwire, not a sandbox; pointer to OS sandboxing for the paranoid.
- **Positioning under platform risk**: if Anthropic ships native plan-stewardship, this project's
  provenance/verdicting/principles layer is deliberately user-land glue over Claude Code primitives —
  it rides platform improvements rather than competing with them; building in the open makes pivots
  legible rather than fatal.
- **Open-core stance (D-8)**: everything required to run the full loop locally — daemon, CLI,
  containment, principles engine, single-project control panel, MCP, retros/knowledge system, the
  public commons — is **Apache-2.0 forever**. Pro candidates (post-traction, not before WS-6):
  hosted relay/sync for mobile push without self-managed tailnet, multi-project portfolio views,
  team/multi-operator seats, hosted question inbox, **hosted org-brain sync** (private
  cross-project knowledge, §Self-improvement). Commitment for community trust: **nothing open ever
  moves behind the paywall**; Pro lives in a separate repo so DCO contributions to core never need
  relicensing.
- **Public support posture (G-6 RESOLVED)**: README carries a pre-alpha banner ("APIs and files
  change without notice; issues/PRs may not receive responses"); **Issues and Discussions OFF until
  WS-4**, then open with templates + DCO sign-off; CODEOWNERS from PR #1.
- **Dogfooding**: from WS-1 on, Remudero builds Remudero — this repo runs its own harness.
- **Out of scope v1**: non-GitHub forges, Windows-native, multi-tenant server, non-Claude agents.

## 7. Collaborative plan UI

**Vision**: the live plan as the shared workspace — human, external Claude (via remudero-mcp),
and the Architect co-edit while workers stream progress underneath. **The control panel** (Craig's
framing): see the plan; work the **human to-do list** (MANUAL queue with check-off); answer the
**question backlog** in batches (QUESTION contract, §2 — answers flow to the Architect, corrective
tasks auto-file when a shipped assumption was wrong); submit **feedback** ("improve/expand X") that
the Architect triages into plan edits or tasks via a grill-lite pass; watch **fleet status** (per-
worker state, current task, live stream tails); **Pause/Resume** (drain-and-hold) and STOP;
quiet-hours toggle; cost meter. Question
store: `plan/questions.ndjson` in the plan repo (durable, diffable), surfaced in clients + daily
digest count; GitHub-issue mirror optional per product.

- **v0 (WS-5a)**: read-only live board. Panes: MASTER-PLAN render, task DAG with live states,
  worker stream tails (stream-json), DECISIONS feed, escalations inbox, cost meter. Transport:
  daemon file-watch + SSE. Git stays the sole writer.
- **v1 (WS-5b)**: human editing in-UI (single-writer, debounced plan-sync commits by the daemon);
  agents propose edits as plan-repo PRs rendered inline for one-click apply.
- **v2 (WS-6)**: true multi-writer via CRDT (Yjs) session over the plan doc, checkpointed to git
  commits by the daemon (git remains truth; CRDT is the live layer). D-3 decides if v2 is worth it
  after living with v1 — PR-shaped proposals may be enough.
- **remudero-mcp (WS-6)**: tools `plan.read`, `plan.propose_patch`, `task.add/update`, `runs.status`,
  `escalations.list/answer`. Exposed over tailnet HTTPS → claude.ai custom connector. Auth: bearer
  token, read vs. write scopes.

**Mobile (WS-9)** — manage the main agent + plan while remote, over Tailscale:
- **API-first is the enabling decision**: WS-5a promotes the daemon's HTTP API (REST + SSE) to a
  first-class contract; dashboard, mobile, and MCP are three clients of ONE tailnet service surface
  (single port, bearer-scoped read/write). No client gets a private backdoor.
- **M0 (free at WS-5a)**: the dashboard is responsive; phone + Tailscale = remote board on day one,
  zero app-store anything.
- **M1 (free at WS-1, before any UI exists)**: escalations are GitHub issues ⇒ the GitHub mobile
  app already pushes them and accepts replies ⇒ remote loop-continuation ships with the daemon MVP.
- **M2 (G-5 RESOLVED: dashboard-first, Expo standalone later)**: dedicated mobile client — live
  board, escalation answer/approve, STOP button, quiet-hours toggle, cost meter. Expo standalone is
  the eventual OSS mobile story; ClawApp-tab and PWA rejected as primary (coupling / capability).
- **Push transport (decide at WS-9)**: imessage-local (default for the Mac+iPhone operator, §1) vs
  ntfy (OSS-clean; HYPOTHESIS to verify: iOS + self-hosted may need ntfy.sh upstream relay) vs
  GitHub-mobile-only (M1 posture). BlueBubbles: legacy overlay only.

## 8. Security posture (consolidated)

Worker credential = fine-grained PAT scoped to the product's repos, via GH_TOKEN env only. No MCP in
workers. Deny-floor hook always installed (removable, on the owner's head): the repo ships a
**generic floor** (force-push to default branch, `gh auth` mutation, probe path) and appends the
operator's concrete protected-path list from gitignored `local/deny.local` at runtime — instance
specifics never live in the public tree. Hooks <1s. Craig overlay (`local/INSTANCE.md`, untracked):
agent accounts, mini paths, protected list, notifier wiring; other resident automation stays fully
out of Remudero's process tree, plain `claude` CLI auth only. **Per-project secrets (WS-2/3
forward design)**: products under management will need runtime secrets (test API keys, service
tokens) — these live per-project in `local/secrets/<project>.env`, globally denyRead'd, injected by
the control plane ONLY into that project's workers, never cross-project. **Terms note (README)**:
operators run the harness on their own subscription per Anthropic's terms — one operator, one
account, one machine; the harness is a tool for your seat, not a seat-multiplier.

## 9. Resource doctrine — mounts, windows & context

**Mounts — model selection is the remudero's core act.** `.remudero/mounts.yaml` is a
DETERMINISTIC policy table (no per-call LLM judgment): keyed by (task_type × risk × operator
thinking level) → {model, effort/thinking budget, max_turns, context_budget}. Operator params
(`subscription`, `thinking_default`, `metering: shared_pool|programmatic_credit|api_key` —
regime-proof; the June-15 walkback proved metering volatility — quiet-hours, permission profile,
notifier) are
**per-instance config, gathered by the first-run setup** — `rmd init` wizard v0, dashboard
Settings pane later — never plan constants. **Tier auto-discovery ladder (detect → confirm, never
silent)**: (1) parse headless `/status`–`/usage` output if machine-readable; (2) local account
metadata the CLI exposes, if any (spike-probed, not assumed); (3) **passive inference by the
HeadroomTracker** — observed limit magnitudes and the presence of dual weekly caps distinguish
tiers over time; (4) wizard asks, pre-filled with the best guess. Whatever is detected, the wizard
shows it for confirmation. Craig instance: `max20x`, `thinking_default: medium` (G-12/G-13).
Defaults encode the official guidance: **Sonnet default for execution; Opus on the bookends**
(Architect planning, DIAGNOSE workers, high-risk reviews); **Haiku for mechanical/high-volume**
(classification, doc-sync, campaign chores). Model-aware strike ladder: routine retries do NOT
auto-upgrade; **diagnose steps UP** — intelligence is spent where evidence-gathering pays.
Per-repo priors live in principles.yaml (a gnarly C# repo can default Sonnet-high-thinking; a docs
repo, Haiku).

**The Tier Invariant (G-17, Craig directive)**: the main agent ALWAYS rides a higher-thinking
mount than the coding agents — it reasons through the plan and orchestrates, so
`architect.tier > max(worker.tier)` and `architect.effort ≥ thinking_default` (floor: high for
plan authorship). This is a **config-validation rule, deterministically enforced**: a mounts.yaml
that violates it is rejected at load, and flywheel-proposed downgrades may lower workers freely but
can NEVER lower the Architect to or below the worker ceiling. The invariant is RELATIVE, not
absolute — an economy install may run Haiku workers under a Sonnet Architect and still comply; the
model-tier ordering table is config-maintained since the lineup shifts.

**Routing is knowledge — golden-calibrated.** mounts.yaml changes ship as PRs behind the golden
suite like every other knowledge change. The flywheel proposes DOWNGRADES when a cheaper mount
passes a task-type's goldens above threshold, and UPGRADES when strike-rate correlates with mount —
the harness learns which horse each job actually needs, with pre-merge proof it still clears the
jumps.

**Windows — the HeadroomTracker.** Models both clocks: the 5-hour rolling window and the weekly
caps (including Max's dual weekly limits — all-models and Sonnet-only — with separate resets).
Strategies, layered: passive (parse limit-hit responses + stated reset times into state), active
probe (cheap Haiku ping to detect throttle), manual (operator pastes /usage; dashboard field).
WS-1 verifies whether /usage is scriptable headlessly. Scheduler behaviors it drives: **quiet-hours is now an OPTIONAL wizard toggle, default OFF**
(Craig, Q1/G-14: he expects to work mostly THROUGH the fleet, so interactive contention is managed
live via the control panel's Pause, not a schedule); **throttle → cheap-groom** (approaching a cap,
the fleet does NOT idle — it drains Haiku-class chores: doc-sync, triage, campaign recon);
**burst-at-reset** (queue depth + imminent window reset ⇒ heavy work scheduled to the reset);
weekly-aware pacing (Opus-hungry campaigns early in a weekly window get budgeted so Friday isn't
starved). Runaway tripwire, per-task attempt caps, and the OSS daily-cap default all stand.

**Env sanitization — the billing boundary (FIELD FINDING 1).** Worker environments are
**constructed, never inherited**: the control plane builds each child env from an explicit
allowlist (PATH, HOME, TMPDIR, GH_TOKEN, project vars) and **strips all ANTHROPIC_\* variables** so
Claude Code falls back to the operator's subscription OAuth. The API key is injected ONLY when the
overflow valve is deliberately engaged. `billing_mode` is therefore a decision the harness makes
and records, never an accident it inherits — and the daemon asserts at startup that its own env is
clean (a `launchctl setenv` key would otherwise leak in). **Conditional cap guard**: `no dollar
cap` (G-3) is VALID ONLY while `billing_mode == subscription`; any run in `api` mode is hard-capped
by the daily cap regardless of operator settings. Config validation rejects
`overflow: api_key` + `daily_cap: none`.

**Overflow valve** (operator opt-in): `overflow: none|api_key` — when subscription windows are
exhausted and priority ≥ threshold tasks are queued, those runs route via ANTHROPIC_API_KEY at
metered rates while cheap work waits for reset. Every ledger line carries `billing_mode`.

**Context doctrine — architecture first, compaction as safety net.** The harness's primary context
strategy is structural: fresh, scoped, one-concern sessions with all durable state external in
git + ledger — sessions should END before compaction matters; auto-compaction (with CLAUDE.md
re-read) is the net, not the plan. Promptsmith style rules, enforced in templates: reference bare
paths, never @-injection (which pulls the whole file + its CLAUDE.md tree); batch related
instructions into one turn; recon-before-implement stands in for plan-mode. **Context telemetry**:
per-turn token usage from stream-json lands in the ledger → a **context-budget ratchet** per task
template (breach files an improvement task; the 200K 2×-billing cliff is a hard ceiling). Exact
resource knobs on the installed version — effort levels, thinking toggles/budgets, max_turns,
auto-compact settings — are spike step-5 probe targets (v4.1), recorded as ground truth in
FINDINGS, never assumed from docs-of-the-week. NDJSON ledger meters everything regardless of
billing mode: spawn/end, model, effort, tokens, total_cost_usd, billing_mode, verdicts, decisions —
**including brain-plane calls** (Architect/Promptsmith invocations log purpose, model, tokens,
cost as first-class ledger citizens; the orchestrator's own spend is never invisible).
Craig instance (G-3): no daily dollar cap — pace to Max limits via the tracker.

## Self-improvement: flywheel, retros, knowledge & the commons

The mechanism behind L3, the answer to "verdicting is where this succeeds or dies," and — per
Craig's directive — the thing that makes every project on this harness self-improving, with a path
to a shared brain across all of them:

- **Flywheel analyzer** (nightly, Haiku/Sonnet): reads the run ledger + task transcripts, mines for
  patterns — repeated transient causes, prompts that needed fix rounds, gates that never fire,
  reviewer misses (merged PRs later reverted/re-fixed) — and files evidence-cited improvement tasks
  into Remudero's own tasks.yaml. Same shape as the ClawApp SRE flywheel (analyze-diagnostics →
  suggestions inbox), pointed at the harness itself. Suppression rules from day one (stale-error
  maps, fingerprint reuse guards — the analyze-diagnostics lessons apply verbatim).
- **LEARNINGS.md per target repo**: diagnose workers and reviewers append durable lessons in place
  ("App Insights pinned 2.22.0 — 3.1.2 crashed startup"-class facts). The Promptsmith injects
  matching entries into prompts as first-class provenance sources (`[src: learnings#…]`). This is
  "the repo remembers its outages in place," made machine-readable.
- **Transcript archive + predecessor query**: every worker session transcript is archived per task;
  fix/diagnose workers may read their predecessors' transcripts before acting (Gas Town's "seance"
  pattern, done as plain files — no daemon mysticism required).
- **Golden-task eval suite**: a set of canned tasks on the sandbox repo with known-good outcomes
  (including planted violations: TDD skip, scope creep, test theater, provenance-free prompt).
  CI runs the proto-runner/daemon against them on every Remudero PR; measures loop completion,
  verdict accuracy (planted violations caught?), cost per task. Regressions in the harness's
  judgment become red CI, not vibes. This is mutation-testing discipline applied to the orchestrator.
- **Verdict calibration**: reviewer verdicts log confidence + rubric scores; a periodic job compares
  them against post-merge reality (revert rate, follow-up-fix rate within N days) and files tuning
  tasks when calibration drifts.

**Retro ceremony (scheduled, not just reactive)**: at every workstream close + a weekly patrol,
the Architect runs a structured retro over the ledger, transcripts, DECISIONS, questions/answers,
and verdict-calibration data. Outputs are always artifacts, never vibes: LEARNINGS.md updates,
**CLAUDE.md / agents-file / prompt-template diffs as PRs**, principles-profile tuning proposals,
new golden tasks minted from real failures, and campaign proposals (§3A) when a finding spans
repos. Retros must also DELETE — compression is a deliverable, not just accretion.

**Knowledge system (the RSI-safety rule)**: knowledge and prompt changes ARE CODE. Every CLAUDE.md,
agents-file, prompt-template, and principles edit ships as a PR, git-versioned (rollback = revert),
and **gated behind the golden-task suite** — a prompt change that regresses a planted-violation
catch or loop completion goes red before it can poison the fleet. This is the piece most
self-improving setups skip: without versioning + pre-merge signal, a bad self-modification has no
recovery path and no alarm. Budgets enforce "short and alive": CLAUDE.md line cap (default ~150,
gated), LEARNINGS entries carry provenance + last-cited date and get compressed/pruned on retro
(the analyze-diagnostics pruning discipline, applied to knowledge). Injection stays
provenance-clean: `[src: learnings#… | claude-md#… | commons#…]`.

**The Commons (universal brain — WS-11)**: a layered knowledge hierarchy the Promptsmith reads
nearest-first: **project** (LEARNINGS.md, CLAUDE.md) → **org brain** (operator's private
cross-project store) → **commons** (public remudero-commons repo shipped with the harness).
A DISTILL pass classifies retro learnings: project-private stays put; **universal candidates**
(tech facts, platform gotchas, pattern fixes — "App Insights 3.1.2 crashes isolated workers"-class)
are proposed upward as **skill-shaped packages** via human-gated PRs — never telemetry, never
auto-upload; the operator reviews every outbound distillation. Contribution to the public commons
is the community mechanism; **hosted org-brain sync** joins the Pro candidate list (§6/D-8).

Prior-art note: this is "compounding engineering" made governable — the ecosystem pattern (codify
decisions into CLAUDE.md/AGENTS.md so each unit of work makes the next easier; skills as
cross-project procedural memory) plus the two pieces the ecosystem's own literature says are
usually missing: versioned rollback and pre-merge evaluation of self-modifications. External-ledger
task tracking for long-running agents remains the documented direction (Anthropic Nov-2025;
Beads 23k★). Remudero's bet is unchanged and now closed-loop: **small worker counts, hard verdicts,
plan-first — and a harness that provably gets better at its own job.**

---

## 10. Workstreams

**WS-0 — Spike** (repo: remudero; sandbox: remudero-sandbox) — the **seven** verdicts:
(1) headless under existing OAuth, no --bare/API key; (2) result JSON parse (exact field names);
(3) worktree→PR→merge closes; (4) ★ deny-hook blocks under bypass (planted-probe; fallback dontAsk
recorded if it fails); (5) ★ zero-prompt git commit/push via Bash under bypass in -p; (6)
DECISION_REQUEST auto-choose round-trip via session resume; (7) ★ OS-sandbox containment probe
(§4A: worktree-write OK, outside-write DENIED, prompt-free push under allowedDomains, hook fires
through sandbox). Prompt v4 + step-5 amendment v4.2 in chat 2026-07-14 (step 5 now probes all
resource knobs, /status headroom scriptability, and any locally visible plan/tier metadata).
MANUAL: create remudero + remudero-sandbox repos; mint sandbox-scoped PAT; `mkdir -p
~/Remudero/{worktrees,state,logs,tmp}`.

**WS-1 — Proto-runner → daemon (G-2: WS-1 builds THROUGH the proto-runner)**: task 1 extracts
`run-task.ts` from the spike's lib — one tasks.yaml entry in, recon → provenance-linted prompt →
implement → PR → verdict out, single kick via `rmd run-task <id>`. Every subsequent WS-1 task —
contracts + parser hardening, strike/transient classifier, diagnose-then-retry, escalation issues +
notifier + daily digest, NDJSON ledger, STOP file, launchd unit (absolute paths + PATH export) —
is authored as a tasks.yaml entry and **landed via the proto-runner**. WS-1 also lands the resource
primitives: mounts.yaml v0 (static table), HeadroomTracker v0 (passive limit-parse + /usage
scriptability verified), config loader + `rmd init` wizard v0 (tier detect→confirm), and
context-telemetry columns in the ledger. Daemonization (the loop that
kicks itself) is deliberately WS-1's LAST task. Acceptance: ≥6 WS-1 tasks merged via `rmd run-task`
with ledger provenance for each PR; then a 3-task plan on remudero-sandbox runs end-to-end
unattended overnight; proof = ledger + merged PRs + digest received.

**WS-2 — Flow & quality**: reviewer worker + rubric; provenance linter hardened; N-concurrent
worktrees with per-repo caps + **merge serialization per repo** (Bors-style: never two auto-merges
racing one main); **task heartbeats + stall detection** (no ledger output in N min ⇒ classify hung,
kill, transient-retry); stuck-PR shepherd (absorbs/retires pr-pipeline.sh); rate-limit-aware
dispatch governor; scope guard (diff/files budget); first fleet-repo target (wild-trails backlog).
Acceptance: two tasks run concurrently, one induced conflict auto-resolves, one induced hang is
detected and recycled; proof = ledger timeline.

**WS-3 — Principles engine**: principles.yaml loader; TDD Guard integration + red→green REPORT
proof; coverage ratchet + jscpd + dependency-cruiser CI templates; auto-filed refactor tasks;
reviewer rubric wired to profile. Acceptance: a `tdd: strict` task is BLOCKED when implementation
precedes a failing test (planted violation), passes when honest; proof = hook denial + green run.

**WS-4 — OSS packaging**: rename executed (D-1); Apache-2.0; `npx remudero init`; adapters; permission
profiles with `standard` default; README + security disclosure + quickstart (<5 min to first looped
PR on a toy repo); CI templates published. **Setup Agent (Q3/G-16)**: the wizard's WS-4 evolution —
an agentic onboarding session that interviews the new operator, **walks through public-vs-private
repo pros and cons** (G-1 was Craig's answer, never the shipped default — the Setup Agent counsels
and the operator chooses), then EXECUTES as much setup as possible via sub-agents: repo creation
through gh (**org-aware; explicitly sets allow_auto_merge, delete_branch_on_merge, and secret
scanning + push protection — fresh-repo defaults break agent pipelines, FIELD FINDING 8**),
plan-repo scaffold, CI templates, hooks/settings install, root layout, first golden run; PAT minting stays MANUAL with guided deep-links (credentials are never agent-handled).
**Project website (Craig req, G-7)**: landing +
quickstart + rendered MASTER-PLAN + honest-limitations page, on the project `.dev` domain; stack rec
Astro Starlight (docs-native, fast) deployed on Vercel per fleet pattern; site content maintenance
becomes a harness-run task post-L2 (the site is dogfood too). Acceptance: clean-machine install to
first auto-merged PR using only the website quickstart; proof = screen recording or transcript.

**WS-5 — UI**: v0 live board (SSE); v1 in-UI editing + agent proposals as PRs. Port audited (18793
taken on Craig's mini). Acceptance v0: watching a live run shows state flips within 2s of ledger
writes; proof = timestamp diff.

**WS-6 — Collaboration**: remudero-mcp server + scoped tokens; claude.ai custom-connector runbook;
CRDT co-editing spike (D-3 gate). Acceptance: an external Claude session reads the plan and files a
proposal PR through the connector; proof = PR authored via MCP path.

**WS-7 — Hardening**: chaos drills (kill worker mid-run, daemon restart mid-loop, network flap,
**reboot-resilience: does the LaunchAgent load and OAuth still authenticate after a cold boot with
no console login? — FIELD FINDING 4 residual**);
explicit supervision chain (launchd restarts daemon → daemon supervises workers via heartbeats →
freshness sentinel watches the daemon — who-watches-whom is documented, no unwatched layer);
worktree/disk GC watchdog; restart-recovery test is a required CI job; **nightly $ROOT/state
backup** (ledger + calibration data are irreplaceable history; git+GitHub already cover the rest)
with a **documented + drilled restore** (fresh machine → clone + rmd init + restore = fleet back);
**Claude Code CLI version is pinned config, not ambient** — a release watcher files platform-bump
tasks, and version bumps ship behind the golden suite like any other change (the platform itself is
a gated dependency; every knob we probed varies by version). Acceptance: daemon killed mid-task
recovers to correct state from git+GitHub alone; restore drill executed once from backup.

**WS-8 — Flywheel, retros & evals**: golden-task suite in CI from the proto-runner era onward
(grows with each workstream, and with every real failure minted into a golden); nightly flywheel
analyzer + suppression rules; **retro ceremony** (workstream-close + weekly patrol) producing
LEARNINGS updates AND agents-file/prompt-template PRs; **knowledge budgets gate** (CLAUDE.md line
cap ~150 default, LEARNINGS provenance + last-cited pruning); **prompt/knowledge-changes-behind-
goldens** enforced in CI; LEARNINGS.md pipeline + Promptsmith injection; transcript archive +
predecessor query; verdict-calibration job **+ mount-routing calibration** (golden-backed
downgrade/upgrade proposals for mounts.yaml, filed as retro PRs); DISTILL classifier stub. Acceptance: planted TDD-skip
golden caught in CI; seeded ledger pattern → exactly one evidence-cited improvement task (no dupes
on rerun); ★ a deliberately-degraded prompt-template PR goes RED on the golden suite before merge;
one retro produces a net-negative diff somewhere (compression proven); proofs = CI runs + diffs.

**WS-9 — Mobile**: shape per G-5. Baseline regardless of shape: responsive dashboard verified on
phone over tailnet (M0); push-transport decision executed (ntfy hypothesis verified against primary
docs first); remote STOP + escalation-answer + quiet-hours toggle. Acceptance: from a phone off the
home network (tailnet up), answer one escalation and STOP one running loop; proof = ledger entries
originating from the mobile client's bearer token.

**WS-10 — Campaigns**: campaign spec loader + Architect instantiation; v1 catalog (§3A); baseline
capture from ledger/CI; standing/scheduled/retro-filed triggers wired to idle-groom + quiet-hours.
Acceptance: a coverage-raise campaign across remudero + remudero-sandbox lands per-repo PRs whose
merged deltas meet the formula; proof = baseline-vs-after ledger lines + merged PRs.

**WS-11 — The Commons (universal brain)**: knowledge-hierarchy loader (project → org → commons,
nearest wins, provenance-tagged injection); DISTILL flow with human-gated outbound PRs to the
public remudero-commons repo; skills-shaped packaging. Acceptance: a universal learning distilled
from remudero's own retros lands in commons via a reviewed PR and is cited by a worker prompt in a
second project; proof = provenance chain across two ledgers.

Dependencies: WS-0 → WS-1 → {WS-2, WS-3} → WS-4 → WS-5 → WS-6; WS-7 threads from WS-1 onward;
WS-8 seeds at WS-0 (goldens), retro ceremony activates at WS-1, completes after WS-2; WS-9 M1
lands free with WS-1, M0 with WS-5a, M2 after WS-5; WS-10 after {WS-2, WS-8 baselines};
WS-11 after WS-4 + a second project on the harness.

## 11. Open decisions

- **D-1 Name — CLOSED 2026-07-14: Remudero (domains purchased)**. The remudero is the wrangler in
  charge of the remuda — the orchestrator's own job title, and a recovery of the remuda concept one
  level up. Alias `rmd`; binary `remudero` with `rmd` symlink. Full saga: drover (registries +
  cloud-shuttle same-space) → foreman (npm + Red Hat) → millwright/gaffer (npm + GafferHQ) →
  overlander (domains) → remuda (domains) → millrace (FATAL: 65★ governed-agentic-loops runtime) →
  nightmuster (registrar-verified .com, superseded on pick) → **Remudero**. Method that closed it:
  container DNS screening across .dev/.io/.com/.sh, retro-validated against both registrar failures,
  with .com-NXDOMAIN demoted to weak signal and finalists restricted to zero-footprint compounds
  (0 GitHub repos, no packages on any registry, no web presence). Evidence trail: git history of
  this line. G-10 bar for the record: .dev+.io(+.sh) suffices, .com nice-to-have — moot; purchased.
- **D-2 License — RESOLVED**: Apache-2.0 (patent grant; ships in PR #1). Veto window: before the
  spike PR merges.
- **D-3 Plan co-editing tech**: CRDT (Yjs) vs PR-proposals-only. Defer until v1 UI is lived-in (rec).
- **D-4 OSS default permission profile**: `standard` (rec). Craig's instance: `yolo`.
- **D-5 Repo shape**: monorepo (daemon+UI+MCP+CLI, npm workspaces) (rec) vs multi-repo.
- **D-8 Monetization**: open-core per §6 stance (rec); shape/pricing decided post-WS-6 traction,
  never earlier — premature paywalling kills the community the differentiation depends on.

## 12. Standing rules

1. PROVENANCE OR IT DOESN'T GO IN A PROMPT.
2. Trust, scheduling, strikes, budgets = deterministic predicates. Never LLM decisions.
3. One concern per PR. Branch from latest origin/main. Isolated worktrees.
4. Acceptance criteria are proofs, not vibes. Green checks ≠ evidence (the full-shop-flow lesson).
5. Never a third blind patch: two strikes → diagnose → one evidence-armed retry → escalate.
6. Zero ask rules in worker settings. Hooks <1s. Workers carry scoped PATs only. No MCP in workers.
7. OpenClaw stays out. The mini's protected paths are inviolate (deny-floor).
8. The loop never waits on a human unless the plan says so. Idle = groom.
9. OSS defaults must be defensible on a stranger's machine; yolo is a documented opt-in.
10. This document is truth. Every session syncs it before acting and after shipping.

## 13. Collaboration protocol (this document)

- Lives at repo root. Header carries sync date + focus, his-house style.
- Humans and agents edit via commits/PRs; the Architect does narrative syncs at workstream
  boundaries; the control plane flips task statuses only.
- Sections are append-biased: shipped arcs move to a SHIPPED log (added at first ship); lessons land
  in Standing rules or the relevant section in place — the repo remembers its outages where they happened.
- External Claude (design partner) contributions arrive as chat-produced patches until WS-6, then
  through remudero-mcp.

## 14. Immediate queue

**SETUP COMPLETE (2026-07-14).** Done: name + domains · repos `remudero` + `remudero-sandbox`
created PUBLIC under the craigoley org with `main`, Issues/Discussions OFF, secret scanning + push
protection ON, auto-merge + delete-branch-on-merge ON · workspace root + deny-floor overlay live ·
**auth fully cleared** (headless OAuth proven interactively AND under launchd) · plan at repo root.
Deferred by decision: scoped sandbox PAT → WS-1 (FIELD FINDING 9).

**NEXT — the only open step: run WS-0 spike v5.1** (prompt in chat 2026-07-14; ambient-gh-auth
variant). Return FINDINGS.md → WS-0 flips SHIPPED → WS-1 tasks.yaml is cut with pre-authored prompts
→ `run-task.ts` starts eating its own backlog (L1).

**Craig's standing side-items (outside Remudero):** (1) `ANTHROPIC_API_KEY` is exported from
`~/.zshrc`, so interactive Claude Code on the mini bills API instead of Max 20x — scope it to the
LaunchAgent plists + crontab entries that need it (FIELD FINDING 2). (2) One-time employer
IP/moonlighting policy glance given the director role; the public tree is already scrubbed to that
standard.

**Grill RESOLVED (complete record):**
- **G-1** → public from day 1 (hygiene woven into §6/§8; spike acceptance includes leak-grep).
- **G-2** → proto-runner; L1 ACTIVE (WS-1 restructured; daemonization is WS-1's last task).
- **G-3** → pace to Max limits, no dollar cap (§9: limit-aware backpressure, quiet-hours throttle,
  per-worker runaway tripwire retained as anomaly detection).
- **G-4/G-8/G-11 (naming)** → Remuda picked, killed at registrar; round 2 requested; **Remudero
  chosen, domains purchased 2026-07-14** (full saga: D-1).
- **G-5** → tailnet dashboard first; Expo standalone later (§7 mobile ladder).
- **G-6** → Issues + Discussions OFF until WS-4; pre-alpha banner; CODEOWNERS from PR #1 (§6).
- **G-7** → domain bar: ≥2 TLDs, prefer 3; **project website added to WS-4** (Craig requirement).
- **G-9** → no auto-advance on naming; Craig confirmed each registrar attempt (honored; now moot).
- **G-10** → .dev+.io(+.sh) meets the bar; .com nice-to-have (recorded; moot — purchased).
- **G-12** → Craig instance = Max 20x; **directive**: tier is per-instance setup config, never a
  plan constant, with auto-discovery on attach (§9 detect→confirm ladder; wizard + Settings pane).
- **G-13** → thinking_default: medium.
- **G-14 (pre-build)** → same Max 20x pool; Craig expects to work mostly THROUGH the fleet ⇒
  quiet-hours optional/off; **Pause (drain-and-hold) added to the control set** — his directive.
- **G-15 (pre-build)** → BlueBubbles acceptable but nothing may be Craig-specific in the default
  path ⇒ **imessage-local reference adapter** (native osascript on the host Mac) built at WS-1.
- **G-16 (pre-build)** → first project = remudero itself (confirmed); new-instance onboarding =
  **Setup Agent** with public/private counsel + sub-agent-executed setup (WS-4).
- **G-17 (pre-build)** → **Tier Invariant**: the main agent always rides a higher-thinking mount
  than the coding agents; relative ordering, config-validated, flywheel-constrained (§9).

## Banked queue

- Grill-me protocol as in-harness interactive intake (`rmd chat`) — post-WS-4.
- Agent Teams as an optional worker sub-mode for parallel exploration inside one task.
- **Beads import/export adapter** — tasks.yaml stays the schema-tight native substrate; Beads (23k★,
  git-backed agent issue ledger) is the interop target if demand appears.
- ~~Formula/molecule-style reusable task templates~~ **PROMOTED to core as §3A Campaigns** (Craig
  directive, 2026-07-14).
- Wasteland-style federation of the commons across operators (portable, reviewed knowledge
  exchange between installs) — post-WS-11 if the commons gets traction.
- Remote/cloud workers beyond the mini (hyperscaler or Claude Code cloud sandboxes).
- Load/scale story: multiple products, one daemon vs. daemon-per-product.
- ClawApp inbox integration as a notifier adapter (Craig instance).
- Plugin/skill marketplace listing once stable.
- Cross-agent support (Codex exec) — explicitly parked; Claude-first keeps contracts tight.
- Tournament dispatch (two approaches, reviewer picks) for high-risk tasks — expensive, park until
  verdict calibration proves the reviewer.
