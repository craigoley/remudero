# `src/lib/worker.ts` — comment forensics

Verbatim archive of the measured facts, incidents and design arguments that used to live in
`src/lib/worker.ts`'s comments. The source file keeps every invariant, trap, citation and directive
those comments carried, stated in fewer words; this page keeps the long-form record they cited, so the
code can give a rule in one sentence and point here for the forensics behind it.

Each section names the symbol the comment documented, gives the line range it occupied in
`src/lib/worker.ts` at merge-base `ea02cc83`, and reproduces the text **unedited** — its original
emphasis, wrapping and every figure it measured. Nothing here is a restatement.

Every comment block of six lines or more at that merge-base is archived below, in file order.

---

## the `node:fs` default import

`src/lib/worker.ts:15-25` at `ea02cc83`.

```
// Imported ADDITIONALLY as the module's DEFAULT export (a plain, mutable object), used
// ONLY by the run.lock read/write path below (writeRunLock/readRunLock/removeRunLock).
// ESM named-export bindings off `node:fs` are non-configurable (mock.method/
// defineProperty on them throws "Cannot redefine property"), so a test that spies on the
// real module -- the W1-T208 proof that a reader interleaved with the writer never
// observes a torn lock file -- cannot intercept a call already bound to a named import at
// load time. Calling `fs.writeFileSync(...)`/`fs.renameSync(...)` as a property access AT
// CALL TIME (never destructured to a local const) keeps those specific calls a live
// lookup an external `t.mock.method(fs, ...)` actually observes. Matches the identical,
// already-established doctrine atop src/lib/status.ts for the sibling W1-T207 task; the
// rest of this file's fs usage is untouched and keeps its existing named imports.
```

## TokenUsage

`src/lib/worker.ts:111-116` at `ea02cc83`.

```
/**
 * Aggregate token usage off the SDK result envelope's `usage` field (verified
 * ground truth, SDK 0.3.209 `sdk.d.ts`: `NonNullableUsage`, itself `BetaUsage`
 * with ALL fields non-nullable — snake_case Anthropic-API names). Zeroed when
 * no result envelope was ever seen (a genuine transport failure).
 */
```

## numTurns

`src/lib/worker.ts:141-171` at `ea02cc83`.

```
  /**
   * Turns the worker actually took (SDK `num_turns` off the result envelope).
   * Recorded on BOTH success and error paths — a run's turn count is telemetry
   * that seeds mounts.yaml calibration (W1-T5), so a failed run is never `0`.
   *
   * W1-T303 GROUND TRUTH: `num_turns` is NOT guaranteed to count the same unit
   * `Options.maxTurns` bounds. sdk.d.ts documents `maxTurns` precisely
   * ("Maximum number of conversation turns before the query stops. A turn
   * consists of a user message and assistant response.") but gives `num_turns`
   * on `SDKResultSuccess`/`SDKResultError` no counting rule at all beyond the
   * bare type `number` — treating the two as interchangeable was always an
   * ASSUMPTION, not something the contract promises. MEASURED over every
   * `recon.done` row for 2026-08-03 under a single hardcoded `maxTurns: 8`:
   * eleven `error_max_turns` failures, across both routed models, every one
   * landing at EXACTLY `num_turns: 9` (cap+1 — consistent with one extra
   * wrap-up turn closing out the error envelope after the cap trips), and one
   * SUCCESS at `num_turns: 17` — nearly double the cap, with no error and no
   * resume/retry involved (recon's retry, W1-T299, always issues a brand-new
   * `query()` call with no `.resume`, never carries a turn count over). A
   * `num_turns` this far past the cap on a clean success means whatever the
   * CLI enforces `maxTurns` against is not simply "the same counter `num_turns`
   * reports" — the leading, falsifiable-but-unverified account is that a
   * mid-run compaction (already detected here as `compactionEvents`) resets
   * the CLI's own enforcement window while `num_turns` keeps a cumulative,
   * whole-session tally; this diagnosis did not confirm that mechanism (it
   * would require inferring from the ledger, which is the same evidence class
   * the puzzle came from) and files it as a follow-up rather than asserting
   * it. Either way: `numTurns` alone cannot be reasoned about against a cap
   * unless the cap it actually ran under rides the SAME row — see `maxTurns`
   * below, which does exactly that.
   */
```

## maxTurns

`src/lib/worker.ts:173-182` at `ea02cc83`.

```
  /**
   * W1-T303: the `maxTurns` THIS call was CONFIGURED with (from
   * `SpawnWorkerArgs.maxTurns`) — an INPUT, never a read-back off the
   * envelope, mirroring the `model`/`effort` discipline below. Ledgered
   * BESIDE `numTurns`/`num_turns` (never replacing it) precisely so a ledger
   * row can be checked against its own cap without cross-referencing
   * `mounts.yaml`, which changes over time and had already moved
   * (`RECON_MAX_TURNS` 8 → 20) by the time this mismatch was diagnosed —
   * `undefined` (never guessed) when the caller configured no cap.
   */
```

## apiError

`src/lib/worker.ts:193-199` at `ea02cc83`.

```
  /**
   * An Anthropic-SIDE api error hit the stream (a `<synthetic>`/`isApiErrorMessage`
   * "API Error: Server error mid-response" message), which the result ENVELOPE may still
   * report as subtype:"success" (WS-0 envelope shape). This is a TRANSIENT signal for the
   * classifier (retry, no strike) — NOT a task failure. Run W1-T12a-1784117152056 lost this
   * because nothing captured it and the classifier was never wired.
   */
```

## usageRefusal

`src/lib/worker.ts:201-217` at `ea02cc83`.

```
  /**
   * W1-T2564: THE ACCOUNT REFUSED THIS RUN FOR A SESSION/USAGE LIMIT. Same shape and same reason
   * as {@link apiError} directly above — a condition the result ENVELOPE misreports as
   * `subtype: "success"`, so a distinct field is the only place it can survive.
   *
   * THE SDK EMITS A SUCCESS ENVELOPE AND THEN THROWS. `collectWorkerResult`'s catch already
   * swallows that throw (the envelope is real and captured) and sets `isError`, but `subtype` was
   * written by the success envelope BEFORE the throw and nothing rewrites it — so
   * {@link workerLedgerFields}'s `r.isError ? r.subtype : "success"` resolves BOTH arms to
   * "success" and the refusal is erased. MEASURED over the three-form union: 793 rows across five
   * rungs recorded `verdict: "success"` for a run the account had refused, 775 of them
   * `inbox.draft_synthesized`.
   *
   * NOT DERIVED FROM COST. 768 of 1,022 draft rows carried `cost_usd: 0` and every one was a
   * refusal — but SEVEN refusals carried a NON-ZERO cost, so the two sets are not equal and a
   * price test both misses those and catches genuinely free runs.
   */
```

## accountLabel

`src/lib/worker.ts:223-231` at `ea02cc83`.

```
  /**
   * W1-T268: the Anthropic account this call's spend is attributed to — the SAME
   * `accountUuid`/`emailAddress` NAME (never a secret) {@link resolveActiveAccountId}
   * resolves and W1-T265's `ensureWorkerKeychain` already compares for identity
   * drift. Resolved fresh per spawn, regardless of platform, so every ledger line
   * carrying a spend figure can also carry the account it was drawn against.
   * `undefined` when no identity could be resolved (e.g. no `~/.claude.json`) —
   * never guessed.
   */
```

## servedModel

`src/lib/worker.ts:255-278` at `ea02cc83`.

```
  /**
   * W1-T2572 (THE SERVED HALF OF THE PAIR): the concrete model id the PROVIDER itself
   * reported serving this call — on the Claude path, read verbatim off the live SDK
   * assistant stream's own `msg.message.model` field (never the `modelUsage` map keys,
   * which are a post-hoc cost breakdown, not a live per-turn report), the LAST real
   * (non-`<synthetic>`) value seen before the stream ended. `model` above is the
   * REQUEST — an INPUT, mount-resolved BEFORE the spawn, unchanged by whatever the
   * provider actually ran. The two ride the SAME row so a run where they disagree (a
   * routed alias resolving to a different concrete snapshot, a Codex account serving
   * off its own preference list) is directly queryable without a second join, and a
   * later per-mount aggregate never silently averages across models it never named.
   *
   * `null` when the provider's own output carried no field naming what it served —
   * paired with {@link servedModelReason}. VERIFIED, not assumed: `codex exec --json`
   * (codex-cli 0.152.0) was probed live and its `thread.started` / `turn.started` /
   * `turn.completed` / `item.completed` / `error` events carry no served-model field at
   * all, so the Codex path records this pair honestly rather than echoing back the
   * `--model` flag it was given — echoing the ASK back as the SERVED value is exactly
   * the guess this field exists to refuse.
   *
   * Optional only so every hand-built `WorkerResult` fixture across test/ that predates
   * this task keeps typechecking unmodified; {@link workerLedgerFields} treats an absent
   * value identically to an explicit `null`.
   */
```

## compactionEvents

`src/lib/worker.ts:286-291` at `ea02cc83`.

```
  /**
   * Compaction events observed in this call's stream (MASTER-PLAN §8B),
   * detected LIVE off `type:"system", subtype:"compact_boundary"` messages
   * (`detectCompactionEvents`, compaction.ts) — `[]` when the call never
   * compacted.
   */
```

## compactionFailures

`src/lib/worker.ts:293-310` at `ea02cc83`.

```
  /**
   * `true` the moment ONE compaction fired (`compactionEvents.length > 0`,
   * MASTER-PLAN §8B) — this call's acceptance proofs must be re-verified
   * against repo state (W1-T3F), never trusted from a possibly-lossy REPORT.
   */
  /**
   * W1-T2245: compaction ATTEMPTS that FAILED — read off the SDK's `compact_result: 'failed'`
   * channel (`SDKStatusMessage`, sdk.d.ts:4684), which carries NO `compact_boundary` message and so
   * was previously invisible to `compactionEvents`/`qualitySuspect` entirely: an attempted-and-
   * failed compaction read identically to one that never happened. `[]` when no failure was seen —
   * same "empty means checked, not absent" discipline as `compactionEvents` itself. Deliberately
   * NOT folded into `qualitySuspect`: a FAILED attempt compacted nothing, so the call's content is
   * no more suspect than before — `qualitySuspect` keeps its exact current meaning (fires ONLY off
   * a real boundary), per this task's own constraint that existing compaction fields are untouched.
   * Optional (never `[]`-by-force) purely so the dozens of hand-built `WorkerResult` fixtures across
   * test/ that predate this task keep typechecking unmodified — `workerLedgerFields` below treats an
   * absent value as `[]`, identical to what a real `collectWorkerResult` call always returns.
   */
```

## compactionConfigured

`src/lib/worker.ts:312-328` at `ea02cc83`.

```
  /**
   * W1-T2245: whether THIS spawn's `Options` object carried `autoCompactEnabled: true` — the row's
   * answer to "was auto-compaction even possible here", so `quality_suspect: false` +
   * `compactionEvents: []` can be read as NEVER-NEEDED (configured, never fired) rather than
   * guessed to mean the same thing as DISABLED (never configured at all). Read off `options`
   * itself at the spawn call site (never a second source), via an index/`in` check rather than a
   * property access: `Options` (sdk.d.ts 0.3.233 ground truth) declares NO `autoCompactEnabled` key
   * at all — that lives only on the separate `Settings` interface, reachable only through a loaded
   * settings file, and `spawnWorker` always passes `settingSources: []`. So this reads `false` on
   * every call today, and that IS the finding this task exists to ledger: the fleet has no live
   * channel to turn auto-compaction on, and the zero was previously silent about it. This task
   * adds NO key to `options` — it only reads whatever is already there, so a future spawn path
   * that legitimately sets the option (not this one) is picked up rather than needing this call
   * site edited. Optional for the SAME reason `compactionFailures` above is: existing hand-built
   * `WorkerResult` fixtures across test/ keep typechecking unmodified; `workerLedgerFields` treats
   * an absent value as `false`, identical to what a real `collectWorkerResult` call always returns.
   */
```

## workerDurationMs

`src/lib/worker.ts:337-347` at `ea02cc83`.

```
  /**
   * W1-T477: wall-clock milliseconds this call spent inside the actual SDK query — measured in
   * {@link collectWorkerResult}, around the message-consumption loop that IS the worker call
   * (excludes the pre-spawn setup above it in {@link spawnWorker}: config load, worker-home
   * materialization, keychain unlock — all local/free per that function's own "impl-EM" comment).
   * Optional, never guessed: a hand-built `WorkerResult` fixture (every existing test helper in
   * test/) simply omits it, and `workerLedgerFields` renders it absent rather than 0 on a call
   * that was never really timed. Answers the operator's fourth analytics question ("time per
   * command/worker") — before this field, `workerLedgerFields` carried cost/tokens/model/effort
   * and no duration at all (see the rationale this task was filed from).
   */
```

## BILLING_MODE

`src/lib/worker.ts:362-368` at `ea02cc83`.

```
/** The DEFAULT billing mode: absent the opt-in overflow valve, `buildWorkerEnv`
 * strips every `ANTHROPIC_*` var before a worker spawns (W1-T1), so the run is
 * metered against the subscription. When the operator engages the valve (exports
 * `ANTHROPIC_API_KEY`, W1-T258) the mode is instead DERIVED per-call from the
 * child's actual key set via {@link billingMode}(`childEnvKeys`) — a ledger line
 * still can never drift from the true boundary because it reads the very env
 * names the worker spawned with, not a guess. */
```

## cacheTokenLedgerFields

`src/lib/worker.ts:371-382` at `ea02cc83`.

```
/**
 * Cache-token NAMED COLUMNS (MASTER-PLAN §8A / W1-T35): the aggregate
 * `tokens.cacheRead`/`cacheCreation` (camelCase, nested inside `tokens`)
 * mirrored as FLAT, snake_case columns matching the SDK result envelope's own
 * field names (`cache_read_input_tokens`/`cache_creation_input_tokens`). A
 * ledger line's other telemetry (`cost_usd`, `num_turns`, …) is already flat
 * snake_case — the nested `tokens` object was the odd one out and not
 * grep/jq-able as a "column". This makes the cache-reuse signal MASTER-PLAN
 * §8A calls for ("near-zero cache reads on the second worker of a run means
 * the ordering is wrong") directly queryable off a worker's ledger line
 * without reaching into a nested object.
 */
```

## STDERR_EXCERPT_CAP

`src/lib/worker.ts:393-401` at `ea02cc83`.

```
/**
 * Persisted-stderr length ceiling (W1-T238, the "Not logged in" incident): the
 * child's stderr and any swallowed error-result text lived only in
 * `stderrChunks`/`text` in memory and were discarded once the spawn returned —
 * two production spawns failed and the one artifact that named the cause had
 * to be reconstructed by a repro instead of read off disk. This bounds the
 * PERSISTED copy so a runaway transcript cannot bloat the ledger; it never
 * bounds what stays in-memory on {@link WorkerResult} itself.
 */
```

## workerFailureExcerpt

`src/lib/worker.ts:410-415` at `ea02cc83`.

```
/**
 * The capped, ledger-safe excerpt of a FAILED spawn's stderr + error-result
 * text (W1-T238). Returns `undefined` for a clean spawn (`isError=false`) or
 * one with nothing to say, so a success line never carries this field — a
 * clean spawn must not spam the ledger with an empty/absent excerpt.
 */
```

## REPORT_EXCERPT_CAP

`src/lib/worker.ts:422-428` at `ea02cc83`.

```
/**
 * Persisted-report length ceiling (W1-T407) — the SAME discipline as {@link STDERR_EXCERPT_CAP}
 * applied to a different string: a terminal-SUCCESS worker's own closing narrative instead of a
 * failed spawn's stderr. Not a new design problem, just this mechanism applied to the text the
 * SILENT NO-OP GUARD in run-task.ts already parses three times (decision request, PR url,
 * already-satisfied claim) and, until now, dropped once no PR came out of it.
 */
```

## workerTranscript

`src/lib/worker.ts:431-448` at `ea02cc83`.

```
/**
 * W1-T2205: THE ONE JOIN, ONE PLACE. `text` is documented as "Final result text (the `result`
 * field of the SDK result message)"; `blocks` is "All assistant text blocks concatenated, in
 * order" — and `collectWorkerResult` (worker.ts's result loop) pushes EVERY assistant text
 * block onto `blocks`, THEN sets `text = r.result` off the terminal envelope. If the SDK's
 * `result` is itself an echo of the last assistant text block (measured true for a real
 * captured envelope — see this task's PR body for the citation either way), a hand-rolled
 * `[r.text, r.blocks.join("\n")].join("\n")` carries the worker's final message TWICE. Every
 * count-sensitive parse over that join (OPTION: lines, verdict markers, …) then silently
 * over-counts — this function exists so that never happens more than once.
 *
 * Contract: SAME shape and ordering as the hand-rolled `[r.text, r.blocks.join("\n")].join("\n")`
 * it replaces — `text` first, then `blocks` in their own chronological order — with the final
 * message appearing EXACTLY ONCE. When `blocks`'s own last entry is not simply a repeat of
 * `text` (the overlap does not hold, or `blocks` is empty), nothing is dropped; every existing
 * call site's "last marker line wins" parsing therefore sees the identical text it always did,
 * minus the duplicate.
 */
```

## noPrReportExcerpt

`src/lib/worker.ts:455-461` at `ea02cc83`.

```
/**
 * The capped, ledger-safe excerpt of a worker's own report — `text` + `blocks` joined, the
 * same shape run-task.ts's local `fullText` closure already builds for every parse at that
 * call site. Returns `undefined` for empty/whitespace-only input, so a truly silent no-op
 * (nothing said, nothing committed) never carries a blank/empty field on its ledger row — the
 * same "absent, never empty" discipline {@link workerFailureExcerpt} already keeps for stderr.
 */
```

## workerLedgerFields

`src/lib/worker.ts:468-519` at `ea02cc83`.

