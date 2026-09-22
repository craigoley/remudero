# The polled 404 — a real `gh` 404, silently caught, that leaks anyway (W1-T3679)

METHOD, STATED UP FRONT. This repo (checked out here as a worktree) has no live shell into the
three running hosts (`remudero-daemon`, `remudero-site-daemon`, `remudero-console-daemon`) —
`docker`/`ssh` are unavailable from this sandbox, and the fleet's own `gh` cadence floor
(`hooks/deny-floor.sh`, W1-T3275) refuses a second read from here inside 180s regardless. Every
claim below is either (a) traced to a specific `src/` line, or (b) an independently reproduced
Node.js behaviour, run in this sandbox and shown verbatim. Nothing here is a log grep from the
live hosts — the task's own rationale already did that measurement; this recon explains it from
the code the measured processes actually run.

## RULED OUT, AND WHY THE RULING HOLDS UP

The task's rationale (itself MEASURED, not recon) already excludes three candidates. Reading the
code behind each confirms the exclusion is sound rather than assumed:

- **The heartbeat.** `scripts/fleet-heartbeat.sh` never invokes `gh` at all (grep for `gh ` inside
  it only matches a doc comment) — there is no ref for it to 404 on, in any repo.
- **Repo reachability.** Every read this recon traces below targets a repo the rationale already
  confirmed answers `GET /repos/{owner}/{repo}` with 200.
- **The board gateway's own two reads.** `src/lib/status.ts`'s `attemptFetch` (PR list, line
  4194) and `issueIndex` (labelled-issue list, line 4124) are the ONLY two GitHub reads that write
  `board_gateway.fetch_ok` / `board_gateway.issue_fetch_ok`, and BOTH explicitly pass
  `stdio: ["ignore", "pipe", "pipe"]` (or `"ignore"` for stderr) to `ghExec` — verified below, this
  shape cannot leak to the real process stderr even on failure. The rationale's ledger correlation
  (`fetch_ok` clean in the same minute) and the code's own stdio contract agree: this genuinely
  is not the source.

## THE CALL

**The workflow-run job hydration inside the daemon's own sweep, run through `ghJson` — a sync
`gh` call whose real implementation carries no `stdio`, so Node inherits the child's stderr
straight onto the daemon's own stream regardless of how the catch around it behaves.**

Two independent facts have to be true together to produce "every ledger step reports ok" while
stdout still fills with a raw `gh: Not Found (HTTP 404)` line every poll. Both are traced here,
not assumed.

**Fact 1 — a real, silently-caught 404, on a call this codebase already knows can go stale.**
`src/run-task.ts`'s `buildOpenPrViews` (the daemon's own per-sweep open-PR builder, called
unconditionally every `runGatedSweep` pass — `src/lib/daemon.ts`'s tick body, `deps.sweep`) scopes
one follow-up read to PRs whose `checksState` reads `"pending"`:

```
// src/run-task.ts:33006
const pendingPrs = raw
  .filter((p) => checksStateFromRollup(p.statusCheckRollup, requiredContexts) === "pending")
  .map((p) => ({ number: p.number, headRefOid: p.headRefOid }));
const workflowRuns = hydrateWorkflowRuns(owner, repo, pendingPrs, fetch);
```

`hydrateWorkflowRuns` → `fetchWorkflowRunObservations` (`src/lib/open-prs-rest.ts:679,737`) lists
the head's workflow runs, then — only for a run GitHub itself reports as **concluded** —
fetches that run's jobs:

```
// src/lib/open-prs-rest.ts:737-763 (fetchWorkflowRunObservations)
for (const run of runs) {
  ...
  if (!runHasConcluded(conclusion) || typeof run.id !== "number") { out.push({ conclusion }); continue; }
  let jobs: ... | undefined;
  try {
    const j = fetch(jobsForRunRestArgs(owner, repo, run.id)) as { ... };
    jobs = ...
  } catch {
    /* leave `jobs` undefined: "could not check", never "nothing was scheduled" */
  }
  out.push({ conclusion, jobs });
}
```

