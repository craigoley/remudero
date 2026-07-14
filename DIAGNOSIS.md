# DIAGNOSIS — resume-spawn "native binary not found" (run W1-T1C-1784038021919)

**Branch:** `diag/resume-spawn-enoent` · **Mandate:** evidence, no patch.
**Verdict:** NOT a code defect in PR #8 and NOT specific to the resume path. The
worker's own Claude Code process triggered a **background auto-update** of the
shared `claude` binary (`npm install -g @anthropic-ai/claude-code@2.1.209`). The
resume spawn fired *during* npm's reify of the package tree, when
`~/.npm-global/bin/claude` did not resolve. Node's `spawn` emitted `ENOENT`; the
SDK mapped it to "native binary not found." Any spawn landing in that window would
have failed — resume was merely the one that did.

---

## Root cause (named)

**A host-level race between Claude Code's background self-updater and a worker
spawn.** At 14:10:00.732Z a detached `npm install --global
@anthropic-ai/claude-code@2.1.209` began reifying the package tree (removing and
rewriting `~/.npm-global/lib/node_modules/@anthropic-ai/claude-code/` **and** the
`~/.npm-global/bin/claude` symlink). The resume worker spawned 11 s later, at
14:10:11.155Z, while that symlink/target was momentarily absent. `spawn()` on the
absolute executable path raised an `ENOENT`-class error event; the SDK's transport
error handler turned it into the observed message.

This is orthogonal to PR #8. PR #8's env/worker/config edits are healthy (proven
below). The prompt's steer — "weight 'it worked before PR #8' heavily; the cause
is most likely a recent edit" — is **contradicted by the evidence**. It worked
before PR #8 *and* it works after PR #8; it failed once because of a concurrent
binary swap on the host.

---

## The single falsifying observation

> The `claude` binary/symlink now on disk has **birthtime = ctime = mtime =
> 2026‑07‑14T14:18:40 UTC — 8m29s AFTER the failure at 14:10:11 UTC** — and
> `~/.claude/.last-update-result.json` records `version_from:"2.1.201" →
> version_to:"2.1.209"`, `path:"npm-global"`, `timestamp:"2026‑07‑14T14:18:40.761Z"`.
> An npm debug log (`~/.npm/_logs/2026-07-14T14_10_00_732Z-debug-0.log`) shows
> `install --global @anthropic-ai/claude-code@2.1.209` with `silly CHANGE
> node_modules/@anthropic-ai/claude-code`, started 11 s before the failure.

The prompt's "RULED OUT: the binary EXISTS … present, unchanged" is **factually
wrong**: the binary observed after the fact is a *fresh 2.1.209 copy written after
the failure*, not the 2.1.201 binary recon/implement used. That single stat
(birthtime after the error) falsifies every "PR #8 broke the resume code" theory:
if the code were broken, the binary would be unchanged and re-running resume now
(stable binary) would still fail. It does not — see confirmation.

---

## Timeline (UTC; from `state/ledger.ndjson`, npm logs, and stat birthtimes)

| Time (UTC)        | Event                                                              | Binary in play |
|-------------------|-------------------------------------------------------------------|----------------|
| 14:07:01.921      | `run.start`                                                        | 2.1.201 (present) |
| 14:07:27.208      | `recon.done` subtype=success, 2 turns, $0.264 — **spawn OK**       | 2.1.201 |
| 14:10:00.732      | **`npm install -g @anthropic-ai/claude-code@2.1.209` begins** (detached) | reify starts |
| 14:10:10.584      | `implement.done` subtype=success, 15 turns, $0.666 — **spawn OK**  | 2.1.201 (still) |
| 14:10:10.614      | `decision.autochoose` → "Option A"                                 | — |
| **14:10:11.155**  | **resume spawn → `run.error` "native binary not found"**          | **symlink absent (mid-reify)** |
| 14:10:11.276      | `worktree.remove` on run.error (cleanup — cwd still existed here)  | — |
| 14:18:40.761      | auto-update **completes**; new 2.1.209 binary written (birthtime) | 2.1.209 (present) |

Additional npm install logs at 14:11:37 (×2), 14:15:55 (×2), 14:18:39 (×2), and
later — a **thundering herd** of concurrent auto-update attempts from the several
Claude Code processes live on the box (the two workers, plus interactive/other
sessions), each racing to `npm install -g`. That widens and repeats the window in
which the shared binary is unavailable.

---

## Evidence chain (command → raw output)

### 1. The exact error, from the ledger (not the paraphrased prompt)
`state/ledger.ndjson` line 62:
```
{"step":"run.error","error":"Claude Code native binary not found at
/Users/craigoleyagent/.npm-global/bin/claude. Please ensure Claude Code is
installed via native installer or specify a valid path with
options.pathToClaudeCodeExecutable."}
```