```
/**
 * The standard per-call ledger telemetry (W1-T6 acceptance): every worker AND
 * brain-plane (architect/reviewer) call logs `{model, effort, tokens,
 * cache_read_input_tokens, cache_creation_input_tokens, total_cost_usd,
 * billing_mode, verdict}`. Extracted so every call site in run-task.ts spreads
 * the SAME shape rather than hand-rolling it — one definition, so the fields
 * can never drift between recon/implement/review/retro.
 *
 * `verdict` here is this CALL's own outcome (`"success"` or the SDK's error
 * subtype) — distinct from the RUN-level `verdict` ledger line (merged /
 * blocked_* / failed), which judges the whole run, not one worker spawn.
 *
 * `quality_suspect`/`compaction_events` (MASTER-PLAN §8B / W1-T36) ride the
 * SAME line as `verdict` — a compacted call's ledger line is directly
 * queryable/grep-able for both its outcome and whether that outcome should
 * be trusted, with no join against a separate compaction event stream.
 *
 * `stderr_excerpt` (W1-T238) rides the same line, capped via
 * {@link workerFailureExcerpt} — present ONLY when `r.isError`, so the run's
 * own ledger (keyed by `run_id`/`task_id` at every existing call site) is the
 * recoverable-after-the-fact home for the stderr that used to die with the
 * process, never a second, uncapped surface.
 *
 * `max_turns` (W1-T303) rides the same line for the SAME reason `quality_suspect`
 * does: every call site already logs `num_turns: r.numTurns` by hand next to this
 * spread, and `num_turns` alone cannot be reasoned about against a cap that lives
 * only in `mounts.yaml` — a value that moves over time (`RECON_MAX_TURNS` itself
 * moved 8 → 20 the same day this mismatch was found). Ledgering the cap THIS call
 * was configured with, beside `num_turns` rather than replacing it, means every
 * historical row stays checkable against its own cap forever, independent of
 * whatever mounts.yaml says today.
 *
 * `compaction_configured`/`compaction_failures` (W1-T2245) ride the SAME line for the SAME
 * reason: a reader of `quality_suspect: false` / `compaction_events: []` could not previously
 * tell DISABLED (compaction never configured) from NEVER-NEEDED (configured, just never fired)
 * from FAILED (attempted, and the SDK's own `compact_result: 'failed'` channel went unread). All
 * three now ride this one line, so the zero explains itself without a second query.
 *
 * `served_model`/`served_model_reason` (W1-T2572) ride the SAME line beside `model` for the
 * reason {@link WorkerResult.servedModel}'s own doc gives in full: `model` is the REQUEST (an
 * alias like `sonnet`, resolved before the spawn), `served_model` is what the provider actually
 * ran, and only logging both on the SAME row lets a later reader see the two disagree instead of
 * silently collapsing them into one label. ALWAYS present (never omitted, unlike the optional
 * fields above) — defaulted to `null` off an absent `r.servedModel` so a fixture that predates
 * this task, or a provider that reports nothing, renders the SAME honest "unknown" a real
 * unreportable call would, never a key that looks forgotten. `served_model_reason` rides beside
 * it ONLY when the id is `null`, falling back to a generic "provider reported no served model"
 * when `r.servedModelReason` itself was not set (the Codex path today: {@link spawnCodexWorker}
 * sets neither field, verified empirically against codex-cli 0.152.0's `--json` event stream) —
 * fail-soft per this task's own constraint: an unreportable served model must never fail the run,
 * so this function itself never throws over a missing one.
 */
```

## workerLedgerFields — verdict

`src/lib/worker.ts:588-597` at `ea02cc83`.

```
    // W1-T2564: A REFUSAL OUTRANKS THE ENVELOPE'S OWN SUBTYPE. The previous form was
    // `r.isError ? r.subtype : "success"` — right in intent ("when this errored, name the error")
    // and defeated by the data: on the swallow path `subtype` was written by a SUCCESS envelope
    // seen BEFORE the SDK threw, so `isError` was true, `subtype` was "success", and BOTH arms
    // rendered "success". 793 refusals across five rungs were recorded as completed work.
    //
    // CHECKED FIRST, not folded into the ternary, because the ordering IS the fix: the envelope's
    // subtype is exactly the field that lies here, so a refusal must not consult it. Every other
    // path is byte-identical to before — `recon.done`'s `error_max_turns` (an envelope that DID
    // name its error) still renders `error_max_turns`, and a clean run still renders "success".
```

## workerHomeReapLogFields

`src/lib/worker.ts:637-652` at `ea02cc83`.

```
/**
 * W1-T2441: the fields the previously-discarded {@link WorkerHomeReapResult} becomes once
 * observed — target/reason/spawn-identity, named so a query over them can answer the falsifier
 * this task's own filing could not close ("a `worker-home-DAEMON-<runid>` removal racing a live
 * sibling spawn — a reap and a still-running child on the same path, both timestamped").
 *
 * Pure — {@link spawnWorker}'s `finally` is the only real caller and the default sink
 * ({@link defaultLogHomeReap}) is a thin `console.error` wrapper around this, so a test can drive
 * every arm (`guard-rejected` / `absent` / reaped-true / a caught error) with no process spawned.
 *
 * NOT a ledger row: this module writes no ledger rows by design (see `workerLedgerFields`'s own
 * "carried on the RESULT rather than logged here" note above `lostGrants`) — reap visibility is
 * diagnostic-only and, per this task's own filing, deliberately does NOT belong in
 * `DECISION_RELEVANT_LEDGER_STEPS`: nothing downstream reads it to decide anything, so adding it
 * there would widen this change's span for nothing.
 */
```

## workerKeychainHeadroomLogFields

`src/lib/worker.ts:673-687` at `ea02cc83`.

```
/**
 * W1-T2518: the fields `ensureWorkerKeychain`'s {@link WorkerKeychainSummary} becomes once
 * observed at THIS call site — `observedHeadroomMs` (worker-home.ts:1080) existed since
 * W1-T2398 but this call site previously discarded the whole summary, chaining `.keychainPath`
 * directly off the call and reading nothing else (`git grep -n '= ensureWorkerKeychain(' src/`
 * read one hit, `.keychainPath` chained straight off it, before this task). Logged on EVERY
 * darwin provisioning call, `expectedRunMs` supplied or not, so the rate the credential's
 * expiry margin is actually exercised becomes answerable off-host — worker-home.ts's own doc
 * names this exact gap ("the rate this shard's own rationale could not measure from a ledger
 * becomes answerable off-host purely by a caller logging this field").
 *
 * Pure — {@link spawnWorker}'s darwin branch is the only real caller and the default sink
 * ({@link defaultLogKeychainHeadroom}) is a thin `console.error` wrapper around this, matching
 * `workerHomeReapLogFields`'s identical discipline just above.
 */
```

## CLAUDE_BIN_ENV_OVERRIDE

`src/lib/worker.ts:713-730` at `ea02cc83`.

```
// ── Toolchain resolution (W1-T113: the vanished-binary incident) ───────────
//
// `config.claudeBin` is resolved ONCE via `which claude` when
// `~/.config/remudero/config.json` is first created (config.ts's
// `resolveClaudeBin`) and then CACHED TO DISK — exactly the "pinned while the
// toolchain self-updates" shape the incident hit: a Claude Code auto-update
// (or a manual migration off npm — the upstream README now reads "Installation
// via npm is deprecated", verified via `gh api repos/anthropics/claude-code`
// since this checkout has no network path to the hosted setup docs, distrust
// this prompt's memory / Standing rule 7) can move the real binary out from
// under that cached path mid-operation. Resolution below runs FRESH at spawn
// time instead, in priority order: an explicit operator override, a live PATH
// lookup, then the known install-location table — never the stale disk cache
// alone. Cached PER PROCESS once resolved (see `ClaudeExecutableCache`), and
// PREFLIGHT-checked (exists AND runs `--version`) before ever reaching the
// SDK, so a bad resolution fails loud — before any worker-home/keychain work
// runs — rather than surfacing deep inside a spawn as "native binary not
// found" (MASTER-PLAN Field Finding 12).
```

## ClaudeExecutableCandidate

`src/lib/worker.ts:735-741` at `ea02cc83`.

```
/**
 * One row of the install-location table — DATA (W1-T113 acceptance: "the
 * location table is data" — adding a row here resolves a newly seeded
 * location with ZERO resolution-code changes). `resolve` returns `undefined`
 * when a row does not apply; a row that DOES apply is still existence- and
 * runnability-checked like every other candidate, never trusted blind.
 */
```

## CLAUDE_EXECUTABLE_LOCATIONS

`src/lib/worker.ts:748-757` at `ea02cc83`.

```
/**
 * The known Claude Code install locations. Verified from the upstream repo
 * rather than trusted from memory (Standing rule 7): `gh api
 * repos/anthropics/claude-code` — README.md ("Installation via npm is
 * deprecated") + CHANGELOG.md, whose 2.1.143 and 2.1.207 entries both name
 * `~/.local/bin/claude` as the native-installer launcher the auto-updater
 * manages, distinct from the (deprecated but still real, and this fleet's own
 * current install method — MASTER-PLAN Field Finding 3) npm-global prefix.
 * Order matters: the FIRST existing+runnable candidate wins.
 */
```

## ClaudeToolchainBlockedError

`src/lib/worker.ts:796-804` at `ea02cc83`.

```
/**
 * Structured refusal (W1-T91 classification: infrastructure, never a task
 * defect) thrown when NO candidate resolves to an existing, runnable
 * executable. Carries every searched path — distinguishing "missing" from
 * "exists but `--version` failed" — so the refusal reason is never a bare
 * "not found". `reasonClass` is a plain string tag (not `instanceof`) so a
 * caller in a different module (daemon.ts) can classify this duck-typed,
 * without importing this class as a value.
 */
```

## ResolveClaudeExecutableDeps

`src/lib/worker.ts:828-833` at `ea02cc83`.

```
/**
 * Injectable seams for `resolveClaudeExecutable` — the real call site defaults
 * every one of these to the live filesystem/PATH/subprocess; tests inject
 * fakes so "pinned path absent, table hit" and "everything absent" are
 * provable over injected fs/exec, with no real binary involved.
 */
```

## canExecute

`src/lib/worker.ts:844-850` at `ea02cc83`.

```
  /**
   * Does this path actually run? (`--version`.) `true` on success, kept as
   * cheap as ever. A failure may answer a bare `false` (every existing
   * injection site does this, and stays valid unchanged — W1-T901 design (i))
   * or a `CanExecuteFailure` carrying the probe's cause for the refusal
   * message to render.
   */
```

## resolveClaudeExecutable

`src/lib/worker.ts:895-905` at `ea02cc83`.

```
/**
 * Resolve the real `claude` binary at SPAWN time (W1-T113 part i): an
 * explicit env override, then a live PATH lookup, then the location table —
 * in that order, memoized in `cache` once an answer is found. Every candidate
 * is PREFLIGHTED (W1-T113 part ii: exists AND runs `--version`) before being
 * accepted; a candidate that exists but won't run is recorded as such in the
 * refusal, distinct from one that's simply missing. Throws
 * `ClaudeToolchainBlockedError` (never a raw ENOENT) when nothing resolves,
 * naming every searched path — the run is refused cleanly rather than
 * crashing on a bare `ENOENT` deep inside the SDK's spawn.
 */
```

## claudeExecutableCache

`src/lib/worker.ts:947-953` at `ea02cc83`.

```
/**
 * The shared, PER-PROCESS cache every real `spawnWorker` call reuses (see
 * `ClaudeExecutableCache`'s doc). Exported so the daemon's boot routine can
 * resolve — and log — the SAME answer once at startup rather than a separate,
 * possibly-different resolution (W1-T113 part i: "log the resolved path once
 * at daemon boot").
 */
```

## workerKeychainGrantApps

`src/lib/worker.ts:956-964` at `ea02cc83`.

```
/**
 * Pure: the macOS keychain grant list (W1-T113) — the FRESHLY resolved `claudeBin`
 * (never `config.claudeBin`'s stale disk-cached value, exactly the vanished-binary
 * incident's shape) plus the fixed `/usr/bin/security` helper every worker keychain
 * grant needs. Extracted so this one-line assembly is unit-testable directly, without
 * invoking `ensureWorkerKeychain` (a real keychain side effect) or gating a test on
 * `process.platform` (spawnWorker's darwin-only call site, below, is untestable off
 * a Linux CI runner by construction).
 */
```

## resolveActiveAccountId

`src/lib/worker.ts:969-984` at `ea02cc83`.

```
/**
 * W1-T265: the Anthropic account identity active on this host — an
 * `accountUuid`/`emailAddress` NAME, read fresh (never cached) from
 * `~/.claude.json`'s `oauthAccount` block, forwarded to `ensureWorkerKeychain`'s
 * `accountId` opt so an account switch is detected. Deliberately NOT the copied
 * worker keychain item's own `acct` attribute — account-usage.ts measured that
 * value to be the OS username, identical before and after an Anthropic account
 * switch, so it cannot discriminate accounts.
 *
 * A private, minimal re-implementation rather than importing account-usage.ts's
 * own `readAccountUsageFile`: that module already depends on panel-actions.ts,
 * which depends on THIS file (`appendQuestionAnswer`) — importing it here would
 * close that into an import cycle. Fails soft to `undefined` on any read/parse
 * error or unexpected shape, matching account-usage.ts's own fail-soft doctrine:
 * this must never throw and never block a spawn.
 */
```

## WORKER_USAGE_PROJECTION_REL

`src/lib/worker.ts:999-1007` at `ea02cc83`.

```
/**
 * W1-T2516: `<root>/state/account-usage-projection.json` — MUST resolve to the SAME relative
 * path as account-usage.ts's own `USAGE_PROJECTION_REL`. Duplicated here (not imported) for the
 * SAME reason `resolveActiveAccountId` above re-implements account-usage.ts's own file-reading
 * rather than importing it: account-usage.ts already depends on panel-actions.ts, which depends
 * on THIS file — an import here would close that into a cycle.
 * test/the-headroom-gate-reads-a-file-the-fleet-never-refreshes.test.ts asserts the two
 * literals stay equal, so they cannot drift apart silently.
 */
```

## captureWorkerUsageProjection

`src/lib/worker.ts:1010-1035` at `ea02cc83`.

```
/**
 * W1-T2516: THE FIX. Every worker's HOME is redirected to a Remudero-controlled scratch dir
 * (worker-home.ts), so the `cachedUsageUtilization` a worker's OWN Claude Code invocation
 * refreshes lands inside `<workerHome>/.claude.json` — and `reapWorkerHome` (below, in
 * `spawnWorker`'s `finally`) deletes that whole directory moments later. Nothing in remudero
 * ever wrote the account-usage panel's PRIMARY source, `homedir()/.claude.json`, so on a
 * headless fleet host that file's `cachedUsageUtilization` never refreshes at all (see
 * account-usage.ts's module header for the full argument).
 *
 * Called from `spawnWorker`'s `finally`, BEFORE `reapWorkerHome` runs, so the read happens
 * while `<workerHome>/.claude.json` still exists. Reads ONLY the same six-field slice
 * account-usage.ts's own `readAccountUsageFile` projects `~/.claude.json` down to (this is a
 * private, minimal re-implementation of that projection for the SAME reason
 * `resolveActiveAccountId` above is one — no import path exists that avoids a cycle), then
 * persists a narrower cut of it — `accountUuid`/`fetchedAtMs`/the two usage windows,
 * DELIBERATELY NEVER `email`/`org`/anything OAuth-shaped — to
 * `<root>/state/account-usage-projection.json`. Written via a temp-file-then-`renameSync` swap
 * so a concurrent reader (the console's `GET /v1/account-usage`) can never observe a
 * half-written file.
 *
 * BEST-EFFORT AND SILENT, matching every other piece of this teardown: an absent/unreadable
 * `.claude.json` (a spawn that died before the CLI ever wrote one), a payload carrying no
 * usable `cachedUsageUtilization.fetchedAtMs`, or a write failure are all simply skipped —
 * never thrown, never blocking the teardown this runs inside of. Returns whether a projection
 * was actually written, so a test can assert on it directly rather than re-reading the file.
 */
```

## disallowedTools

`src/lib/worker.ts:1092-1101` at `ea02cc83`.

```
  /**
   * W1-T2591: tool names this spawn is never offered, threaded to the SDK's own
   * `Options.disallowedTools`. NOT the settings `deny` list, deliberately: that floor is enforced
   * by a hook, and this repo's own {@link DenyFloorVerdict} exists because the block can LEAK
   * under `bypassPermissions` (claude-code#20946) and needs a `dontAsk` re-probe to catch it. A
   * disallowed tool is never presented to the model at all, so there is no check to race.
   *
   * The default is UNRESTRICTED — every existing caller spawns exactly as before. Only a lane
   * that has shown it needs no mutation passes this.
   */
```

## tools

`src/lib/worker.ts:1138-1144` at `ea02cc83`.

```
  /**
   * Restrict the model's base built-in tool set (SDK `Options.tools`). Unset
   * ⇒ the SDK default (all Claude Code tools). Pass e.g. `["Bash"]` to make a
   * worker read-only BY CONSTRUCTION — Write/Edit/NotebookEdit/MultiEdit are
   * never in the model's context, so it cannot use one even if asked
   * (isolation.ts's preflight probe, W1-T17).
   */
```

## claudeExecutable

`src/lib/worker.ts:1146-1152` at `ea02cc83`.

```
  /**
   * W1-T113: override the toolchain-resolution cache/seams — same injection
   * convention `config` above already follows. Omitted ⇒ the shared,
   * PER-PROCESS `claudeExecutableCache` and live fs/PATH/subprocess (the real
   * spawn path); tests can inject a fresh cache + fakes here instead of
   * reaching into the module-level singleton.
   */
```

## keychain

`src/lib/worker.ts:1154-1162` at `ea02cc83`.

```
  /**
   * W1-T113: override the darwin-only keychain-provisioning gate/seams —
   * same injection convention as `config`/`claudeExecutable` above. Omitted
   * ⇒ the real `process.platform` and `ensureWorkerKeychain`'s own live
   * `security(1)`/fs defaults. Tests inject `platform: "darwin"` plus a fake
   * `runner`/`exists` (matching `ensureWorkerKeychain`'s OWN existing
   * injectable seams, worker-home.ts) to exercise this gate deterministically
   * off a non-macOS CI runner, with no real keychain touched.
   */
```

## SpawnWorkerArgs — readCredentialFile