`jobsForRunRestArgs` is `["api", "repos/{owner}/{repo}/actions/runs/{runId}/jobs?per_page=100"]`
(`open-prs-rest.ts:721`). GitHub 404s that endpoint once a run's job/log data has aged out of
retention or the run was deleted, even while the run's own summary record (and therefore a stale
`statusCheckRollup` still cached on the PR) keeps reading as a live, unresolved check — this is
the EXACT "stalled run" shape `stalledRunReason` (`src/lib/sweep.ts:3713`) exists to name, cited
verbatim in `fetchWorkflowRunObservations`'s own doc comment as sharing its first clause. A PR
whose one pending check can never resolve is not hypothetical here: it is a named, documented
failure mode this codebase already built a detector for.

The catch around the jobs fetch is **completely silent** — no `console.error`, no `log(...)`
call, nothing. Its own comment says so: `/* leave jobs undefined: "could not check" ... */`. This
is why "every ledger step reports ok": this specific 404 has no ledger step to report to. It is
"a call whose failure is tolerated and never ledgered" by explicit design, not by omission.

**Fact 2 — the tolerated failure is still visible, because of how `fetch` is wired, not because
of anything in the catch above.** `hydrateWorkflowRuns`'s `fetch` parameter defaults to nothing —
the caller supplies it — and `buildOpenPrViews`'s own default is stated on the type
(`src/lib/open-prs-rest.ts:56`, "the real caller passes `ghJson`") and confirmed at the call site:

```
// src/run-task.ts:32908
const fetch = deps.fetch ?? ghJson;
```

`ghJson` (`src/lib/github-transport.ts:105-119`) is the SYNC path — it shells `gh` via
`execFileSync` with **no `stdio` option at all**:

```
// src/lib/github-transport.ts:115
const out = exec("gh", execArgs, { encoding: "utf8", maxBuffer: DEFAULT_GH_MAX_BUFFER, timeout: DEFAULT_GH_CALL_TIMEOUT_MS });
```

Every OTHER production `gh` call site in this codebase explicitly redirects `stdio`
(`ghExec(args, { stdio: ["ignore", "pipe", "pipe"], ... })` — `status.ts`, `daemon-health.ts`,
`github-posture.ts`, `feedback.ts`, `ops.ts`, `onboard/*.ts`, all confirmed by grep). `ghJson` is
the one production path that never does, and it cannot be told to: its `stdio` is not a
caller-configurable field, it is baked into the function body.

**This is a real, reproducible Node.js behaviour, not a guess** — run in this sandbox, twice, to
isolate the variable:

```
$ node -e '
const {execFileSync} = require("child_process");
try {
  execFileSync("bash", ["-c", "echo TOSTDOUT; echo TOSTDERR 1>&2; exit 3"], {encoding:"utf8"});
} catch (e) { console.log("stderr captured:", JSON.stringify(e.stderr)); }
' 2>captured-stderr.txt 1>captured-stdout.txt
$ cat captured-stdout.txt   # -> stderr captured: "TOSTDERR\n"
$ cat captured-stderr.txt   # -> TOSTDERR         <-- LEAKED to the real process stderr too
```

versus the SAME command with an explicit `stdio`:

```
$ node -e '... execFileSync(..., {encoding:"utf8", stdio:["ignore","pipe","pipe"]}) ...' \
    2>captured-stderr.txt 1>captured-stdout.txt
$ cat captured-stderr.txt   # -> (empty) — nothing leaked
```

`execFileSync` (which `ghJson` calls) inherits the child's stderr onto the parent's real stderr
by default UNLESS `stdio` is explicitly set — confirmed with `{encoding:"utf8"}` alone too, which
is exactly `ghJson`'s own shape. (The async sibling, `ghJsonAsync` via `execFileAsync`, does NOT
leak this way — confirmed separately — which is why this is specifically the SYNC `ghJson`
callers, not every `gh` read in the codebase.)

So: `gh api repos/{owner}/{repo}/actions/runs/{runId}/jobs` 404s for a stale, stalled run;
`hydrateWorkflowRuns`'s catch swallows the resulting exception with zero ledger/console footprint
of its own; but the CHILD PROCESS's own stderr — literally `gh`'s `"gh: Not Found (HTTP 404)"` —
was already written straight to the daemon's real stdout/stderr stream by Node, the instant the
`gh` child exited non-zero, before that exception was ever caught. The JS-level silence and the
OS-level noise are two different, uncoordinated things, which is exactly why a correctly-written,
correctly-tolerant catch block did not prevent this.