### 2. SDK source: this exact string ⟺ `existsSync(executable) === false`
Installed SDK `@anthropic-ai/claude-agent-sdk@0.3.209`, `sdk.mjs` (de-minified):
```js
import { existsSync as eZ } from "fs";
function sZ(e, t) {                                  // e = executable path, t = isNativeBinary
  if (eZ(e)) return t ? `…native binary at ${e} exists but failed to launch…`
                      : `…executable at ${e} exists but failed to launch.`;
  return t ? `Claude Code native binary not found at ${e}. Please ensure … or
              specify a valid path with options.pathToClaudeCodeExecutable.`
           : `Claude Code executable not found at ${e}. …`;
}
// child error handler:
di.on("error",(ye)=>{ … else if (Yb(ye)) { let cr = sZ(a, ui);
  this.exitError = ReferenceError(cr); } … });
var lq = new Set(["ENOENT","EACCES","EPERM","ENOTDIR","ELOOP","ENAMETOOLONG","EROFS"]);
function Yb(e){ let t = e?.code; return t !== void 0 && lq.has(t); }   // ENOENT-class predicate
```
The observed "**not found**" wording is reached **only** when `existsSync(a)` is
false. So at 14:10:11 the orchestrator's `existsSync("~/.npm-global/bin/claude")`
returned false. (`a` = `pathToClaudeCodeExecutable` = `config.claudeBin`; the spawn
command is that same absolute path — `iZ(a)` true ⇒ native binary spawned directly.)

### 3. The binary that recon/implement used was replaced AFTER the failure
```
$ stat -f '%N birth=%SB mtime=%Sm' -t '%Y-%m-%dT%H:%M:%S%z' \
    ~/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe
claude.exe  birth=2026-07-14T10:18:40-0400  mtime=2026-07-14T10:18:40-0400   # = 14:18:40 UTC
$ cat ~/.claude/.last-update-result.json
{"timestamp":"2026-07-14T14:18:40.761Z","path":"npm-global","outcome":"success",
 "status":"success","version_from":"2.1.201","version_to":"2.1.209","error_code":null}
```

### 4. npm was actively reifying the package tree at the failure instant
```
$ head ~/.npm/_logs/2026-07-14T14_10_00_732Z-debug-0.log
7 verbose argv "install" "--global" "@anthropic-ai/claude-code@2.1.209"
$ grep 'CHANGE node_modules/@anthropic' <that log>
79 silly CHANGE node_modules/@anthropic-ai/claude-code       # remove+rewrite of the tree (and bin symlink)
92 verbose exit 0
```
Log filename timestamp `14:10:00.732Z` = install start, 11 s before the failure.