`src/lib/worker.ts:1167-1172` at `ea02cc83`.

```
    /**
     * recon-cloud-workers-spike stop 6: injectable reader for the NON-DARWIN credential file,
     * mirroring `runner`/`exists` above. Omitted (the production default) reads the real file
     * with `readFileSync` — and the suite drives that default against real fixture files, because
     * a test that only ever supplies its own reader proves nothing about the shipping path.
     */
```

## SpawnWorkerArgs — accountId

`src/lib/worker.ts:1174-1184` at `ea02cc83`.

```
    /**
     * W1-T265: the active Anthropic account identity for THIS spawn — an
     * `accountUuid`/`emailAddress` NAME, never a secret — forwarded to
     * `ensureWorkerKeychain`'s `accountId` opt so an account switch under the
     * unlabelled default store re-provisions instead of silently spending the
     * stale copy. Omitted ⇒ resolved fresh, per spawn, by this file's own
     * `resolveActiveAccountId` (never from the keychain's own `acct` attribute —
     * account-usage.ts measured that to be the OS username, identical across an
     * account switch). Tests inject a fixed value here to exercise the gate
     * without touching the real `~/.claude.json`.
     */
```

## SpawnWorkerArgs — priorSpawnCredentialExpired

`src/lib/worker.ts:1186-1194` at `ea02cc83`.

```
    /**
     * W1-T293 arm (3): set when the PRIOR spawn died on the containment preflight's
     * expiry-named reason (W1-T292's `spawn_credential_expired`, once that task wires
     * it through this call site) — forces `ensureWorkerKeychain` to re-provision even
     * when its own before-the-fact sidecar check (worker-home.ts's `expiryPath`) saw
     * nothing wrong. NOT YET WIRED to any containment token here (W1-T292 hasn't
     * shipped one to consume) — this is the hook a future caller sets; omitted ⇒
     * unchanged behavior, matching every other opt-in seam in this block.
     */
```

## SpawnWorkerArgs — expectedRunMs

`src/lib/worker.ts:1196-1209` at `ea02cc83`.

```
    /**
     * W1-T2518: the dispatcher's own run-length estimate, forwarded VERBATIM to
     * `ensureWorkerKeychain`'s `expectedRunMs` (worker-home.ts) — the option W1-T2398 shipped
     * with ZERO callers (`git grep -n expectedRunMs origin/main -- src/` read 9 hits, all
     * inside worker-home.ts itself — the declaration, its docs, and its two use sites — and
     * none a caller). This is that first caller. Omitted ⇒ byte-identical behavior, matching
     * `expectedRunMs`'s own doc ("never derived in here") — this call site is where a real
     * estimate belongs, never invented inside worker-home.ts. Supplied, it widens the
     * effective expiry skew and, after `ensureWorkerKeychain`'s own re-provision attempt,
     * refuses the spawn (`WorkerKeychainError`, `credential-too-short-for-run`) before it
     * starts when even a freshly re-provisioned credential still can't outlast the run — see
     * that option's own doc for the full two-part contract. Appended LAST — no positional
     * caller shifts.
     */
```

## runId

`src/lib/worker.ts:1212-1223` at `ea02cc83`.

```
  /**
   * W1-T117: attribution markers threaded into the child's env
   * (`REMUDERO_RUN_ID`/`REMUDERO_TASK_ID`) — inherited by every descendant
   * process the CLI spawns (env propagates downhill through `bash -c` by
   * default, the same propagation that let the armed `gh pr create` bomb
   * survive), consumed by the orphan sweep (worker-containment.ts's
   * `sweepOrphanWorkers`) to attribute a stray survivor back to the run/task
   * that spawned it. Optional: a caller that omits them still gets
   * process-group containment (teardown kills everything regardless), it
   * just cannot be RE-attributed by a later sweep if teardown itself never
   * ran (e.g. the daemon process was killed mid-run).
   */
```

## containment

`src/lib/worker.ts:1226-1232` at `ea02cc83`.

```
  /**
   * W1-T117 injectable seam: override the process-group spawn/teardown —
   * same injection convention as `config`/`claudeExecutable`/`keychain`
   * above. Omitted ⇒ the real `spawnDetachedGroup`/`teardownProcessGroup`
   * (worker-containment.ts). Tests inject fakes so containment wiring is
   * provable without a real `claude` binary.
   */
```

## onSpawnError

`src/lib/worker.ts:1241-1258` at `ea02cc83`.

```
  /**
   * W1-T442: sink for a spawn's ASYNCHRONOUS 'error' event — the only place the
   * errno (ENOENT / EAGAIN / EMFILE / EACCES) ever appears, since the no-pid
   * throw unwinds before the event fires.
   *
   * A CALLBACK RATHER THAN A MUTABLE HOLDER THE CALLER READS AFTER CATCHING,
   * and the reason is a race, not taste: the event may not have fired when the
   * catch runs, so a holder is read too early exactly when the spawn failed
   * fastest. A callback fires WHEN THE ERROR DOES rather than when the caller
   * happens to look, which is correct regardless of ordering.
   *
   * It is wired HERE and destined for the ledger in `run-task.ts`, because
   * worker.ts cannot reach the ledger: `ledgerPathFor` lives in run-task.ts,
   * run-task.ts already imports this module, and re-spelling
   * `join(config.root, "state", "ledger.ndjson")` here would undo the
   * consolidation that function's own doc records. Omitted ⇒ the error is
   * swallowed exactly as it was before this existed.
   */
```

## queryFn

`src/lib/worker.ts:1260-1268` at `ea02cc83`.

```
  /**
   * W1-T117 injectable seam: override the SDK's own `query()` entry point —
   * same injection convention as every other seam above. Omitted ⇒ the real
   * SDK `query` (a live `claude` subprocess). Tests inject a fake async
   * iterable so spawnWorker's OWN process-group-teardown wiring (the code
   * AFTER this call — see the `withWorkerGroupTeardown` call at the bottom
   * of this function) is exercised end-to-end, on both the success and the
   * thrown-error verdict path, with no real claude binary involved.
   */
```

## streamObserver

`src/lib/worker.ts:1270-1277` at `ea02cc83`.

```
  /**
   * W1-T942 (design note i): forwarded VERBATIM to {@link collectWorkerResult}'s own
   * `streamObserver` — the ONE seam that turns the SDK message stream this call already
   * consumes into per-message `working`/`tool-executing`/heartbeat events. Omitted (every
   * caller before this task) ⇒ byte-identical behavior. run-task.ts wires the REAL observer
   * here at its spawn call sites — see `buildWorkerStateSensor` — so `worker.state` is
   * produced by live runs, never only by a test (Standing rule 14).
   */
```

## clockBound

`src/lib/worker.ts:1279-1290` at `ea02cc83`.

```
  /**
   * W1-T1045: THE CLOCK BOUND. Omitted (every caller before this task) ⇒ byte-identical
   * behavior — no `AbortController` is ever constructed and `options.abortController` stays
   * unset. When set, a watchdog ({@link createWorkerClockBoundWatchdog}) aborts THIS call's own
   * SDK query the moment `boundMs` elapses since the last observed stream activity (never on
   * total run age — see that function's own doc), and `spawnWorker` throws {@link
   * WorkerAbandonedError} carrying the evidence instead of whatever the SDK's iterator threw on
   * abort. run-task.ts wires the REAL bound here (`policy.values.workerAbandon`) at its own
   * dispatch-spawn wrapper, never at this call site directly (Standing rule 14: the real
   * observer/bound is wired at the real spawn path, not merely available) — the advisory
   * reviewer's and the architect's own direct `spawnWorker` calls omit it and are unaffected.
   */
```

## logHomeReap

`src/lib/worker.ts:1292-1312` at `ea02cc83`.

```
  /**
   * W1-T2441: observe the per-spawn worker-home reap this call's teardown already runs
   * (`reapWorkerHome`, worker-home.ts). That call ALREADY COMPUTES a {@link WorkerHomeReapResult}
   * naming the target it removed (or didn't) and why, on every arm (`guard-rejected`, `absent`,
   * reaped-true, a caught error) — it was previously discarded in statement position at the
   * `finally` call site below (`grep -acE "=\s*reapWorkerHome\(" src/lib/worker.ts` read 0 before
   * this task). Called on EVERY exit path, including a thrown error, exactly like the reap
   * itself, and NEVER allowed to throw — see the call site's own try/catch. Omitted ⇒ the default
   * ({@link workerHomeReapLogFields} to `console.error`, one JSON line — the same best-effort
   * exit-path diagnostic-output discipline this file's `assertWorktreeBaseCurrent`'s `warn`
   * already uses).
   *
   * INSTRUMENTATION ONLY, AS OF W1-T2441 (that task's own constraint at the time): this option
   * itself does not change WHAT is reaped or WHEN — it only surfaces the already-computed
   * {@link WorkerHomeReapResult}. W1-T2441's own no-remedy premise — "the home is still keyed on
   * `runId`, so every fix spawn inside one daemon run still shares one" — held at filing but no
   * longer holds at this call site: W1-T2463 shipped the remedy below (`perRunWorkerHomeDir(...,
   * { perSpawn: true })`), so a still-running sibling can no longer lose its home out from under
   * it the moment another sibling exits. This option's own contract (observe, never decide) is
   * unaffected by that — it still just makes whatever `reapWorkerHome` computed observable.
   */
```

## logKeychainHeadroom

`src/lib/worker.ts:1314-1323` at `ea02cc83`.

```
  /**
   * W1-T2518: sink for the darwin keychain rung's {@link WorkerKeychainSummary}, observed at
   * THIS call site on EVERY darwin provisioning call — `keychain.expectedRunMs` supplied or
   * not — so the rate `observedHeadroomMs` (worker-home.ts:1080) actually gets exercised
   * becomes answerable off-host purely by reading this line, exactly as that field's own doc
   * anticipates. Never called on the non-darwin path: `assertWorkerCredentialFile` returns no
   * summary carrying this field at all. Omitted ⇒ {@link defaultLogKeychainHeadroom}, one JSON
   * line to stderr — the same best-effort diagnostic-output discipline `logHomeReap` above
   * already uses.
   */
```

## resolveWorkerCapabilities

`src/lib/worker.ts:1383-1389` at `ea02cc83`.

```
/**
 * Worker checkouts carry the repository-owned capability policy. `config.root` is the daemon
 * state root on the Azure fleet (`/home/node/Remudero`), not the repository root, so resolving
 * from it silently misses `.remudero/mounts.yaml`. Task workers use their checkout `cwd`; early
 * isolation probes use a scratch cwd before that worktree exists, so they fall back to the
 * module's installed repository root. Neither path guesses from the state-root directory.
 */
```

## spawnWorker

`src/lib/worker.ts:1538-1558` at `ea02cc83`.

```
/**
 * Spawn one headless Claude Code worker via the Agent SDK, or an opted-in Codex worker.
 *
 * Uses the installed SDK's isolation options as ground truth (SDK 0.3.209):
 *  - `pathToClaudeCodeExecutable` → resolved FRESH at spawn time (W1-T113: env
 *    override → live PATH → the install-location table), never `config.claudeBin`'s
 *    disk-cached value directly and never bare PATH inheritance either.
 *  - `env` → REPLACES the subprocess env entirely (per the SDK contract), so the
 *    allowlisted, ANTHROPIC-stripped env from buildWorkerEnv() is the billing
 *    boundary. No wholesale process.env inheritance.
 *  - `settings` → the worker settings file (permissions + hooks).
 *  - `settingSources: []` → SDK isolation mode; never loads ~/.claude/settings.json.
 *  - `sandbox` → parsed from the settings file and passed as the validated SDK
 *    option, so a malformed sandbox block fails loud instead of the CLI silently
 *    dropping an invalid settings file and running unsandboxed.
 *  - `env.home` → a worker-home dir UNIQUE to this call (W1-T170: `perRunWorkerHomeDir`,
 *    preferring `args.runId` when supplied, plus a W1-T2463 per-spawn token so two spawns
 *    SHARING one `runId` still get distinct homes), materialized fresh and reaped in a
 *    `finally` regardless of outcome — the pre-W1-T170 singleton `<root>/worker-home`
 *    does not survive two overlapping spawns (WS-2).
 */
```

## workerHomeRoot

`src/lib/worker.ts:1573-1580` at `ea02cc83`.

```
  // W1-T2800: HOISTED ABOVE PROVIDER SELECTION so the Codex branch below cannot return past the
  // HOME redirection the Claude path has had since W1-T18. Previously this sequence lived after
  // the `selection.provider === "codex"` early return, so `codexSpawnEnv` fell back to
  // `process.env.HOME` — the OPERATOR'S REAL HOME — and a worker shell sourcing an rc file from
  // it re-exported ANTHROPIC_API_KEY past both of Codex's process-boundary exclusions. Computing
  // the path here is inert (no disk write); each provider branch materializes and reaps it.
  // `{ perSpawn: true }` is preserved verbatim (W1-T170, W1-T2463): two spawns sharing a runId
  // still get distinct homes.
```

## spawnWorker — materializeWorkerHome

`src/lib/worker.ts:1730-1735` at `ea02cc83`.

```
        // W1-T2800: MATERIALIZE the redirected home before the spawn — the SAME function the Claude
        // path calls (never a second materializer), which writes the blank rc files
        // (`WORKER_HOME_RC_FILES`) that close the leak. MEASURED against pinned codex-cli 0.152.0:
        // both Codex exclusions hold at the process boundary (zero ANTHROPIC keys in the child's
        // `/proc/self/environ`) while the worker's SHELL still read the operator's exported value
        // from `$HOME/.bashrc`. A blank rc in a redirected HOME is the only boundary that stops it.
```

## claudeBin

`src/lib/worker.ts:1760-1765` at `ea02cc83`.

```
  // W1-T113 PREFLIGHT: resolve the real binary FRESH (see resolveClaudeExecutable's
  // doc, above) before any worker-home/keychain work runs. Throws
  // ClaudeToolchainBlockedError — never a raw ENOENT — naming every searched
  // path, carrying `reasonClass: "blocked_toolchain"` (the W1-T91 infrastructure
  // classification, never a task defect) for a caller to classify duck-typed —
  // see daemon.ts's `isSpawnInfraBlocked`, which does exactly that.
```

## try

`src/lib/worker.ts:1767-1786` at `ea02cc83`.

```
  // W1-T18 general isolation mechanism: redirect HOME to a Remudero-controlled
  // scratch dir holding ONLY empty rc files (never the operator's real HOME),
  // with the few paths a worker legitimately needs symlinked back in. Best-
  // effort/idempotent — safe to call before every spawn. See worker-home.ts.
  //
  // W1-T170: the singleton root does NOT survive concurrency (WS-2) — two
  // overlapping spawns truncating/symlinking the SAME rc files and keychain
  // slot race each other. So EVERY spawn gets its OWN home, a sibling of the
  // root (`perRunWorkerHomeDir`), never the shared root itself; reaped below
  // on every exit path (including error) once this spawn is done with it.
  // W1-T2463: opt IN to a per-spawn uniqueness token appended after args.runId (see
  // perRunWorkerHomeDir's own doc, worker-home.ts). Every fix spawn inside one daemon run
  // previously resolved to the SAME `worker-home-<runId>` (keyed on runId alone), so one
  // spawn's teardown (reapWorkerHome, in the `finally` below) tore the directory out from
  // under a still-live sibling — the ENOTEMPTY collision this task fixes. runId stays the
  // FIRST component of the path (workerMarkerEnv below still writes the bare args.runId,
  // untouched), so reclamation is unaffected; only THIS call site opts in — the OTHER
  // caller in src/ (run-task.ts's readUsageSnapshot, "usage-probe") does not, so its
  // stable, non-per-call home is unchanged.
  // W1-T2800: both are resolved ONCE, above provider selection — see that hoist's own comment.
```

## spawnWorker — workerKeychainPath

`src/lib/worker.ts:1788-1793` at `ea02cc83`.

```
    // W1-T235 (WS-7 keychain-unlock gate, macOS only): guarantee the DEDICATED
    // always-unlocked worker keychain before any spawn, and point the redirected
    // HOME's keychain slot at it — a LOCKED login keychain can no longer kill the
    // spawn "Not logged in" at $0. A credential problem throws WorkerKeychainError
    // HERE, pre-spawn, with a named reason class — never a $0 worker whose
    // zero-write death reads as "containment UNPROVEN" (the 2026-07-21 incident).
```

## spawnWorker — accountId

`src/lib/worker.ts:1796-1803` at `ea02cc83`.

```
    // W1-T265/W1-T268: resolve fresh, per spawn, regardless of platform — never
    // captured once at boot, matching account-usage.ts's own "identity is read
    // fresh" doctrine (that module is the reason this reads accountUuid/
    // emailAddress here rather than the keychain's own `acct` attribute, which it
    // measured to be the OS username and therefore not a discriminator across an
    // Anthropic account switch). Computed unconditionally (not just under the
    // darwin keychain gate below) so every WorkerResult — on any platform — can
    // carry the account its spend is attributed to (W1-T268's ledger dimension).
```

## spawnWorker — assertWorkerCredentialFile

`src/lib/worker.ts:1828-1842` at `ea02cc83`.

```
      // recon-cloud-workers-spike stop 6: the SAME refusal contract, one rung later in the
      // taxonomy and one platform over. The darwin branch above is untouched — this is an
      // `else`, so nothing in production behaviour moves.
      //
      // WHY IT IS WORTH A RUNG AT ALL, since a credential-dead worker is already caught: the
      // containment probe (`probeContainment`) catches it on every platform, but by SPAWNING
      // and reading the death. Here the same fact costs one file read, before anything runs.
      // `assertWorkerCredentialFile` throws `WorkerKeychainError` with a named reason class,
      // exactly as the keychain rung does, so the failure stays queryable rather than prose.
      //
      // It refuses only what is unambiguously unusable — absent, unreadable, malformed, or
      // carrying no Claude credential at all. An EXPIRED token is reported and allowed through:
      // there is nothing to re-provision from on this platform, the CLI maintains its own
      // refresh, and refusing there would be a bound firing on a healthy condition. See
      // worker-home.ts's note above `workerCredentialFilePath` for the full argument.
```

## spawnWorker — lostGrants

`src/lib/worker.ts:1845-1851` at `ea02cc83`.

