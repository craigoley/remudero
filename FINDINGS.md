# WS-0 Spike — FINDINGS

Ground truth from running the primitive Remudero loop end-to-end against
`remudero-sandbox`, fully unattended, under OS-sandbox containment, on
subscription OAuth. Machine identifiers are redacted as `<host>` / `~` /
`<user>` per public-repo hygiene. Everything below is observed on THIS install,
not read from docs.

## Installed versions (pinned ground truth)

| Component | Version |
| --- | --- |
| Claude Code CLI | **2.1.209** (real binary at `~/.npm-global/bin/claude`; `claude` is a shell function — FIELD FINDING 3) |
| `@anthropic-ai/claude-agent-sdk` | **0.3.209** |
| node | **v22.22.3** (`/opt/homebrew/…`; pinned in `.nvmrc` + `engines`) |
| gh | **2.92.0**, authed as `cao825` (scopes: `gist, read:org, repo, workflow`), HTTPS |
| typescript | 7.0.2 · tsx 4.23.1 · @types/node 22 |

Total spend for the spike run: **≈ $0.86** (recon 0.237 · probe 0.079 · impl-r1
0.048 · impl-r2 0.299 · smoke 0.201). `total_cost_usd` is reported even on
subscription (notional cost; billing draws from the Max window, not the invoice).

---

## The seven verdicts

### ✅ (1) Worker spawned FROM NODE authenticates on OAuth — billing boundary holds

**Proof — child env carries zero `ANTHROPIC_*` and the precedence warning is absent, on every worker:**

```
recon.childEnvKeys:  ["HOME","LANG","PATH","TMPDIR","USER"]
recon.ANTHROPIC_keys_in_child_env: []
recon.precedence_warning_in_stderr: false
probe.childEnvKeys:  ["HOME","LANG","PATH","TMPDIR","USER"]   ANTHROPIC: []   precedence: false
impl1.childEnvKeys:  ["HOME","LANG","PATH","TMPDIR","USER"]   ANTHROPIC: []   precedence: false
impl2.childEnvKeys:  ["HOME","LANG","PATH","TMPDIR","USER"]   ANTHROPIC: []   precedence: false
```

The child env is CONSTRUCTED by `buildWorkerEnv()` from an explicit allowlist and
passed to the SDK's `env` option, which **replaces the subprocess environment
entirely** (SDK doc, verified) — it is never merged with `process.env`. The unit
test proves a parent polluted with `ANTHROPIC_API_KEY` yields a child with none
(`npm test`, 4/4 green).

**Subscription confirmed** by `claude -p "/usage"` (see verdict-2 raw): *"You are
currently using your subscription to power your Claude Code usage."*

**★ New field finding — `USER` is load-bearing for OAuth on macOS.** The
subscription OAuth token lives in the **login Keychain** (there is NO
`~/.claude/.credentials.json`). With `PATH/HOME/TMPDIR/LANG` but no `USER`, a
headless run returns `"Not logged in · Please run /login"`. Bisected:

```
USER only:    OK
LOGNAME only: Not logged in · Please run /login
neither:      Not logged in
```

`USER` is now in the allowlist (`src/lib/env.ts`). It carries no secret. Corollary
recorded for WS-7: the Keychain must be *unlocked* for the lookup to succeed — on
this SSH-attached session it was unlocked out-of-band; a cold-boot launchd daemon
must re-establish that (FIELD FINDING 4 residual → chaos drill).

**★ Correction to FIELD FINDING 1 method (not the conclusion).** `launchctl getenv
ANTHROPIC_API_KEY` returns exit 0 even when unset, so an exit-code check
false-positives. The authoritative check (`-n "$(launchctl getenv …)"`) confirms
**launchd domain: absent** — FF1's "checked: 0" stands. This process's own env
also has 0 `ANTHROPIC_*` keys.

### ✅ (2) Result JSON parses — exact observed field names

The result envelope (captured from `claude -p "/usage" --output-format json`,
account-usage text elided):

```json
{"type":"result","subtype":"success","is_error":false,"duration_ms":518,
 "duration_api_ms":0,"num_turns":0,"result":"…","stop_reason":null,
 "session_id":"887af5dc-…","total_cost_usd":0,
 "usage":{"input_tokens":0,"cache_creation_input_tokens":0,
   "cache_read_input_tokens":0,"output_tokens":0,
   "server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},
   "service_tier":"standard","cache_creation":{…},"inference_geo":"",
   "iterations":[],"speed":"standard"},
 "modelUsage":{},"permission_denials":[],"fast_mode_state":"off","uuid":"…"}
```