## WHY CORE DOES NOT

This read only fires for a PR whose `checksState` reads `"pending"` — `pendingPrs`
(`run-task.ts`, above) is empty on a healthy pass, and `hydrateWorkflowRuns`'s own doc says so
plainly: "a population that is usually empty." Core's queue clears fast enough (thousands of
merged PRs, per `MASTER-PLAN.md`'s own retro history) that its open PRs resolve their checks
before any workflow run behind them ages out of GitHub's retention — nothing sits "pending" long
enough to decay into a 404.

Site and console are the two instances the SAME day's sibling task (`W1-T3657`,
`origin: oper#dispatch-refusal-audit-2026-09-16`) measured as **structurally stuck**: the
console fleet re-attempted (and re-refused) `CONSOLE-T12` 1,232 times over 10.4 hours, and the
site fleet could dispatch NOTHING AT ALL ("4 OPEN FAILING OF 5 CHECKED"). A fleet whose dispatch
loop cannot advance is a fleet whose OTHER open PRs — whichever were already in flight before the
stuck task started monopolising every tick — are not being closed, merged, or re-driven either.
One of those PRs sitting open long enough for GitHub to age out a concluded run's job data is
exactly the shape `stalledRunReason` was built to catch, and it is a condition that needs TIME
stuck, not just an unlucky repo — which is precisely the asymmetry: core moves, site and console
do not, on the same day the rationale measured both.

## RULING

**Silence it at the transport, not per call site — the 404 itself is correct and already
tolerated; only its visibility is a defect, and it is a plumbing defect in exactly one function.**

- **Not "fix."** A workflow run's jobs 404ing after its data has aged out (or the PR's check
  genuinely stalled) is GitHub behaving correctly, and `hydrateWorkflowRuns`'s catch already
  treats it as the intended "could not check" outcome — the same discipline
  `readRequiredStatusCheckContexts` (`status.ts:3472`) documents for its OWN "404 on an
  unprotected branch" case. There is nothing wrong with the call failing.
- **Not "ledger."** This is a per-tick retry of a condition that, once true for a given run id,
  cannot become false — logging it every poll would trade one noise channel for another
  (`state/ledger.ndjson` growth) without telling an operator anything the FIRST occurrence
  didn't. `W1-T3622`'s own precedent (an unreachable shared-pause anchor, resolved once per sha
  rather than re-logged every tick) is the shape a repeat-safe fix here should follow if the
  stuck-PR condition itself is ever addressed — but that is a separate concern from this task's.
- **Silence, at `ghJson` itself.** `src/lib/github-transport.ts:115`'s real `exec("gh", execArgs,
  {...})` call is the ONE production `gh` invocation in this codebase that omits `stdio`. Giving
  it the SAME explicit, redirecting `stdio` every other production call site already carries
  (`["ignore", "pipe", "pipe"]`, matching `ghExec`'s own convention) fixes this at the layer that
  actually owns it — `ghJson` is the shared transport every one of its ~15 production call sites
  (per-PR `pr view`/hydration reads across `run-task.ts`, `sweep.ts`, `worker.ts`) already funnels
  through, so the fix does not depend on first pinning down which of those call sites is the exact
  one firing on any given host tonight. It also means a future `ghJson` caller inherits the safe
  default for free, instead of every new call site having to remember to opt out of a leak that
  should never have been the default in the first place.

## Follow-ups (out of scope for this recon)

- task: patch `ghJson`'s real `exec` default (`src/lib/github-transport.ts:115`) to pass an
  explicit, redirecting `stdio` (mirroring `ghExec`'s own convention) — this is the one-line fix
  the RULING above names, deliberately left undone here because this task's declared file is the
  recon doc alone.
- research: confirm on the live hosts (via `docker logs remudero-console-daemon | grep -B2 -A2
  'gh: Not Found'` correlated against that same second's `state/ledger.ndjson`) which specific PR
  and run id is stalled on site/console today — this recon identifies the MECHANISM and the
  call family with source-level certainty, but pinning the exact PR number needs a live read this
  sandbox does not have.