```
    // W1-T417-adjacent: a grant that FAILED is not a grant that was OPTIONAL. The absent-target
    // skip stays silent (several are legitimately unavailable), but a target that EXISTS and could
    // not be reached is a LOST CAPABILITY the worker then runs without — exactly how a real
    // `.claude` DIRECTORY in the symlink slot left the usage probe running LOGGED OUT for days
    // with nothing on disk saying so. Carried on the RESULT rather than logged here: this module
    // writes no ledger rows by design, and `workerLedgerFields` already projects the result onto
    // the verdict row every caller writes.
```

## spawnWorker — childEnv

`src/lib/worker.ts:1856-1861` at `ea02cc83`.

```
    // Shell isolation (resolved from config, never hardcoded) so a worker sources
    // no operator rc: HOME is redirected (above) so CLAUDE_CODE_SHELL's Bash-tool
    // snapshot (which sources `$HOME/.bashrc`) resolves to the redirected scratch
    // HOME's empty rc, never the operator's — isolation independent of whatever
    // the operator's real dotfiles contain. ZDOTDIR covers any direct zsh (W1-T1C
    // compinit contamination).
```

## spawnWorker — pidRef

`src/lib/worker.ts:1880-1890` at `ea02cc83`.

```
    // W1-T117: worker process-tree containment. `pidRef` is populated by the
    // spawnClaudeCodeProcess closure below the first time the SDK actually
    // spawns (lazily, on the returned async iterable's first pull);
    // withWorkerGroupTeardown guarantees `teardownFn` runs against it on EITHER
    // path once the message stream settles — normal return (any result
    // subtype, including error_max_turns/error_max_budget_usd) or a thrown
    // transport failure — never leaving a run's process group alive past its
    // own teardown. See worker-containment.ts's file header for the verified
    // SDK spawn-surface ground truth (`Options.spawnClaudeCodeProcess`) this
    // relies on, including why it ALSO owns stderr piping here (a custom spawn
    // gets no stderr wiring from the SDK itself).
```

## spawnWorker — spawnClaudeCodeProcess

`src/lib/worker.ts:1906-1912` at `ea02cc83`.

```
      // W1-T117: run the CLI DETACHED into its own process group/session
      // (setsid-equivalent) so teardown can reach every descendant — including
      // one that outlives the CLI's own exit — with a single group signal.
      // This REPLACES the SDK's default local spawn, so `stderrChunks` is fed
      // from THIS closure (via buildContainedSpawnFn's onStderr sink), not
      // from an `Options.stderr` callback here — the SDK never invokes one for
      // a custom spawn (see the file-header note in worker-containment.ts).
```

## spawnWorker — if

`src/lib/worker.ts:1933-1946` at `ea02cc83`.

```
    // impl-EM LIVE-SPAWN GUARD — the final authority gate before the optional attribution boundary
    // and the SDK invocation; only the SDK call creates the paid worker. Everything above this line is local and free (config load, binary
    // resolve, worker-home materialisation, keychain unlock, env construction) and pushes nothing,
    // reaches no network and spends nothing — verified over the whole range. Those steps ALSO refuse
    // on their own for bad input (an invalid settings file, an absent toolchain, a locked keychain),
    // and those refusals are safety features with their own tests; guarding above them would mask
    // three of them and make this guard the reason they stopped being exercised.
    //
    // Scoped to a REAL spawn: `args.queryFn` is the W1-T117 seam replacing the SDK's own `query()`, so
    // a test injecting it creates no process and is not what this refuses. What it stops is the shape
    // that actually cost money — a test reaching the real SDK through an un-stubbed dep or an
    // `as never` cast, which is how test/mounts-wiring.test.ts once spent $1.42+ and left six ghost
    // branches behind. The multi-provider capacity read below is control-plane telemetry, not a
    // model spawn, and catches its own failure without weakening this guard.
```

## spawnWorker — if (2)

`src/lib/worker.ts:2029-2034` at `ea02cc83`.

```
      // W1-T1045: runs on EVERY thrown error, but only REPLACES it when the watchdog itself
      // tripped (`abandonment` populated) — any other transport failure passes through
      // unchanged, exactly as before this task. Replacing rather than adding a second reject
      // means run-task.ts checks ONE type (`instanceof WorkerAbandonedError`) rather than
      // re-deriving "was this OUR abort" from the SDK's own thrown error shape, which is not a
      // documented contract.
```

## spawnWorker — captureWorkerUsageProjection

`src/lib/worker.ts:2041-2059` at `ea02cc83`.

```
    // W1-T170: reap THIS spawn's per-spawn home on every exit path, including a
    // thrown error (validate/toolchain/keychain failures above, or a transport
    // failure out of withWorkerGroupTeardown) — the same withTempDir discipline
    // (W1-T115/W1-T131) applied to a resource that must not accumulate across
    // concurrent or serial spawns. Guarded (never touches the singleton root or
    // anything outside its own sibling) and best-effort — see worker-home.ts.
    //
    // W1-T2441: `reapWorkerHome` ALREADY COMPUTES which target it removed (or didn't) and
    // why, on every arm — previously discarded here in statement position (nothing ever
    // assigned its return value). Surfaced now via `logHomeReap` — the reap call itself
    // (still best-effort, still never throws, still unconditional in this `finally`) is
    // untouched by that instrumentation. W1-T2463: `workerHome` above is now this spawn's OWN
    // per-spawn sibling (`perRunWorkerHomeDir(..., { perSpawn: true })`), not a home shared
    // with every other spawn in the run, so this unconditional `rmSync` no longer tears down
    // a still-live sibling's home out from under it.
    // W1-T2516: capture the usage cache OUT of this spawn's own worker home BEFORE the reap
    // immediately below deletes it — see captureWorkerUsageProjection's own doc for why this is
    // the only place in the codebase this reading is still reachable at all. Best-effort and
    // silent by construction, exactly like the reap it precedes; never gates or delays it.
```

## UsageProbeSession

`src/lib/worker.ts:2075-2092` at `ea02cc83`.

```
/**
 * Reduce the SDK message stream into a {@link WorkerResult}. Extracted from
 * spawnWorker so the error-envelope behavior is unit-testable without spawning
 * a real worker.
 *
 * CRITICAL (SDK 0.3.209 ground truth, WS-1 root cause): the SDK still YIELDS the
 * `type:"result"` envelope for an error subtype (error_max_turns,
 * error_max_budget_usd, …) — carrying `num_turns` and `total_cost_usd` — and
 * only THEN throws `Error("Claude Code returned an error result: …")` from the
 * iterator. If that throw escapes, the run's cost + turns are lost and a failed
 * run looks FREE in the ledger. So: once a result envelope is seen, the trailing
 * throw is swallowed and the captured envelope is returned with isError=true. A
 * throw with NO result envelope is a genuine transport/spawn failure — re-raised.
 */
/**
 * The SDK session type a usage probe needs — narrowed to the control request and teardown, so
 * neither this module nor its callers depend on the experimental method's full shape.
 */
```

## openUsageProbeSession

`src/lib/worker.ts:2106-2121` at `ea02cc83`.

```
/**
 * OPEN A CONTROL-ONLY SDK SESSION FOR THE USAGE PROBE — and it lives HERE, in the spawn
 * chokepoint, deliberately.
 *
 * `test/spawn-guard.test.ts` pins that EXACTLY ONE file imports the SDK's runtime `query`, and
 * that that file calls {@link assertLiveSpawnAllowed} before reaching it: "If a second file now
 * spawns workers, guard it too rather than widening this list." Putting the probe's session here
 * keeps both halves true — one importer, one guard — instead of widening a stated invariant for a
 * session that, while it spawns no worker, still opens a real SDK connection and so deserves the
 * same treatment.
 *
 * STREAMING INPUT IS REQUIRED, NOT PREFERRED. The usage control request is declared inside
 * `Query`'s control-request block, documented "only supported when streaming input/output is
 * used", so this passes an async generator rather than the string `spawnWorker` uses. Converting
 * `spawnWorker` itself to streaming input is a separate decision and is NOT made here.
 */
```

## WorkerState

`src/lib/worker.ts:2130-2143` at `ea02cc83`.

```
/**
 * The 3-value worker activity vocabulary (W1-T942 design note ii) — and no more. A fourth
 * value invented here would have to be re-rendered by every consumer (W1-T943's stall
 * detector, W1-T944's NOW card, W1-T945's `rmd peek`) and re-judged by the first of those, so
 * the vocabulary is pinned at exactly these three:
 *  - `working`        — assistant TEXT is arriving.
 *  - `tool-executing`  — a `tool_use` content block has been seen with no subsequent message yet.
 *  - `quiet`           — no message of ANY kind has arrived for longer than the quiet floor.
 *
 * DELIBERATELY NOT A LEDGERED VALUE ON ITS OWN: a run with no `worker.state` row yet is
 * `UNKNOWN`, never defaulted to `working` (the W1-T130 cannot-observe polarity) — see
 * {@link WorkerStateTracker.currentState}'s doc for how that is represented (`undefined`,
 * never a 4th string).
 */
```

## WorkerStreamEvent

`src/lib/worker.ts:2146-2153` at `ea02cc83`.

```
/**
 * One classified SDK stream event, as {@link collectWorkerResult}'s `streamObserver` sees it.
 * `"working"`/`"tool-executing"` map 1:1 onto {@link WorkerState}; `"message"` covers every
 * OTHER message the stream yields (a `system` event, the terminal `result` envelope, or an
 * `assistant` message whose content carries neither a text nor a `tool_use` block) — a
 * heartbeat that proves the worker is still alive without asserting either named state, so it
 * still resets the quiet clock a {@link WorkerStateTracker} tracks.
 */
```

## text

`src/lib/worker.ts:2159-2164` at `ea02cc83`.

```
  /**
   * The live-tail-worthy text this event carries — the assistant's own text for `"working"`,
   * a short `[tool_use: <name>]` label for `"tool-executing"`, and ABSENT for `"message"` (a
   * system/result envelope carries no worker-authored output worth tailing — see W1-T942
   * design note iv, "the worker's recent output").
   */
```

## turnsSoFar

`src/lib/worker.ts:2166-2180` at `ea02cc83`.

```
  /**
   * W1-T2557: the cumulative count of raw `assistant`-type SDK messages {@link
   * collectWorkerResult} has seen SO FAR this spawn, as of this event — one increment per raw
   * assistant message, regardless of how many text/tool_use blocks it carries (so a message
   * with both fires two `WorkerStreamEvent`s that report the SAME `turnsSoFar`, never double
   * counted). Present on every event kind, including `"message"` heartbeats, so a reader never
   * has to guess a stale value forward across a heartbeat-only stretch.
   *
   * DELIBERATELY NAMED `turnsSoFar`, NOT `numTurns`: {@link WorkerResult.numTurns}'s own doc
   * (W1-T303 ground truth) already established that the SDK's terminal `num_turns` does not
   * reliably count "one turn = one user message + one assistant response" — an independently
   * counted mid-flight approximation must not borrow that name and imply it is the same figure.
   * This is the HONEST count available while the spawn is still in flight, never asserted to
   * equal whatever `num_turns` lands on the terminal envelope.
   */
```

## DEFAULT_WORKER_QUIET_FLOOR_MS

`src/lib/worker.ts:2189-2195` at `ea02cc83`.

```
/**
 * Default quiet floor (W1-T942 design note ii): how long with NO message of any kind before a
 * run reads `quiet`. Deliberately short — this is a raw ACTIVITY sensor ("has this worker said
 * anything lately"), not a stall alarm (W1-T943's own, much longer, threshold): the two must
 * stay decoupled or a slow-but-healthy tool call would misreport as the stall detector's own
 * escalation-worthy condition before that detector even exists.
 */
```

## WorkerStateTracker

`src/lib/worker.ts:2198-2210` at `ea02cc83`.

```
/**
 * FOLD a stream of {@link WorkerStreamEvent}s (plus periodic quiet-floor checks) into the
 * 3-value {@link WorkerState}, reporting only the TRANSITIONS — never one result per message
 * (W1-T942 design note iii: a per-message ledger row would multiply ledger volume by the turn
 * count and slow every reader in the repo).
 *
 * PURE: no fs, no ledger, no clock of its own — every timestamp is supplied by the caller (the
 * SAME injected clock `collectWorkerResult` uses, or a test's synthetic one), so this is
 * unit-testable against a synthetic event sequence with zero real time elapsed and no SDK
 * stream at all. `worker.ts` still cannot reach the ledger (see this file's own header comment
 * on `onSpawnError`) — appending the `worker.state` row is run-task.ts's job
 * (`buildWorkerStateSensor`), consuming this tracker's return values.
 */
```

## observe

`src/lib/worker.ts:2221-2226` at `ea02cc83`.

```
  /**
   * Fold one observed message-stream event. Returns the NEW {@link WorkerState} iff this event
   * caused a transition (the caller ledgers it); `undefined` when the state is unchanged — a
   * `"message"` heartbeat NEVER itself asserts `working`/`tool-executing` (it only resets the
   * clock {@link check} reads), so it never returns a transition on its own.
   */
```

## turnsSoFar (2)

`src/lib/worker.ts:2238-2246` at `ea02cc83`.

```
  /**
   * W1-T2557: the running count of assistant-message "turns" observed so far THIS spawn — see
   * {@link WorkerStreamEvent.turnsSoFar}'s own doc for the counting unit and why it is not
   * asserted to equal the terminal envelope's `num_turns`. THE MID-FLIGHT VISIBILITY THIS TASK
   * ADDS: unlike {@link currentState}, which only changes on a working/quiet/tool-executing
   * TRANSITION (and can go a whole run without firing again for a continuously-`working`
   * worker), this updates on every single observed event — the running spend signal a caller
   * (run-task.ts's `buildWorkerStateSensor`) can ledger WHILE the spawn is still in flight.
   */
```

## check

`src/lib/worker.ts:2251-2258` at `ea02cc83`.

```
  /**
   * Call periodically (a live caller polls this on an interval WHILE a spawn is in flight —
   * see run-task.ts's `buildWorkerStateSensor`) with the current clock reading. Transitions to
   * `quiet` iff MORE than `quietFloorMs` has elapsed since the last observed event of ANY kind
   * (design note ii: "no message of any kind for longer than the quiet floor"). A no-op
   * (returns `undefined`) before any event has ever been observed (UNKNOWN, never `quiet` by
   * default) or while already `quiet` (no repeat transition).
   */
```

## WorkerAbandonmentEvidence

`src/lib/worker.ts:2280-2287` at `ea02cc83`.

```
/**
 * Evidence captured the MOMENT the clock-bound watchdog (W1-T1045, {@link
 * createWorkerClockBoundWatchdog}) trips — BEFORE anything is released (the lock, the
 * worktree, the process group; run-task.ts writes this evidence to the ledger before doing any
 * of that). `lastState`/`lastStateMs` are `undefined` when the stream never produced even one
 * classifiable `working`/`tool-executing` event before going silent — the same UNKNOWN
 * polarity {@link WorkerStateTracker.currentState} keeps (never defaulted to `"working"`).
 */
```

## WorkerAbandonedError

`src/lib/worker.ts:2301-2314` at `ea02cc83`.

```
/**
 * Thrown by {@link spawnWorker} when the W1-T1045 clock-bound watchdog trips: the stream
 * produced no observed activity for longer than `args.clockBound.boundMs`, so this call's own
 * `AbortController` was aborted and the SDK's iterator settled with an error rather than a
 * result envelope (see {@link collectWorkerResult}'s `if (!sawResult) throw err` path — a
 * stalled stream never produces one). Carries the {@link WorkerAbandonmentEvidence} the caller
 * (run-task.ts) needs to write a terminal verdict without re-deriving the same judgment this
 * watchdog already made; `cause` keeps the raw underlying error reachable for a post-mortem,
 * never discarded.
 *
 * A NAMED, DUCK-TYPEABLE reason, matching this file's existing convention for a refusal a
 * caller must recognize (`ClaudeToolchainBlockedError.reasonClass`, `WorkerKeychainError`) —
 * never a bare string match against `.message`.
 */
```

## createWorkerClockBoundWatchdog

`src/lib/worker.ts:2336-2360` at `ea02cc83`.

```
/**
 * THE CLOCK-BOUND WATCHDOG ITSELF (W1-T1045) — pure and independently testable, mirroring
 * `buildWorkerStateSensor`'s own observer/poll split (run-task.ts) one layer down, inside the
 * file that actually holds the live stream.
 *
 * Reuses {@link WorkerStateTracker}'s own "elapsed since last activity" math rather than
 * re-deriving it: constructing one with `quietFloorMs: boundMs` makes its `check()` transition
 * to `"quiet"` at EXACTLY the moment this watchdog must trip — the SAME `"quiet"` concept
 * {@link DEFAULT_WORKER_QUIET_FLOOR_MS} names, at a much longer floor, on a tracker instance
 * PRIVATE to this watchdog (never the run-level one `buildWorkerStateSensor` owns — the three
 * thresholds {@link WorkerStreamEvent}'s own doc names stay decoupled).
 *
 * `observer` wraps a `WorkerStreamObserver` so every observed event (working/tool-executing/
 * message — `"message"` heartbeats included, deliberately: see {@link WorkerStreamEvent}'s own
 * doc for why a heartbeat still resets the quiet clock) resets the idle clock; `start(onTrip)`
 * seeds that clock the moment polling begins (a synthetic `"message"` event) so a stream that
 * yields ZERO events before going silent still trips at `boundMs` — never earlier, never never
 * — and fires `onTrip` EXACTLY ONCE, carrying the evidence, the moment elapsed silence exceeds
 * the bound. Criterion 6 (a stream still producing events is never tripped, however long it
 * runs) holds because every event — via `observer` — pushes the tracker's own clock forward.
 *
 * `now`/`pollMs` are injectable, the SAME `now?: () => number` convention every clock-bearing
 * function in this file already follows (`collectWorkerResult`, `WorkerStateTracker.check`), so
 * a test trips this deterministically without a real multi-hour wait.
 */
```

## createWorkerClockBoundWatchdog — return

`src/lib/worker.ts:2402-2409` at `ea02cc83`.