**Exact field names for the harness contract:** `session_id`, `total_cost_usd`,
`subtype`, `is_error`, `result`, `num_turns`, `usage.{input_tokens,output_tokens,
cache_read_input_tokens,cache_creation_input_tokens,service_tier}`, `modelUsage`,
`permission_denials`. SDK error subtypes (from `SDKResultError`):
`error_during_execution | error_max_turns | error_max_budget_usd |
error_max_structured_output_retries`. `worker.ts` reads `session_id` /
`total_cost_usd` / `result` / `permission_denials` off the `type:"result"`
message; all four workers returned parseable success envelopes.

### ✅ (3) worktree → PR → merge closes

```
WORKTREE ADD  <root>/worktrees/spike-hello-<ts>   (branch off origin/main)
PR_URL:  https://github.com/craigoley/remudero-sandbox/pull/1
pr.state: OPEN → mergeable: MERGEABLE
MERGE --squash --delete-branch → state: MERGED
WORKTREE REMOVE  (clean)
```

GitHub confirms: `{"state":"MERGED","mergedAt":"2026-07-14T10:50:46Z",
"files":["docs/spike-hello.md"]}`, and `docs/spike-hello.md` is now on sandbox
`main`. Full loop closed unattended.

### ✅ (4) ★ Deny-hook blocks under bypass — on THIS version

The probe worker ran under `permissionMode: bypassPermissions` with the sandbox
on. `hooks/deny-floor.sh` (PreToolUse, exit 2) blocked the `~/FORBIDDEN_PROBE`
write:

```
verdict4.hook_denial_in_transcript: true
verdict4.forbidden_absent: true        (file never created)
verdict4.held_under_bypass: true       (no dontAsk fallback needed)
```