### 5. `existsSync=false` requires an ABSENT path, not a bad cwd (rules out cwd theory)
`scratchpad/spawn-probe.mjs` (isolating Node's `spawn` behavior):
```
existsSync(EXE) now: true
[MISSING-cwd]  error-event code=ENOENT errno=-2 syscall=spawn /…/claude
               path=/…/claude | existsSync(EXE)=true          ← would yield "exists but failed to launch"
[cwd-is-a-FILE] SYNC THROW code=ENOTDIR
```
A missing/invalid **cwd** produces ENOENT but with `existsSync(EXE)=true`, which
the SDK renders as "*exists but failed to launch*" — NOT the observed message. The
observed "not found" text therefore points at an absent **executable**, not the
worktree cwd. (The ledger also shows `worktree.remove` firing *after* run.error,
so the cwd existed at spawn time regardless.)

### 6. Identical error reproduced by pointing at an absent executable ($0 — fails at spawn)
`scratchpad/absent-binary-repro.mjs` — real SDK, `pathToClaudeCodeExecutable` set
to a non-existent path, `resume` set:
```
SDK THREW: ReferenceError
MESSAGE: Claude Code native binary not found at
/Users/craigoleyagent/.npm-global/bin/claude-MID-UPDATE-GONE. Please ensure Claude
Code is installed via native installer or specify a valid path with
options.pathToClaudeCodeExecutable.
```
Same class (`ReferenceError`) and same message template as the ledger — an absent
executable path is a sufficient and exact cause.

### 7. The resume CODE PATH is healthy NOW (binary stable) — confirms it was environmental
`scratchpad/resume-repro.mjs` — real `spawnWorker` (PR #8 env/worker/config), one
turn then a resume of that session:
```
TURN1:  { subtype: 'success', isError: false, turns: 1 }
RESUME: { sessionId: <same>, subtype: 'success', isError: false, turns: 1 }
RESUME SUCCEEDED
```
The resume option (`--resume=<id>`, the *only* child-arg difference vs. the
first implement spawn) works cleanly. PR #8's `buildWorkerEnv` (adds
`CLAUDE_CODE_SHELL`/`ZDOTDIR`; unchanged allowlist) is not implicated.

### 8. Why resume and not recon/implement — pure timing, not code
Both earlier spawns used identical `cwd`, `env`, `settings`, and
`pathToClaudeCodeExecutable`; the only per-call difference on resume is the
appended `--resume=<sessionId>` CLI flag (SDK `initialize()`:
`if(R)W.push(\`--resume=${R}\`)`). recon (14:07:27) and implement (14:10:10) ran
before the 14:10:00 install reached its tree-swap; the resume (14:10:11) did not.

---

## Exact minimal fix (described — NOT implemented)

**Primary (removes the race): stop workers from auto-updating the shared binary.**
Each worker is itself a Claude Code process and triggers the background updater.
Grant the updater-disable env var in `buildWorkerEnv` alongside the existing
`CLAUDE_CODE_SHELL`/`ZDOTDIR` grants (same "workers inherit nothing they aren't
given" pattern in `src/lib/env.ts`). Verified against official Claude Code docs
(`code.claude.com/docs/en/setup#disable-auto-updates`):
- **`DISABLE_AUTOUPDATER=1`** (string `"1"`) — disables the background auto-update
  check; `claude update`/`claude install` still work. **This is the right knob**
  (purpose-specific; keeps manual/security updates possible).
- `DISABLE_UPDATES=1` — blocks *all* update paths including manual. Heavier hammer;
  use only if you also want to forbid `claude update`.
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` — also stops the autoupdater but is
  **undocumented** and **also blocks security updates** (known issue #53899).
  Do NOT use this one for the autoupdater.

⚠️ Caveats before implementing:
- There is an open report (#14985) that `DISABLE_AUTOUPDATER=1` is not always
  honored on some builds — **verify empirically against the pinned CLI**: set it in
  a worker env and confirm no `npm install -g` fires (watch `~/.npm/_logs/`). The
  main CLI logic is inside the Bun-compiled `claude.exe` and cannot be grepped, so
  the var's effect must be confirmed by observation, not by reading source
  (binding rule 1: distrust any doc/prompt over the installed version).

This is necessary but not fully sufficient on its own: interactive/other Claude
Code sessions on the same host will still auto-update the shared install. So also:

**Defense-in-depth (survive a swap regardless of who triggers it): retry the
pre-first-message spawn on an ENOENT-class transport error.** The SDK surfaces this
as a `ReferenceError` whose message matches `/Claude Code (native binary|executable)
(not found|exists but failed to launch)/`, thrown *before* any `result` envelope
(so `collectWorkerResult`'s `if(!sawResult) throw err` path). Wrap `spawnWorker` so
that this specific class of failure — and only when zero turns/cost were incurred
(spawn never started) — retries a small bounded number of times with backoff
(e.g. 3× at 2 s), re-reading `config.claudeBin` existence each time. It is safe:
no turns consumed, no double-spend, no partial session. A budget/max_turns error
(which *does* carry a result envelope) must NOT be retried — the existing
`sawResult` gate already distinguishes them.

Optionally pin the fleet to a chosen CLI version and update it deliberately
(out-of-band) rather than letting each worker self-update — the cleanest long-term
posture for a self-hosting harness, and consistent with `config.claudeBin` being a
pinned path (FIELD FINDING 2/3).

---

## Could not verify

- **Exact autoupdater env-var name/semantics for CLI 2.1.209** — the logic lives
  in the Bun-compiled `claude.exe`; not greppable. Recommendation above must be
  checked against the pinned CLI before coding.
- **Precise sub-second unlink window** — I did not instrument npm's reify to timestamp
  the exact microseconds `bin/claude` was unlinked. The bracketing evidence (install
  start 14:10:00.732Z, `CHANGE` on the tree, failure 14:10:11.155Z, completion
  14:18:40.761Z) is conclusive that the swap overlapped the spawn; the exact unlink
  instant within it is not separately proven and does not change the diagnosis.

---

## Recoverable work? (the ~$0.93)

**The dollars are notional (subscription) and not "refundable," but no *output* was
destroyed, and nothing code-wise was lost.**

- The implement worker **stopped at a `DECISION_REQUEST` before writing any code**
  (its final transcript message is the decision request). It committed nothing:
  `git -C repos/remudero rev-list --count origin/main..run-W1-T1C-1784038021919` →
  **0**. There was never a code artifact in the (now-removed) worktree to recover.
- **Both session transcripts survive** and hold the entirety of what the spend
  bought:
  - recon: `~/.claude/projects/-Users-craigoleyagent-Remudero-worktrees-run-W1-T1C-1784038021919/d7329458-….jsonl` (26 KB)
  - implement: `…/d02398e1-30f3-482d-85e8-7c57b9cdd98f.jsonl` (200 KB)
- The auto-chosen decision ("Option A") is already recorded in `DECISIONS.md` by
  the orchestrator, so the decision outcome is not lost either.
- The implement session `d02398e1…` is **technically resumable now** (binary
  stable) via the SDK `resume` option, though its project/cwd (the worktree) was
  removed — a resume would run in a missing cwd. **Simpler and cheaper is a fresh
  `rmd run-task W1-T1C`**: recon re-runs (~$0.26) but the decision is already made
  ("Option A"), so the implement phase can proceed straight to code. Net
  unrecoverable spend if re-run: ~$0.26 of recon, not the full $0.93.

---

## One-line summary

The resume spawn failed because the host's `claude` binary was mid-`npm install`
self-update (2.1.201→2.1.209) and its path did not resolve at that instant; the
SDK reported this as "native binary not found." PR #8 and the resume logic are
sound. Fix = disable the worker autoupdater and retry ENOENT-class spawn failures;
no committed work was lost.