```
    // DELIBERATELY NOT `.unref()`'d, unlike `buildWorkerStateSensor`'s own cosmetic poll
    // (run-task.ts): that timer only feeds a display/telemetry row, so losing it costs nothing.
    // THIS timer is the enforcement mechanism a genuinely stalled worker relies on — the SDK
    // call itself holds no Node-level timer or handle while it's hung, so an unref'd interval
    // here can let Node decide the event loop is idle and let the process exit (or, under a
    // runner, be torn down) before it ever fires, silently defeating the whole bound. `stop()`
    // (returned below) still clears it on every real exit path (spawnWorker's `finally`), so a
    // HEALTHY run is never kept alive a moment longer than the call it's watching.
```

## collectWorkerResult — streamObserver

`src/lib/worker.ts:2437-2443` at `ea02cc83`.

```
    /**
     * W1-T942: invoked per message, classified by kind, with THIS call's own injected clock
     * reading (never a second `Date.now()` read) — the ONE observer seam the design calls for.
     * Absent (every caller before this task, and every caller that omits it) ⇒ the loop below
     * behaves BYTE-IDENTICALLY to before this existed: no new branch, no new SDK call, no
     * second stream. See {@link WorkerStreamObserver}.
     */
```

## startedAtMs

`src/lib/worker.ts:2451-2456` at `ea02cc83`.

```
  // W1-T477: started BEFORE the first `for await` pull below — this function's body, start to
  // return, IS the worker call (spawnWorker's own "impl-EM" comment: everything ABOVE this call
  // is local/free setup). No clock injection: existing callers/tests already exercise this loop
  // against synthetic (near-instant) message streams, so `worker_duration_ms` on those results is
  // small but present, never a reason to add an injectable `now` seam this module didn't need
  // before.
```

## collectWorkerResult — if

`src/lib/worker.ts:2512-2517` at `ea02cc83`.

```
        // W1-T2572: verbatim off the SAME per-message field `apiError` above already reads —
        // the ONE place the live Claude stream names what actually generated this turn. Never
        // `modelUsage` (a post-hoc cost breakdown keyed by whatever the envelope reports at the
        // END, not a live per-turn signal) and never `<synthetic>` (that value marks an
        // Anthropic-side error placeholder, not a model that served anything). Last real value
        // wins, matching `text`/`subtype` below overwriting on each new message.
```

## collectWorkerResult — refusal

`src/lib/worker.ts:2615-2620` at `ea02cc83`.

```
    // W1-T2564: CLASSIFY THE REFUSAL HERE, where the message still exists. `detectUsageLimitRefusal`
    // is the fleet's ONE usage-limit detector (lib/classify.ts, W1-T2515 — "A SHUT WINDOW IS NOT A
    // FLAKE"), already wired into the fix-retry loop; this is a second CALLER, never a second
    // classifier. Verified against the real stderr: it matches "You've hit your session limit" and
    // recovers `resetsAtMs` 2026-09-01T11:50:00.000Z — the reset the API actually stated, and MORE
    // ACCURATE than the 12:00:00.000Z the headroom governor believed at that same instant.
```

## evaluateDenyFloor

`src/lib/worker.ts:2688-2696` at `ea02cc83`.

```
/**
 * Fold the containment probe's observations into a {@link DenyFloorVerdict}.
 *
 * Pass only `forbiddenPresentUnderBypass` for the first (bypass) probe. When it
 * is `true` the floor leaked, so the caller MUST re-run the probe under
 * {@link DENY_FLOOR_FALLBACK_MODE} and pass `forbiddenPresentUnderDontAsk` from
 * that second run. An omitted second observation is treated conservatively as
 * "not contained" — an unverified floor is never reported as holding.
 */
```

## renderWorkerSettings

`src/lib/worker.ts:2711-2719` at `ea02cc83`.

```
/**
 * Render the committed worker-settings TEMPLATE into a concrete settings file.
 *
 * The template ships `${HOOKS_DIR}` in its hook command so the public tree
 * carries no absolute machine path. At runtime we substitute the real hooks dir
 * and write the result outside the tree (workers run with cwd = a worktree, so
 * the hook path must be absolute, not `$CLAUDE_PROJECT_DIR`-relative). Returns
 * the path to the rendered file.
 */
```

## anchoredPrUrl

`src/lib/worker.ts:2793-2808` at `ea02cc83`.

```
/**
 * ANCHORED PR_URL extraction (W1-T62). The OUTPUT CONTRACT (run-task.ts) demands
 * a REPORT whose LAST line is exactly `PR_URL: <url>` — but the prior parse took
 * the FIRST pull-URL ANYWHERE in the worker output, so an evidence pull-URL
 * (e.g. a dependency PR cited to satisfy acceptance criteria) appearing BEFORE
 * the real PR_URL line won attribution instead. Run W1-T54b-1784151420811 was
 * ledgered verdict=merged via PR #80 (Dependabot's own PR) by exactly this
 * defect; the run's real PR was #91.
 *
 * Only a line matching `PR_URL:` (anchored to the start of that line, case
 * -insensitive) followed by a well-formed github pull-request URL counts; every
 * other pull-URL in the text — evidence, prose, quoted contract text — is INERT.
 * When the contract is honored more than once (e.g. a DECISION_REQUEST resume
 * appends a second REPORT), the LAST such line wins, matching "last line of the
 * REPORT". A missing or malformed line yields `undefined` — never a guess.
 */
```

## stripDecoration

`src/lib/worker.ts:2823-2831` at `ea02cc83`.

```
/**
 * Strip presentation decoration from a decision option/recommendation label so
 * the returned value is the DATA, never the DATA-plus-chrome. Decoration is not
 * data: the WS-0 `)` bleed (an inline `(RECOMMENDED)` marker leaking its closing
 * paren) and the T1D `**`…`**` / backtick / ✅ / trailing `****` noise are the
 * same class of bug — a decorated label mistaken for the value it dresses up.
 * Removes the inline recommend marker, markdown emphasis (`*`) and code ticks
 * (`` ` ``), and emoji, then collapses the leftover whitespace.
 */
```

## parseFollowups

`src/lib/worker.ts:2880-2890` at `ea02cc83`.

```
/**
 * Parse the OPTIONAL `## Follow-ups` section of a worker REPORT (§2 OUTPUT
 * CONTRACT, W1-T105): "anything discovered that is OUT OF SCOPE for the one
 * concern goes here, never into the diff." One typed entry per line —
 * `research:` | `task:` | `action:` (an optional leading `-`/`*` bullet is
 * tolerated) — each line's own text carries its why, so no separate why field
 * is ever required. Absent section -> `null`, a byte-identical no-op for
 * every existing caller (parseReport/parseQuestion are untouched by this
 * parser and never see it). A line that names none of the three types is
 * silently skipped, never crashes the whole report over one malformed line.
 */
```

## appendQuestion

`src/lib/worker.ts:2907-2916` at `ea02cc83`.

```
/**
 * Append a QUESTION to the durable side-channel store, `plan/questions.ndjson`
 * (one JSON object per line — diffable, append-only, no round-trip hazard).
 *
 * NON-BLOCKING by contract (MASTER-PLAN §2): the QUESTION channel is the
 * assume-log-keep-moving path, so it must NEVER stall the loop. A write failure
 * is caught and reported as `false` rather than thrown. Ensures `plan/` exists so
 * a fresh checkout logs durably on its first question. Returns whether the line
 * was written.
 */
```

## QuestionAnswerEntry

`src/lib/worker.ts:2928-2935` at `ea02cc83`.

```
/**
 * One durable ANSWER entry — a line of `plan/questions.ndjson` (W3-T5, MASTER-PLAN §7: "the
 * question backlog... answers flow to the Architect"). Shares the QUESTION contract's own
 * store (never a second file) so an answer lands in the SAME diffable, append-only channel
 * every future question consumer (the Architect's triage/retro loop, the daily digest) already
 * watches — distinguished from a {@link QuestionEntry} by carrying `answer` instead of
 * `question`, so a reader can tell the two apart without a separate `kind` discriminator.
 */
```

## appendQuestionAnswer

`src/lib/worker.ts:2944-2950` at `ea02cc83`.

```
/**
 * Append an operator's ANSWER to the SAME durable side-channel store `appendQuestion` writes
 * to, `plan/questions.ndjson` — the panel's write action (W3-T5) is this function's only
 * caller today (lib/panel-actions.ts's `buildAnswerQuestionRoute`). NON-BLOCKING by the same
 * contract as `appendQuestion`: a write failure is caught and reported as `false`, never
 * thrown — an unwritable store must not turn an operator's answer into an unhandled crash.
 */
```

## adhocLaneRoot

`src/lib/worker.ts:2968-2993` at `ea02cc83`.

```
/**
 * W1-T2847 — THE DECLARED HOME FOR HAND-CUT (AD-HOC) LANES, and the ONLY new root this task adds.
 *
 * THE MEASUREMENT. `worktreesDir` is the one root `runWorktreeReapRung` ever passes to
 * {@link reapStaleWorktrees}. On the Mac mini 2026-09-04, `config.root` held 214 entries of which
 * **180 carried a `.git` FILE** — linked worktrees — sitting as SIBLINGS of `worktrees/`, which
 * itself held 11. So the reaper's entire scan surface was 11 directories totalling 44K while 4.7G
 * of the identical object class sat one directory above it, unreachable. Nothing else covers them
 * either: `cloneReapRoots()` returns tmp roots only, `pruneStaleRuns` is handed `worktreesDir` at
 * every call site, and `reapWorkerScratch` is fenced to `claudeScratchRoot()` children.
 *
 * A SIBLING OF `worktreesDir`, NEVER `config.root` ITSELF. Pointing any reaper at `config.root`
 * is refused by this task's own design: those 180 worktrees are LIVE (`git worktree list
 * --porcelain` reported `prunable` zero times), and 34 of the 214 entries are not worktrees at all
 * — ledgers, PR bodies, manifests — which a reaper must never walk. Reaping the parent wholesale
 * is the 2026-07-31 failure this repo already paid for once.
 *
 * AND NEVER `$HOME`. The same practice on the console account put lanes at `~/<name>`, and 154
 * distinct ones accumulated over three days there; adding a home-scoped reap root would gain a
 * root full of `Documents`, `Library` and `.ssh` while still refusing ~96% of that leak (those
 * lanes are linked worktrees, and `clone-reaper.ts` requires `.git` to be a DIRECTORY by design).
 * The fix is to move the practice INTO a bounded, fleet-owned directory — this one.
 *
 * DERIVED, never a hardcoded absolute path — the same `join(config.root, …)` shape
 * {@link worktreesDir} and `workerHomeDir` already use, for the same public-repo-hygiene reason.
 */
```

## ADHOC_LANE_REAP_GRACE_MS

`src/lib/worker.ts:2998-3017` at `ea02cc83`.

```
/**
 * W1-T2847 — THE AGE CEILING FOR AN OPERATOR LANE, SIZED FOR A HUMAN RATHER THAN FOR A RUN.
 *
 * {@link DEFAULT_WORKTREE_REAP_GRACE_MS} is calibrated against run wall-clock, and reusing it here
 * would fire on a healthy condition — this repo's recurring defect (W1-T312, W1-T380/#1392,
 * W1-T382/#1401), which is why this constant exists rather than a shared one.
 *
 * WHAT IT WAS SIZED AGAINST, STATED. The population is hand-cut lanes on a developer machine. The
 * longest LEGITIMATE idle window for one is a long weekend — a lane cut Friday evening and resumed
 * Tuesday morning is roughly 84 hours idle and is not garbage. The observed creation window
 * (2026-09-01 07:15 → 2026-09-03 18:58, 15/88/51 lanes per day) shows lanes retained across at
 * least that span, and every one of the 180 measured was still on a live branch. Fourteen days is
 * ~4x the longest legitimate idle window, which is the headroom the bound-fires-on-a-healthy-
 * condition rule asks for, while still bounding a directory that grows at 15-88 entries a day.
 *
 * AGE IS THE BACKSTOP, NOT THE PREDICATE. {@link reapStaleWorktrees} fails closed on a live pid,
 * on a branch still live upstream HOWEVER OLD, and on an incomplete activity probe. Against the
 * measured population this ceiling therefore reclaims ZERO today, and that is the expected result:
 * the value delivered is the bound, not an immediate reclaim.
 */
```

## resolveNodeModulesSource

`src/lib/worker.ts:3028-3036` at `ea02cc83`.

```
/**
 * Which `node_modules` a fresh worktree should resolve its dev CLIs from.
 *
 * Prefers the PARENT CLONE's own install, which is the right answer whenever that clone
 * has been installed. Falls back to this rmd install's, which on the fleet host is the
 * only one that exists: worktrees are cut from `<config.root>/repos/<repo>`, and that
 * clone carries NO `node_modules` at all (measured). Sourcing only from `repoDir` would
 * therefore ship a fix that is inert on the very host it is meant to repair.
 */
```

## the "linked-lockfile-mismatch" member

`src/lib/worker.ts:3050-3056` at `ea02cc83`.

```
  // W1-T2777: the link was made (best-effort contract unchanged) but the source's
  // `package.json`+`package-lock.json` hash differed from the worktree's. The worktree's
  // source tree was cut from `origin/main` at HEAD; its `node_modules` came from
  // `repoDir` (see {@link resolveNodeModulesSource}) which may sit arbitrarily far behind
  // (see {@link recordCanonicalCheckoutDrift} for the coupling that surfaces this). This
  // outcome tells the caller so a worker cannot start with a lockfile it cannot resolve
  // and read the resulting "module not found" as a defect in its own diff.
```

## linkWorktreeNodeModules

`src/lib/worker.ts:3059-3078` at `ea02cc83`.

```
/**
 * Give a fresh worktree a `node_modules`, by SYMLINK — never by installing.
 *
 * WHY THIS EXISTS. W1-T137 (#842) shipped `hooks/commit-msg`, wired into every worktree by
 * the `core.hooksPath` line below. That hook resolves `$(git rev-parse --show-toplevel)/
 * node_modules/.bin/commitlint` and, finding none, exits 1 with "commitlint is not installed
 * in this worktree" — by design, it refuses to skip the gate silently. But `worktreeAdd` never
 * supplied a `node_modules`, so EVERY commit from EVERY worktree verb (runTask, retro, triage,
 * plan, draftProposalBatch, approve — all six share this function) has been rejected since
 * 2026-07-29. W1-T137's own suite passes only because it symlinks one in itself
 * (`symlinkNodeModules`, test/commit-msg-hook.test.ts:78).
 *
 * A symlink is the remedy this repo already prescribes for exactly this (CLAUDE.md, 2026-07-29:
 * "Wire a worktree up with `ln -s <canonical>/node_modules <worktree>/node_modules`"), and it is
 * emphatically NOT `npm ci`: an install here is what emptied the shared `node_modules` under the
 * live daemon on 2026-07-29. The hook's own advice ("run `npm ci` first") must not be taken.
 *
 * Best-effort by contract: every outcome is a RETURN VALUE, never a throw. Creating a worktree
 * must not fail because its dev CLIs could not be wired up.
 */
```

## linkWorktreeNodeModules — hashInstallInputs

`src/lib/worker.ts:3088-3094` at `ea02cc83`.

```
    /**
     * W1-T2777: injectable hasher over `package.json` + `package-lock.json` (default the real
     * `hashInstallInputs` shared with `ensureInstallFresh`). A test hands both sides to prove
     * both directions of the compare — matching lockfiles stay quiet, differing ones return
     * `linked-lockfile-mismatch`. Sharing this ONE primitive with the run-task freshness path
     * is what stops two independent hashes on the same inputs from drifting silently.
     */
```

## linkWorktreeNodeModules — warn

`src/lib/worker.ts:3096-3101` at `ea02cc83`.

```
    /**
     * W1-T2777: surface for the loud channel. Default `console.error`, matching
     * {@link recordCanonicalCheckoutDrift}'s existing convention rather than inventing a second
     * one. The warning names the two sides being compared (worktree source dir and the
     * `node_modules` source path) so the operator or the caller has both without re-deriving.
     */
```

## hashFn

`src/lib/worker.ts:3121-3132` at `ea02cc83`.

```
  // W1-T2777: LOCKFILE COMPARE AT SYMLINK TIME. The link is already in place (best-effort
  // contract from the header holds), and now the two `package.json`+`package-lock.json` hashes
  // decide whether it is SAFE-TO-USE or KNOWN-STALE. The source of node_modules is
  // `parentOf(source)` — `resolveNodeModulesSource` returns `<x>/node_modules` and the
  // hashInputs live in `<x>` — not `repoDir`, because on the fleet host the fallback branch
  // resolves to the install root's own tree, not repoDir's (see the doc for `resolveSource`).
  // WHY THIS IS THE RIGHT MOMENT. Any comparison earlier misses the fact that resolveSource
  // may point at the install root rather than repoDir; any comparison later runs after a worker
  // has already imported code and seen "Cannot find module" without the operator being told
  // whose fault it was. Here, the link is fresh, the two source trees are identifiable, and
  // the outcome propagates to the caller by return value — the existing best-effort pattern
  // (`recordCanonicalCheckoutDrift`) uses the same idiom for the same reason.
```

## excludeNodeModulesFromGit

`src/lib/worker.ts:3159-3171` at `ea02cc83`.

```
/**
 * Make git ignore the `node_modules` link above, independent of whether the checked-out
 * `.gitignore` happens to cover it.
 *
 * WITHOUT THIS the link is an untracked file, and W1-T142's out-of-scope push guard refuses
 * the whole branch with "NOT pushing: node_modules" — turning a commit fix into a push
 * regression. remudero's own `.gitignore` does list it, but relying on the checked-out repo
 * to do so is exactly the assumption that failed here; `worktreeAdd` serves any repo.
 *
 * MEASURED (this host, git 2.x): a linked worktree honours the COMMON dir's `info/exclude`
 * and IGNORES its own per-worktree admin one, so that is where this writes — the same
 * shared-scope write the `core.hooksPath` line already makes. Idempotent and best-effort.
 */