**The documented counter-report (claude-code#20946, macOS async race) did NOT
reproduce on 2.1.209** — the deterministic floor held under bypass. The `dontAsk`
fallback path is implemented but was not exercised.

### ✅ (5) ★ Zero-prompt git commit/push under bypass in `-p`

The implement worker (round 2, bypass) committed and pushed with **no permission
prompts and no hang**:

```
impl2.permission_denials: []
impl2 report: "commit … (1 file changed, 1 insertion)";
              "The commit pushed successfully — the remote confirmed
               [new branch] HEAD -> spike-hello-<ts>."
verdict5.push_path: git push (in-sandbox, HTTPS via gh credential helper)
verdict5.pushed_by_worker: true
```

No ask rules in `settings/worker.json` ⇒ no stall. `.git/` writes inside the
worktree did not trip any protected-path prompt.

### ✅ (6) DECISION_REQUEST auto-choose via session resume

Round-trip closed within one session:

```
IMPLEMENT r1 → emits DECISION_REQUEST (two options, one RECOMMENDED), STOPS
  decision.parsed: true   auto_selected: docs/spike-hello.md
DECISIONS.md appended (rationale + rollback)
IMPLEMENT r2 → resume 9b1c2808-… (same session_id) → creates file, commits,
              pushes, opens PR, REPORT ends "PR_URL: …/pull/1"
```

`resume: <sessionId>` (SDK option) continued the exact worker context. A parser
fragility surfaced and was hardened (see Failures).

### ✅ (7) ★ Sandbox containment probe — all four sub-proofs

```
verdict7.sandbox_active: true
verdict7.worktree_write_present(probe-ok): true      (write INSIDE cwd OK)
verdict7.outside_write_absent: true                  (../outside-probe-<ts>.txt never created)
verdict7.os_denial_in_transcript: true
verdict7 push: prompt-free under allowedDomains (branch+commit landed on origin)
verdict4 hook fired through the sandbox (FORBIDDEN_PROBE blocked)
```

Probe transcript (verbatim tail):

> `Operation not permitted` (exit code 1). Writing outside the working directory
> is not permitted; no file was created. … step3: SUCCESS — `touch probe-ok.txt`
> completed … Containment is holding as expected — writes to the home directory
> (hook-blocked) and to the parent/outside directory (sandbox-blocked) were both
> prevented, while a write inside the working directory succeeded.

**★ git-vs-gh push outcome + a worktree nuance.** Plain `git push` over HTTPS
**worked through the sandbox** on the first try (github.com in `allowedDomains`,
gh credential helper) — no gh fallback needed. The only sandbox friction: `git
push -u` also tries to write upstream-tracking metadata to the **shared
`.git/config`, which for a linked worktree lives in the main repo checkout
OUTSIDE the worktree cwd** → OS-denied (`Operation not permitted` on the config
lock). The push itself still succeeded; only the local `-u` bookkeeping was
skipped. Implication for WS-1: run `git push` without `-u` inside worktrees (or
set tracking out-of-band), and expect the shared `.git` to be outside the sandbox
write scope.

---

## Sandbox keys accepted by the INSTALLED version (step 4)

**The prompt's spelling was wrong for this version and would have been silently
dropped.** From `SandboxSettingsSchema` (SDK 0.3.209), the accepted shape is:

```
sandbox: {
  enabled, failIfUnavailable, autoAllowBashIfSandboxed, allowUnsandboxedCommands,
  network: { allowedDomains[], deniedDomains[], allowManagedDomainsOnly,
             allowUnixSockets[], allowAllUnixSockets, allowLocalBinding,
             allowMachLookup[], httpProxyPort, socksProxyPort,
             tlsTerminate: { caCertPath, caKeyPath } },
  filesystem: { allowWrite[], denyWrite[], denyRead[], allowRead[],
                allowManagedReadPathsOnly },
  credentials: { files:[{path,mode:"deny"}], envVars:[{name,mode:"deny"|"mask",
                 injectHosts[]}], allowPlaintextInject },
  excludedCommands[], allowAppleEvents, enableWeakerNestedSandbox,
  enableWeakerNetworkIsolation, ignoreViolations{}, ripgrep{}, bwrapPath, socatPath
}
```

Key deltas the working `settings/worker.json` reflects:
- **`allowedDomains` is NOT top-level — it nests under `network`.** (Prompt put it
  at the sandbox root; that would be stripped.)
- `denyRead` nests under `filesystem`. `excludedCommands` is top-level. ✓
- **SDK 0.3.209 rejects passing BOTH a `settings` file path AND the `sandbox`
  option**: `"Cannot use both a settings file path and the sandbox option.
  Include the sandbox configuration in your settings file instead."` ⇒ sandbox
  lives in `worker.json`; `worker.ts` passes only `settings: <file>`. The probe
  (verdict 7) is the empirical guard that it engaged, since `-p` **silently
  ignores a settings file that fails validation**.

`settingSources: []` (SDK isolation mode) guarantees `~/.claude/settings.json` is
never loaded into a worker.

---

## Resource knobs & discovery (installed-version ground truth, step 7)

| Knob | Where | Exact name / values |
| --- | --- | --- |
| **(a) per-run max budget** | CLI + SDK | `--max-budget-usd <amount>` (print-only) · SDK `maxBudgetUsd?: number` → breach returns `error_max_budget_usd` |
| **(b) thinking / effort** | CLI + SDK | `--effort <low\|medium\|high\|xhigh\|max>` · SDK `effort?` (same) · SDK `thinking?: {type:'adaptive'} \| {type:'enabled',budgetTokens:number} \| {type:'disabled'}` · deprecated `maxThinkingTokens?` |
| **(c) max_turns** | SDK only | `maxTurns?: number` (no CLI flag) |
| **(d) auto-compact** | SDK types | `autoCompactThreshold?: number`, `autoCompactEnabled?` / `isAutoCompactEnabled`, `autoCompactWindow?`; `~/.claude.json` caches `autoCompactWindowsCache`. No `-p` CLI flag observed. |
| **(e) exec path / child env** | SDK | `pathToClaudeCodeExecutable?: string` · `env?: {[k]:string\|undefined}` (**replaces** env entirely) · `executable?: 'bun'\|'deno'\|'node'` · `executableArgs?`, `extraArgs?` |

Other confirmed options in use: `permissionMode` (`acceptEdits|auto|
bypassPermissions|manual|dontAsk|plan`), `settings` (path|object), `resume`,
`forkSession`, `settingSources`, `stderr` callback.

**(f) `/usage` and `/status` headless.** `claude -p "/status"` →
`"/status isn't available in this environment."` (unusable headless). **`claude
-p "/usage"` IS machine-readable** and returns, inside `result`:

```
You are currently using your subscription to power your Claude Code usage
Current session: NN% used · resets <ts> (<tz>)
Current week (all models): NN% used · resets <ts>
Current week (Fable): NN% used · resets <ts>
… Last 24h · N requests · N sessions … Last 7d · …
```

⇒ HeadroomTracker CAN parse session + dual-weekly windows (all-models + a
model-specific cap) with reset timestamps from `-p "/usage"`. (Values redacted.)

**(g) locally-visible account/plan metadata (KEYS/SHAPES ONLY).** There is **no
`claude config` subcommand** in 2.1.209 (commands: `agents, auth, auto-mode,
doctor, gateway, install, mcp, plugin, project, setup-token, ultrareview,
update`). Local files under `~/.claude/`: `settings.json`
(keys: `skipDangerousModePermissionPrompt`, `tui`), `policy-limits.json`,
`remote-settings.json`, `mcp-needs-auth-cache.json`, plus `projects/`, `sessions/`,
`telemetry/`. `~/.claude.json` holds plan-relevant KEYS (values never read):
`hasAvailableSubscription`, `cachedUsageUtilization`, `modelAccessCache`,
`additionalModelCostsCache`, `autoCompactWindowsCache`,
`cachedExtraUsageDisabledReason`, `machineID`, `oauthAccount`(present), `mcpServers`.
⇒ tier/plan inference has a local surface (§9 ladder rung 2) without any network
call; no OAuth token is stored in a file (Keychain only).

---

## Failures hit and their fixes

1. **`Cannot use both a settings file path and the sandbox option`** — passing SDK
   `settings:<file>` + `sandbox:{}` together throws. **Fix:** put sandbox in
   `worker.json`; pass only `settings`. (Documented above.)
2. **`Not logged in · Please run /login`** with a minimal env — OAuth needs
   `USER` (Keychain identity). **Fix:** add `USER` to the allowlist. (Verdict 1.)
3. **`env: -p: No such file or directory`** during discovery — `which claude` in
   zsh printed the shell function, not a path. **Fix:** resolve the binary with
   `execFileSync('which', …)` in a non-shell context (that's exactly what
   `config.resolveClaudeBin()` does) / use the absolute path.
4. **`timeout` not found on macOS** — no coreutils. **Fix:** print-mode `claude
   -p` self-exits; ran probes without a wrapper timeout.
5. **DECISION_REQUEST parser captured `")"`** from an inline `(RECOMMENDED)`
   marker; the correct file was chosen only because it equalled the default.
   **Fix:** hardened `parseDecisionRequest()` to prefer an explicit
   `RECOMMENDED: <x>` line, dedupe options, and strip the inline marker.
6. **Realistic key/token prefixes in the env unit test** would have tripped the
   leak-grep (the same patterns the grep hunts for). **Fix:** replaced the test's
   fixture values with non-matching placeholders.

---

## Auth boundary (per directive)

Workers use **ambient gh credentials** (cao825, push to both repos). `buildWorkerEnv()`
does **NOT** inject `GH_TOKEN`, does **NOT** read `~/.config/remudero/sandbox.pat`
(which does not exist), and **strips all `ANTHROPIC_*`**. Scoped-PAT injection via
`buildWorkerEnv()` is a **WS-1 hardening task**, not implemented here (FIELD
FINDING 9). Containment for WS-0 rests on OS sandbox + deny-hook + worktree
scoping + push-protection, exactly as planned.

## Open questions → WS-1/WS-7

- **Keychain unlock under cold-boot launchd** (no console login) is unverified —
  the OAuth `USER`/Keychain dependency makes this a hard WS-7 chaos-drill gate,
  not an assumption (FIELD FINDING 4 residual).
- **Shared `.git` outside the sandbox**: settle worktree push ergonomics (drop
  `-u`, or pre-configure tracking / `push.autoSetupRemote` out-of-band).
- **`total_cost_usd` on subscription** is notional — confirm MeterGuard reads it
  purely for metering, and cross-check against `/usage` window deltas.
- **Auto-compact knobs** are SDK-typed but not `-p`-flag-exposed; WS-1 should
  verify whether `autoCompactThreshold` is honored via `settings`/`env`.
- **Settings silent-drop under `-p`**: any worker-settings schema drift fails
  silently; WS-1 needs a validate-before-spawn guard (the probe is today's proxy).