```

## WorktreeBaseStaleError

`src/lib/worker.ts:3209-3222` at `ea02cc83`.

```
/**
 * Thrown by {@link assertWorktreeBaseCurrent} (and so by `worktreeAdd`) when the base a
 * worktree was just created from differs from an independently-observed remote head.
 * Named so a caller can catch it specifically — see `run-task.ts`'s `runTask`, which turns
 * it into a `blocked_stale_base` verdict rather than letting it propagate as a bare crash.
 *
 * W1-T405: the message names what was OBSERVED — behind — never a cause it cannot see. The
 * out-of-scope scope guard (`scopeGuardOutOfScopeFiles` in run-task.ts) used to assert a
 * "forged merge-base" for a diff shape that a merely-stale base produces identically; that
 * guard cannot tell the two apart because by the time it runs (after recon, implement, and
 * commit) the distinguishing evidence — what the base actually was at creation time — is
 * long gone. This error exists so staleness is caught, and named for what it is, before
 * that guard ever gets a chance to guess.
 */
```

## assertWorktreeBaseCurrent

`src/lib/worker.ts:3242-3278` at `ea02cc83`.

```
/**
 * Assert-and-refuse (W1-T405 design note (i)): compare the base a worktree was just
 * created from against the remote head an INDEPENDENT read observes right now, and throw
 * {@link WorktreeBaseStaleError} when they differ.
 *
 * WHY INDEPENDENT. `worktreeAdd`'s own `git fetch` already moves the local `origin/<ref>`
 * tracking ref before the worktree is cut, so in the ordinary case this can never fire —
 * that is the point; every one of `worktreeAdd`'s six call sites already fetches before
 * creating. It exists for the failure mode source review cannot rule out (W1-T405's own
 * rationale): a fetch that exits zero without the worktree actually landing on the ref that
 * fetch believed it moved. Re-reading the remote here — never the just-fetched local ref,
 * which is exactly the thing in question — catches that regardless of which path let it
 * through, without this function having to name the path.
 *
 * STALE MEANS BEHIND BY ANY COMMIT (design note (ii)) — a deliberate over-approximation:
 * the precise question ("behind in a way that affects the diff") needs the diff, which
 * needs the run, which is the spend this check exists to avoid paying before finding out.
 *
 * UNREADABLE WARNS, NEVER REFUSES (design note (iii)): `deps.readRemoteHead` throwing (an
 * unreachable forge, a transport error) is treated as "cannot be measured", not "is stale"
 * — refusing on an unmeasurable condition would convert a network blip into a stalled
 * queue, the exact failure this repo keeps re-learning (ci-gate's wait cap, a deploy
 * ceiling burned by a dry run, a check-wait bound, the idle-gate ceiling). The warning
 * still surfaces so an operator can tell the check ran and could not measure, rather than
 * silently skipping it.
 *
 * W1-T2621: the SAME unreadable branch also ledgers `worktree.base_uncheckable` (carrying
 * `ref`, `base`, and the error) through `deps.log` when one is supplied, IN ADDITION to the
 * `warn` above — `warn`'s only channel in production is `console.error` (a worktreeAdd
 * caller with no `worktreeBaseDeps` gets the default), which is neither durable nor read by
 * anything; `log`, when supplied, is the run's own ledger, so the fail-open leaves a trace
 * an operator can find after the fact instead of only at the moment it happened. Polarity is
 * unchanged: this still returns (proceeds) rather than throwing.
 *
 * PURE aside from the injected callbacks — no git/network call of its own — so a test
 * drives every branch (stale / current / unreadable) without a second real remote.
 */
```

## assertWorktreeBaseCurrent — countBehind

`src/lib/worker.ts:3289-3294` at `ea02cc83`.

```
    /** W1-T2621: commit distance `base..remoteHead`, invoked ONLY on the stale branch (the
     *  current/unreadable branches have a trivial distance — 0 / "unknown" — that needs no
     *  git call at all). Local objects only, never a second network read; the caller
     *  (`worktreeAdd`) is the one with a `repoDir` to read them from, so it supplies this —
     *  omitting it here keeps this function itself free of any real git/network call.
     *  Default: "unknown", never a guessed number. */
```

## WORKTREE_BASE_UNCHECKABLE_STREAK_BOUND

`src/lib/worker.ts:3318-3342` at `ea02cc83`.

```
/**
 * How many CONSECUTIVE `worktree.add` lines with an UNREADABLE `remote_head` — the shape
 * {@link assertWorktreeBaseCurrent}'s fail-open branch produces, see its own doc — turn "the
 * currency check could not run this once" into a DEGRADED POSTURE worth naming, rather than
 * continuing indefinitely, one `console.error` at a time, exactly as though the guard were
 * still running (W1-T2626 design note (iii)).
 *
 * A NAMED CONSTANT, NOT YET POLICY DATA. `plan/policy.yaml` is this value's eventual home — the
 * same substrate `fixStrikeCap`/`sweep.strikeCap` already ride — but wiring a NEW field through
 * there means editing `src/lib/policy.ts`'s schema too, outside this task's declared scope
 * (`src/lib/worker.ts` + `src/run-task.ts` + this feature's own test). Design note (iii)'s own
 * parenthetical covers exactly this: "a single named constant with its bound stated until
 * then". 3 — the same "three strikes" order of magnitude `fixStrikeCap`/`sweep.strikeCap`
 * already use in `plan/policy.yaml` — rules out one flaky `ls-remote` (noise the existing
 * warn/fail-open already fully absorbs on its own) while still catching a persistently
 * unreachable remote well before an entire session passes under a guard that silently never ran.
 *
 * BACKSTOP (W1-T1266's bound-kind tag). The PRIMARY CONTROL for a base that cannot be read is
 * `assertWorktreeBaseCurrent`'s own warn/fail-open branch: it runs on every add, decides every
 * ordinary case, and is what deliberately absorbs a single flaky `ls-remote`. This constant decides
 * nothing on that path and never fires while that control is working. It exists only for the case
 * the primary handles SILENTLY and indefinitely — a remote unreachable run after run, which reads
 * exactly like a guard that is passing. That is the backstop shape: it catches the failure of the
 * control above it, not the condition that control was written for.
 */
```

## detectWorktreeBaseUncheckableStreak

`src/lib/worker.ts:3357-3375` at `ea02cc83`.

```
/**
 * Is the worktree-base currency check currently DEGRADED — has its remote-head read failed N
 * times running, with no intervening readable creation? Pure over ledger lines, oldest-first,
 * the SAME "current-run-only, a success resets it" shape {@link detectPostReviewStall}
 * (`lib/sweep.ts`) already established for the sweep's post-review path — a success (or, here, a
 * readable head) resets the count rather than letting one good day forgive a permanent latch.
 *
 * READS `worktree.add` LINES ONLY. Every worktree creation that reaches the point of being
 * ledgered emits exactly one — a refusal (`WorktreeBaseStaleError`) never does, `worktreeAdd`
 * throws before that log call runs — so this single step name can't double-count a creation
 * whose `worktree.base_uncheckable` companion line rotated out independently; `remote_head` on
 * that one line already tells "readable" (a real sha) from "unreadable" (the literal string)
 * without needing the companion line at all.
 *
 * ORTHOGONAL TO STALENESS: a `worktree.stale_base` refusal (a READABLE remote head that simply
 * differs from the base) neither resets nor extends this run — base currency and base
 * READABILITY are different questions, and design note (iii) is scoped to the unreadable branch
 * only.
 */
```

## measureCanonicalCheckoutDrift

`src/lib/worker.ts:3415-3444` at `ea02cc83`.

```
/**
 * Measure how many commits the CANONICAL CHECKOUT's `HEAD` sits behind `origin/<ref>` — the
 * deps SOURCE every worker worktree's `node_modules` is symlinked to by
 * {@link linkWorktreeNodeModules} (W1-T2618). Read at the exact moment that link is made, so
 * the staleness of the tree a fresh worktree resolves its dev CLIs through becomes an
 * OBSERVED quantity instead of an assumed-fresh one.
 *
 * MEASURE, NEVER REPAIR (design note (i)). This does not fetch, pull, or install anything to
 * fix a stale checkout — what to DO about one (refresh it, refuse, warn) is a later ruling,
 * not decided here. It runs no package manager and performs no install on any path: the only
 * subprocess it launches is `git rev-list --count`, never `npm`/`yarn`/`pnpm` — the exact
 * outage class (an install emptying the shared `node_modules` under a live daemon) the
 * symlink discipline exists to prevent.
 *
 * REUSES THE ALREADY-FETCHED REF (design note (ii)), NO NEW FETCH. Every `worktreeAdd` call
 * site runs `git fetch origin --quiet` in `repoDir` before this ever runs (see the `fetch`
 * line above the `linkWorktreeNodeModules` call below), which already moves `repoDir`'s
 * local `origin/<ref>` tracking ref to the current remote head. So `origin/<ref>` here is
 * already current, and the `rev-list` below is a purely LOCAL, no-network read comparing two
 * refs already on disk — it does not re-fetch.
 *
 * BEST-EFFORT, LIKE ITS SIBLING (design note (iii)): mirrors `linkWorktreeNodeModules`'s own
 * "every outcome is a RETURN VALUE, never a throw" contract exactly. An unreadable repo, a
 * missing `origin/<ref>`, or unparseable `rev-list` output all degrade to `"unknown"`, never
 * a thrown error — a staleness measurement that could itself break dispatch would be worse
 * than the drift it measures.
 *
 * PURE aside from the injected callback — no git call of its own beyond the default — so a
 * test drives every branch (current / behind / unknown) without a second real remote.
 */
```

## recordCanonicalCheckoutDrift

`src/lib/worker.ts:3468-3477` at `ea02cc83`.

```
/**
 * Report {@link measureCanonicalCheckoutDrift}'s result the way {@link assertWorktreeBaseCurrent}
 * reports an unreadable remote head: NAME the checkout and its measured distance via `warn`
 * when it is behind (acceptance claim 2), and stay silent when it is current — a detector,
 * not a permanent red (acceptance claim 3). NEVER THROWS regardless of outcome: the symlink
 * this runs right after is best-effort by contract, and a stale deps source must never fail
 * worktree creation (acceptance claim 2, design note (iii)). Called from `worktreeAdd`
 * immediately after `linkWorktreeNodeModules` — the one place the system already knows a
 * worktree's deps source.
 */
```

## recordWorktreeBase

`src/lib/worker.ts:3506-3511` at `ea02cc83`.

```
/**
 * Record the base a worktree was just created from (W1-T405 acceptance (4)). `worktreeAdd`
 * calls this for every worktree it creates, BEFORE the currency check below can throw, so a
 * stale-base refusal still leaves an attributable sibling file even though the worktree
 * itself is about to be abandoned.
 */
```

## readWorktreeBase

`src/lib/worker.ts:3516-3521` at `ea02cc83`.

```
/**
 * Read a previously-recorded base (see {@link recordWorktreeBase}). `null` when absent or
 * unreadable — never throws, so a missing record (a worktree predating W1-T405, or one
 * whose sibling file was cleaned up) degrades to "unknown" rather than blocking whatever
 * wanted to attribute a refusal.
 */
```

## removeWorktreeBase

`src/lib/worker.ts:3530-3536` at `ea02cc83`.

```
/**
 * Drop a worktree's sibling base record. The record's lifetime is its worktree's: it exists
 * so a refusal can be attributed while the corpse is still on disk, and it must die when the
 * corpse does — a removal that leaves it behind fails the guard suite's "cleans up" contract
 * (the approve refusal path found exactly that residue) and would hand the reaper one orphaned
 * file per pass. Guarded, never throws: a worktree predating W1-T405 has no record to drop.
 */
```

## readLocalOriginRefHead

`src/lib/worker.ts:3558-3564` at `ea02cc83`.

```
/** W1-T2621: the LOCAL `origin/<ref>` tracking ref, read immediately after `worktreeAdd`'s own
 *  `git fetch` — one of the three readings the `worktree.add` ledger line needs (the other two
 *  are the created base and {@link defaultReadRemoteHead}'s independent remote read) to tell
 *  "the add cut from a ref other than the one it was told to" apart from "the fetch did not
 *  move the ref" after the fact. No network call of its own — purely local, right after a
 *  fetch that already succeeded (fail-closed), so failure here is not expected; it degrades to
 *  the literal `"unreadable"` rather than aborting worktree creation over a sensor read. */
```

## defaultCountBehind

`src/lib/worker.ts:3577-3582` at `ea02cc83`.

```
/** W1-T2621: `assertWorktreeBaseCurrent`'s `countBehind` for a real repo — commits
 *  `base..remoteHead`, LOCAL OBJECTS ONLY (`git rev-list --count`), never a second network
 *  call. Returns `"unknown"`, never a guessed number, when the count cannot be produced — most
 *  notably when `remoteHead`'s object is not present locally at all, which is exactly the "the
 *  fetch did not move the ref" shape this task exists to surface rather than silently render
 *  as `behind: 0`. */
```

## worktreeAdd — log

`src/lib/worker.ts:3613-3620` at `ea02cc83`.

```
    /** W1-T2621: the run's ledger logger. Absent (the default) leaves behaviour BYTE-IDENTICAL
     *  to before this option existed — `spike.ts` and any other caller with no ledger are
     *  unchanged. Present, this emits ONE `worktree.add` line per creation carrying the
     *  three-way base reading (`base`, `local_ref_head`, `remote_head`) plus `ref` and
     *  `behind`, and — on the currency check's fail-open branch — `worktree.base_uncheckable`
     *  (see {@link assertWorktreeBaseCurrent}). `run-task.ts`'s call sites supply it; a
     *  refusal (`WorktreeBaseStaleError`) is still the caller's own to ledger, since only the
     *  caller decides what a refusal means for its dispatch. */
```

## execFileSync

`src/lib/worker.ts:3630-3635` at `ea02cc83`.

```
  // W1-T1129: `base` (e.g. "origin/main") is a remote-tracking start point, so plain
  // `-b <branch>` would ALSO write `branch.<branch>.remote`/`.merge` into the repo's ONE
  // shared `.git/config` — a write every other concurrent worktreeAdd/checkout -B call
  // races for the same `.git/config.lock` (rationale (3)/(4)). Nothing here reads that
  // tracking config, so `--no-track` keeps the branch (still at `base`'s commit, still
  // pushable) and drops only the config write.
```

## execFileSync (2)

`src/lib/worker.ts:3666-3676` at `ea02cc83`.

```
  // W1-T137: point this worktree at the repo's tracked hooks/ dir so its real git
  // commit-msg hook (hooks/commit-msg) fires on every commit the worker authors
  // itself — the only backstop PR #407 explicitly left unbuilt (it shaped only the
  // two HARNESS-built commit-header sites, never a worker's own `git commit`).
  // A RELATIVE core.hooksPath resolves against each worktree's OWN top-level dir
  // (verified against git 2.54: a linked worktree finds <worktree>/hooks, not the
  // main checkout's), so "hooks" is correct here even though `git config` (no
  // `extensions.worktreeConfig`) writes it to the repo's ONE shared config file —
  // every worktree, this one and every future one off the same repoDir, resolves
  // the same relative value against its own checked-out hooks/. Idempotent: safe
  // to set on every worktreeAdd call, including ones after it is already set.
```

## uniqueRunBranch

`src/lib/worker.ts:3705-3734` at `ea02cc83`.

```
/**
 * Pick a `run-<runId>` worktree branch name that is ACTUALLY FREE in `repoDir` right now,
 * falling back to a numbered suffix (`run-<runId>-2`, `-3`, …) when the plain name is
 * already taken (W1-T2493).
 *
 * WHY A RUN ID CAN BE ASKED FOR TWICE. `runId` identifies a PROCESS across every ledger row
 * it writes — right for a run id — but a rung built ONCE at daemon boot and re-invoked on
 * every later poll (`buildInboxDraftHook`/`draftProposalBatch`, run-task.ts) closes over that
 * SAME string and hands it to this function again on every poll that has work. `worktreeAdd`'s
 * `-b` correctly refuses an existing branch — that refusal is exactly what stops two lanes
 * silently sharing a checkout — so without this, the SECOND call in one boot died on
 * `fatal: a branch named 'run-<runId>' already exists`, deterministically, forever, because
 * nothing about the requested name ever changed between polls.
 *
 * WHY A LEFTOVER BRANCH IS THE COMMON CASE, NOT THE EXCEPTION. `git worktree remove` (see
 * `worktreeRemove`, below) never deletes the branch a worktree was checked out on — that is
 * ordinary git, not a bug — so even a worktree that finished CLEANLY leaves `run-<runId>`
 * behind as a local ref the very next call to this function will find. A worktree reaped after
 * a crash leaves the identical residue. Either shape must be tolerated without assuming a
 * clean namespace, which is exactly what re-checking existence per candidate gives for free.
 *
 * NEVER FORCES OR REUSES. This function only ever returns a name it just observed to be free
 * — it does not delete, rename, or `-f` over anything. A genuine race (two lanes computing the
 * identical candidate at the same instant) is still refused: `worktreeAdd`'s own `-b` throws
 * if the real `git worktree add` loses that race, exactly as it always has.
 *
 * THE RUN ID ITSELF IS NEVER TOUCHED. Only the returned branch NAME can gain a suffix; every
 * caller keeps passing the original `runId` to `log`/`writeRunLock` unchanged, so ledger
 * attribution for this process's whole life is byte-identical to before this function existed.
 */
```

## sweepStaleWorkerScratch

`src/lib/worker.ts:3755-3761` at `ea02cc83`.

```
  // Accumulation control (orchestrator-side, survives a killed worker): also reap
  // STALE ORPHAN scratch under the same claude-<uid> root — the `rmd-*` test fixtures
  // a SIGKILL'd `npm test` leaves behind (its own finally + tmp-hygiene's exit handler
  // are both skipped on SIGKILL), which the daemon boot sweep (os.tmpdir()) never
  // scans. The 4h ceiling is far above the longest task, so a concurrent live fixture
  // is never reaped; far below the 24h boot ceiling, so orphans clear within a task
  // cycle. Disjoint from the per-<slug> reap above and best-effort/never-throws.
```

## RunLockInfo

`src/lib/worker.ts:3776-3781` at `ea02cc83`.

```
/**
 * The liveness token a run writes beside its worktree so a concurrent prune knows
 * the worktree is ALIVE, not debris. Stored as a SIBLING file (`<worktree>.lock`),
 * never inside the worktree working tree — otherwise a worker's `git add -A` could
 * commit it into the PR. See {@link pruneStaleRuns}.
 */
```

## target

`src/lib/worker.ts:3794-3807` at `ea02cc83`.

```
  // ATOMIC OVERWRITE (W1-T208): write to a sibling temp file, then rename() into place.
  // The prior direct writeFileSync(target) let a concurrent readRunLock() (pruneStaleRuns
  // runs in a DIFFERENT process, on its own schedule) observe a partially-written file —
  // JSON.parse then throws, and the old readRunLock caught that and returned null, the
  // exact same value "no lock at all" also produces. That misclassified a live, mid-write
  // run as abandoned debris, handing pruneStaleRuns a green light to --force remove its
  // worktree (the same class of bug DIAGNOSIS.md/drain-concurrency already called out for
  // the no-lock case). rename(2) atomically swaps the directory entry on a POSIX
  // filesystem, so a reader can only ever see the complete old content or the complete
  // new content — never a torn intermediate — which removes the ambiguity at its source
  // instead of trying to distinguish "torn" from "absent" after the fact. The temp name
  // embeds pid + timestamp so two writers racing on the same lock path never clobber each
  // other's in-flight temp file. Uses the default `fs` import (see the header comment on
  // that import) so the write is a live property lookup a test can spy on.
```

## RunLockRead

`src/lib/worker.ts:3814-3822` at `ea02cc83`.

```
/**
 * The three, and only three, things reading a run.lock can honestly conclude (W1-T208).
 * `absent` (no file) is a DIFFERENT fact from `corrupt` (a file is there but did not
 * parse into a valid {@link RunLockInfo} — e.g. a reader caught a live writer mid
 * rename, or genuine on-disk corruption): one means the worktree is free, the other means
 * something is wrong and liveness cannot be determined. Collapsing both into the same
 * `null` (the pre-fix shape) let a corrupt lock read as silently idle. `live` means the
 * file parsed; whether that pid is still running is for the caller (isPidAlive) to check.
 */
```

## DEFAULT_PRUNE_GRACE_MS

`src/lib/worker.ts:3964-3974` at `ea02cc83`.

```
/**
 * Grace window (ms) below which a LOCKLESS worktree is presumed to be a run that has
 * just `git worktree add`-ed but not yet written its {@link runLockPath} — the tiny
 * create-before-lock race. Callers pass this to protect that window; genuinely old
 * lockless debris (past the window) is still reaped.
 *
 * W1-T253 (P37 CONSUMERS): read from `plan/policy.yaml`'s `pruneGraceMs` (a POLICY value now,
 * never a source literal) via {@link loadDefaultPolicy} — a retune is a reviewed plan PR, not
 * a code edit. `loadDefaultPolicy` self-locates the policy file from its own install location
 * (never cwd), so this resolves identically regardless of which directory a caller runs from.
 */
```

## (end of file)

`src/lib/worker.ts:3990-4001` at `ea02cc83`.

```
// ── Stale `.git/config.lock` reclaimer (W1-T1036) ──────────────────────────
//
// A `.git/config.lock` left behind by a killed process (rationale (1): an OOM-stalled VM)
// fails every subsequent `git worktree add` outright — that call writes
// `branch.<name>.remote`/`.merge` into `.git/config` (rationale (2)) — and the EXISTING
// widowed-lock pass in reapStaleWorktrees cannot see it: that pass enumerates the worktrees
// directory and asks "is the directory this lock is named after gone?", but a config lock
// lives in a different tree entirely and is paired with no directory at all (rationale (3)).
//
// This reclaimer plugs into pruneStaleRuns (below), the shared function every prune-then-add
// call site already runs immediately before worktreeAdd (design (v)) — so the fix reaches all
// of them without src/run-task.ts needing to declare or change anything.
```

## DEFAULT_CONFIG_LOCK_GRACE_MS

`src/lib/worker.ts:4003-4009` at `ea02cc83`.

```
/**
 * Grace window (ms) below which a zero-byte `.git/config.lock` is presumed to be a process
 * still between `open()` and `write()` — design (i).1. A `git config` write completes in
 * single-digit milliseconds, so this is orders of magnitude of headroom over the only
 * legitimate race, while remaining short enough that genuinely abandoned debris (the
 * OOM-killed process in rationale (1)) clears on the very next prune pass.
 */
```

## defaultProbeLiveGitProcess

`src/lib/worker.ts:4036-4044` at `ea02cc83`.

```
/**
 * Real probe: `pgrep git` (design (i).2 — deliberately `pgrep`, not `lsof`; both are declared
 * in the image, and the coarser name-match answers "held" more often, which is the safe
 * direction per design (ii)). Reuses {@link pgrepFailureMeansZero} (deployer.ts) rather than
 * reinventing its exit-code table: `status === 1` is pgrep's own documented "no processes
 * matched" (a real, ran-to-completion zero); anything else — ENOENT (binary absent, rationale
 * (5)'s measured failure mode), a syntax error, a fatal error — means the read did not happen
 * and must NOT be read as "no git process".
 */
```

## isConfigLockStale

`src/lib/worker.ts:4071-4079` at `ea02cc83`.

```
/**
 * THE PREDICATE, AND IT FAILS CLOSED (design (i)). All three rungs must hold before a
 * `.git/config.lock` is considered reclaimable:
 *   1. AGE — older than `graceMs`.
 *   2. NO LIVE GIT PROCESS — the probe ran AND found none.
 *   3. THE PROBE RAN — an unrunnable probe is not evidence of staleness and KEEPS the lock.
 * THIS PREDICATE MAY NOT BE LOOSENED TOWARD RECLAMATION (design (ii)): clearing a live lock
 * lets two writers race and corrupts `.git/config`; keeping a dead one costs only minutes.
 */
```

## reclaimStaleConfigLock

`src/lib/worker.ts:4100-4114` at `ea02cc83`.

```
/**
 * Reclaim a stale `.git/config.lock` for `repoDir` (design (i)-(iv)) — meant to run
 * immediately before the `git worktree add` that would otherwise fail on it (rationale (2)).
 *
 * `unlink`s, never truncates/overwrites (design (iii)): the observed artifact is mode
 * `-r--r--r--`, so an "open for write and truncate" reclaimer fails on the exact file this
 * function exists to clear, while removal succeeds under the DIRECTORY's own permission.
 *
 * Ledgers BEFORE removing, naming the path (design (iv)): nothing about a zero-byte file
 * tells a later reader what was removed or why, so an unledgered reclaim would be
 * indistinguishable from the corruption it exists to prevent.
 *
 * Best-effort and per-item guarded, like every other reclaim in this module: an absent,
 * unreadable, still-live, or already-vanished lock is left alone and reported `false`.
 */
```

## pruneStaleRuns

`src/lib/worker.ts:4132-4157` at `ea02cc83`.

```
/**
 * Reclaim leftovers from crashed prior runs so they cannot block this one.
 *
 * A run that dies without reaching its cleanup (WS-1: max-turns run died with the
 * worktree + branch still on disk) leaves a `run-*` worktree and local branch
 * behind. `git worktree add -b run-…` for a NEW run has a unique timestamp so it
 * never collides — but the debris accumulates and a stale branch name could later
 * clash. At run start we force-remove every DEAD `run-*` worktree, `git worktree prune`
 * the admin records, then delete every remaining local `run-*` branch. All
 * best-effort and per-item guarded: a repo with nothing to prune returns empties.
 * The caller's own about-to-be-created branch does not exist yet, so it is safe.
 *
 * LIVENESS GUARD (DIAGNOSIS.md, diag/drain-concurrency): this prune ORIGINALLY
 * force-removed ANY `run-*` worktree, an assumption valid ONLY under strictly
 * sequential execution. Under ANY overlap (two drains; a manual `run-task` beside a
 * drain) it became an active saboteur — it once `--force`-removed a LIVE worktree
 * mid-run and destroyed a successful 65-turn implement. We now SKIP any worktree
 * whose sibling {@link runLockPath} names a LIVE pid, and reap only genuinely dead
 * ones (no lock, or the lock's pid is dead). A live-pid worktree is NEVER removed.
 *
 * W1-T208: a CORRUPT lock (present but unparseable — e.g. a reader caught a live writer
 * mid-write) is treated the SAME as an ABSENT one here, never as proof of death: both go
 * through the age/grace guard below rather than an immediate force-remove. That is the
 * guard that makes a torn read survivable — it must keep applying to the corrupt case
 * exactly as it already did to the lockless case, unchanged by this fix.
 */
```

## pruneStaleRuns — if

`src/lib/worker.ts:4191-4197` at `ea02cc83`.

```
        // AGE GUARD: a LOCKLESS ("absent") OR CORRUPT ("W1-T208: unparseable — may be a
        // live writer caught mid-write, not proof of death) worktree younger than graceMs
        // may be a run that just `git worktree add`-ed but has not yet written its
        // run.lock (the create race), or one whose lock a reader caught mid torn-write.
        // Protect either; only genuinely-old debris (or a definitively dead-pid lock) is
        // reaped. A "live" lock naming a dead pid skips this guard entirely below — that
        // pid cannot still be writing, so no grace period is owed to it.
```

## (end of file) (2)

`src/lib/worker.ts:4254-4275` at `ea02cc83`.

```
// ── Worktree reaper (W1-T175) — closes pruneStaleRuns' coverage holes ─────
//
// pruneStaleRuns (above) is a real, working owner, but it only sees what it is
// TOLD to look at, and only at moments a run happens to start:
//   (1) it enumerates ONLY `git worktree list --porcelain` for ONE assumed
//       repoDir, so a directory git no longer registers is invisible to it;
//   (2) it fires exclusively at the START of a run — an idle fleet reaps
//       nothing, however long a crashed run's debris sits;
//   (3) its predicate requires a `run-*` BRANCH, so a `sweep-*` worktree
//       interrupted before `checkout -B` (still on a detached HEAD) is
//       permanently orphaned, and a widowed `.lock` whose worktree dir is
//       already gone is never swept (removeRunLock only runs INSIDE a
//       successful removal).
// reapStaleWorktrees closes all three: it enumerates the DIRECTORY itself
// (never git's registry) and resolves each entry's parent repo from its OWN
// `.git` gitdir pointer — never a fixed/assumed repoDir, which matters on a
// host with more than one checkout of the same project. It is intentionally
// MORE conservative than pruneStaleRuns: every path that is not a definitely-
// alive pid still goes through the age gate (pruneStaleRuns lets a
// definitively-dead pid skip that grace; this reaper does not need that
// nuance — it runs on a cadence, not to urgently reclaim a name collision at
// run start), so a wrong reap here would take strictly longer to happen.
```

## DEFAULT_WORKTREE_REAP_GRACE_MS

`src/lib/worker.ts:4277-4282` at `ea02cc83`.

```
/**
 * The CADENCE reaper's own age ceiling (W1-T378) — see plan/policy.yaml's `worktreeReapGraceMs`
 * for the measurement behind the number. Deliberately NOT {@link DEFAULT_PRUNE_GRACE_MS}: that
 * one is consumed by six `pruneStaleRuns` call sites at RUN START, where a longer value delays
 * reclaiming a colliding worktree name; this reaper runs on a cadence with no such urgency.
 */
```

## newestActivityMs

`src/lib/worker.ts:4310-4332` at `ea02cc83`.

```
/**
 * The newest mtime anywhere under `dir`, and whether the walk could be trusted (W1-T378).
 *
 * WHY THIS EXISTS. `reapStaleWorktrees` age-gated on `statSync(worktreeRoot).mtimeMs`, and a
 * DIRECTORY's mtime advances only when an entry is added to or removed from THAT directory —
 * never when a file nested inside it is modified. A worker editing `src/lib/feedback.ts` touches
 * `src/lib/`'s mtime, not the root's; `git commit` in a linked worktree writes to
 * `<parent>/.git/worktrees/<name>/index`, outside the tree entirely. So the root's mtime was
 * effectively FROZEN AT CHECKOUT and the age gate degraded to "reap unconditionally".
 * MEASURED CONSEQUENCE (2026-08-05, W1-T350): a run that was actively committing had its worktree
 * destroyed 40 minutes in; it stayed alive another 51 minutes but lost its ledger identity, and the
 * task re-dispatched and rebuilt itself (see W1-T377 for the other half of that incident).
 *
 * BOUNDED, because this runs per candidate on every cadence pass: `.git` and `node_modules` are
 * never descended into ({@link ACTIVITY_SKIP_DIRS}) — `.git` churns for reasons unrelated to the
 * worker and `node_modules` is a symlink to the shared canonical tree on this host — and the walk
 * stops after {@link ACTIVITY_WALK_ENTRY_CAP} entries.
 *
 * `complete: false` means DO NOT TRUST `mtimeMs`: either the walk hit the cap (so the max is
 * partial and could be older than the true newest) or a read failed. Callers must treat that as
 * unknown-and-keep, never as "old enough to reap" — a partial max is exactly the value that would
 * destroy live work.
 */
```

## keptReasons

`src/lib/worker.ts:4393-4399` at `ea02cc83`.

```
  /**
   * W1-T378: the SAME entries as {@link WorktreeReapSummary.kept}, each paired with the reason it
   * survived, so a pass that keeps everything is diagnosable instead of silent — and so the
   * `activity-unknown` keeps (the ones that bound disk growth) are visible to an operator.
   * OPTIONAL so callers holding a `{ reaped: [], reapedLocks: [], kept: [] }` literal keep
   * typechecking; {@link reapStaleWorktrees} always populates it.
   */
```

## dryRun

`src/lib/worker.ts:4426-4432` at `ea02cc83`.

```
  /**
   * W1-T406: SURVEY ONLY when true — an entry that would be reaped is still recorded in the
   * returned `reaped`/`reapedLocks` (so a caller can ledger exactly what it would reclaim),
   * but nothing is actually removed from disk. Mirrors {@link reapStaleClones}'s own `dryRun`
   * shape. Default false, unchanged for every existing caller (the daemon poll hook and
   * `rmd sweep`, via {@link runWorktreeReapRung}, never pass this).
   */
```

## worktreeLockIsPidAlive

`src/lib/worker.ts:4436-4457` at `ea02cc83`.

```
/**
 * A {@link WorktreeReapOpts.isPidAlive}-shaped predicate for the W1-T406 ONE-SHOT CONTAINER
 * boot rung: answers "is THIS the same process that wrote the lock", not merely "does some
 * process hold this pid right now". {@link defaultIsPidAlive} (drain-lock.ts, `process.kill(pid,
 * 0)`) answers only the second question — it reads this container's OWN pid namespace, which
 * restarts at 1 on every `docker run`. A lock written by a previous boot naming a low pid
 * therefore very often finds that number ALIVE as an entirely unrelated process, and
 * reapStaleWorktrees then takes the live-pid keep branch and never reaps it — PERMANENT
 * NON-RECLAMATION, the shape of the 3.0 GB this task was filed against, not destruction.
 *
 * Reuses {@link isHolderStale} (fs-race-safe.ts, W1-T396/W1-T368) exactly as written rather
 * than reinventing its rung-3 start-time comparison — `pid`/`startedAt` structurally satisfy
 * {@link HolderIdentity} with no `host` key at all, so isHolderStale's host rung (rung 1) is
 * skipped by construction; there is nothing for it to read. `RunLockInfo` deliberately gains
 * no `host` field to make that rung reachable — see this task's plan shard for why that would
 * import the exact hazard (a container's hostname changing every boot) this predicate exists
 * to avoid.
 *
 * `deps` is injectable (tests only — appended LAST, defaulting to the real syscalls) so the
 * pid-reuse scenario itself — a live pid whose ACTUAL start time is after the lock's recorded
 * `startedAt` — is drivable without a real process wrapping a real pid number.
 */
```

## resolveWorktreeRepoDir

`src/lib/worker.ts:4466-4472` at `ea02cc83`.

```
/**
 * Resolve a linked worktree's parent repoDir from its OWN `.git` gitdir pointer file
 * — `gitdir: <repoDir>/.git/worktrees/<name>` — rather than assuming a fixed repoDir.
 * Returns null when `entryPath` is not a linked git worktree at all (no `.git` file,
 * or it does not parse): exactly the shape hole (1) exists to cover — debris that
 * never was, or no longer is, a registered worktree.
 */
```

## resolveWorktreeRegistration

`src/lib/worker.ts:4496-4502` at `ea02cc83`.

```
/**
 * Cross-reference `entryPath` against `git worktree list --porcelain` for its OWN
 * resolved repoDir (never a fixed/assumed one — the multi-checkout lesson from this
 * task's fixture forensics). Returns null when git does not register this path at
 * all under that repo, which this function treats identically to "not a worktree" —
 * both are hole (1) debris with no branch to consult.
 */
```

## WorktreeRemovalPlan

`src/lib/worker.ts:4510-4517` at `ea02cc83`.

```
/**
 * HOW an aged, terminal reap candidate must be REMOVED — never WHETHER it should be, which
 * every gate above this decides and this function deliberately does not revisit.
 *
 * `git-remove` deletes the working tree AND its admin record in one operation, in the parent.
 * `rm-only` deletes the tree directly, and carries the parent (when one exists) so the caller
 * can `git worktree prune` behind it. `keep` destroys nothing.
 */
```

## planWorktreeRemoval

`src/lib/worker.ts:4523-4570` at `ea02cc83`.

```
/**
 * Decide {@link WorktreeRemovalPlan} for `entryPath` from its OWN `.git`, BEFORE anything is
 * destroyed.
 *
 * WHY THIS EXISTS (the 2026-07-31 destruction, CLAUDE.md "Never do interactive work inside
 * `<config.root>/worktrees`"). `reapStaleWorktrees` removed every candidate with a bare
 * `fs.rmSync`. Everything under {@link worktreesDir} is a LINKED worktree — {@link worktreeAdd}
 * is what puts it there — and a linked worktree's admin record lives in the PARENT clone at
 * `<repoDir>/.git/worktrees/<name>`. `rm -rf` on one deletes the tree and STRANDS that record:
 * `git worktree list` reports it `prunable`, and git still refuses to re-check-out the branch
 * (`fatal: '<branch>' is already used by worktree at <path>`) on the next run that mints the same
 * name. `lib/clone-reaper.ts`'s own header cites this same failure as its reason for touching
 * nothing whose `.git` is not a DIRECTORY; this function is the other half of that lesson —
 * the reaper that DOES own linked worktrees, removing them through git instead of around it.
 *
 * THE CASES, and why each primitive is the correct one rather than a fallback:
 *
 *   `.git` ABSENT — not a worktree at all: hole (1) debris, or a tree something else already
 *     removed mid-pass. No record anywhere points at it, so `rmSync` strands nothing. `rm-only`.
 *
 *   `.git` is a DIRECTORY — a STANDALONE clone. It owns its objects and its admin dir outright,
 *     so removing the tree removes every record with it. `rm-only`.
 *
 *   `.git` is a FILE and the resolved parent REGISTERS this path — the real linked case, and the
 *     only one that can strand anything. `git-remove`: `git worktree remove --force` in that
 *     parent, the same primitive {@link pruneStaleRuns} already uses.
 *
 *   `.git` is a FILE, the parent exists, but does NOT register this path — the record is already
 *     gone (a parent that pruned it, or a tree that was never registered there). There is nothing
 *     left to strand, so `rmSync` is CORRECT here, not a concession; the `repoDir` rides along so
 *     the caller can prune behind it anyway, which is idempotent and collects any record this
 *     lookup could not see.
 *
 *   `.git` is a FILE and the parent is ABSENT — the parent clone is gone, so no admin record can
 *     exist to be stranded and no `git worktree remove` is even possible. `rmSync` is the only
 *     primitive left AND is safe for exactly that reason. (This is the shape 52 of the 54
 *     directories measured in `$HOME` on 2026-09-04 had: linked worktrees outliving their parent.)
 *
 *   `.git` is UNREADABLE or UNPARSEABLE — whether a record exists is UNKNOWABLE, so this KEEPS.
 *     An ambiguous signal never destroys; that is the same direction `activity-unknown` already
 *     fails one gate above, and the direction the 2026-07-31 incident was decided in the wrong
 *     one. A kept directory costs disk; a wrongly removed one costs work.
 *
 * `registration` is the caller's ALREADY-COMPUTED {@link resolveWorktreeRegistration} result —
 * threaded in rather than re-derived so this decision cannot disagree with the `live-branch`
 * gate that read the same lookup, and so the reaper still shells `git worktree list` exactly once
 * per entry.
 */
```

## executeWorktreeRemoval

`src/lib/worker.ts:4600-4613` at `ea02cc83`.

```
/**
 * Execute a {@link planWorktreeRemoval} decision. Throws on failure so the reaper's own
 * per-entry try/catch records `removal-failed` and the pass continues — the same best-effort
 * shape every other removal in this file already has.
 *
 * `--force` is deliberate and is what keeps this a DEFECT FIX rather than a selection change:
 * plain `git worktree remove` refuses on a tree with modified OR untracked files (measured:
 * `fatal: '<path>' contains modified or untracked files, use --force to delete it`), and a stale
 * run worktree nearly always carries untracked build output — so omitting `--force` would keep
 * almost everything and silently disable the W1-T175 reaper. Today's `rmSync` already removes
 * these trees unconditionally; `--force` reproduces exactly that set while adding the admin-record
 * cleanup. WHETHER a dirty tree deserves protection is a SELECTION question, owned by the
 * liveness/age gates above, and is not reopened here.
 */
```

## defaultBranchIsLiveUpstream

`src/lib/worker.ts:4636-4642` at `ea02cc83`.

```
/**
 * Default {@link WorktreeReapOpts.branchIsLiveUpstream}: does `branch` still exist on
 * `origin`? Mirrors the fixture forensics' own check (`gh api .../branches/<b>` => 404
 * ⇒ deleted upstream) with plain git plumbing. FAIL CLOSED on anything ambiguous — a
 * network hiccup or an unexpected exit code is reported as "still live", never as
 * grounds to reap; only git's own not-found signal (exit 2) says the branch is gone.
 */
```

## reapStaleWorktrees

`src/lib/worker.ts:4654-4667` at `ea02cc83`.

```
/**
 * Cadence reaper for `root` (pass {@link worktreesDir}(config)) — the backstop for
 * pruneStaleRuns' three coverage holes (see the block comment above). Fail-closed
 * throughout: a live pid is NEVER reaped; a branch still live upstream is NEVER
 * reaped, however old; everything else is reaped only once past `maxAgeMs`. A
 * per-entry failure (a removal hiccup, an unreadable entry) is best-effort and
 * never blocks the rest of the pass — mirrors pruneStaleRuns' own per-item guards.
 *
 * HOW an entry is removed is a separate decision from WHETHER, and lives in
 * {@link planWorktreeRemoval}: a LINKED worktree (which is what {@link worktreeAdd} puts under
 * {@link worktreesDir}) dies through `git worktree remove --force` in its own parent, so its
 * admin record dies with it. A bare `rmSync` here is what stranded records as `prunable` and
 * left git refusing the branch — the 2026-07-31 destruction CLAUDE.md records.
 */
```

## reapStaleWorktrees — activity

`src/lib/worker.ts:4724-4732` at `ea02cc83`.

```
    // Terminal by every available signal: no live pid, and either git no longer
    // registers this directory at all (hole 1), it is registered but on a detached
    // HEAD with no branch to check (hole 3), or its branch is confirmed
    // merged-or-deleted upstream. Age-gate before acting on any of them.
    // AGE GATE, W1-T378: measured against the newest mtime ANYWHERE IN THE TREE, not the root
    // directory's own — see {@link newestActivityMs} for why the root's is frozen at checkout and
    // what that cost. An INCOMPLETE probe means liveness is unknown, and an ambiguous signal keeps
    // — that holds regardless of `lockNamesDeadPid`: "unknown" and "confirmed dead" are different
    // questions, and only the latter overrides the rescue below (W1-T381).
```

## widowSuffixes

`src/lib/worker.ts:4772-4780` at `ea02cc83`.

```
  // Widowed `.lock`/`.base` siblings whose worktree dir is already gone (hole 3):
  // removeRunLock/removeWorktreeBase only ever fire INSIDE a successful removal
  // (worktreeRemove, pruneStaleRuns, or the reap above), so a sibling orphaned by any
  // OTHER path — e.g. a manual `rm -rf` of the worktree dir — lingers forever: a `.lock`
  // makes a dead run read as live to anything that trusts it, and a `.base` accumulates
  // without bound (W1-T2628 — pruneStaleRuns is one such other path, now closed above,
  // but this sweep still owes any widow left by causes this file cannot enumerate). No
  // age gate is owed here: the owning directory is already gone, so nothing in flight
  // can be harmed.
```

## runWorktreeReapRung

`src/lib/worker.ts:4798-4808` at `ea02cc83`.

```
/**
 * The W1-T175 worktree-reap RUNG: resolve `config`'s worktreesDir, run
 * {@link reapStaleWorktrees} against it, and best-effort-ledger the outcome via `log`. Shared by
 * `rmd sweep` (sweepCommand) and the daemon's own per-poll hook (buildSweepHook) so both run the
 * EXACT same rung on the EXACT same cadence-doctrine — pulled out to one place after the first
 * draft duplicated this try/catch verbatim at both call sites (a duplicate-drift risk the two
 * rungs' own doc comments already warned about). The try/catch here guards ONLY
 * `worktreesDir(config)` itself (a malformed `config.root` throws from `path.join`) —
 * {@link reapStaleWorktrees} is fail-closed internally and never throws under default opts — so
 * a reap-rung failure never masks, or is masked by, the caller's OWN error handling.
 */
```

## runWorktreeReapRung — undecidable

`src/lib/worker.ts:4817-4822` at `ea02cc83`.

```
    // W1-T378: an `activity-unknown` keep is the one outcome that needs its own row. It is the
    // reaper declining to decide, and it is what bounds disk growth now that an ambiguous signal
    // keeps rather than destroys — so a tree that can never be probed would otherwise accumulate
    // silently, which is exactly the invisible-leak shape W1-T175 was filed against. Logged even
    // when nothing was reaped (the pass above stays quiet in that case), and NOT logged for the
    // ordinary live-pid/live-branch/recent-activity keeps, which are the reaper working correctly.
```

## runAdhocLaneReapRung

`src/lib/worker.ts:4831-4852` at `ea02cc83`.

```
/**
 * W1-T2847 — THE AD-HOC LANE RUNG: the same reaper, pointed at {@link adhocLaneRoot}, shipping
 * SURVEY-FIRST.
 *
 * NO SECOND REMOVAL, BY CONSTRUCTION. This delegates to {@link reapStaleWorktrees}, which already
 * classifies a candidate from its own `.git` and removes a linked worktree through
 * {@link planWorktreeRemoval}/{@link executeWorktreeRemoval} — `git worktree remove --force` in the
 * resolved parent, falling back to `rmSync` only where no admin record can be stranded, and KEEPING
 * on an unreadable `.git`. A bare `fs.rmSync` here would reinstate the 2026-07-31 defect that work
 * exists to close, so there is deliberately no filesystem call in this function at all.
 *
 * THE LIVENESS DOCTRINE IS INHERITED WHOLE, not re-decided: live pid, live upstream branch however
 * old, and an incomplete activity probe all KEEP, because that is what `reapStaleWorktrees` already
 * does. This function adds one thing only — a different root and a different age ceiling.
 *
 * SURVEY-FIRST IS THE DEFAULT AND THE DEFAULT IS OFF. `enabled` defaults to `false`, so the pass
 * runs with `dryRun: true` and ledgers exactly what it WOULD reclaim while removing nothing. That
 * is the same posture `worktreeReapBoot` and `scratchReap` ship in, and against a measured
 * population of 180 LIVE operator lanes it is not caution but the only responsible default: an
 * operator reads several passes' dispositions before arming it. Arming is a separate operator
 * decision, and the `enabled` seam is where it lands.
 */
```

## unmanagedWorktreeLanes

`src/lib/worker.ts:4910-4924` at `ea02cc83`.

```
/**
 * W1-T2847 design (vi), the REPORTING half: every worktree git itself has registered for
 * `repoDir` that lives under NEITHER {@link worktreesDir} NOR {@link adhocLaneRoot} — the lanes
 * no cadence can reach.
 *
 * READS GIT'S OWN REGISTRATION, never a shell-command pattern. The design names this explicitly:
 * the console account's 154 lanes were cut by Codex rather than Claude Code, so a session-hook
 * matching `worktree add` in one agent's command log would have observed none of them.
 * `git worktree list --porcelain` is agnostic about who created the entry.
 *
 * REPORTS, NEVER REAPS. The returned paths are outside both managed roots by definition, so
 * nothing in this file may act on them — rationale (2) measured 180 such lanes ALL LIVE. This
 * exists so the survey can NAME the unmanaged population instead of leaving it invisible, which is
 * the whole reason 4.7G accumulated with no ledger row.
 */
```

## GhRateLimitReading

`src/lib/worker.ts:4960-4971` at `ea02cc83`.

```
/**
 * `gh`'s `X-Ratelimit-*` response headers, parsed off the SAME response the metered call itself
 * carried (W1-T525 design (iii)) — never a separate `gh api rate_limit` probe. That probe is
 * FREE (measured: ten such calls moved `used` by 4 while ten real calls moved it by 23) which is
 * exactly what makes it tempting, but it answers about a DIFFERENT bucket with a DIFFERENT reset
 * — measured back to back, an ordinary `gh api repos/…` call carried remaining=3259 while `gh api
 * rate_limit` in the same window reported remaining=4960. A floor read from the probe would be
 * wrong by the gap between those two numbers. All fields are `undefined` when the header was
 * absent, which is every `gh` invocation this file issues that is not `gh api …` — `pr view`,
 * `pr list`, etc. are answered over GraphQL internally and carry no REST rate-limit header for
 * the CLI to expose.
 */
```

## GH_RATE_LIMIT_BUCKET_UNKNOWN

`src/lib/worker.ts:5004-5012` at `ea02cc83`.

```
/**
 * W1-T1235 — sentinel recorded for a bucket or reset that could not be READ, never one that was
 * merely inconvenient to look up: an unreadable reset must be recorded as unknown rather than
 * given an invented wait (design (ii)/(iii) of this task — the exact discipline
 * `defaultGhRetryAfterSeconds` (lib/open-prs-rest.ts) already applies to its own `undefined`
 * return). Shared by every consumer of {@link GhRateLimitRefusal} — the auto-merge arm's own row
 * and `rmd status`'s GitHub-buckets section both render "no reading" identically, rather than
 * each inventing its own ad hoc placeholder string.
 */
```

## ghRateLimitRefusalFromReading

`src/lib/worker.ts:5030-5043` at `ea02cc83`.

```
/**
 * W1-T1235 — THE ONE PLACE a {@link GhRateLimitReading} becomes a refusal record.
 *
 * `remaining === 0` is the ONLY evidence this treats as an actual refusal: a reading with
 * `remaining` merely low, or entirely absent (every non-`gh api` call {@link ghJson} issues —
 * see that function's own doc), returns `undefined` rather than a manufactured refusal, so a
 * call that was never rate limited produces no row (design (iv); this is what keeps ordinary
 * traffic from ever seeding a false refusal).
 *
 * `bucket` is read off `reading.resource` ALONE, `resetsAt` off `reading.reset` ALONE — either
 * missing renders {@link GH_RATE_LIMIT_BUCKET_UNKNOWN}, never inferred from `operation` and
 * never invented. This is what makes the bucket this function names provably the response's
 * OWN field rather than a guess keyed on which caller happened to be refused.
 */
```

## ghRateLimitRefusalUnknown

`src/lib/worker.ts:5056-5069` at `ea02cc83`.

```
/**
 * W1-T1235 — the auto-merge arm's OWN shape: `gh pr merge --auto` is `execFileSync`'d directly
 * (run-task.ts's `ArmDeps.armAuto`), never through {@link ghJson}, so no header block ever
 * reaches this file for it — see {@link ghJson}'s own doc, above, "captures stderr TEXT, never
 * headers". A refusal recognisably rate-limit-SHAPED by its stderr text (run-task.ts's own
 * narrow `armFailureIsRateLimited` classifier) is still worth NAMING as one — design (ii)'s
 * second acceptable option — rather than folding silently into the same undifferentiated
 * `arm-error-ignored` bucket every other permanent refusal already falls into.
 *
 * Both fields are {@link GH_RATE_LIMIT_BUCKET_UNKNOWN}: this is called ONLY when there is no
 * header to read, so hardcoding `"graphql"` here — however true structurally (the arm has no
 * REST form at all) — would be exactly the by-caller inference {@link ghRateLimitRefusalFromReading}'s
 * own doc forbids for a refusal record. Honest-unknown, not a guess.
 */
```

## splitGhHeaderBlock

`src/lib/worker.ts:5074-5081` at `ea02cc83`.

```
/**
 * Split `gh api -i`'s combined stdout into its HTTP header block and its JSON body — mirroring
 * curl's `-i`: a status line, the response headers (CRLF-terminated, per measurement), one blank
 * line, then the body. Anything that does not start with an HTTP status line (every `gh`
 * invocation this file issues that is not `gh api …`, which never receives `-i` — see
 * {@link ghJson}) is returned whole as `body` with an empty `headers` block, so a caller with no
 * reading to parse can never mis-split real JSON.
 */
```

## ghJson

`src/lib/worker.ts:5089-5117` at `ea02cc83`.

```
/**
 * Shared `gh ... --json` invocation + parse, used by ~13 call sites across run-task.ts (mostly
 * single-PR `pr view` reads, O(1) regardless of repo size). W1-T181's sibling-audit named exactly
 * ONE of those callers as repo-size-SCALING: run-task.ts's `buildOpenPrViews` (`pr list --state
 * open --limit 100 --json ...,body,...,statusCheckRollup`) — up to 100 open PRs' full bodies +
 * check rollups in one payload, the same shape (body-heavy, N-PRs-wide) that crossed Node's 1 MiB
 * `execFileSync` default and caused status.ts's batched-board-gateway outage. `maxBuffer` is
 * therefore set here, on the ONE shared codepath, rather than duplicated per call site — it is
 * strictly headroom (`1 << 24` = 16 MiB, the orientation.ts:72 in-repo precedent) for every other
 * O(1) caller, since a larger ceiling costs nothing unless it is actually approached.
 *
 * W1-T525: THE METERED ENTRY POINT — the single place a `gh` invocation is issued AND observed.
 * For a `gh api …` call this now passes `-i`/`--include` (today ZERO sites do — the rationale's
 * "NOTHING READS THE HEADER, AND NOTHING EVEN RECEIVES IT"), splits the response into its header
 * block and body, parses the rate-limit reading off THAT header block, and — when `onRateLimit`
 * is supplied — hands the reading back before returning, so a caller can feed it to
 * `GhCallPacer.recordResult` (lib/open-prs-rest.ts) and widen pacing proactively, before any call
 * has failed (design ii). `-i` is added ONLY for `gh api` calls: it is not a flag `gh pr
 * view`/`gh pr list`/etc. accept (confirmed against `gh`'s own `--help`), and those subcommands
 * are answered over GraphQL internally, so they carry no REST rate-limit header to read either
 * way. The parsed body returned is byte-for-byte what `JSON.parse(out)` returned before this
 * change, and `onRateLimit` is optional — every existing call site (all 11 today) omits it and is
 * therefore unaffected: this changes no caller's contract.
 *
 * `exec` is injectable (mirrors `GhApiFetcher`/`ghGateway`'s own `opts.exec` seam elsewhere in
 * this codebase) purely so this metered entry point itself is testable with zero network and no
 * real `gh` binary — this leaf previously had no test driving it at all. Every real caller omits
 * it and gets the genuine `execFileSync`.
 */
```

## ghPrMergeSquash

`src/lib/worker.ts:5142-5147` at `ea02cc83`.

```
  // W1-T1050: NO `--delete-branch`. `gh pr merge --help` documents the flag as deleting the
  // LOCAL branch too, which needs a resolvable current branch — a caller running from the
  // daemon's deliberately detached checkout (the self-sync guard depends on that) has none, so
  // the call failed "not on any branch" even when the merge itself landed. The repository
  // already carries `delete_branch_on_merge: true`, so the head branch is still deleted, just
  // server-side rather than by this local call.
```

