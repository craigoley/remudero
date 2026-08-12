/**
 * lib/host-parity.ts — RUN THE SUITE ON BOTH POLES AND DIFF THE FAILURE SETS.
 *
 * THE GAP. `ci` runs `ubuntu-latest`. The review judge runs the operator's mac mini (`judgeReview`
 * has exactly one non-test caller, `src/run-task.ts`; no workflow invokes `rmd review`). NOTHING
 * RUNS BOTH, so a test whose answer depends on the machine is discovered only when somebody happens
 * to execute on the other pole. The measured record of that convention: NINE encounters, EIGHT
 * independent rediscoveries, ZERO durable entries — eight test files each carry a prose comment
 * explaining the trap, written by people who did not know the others existed, and one of them counts
 * the victims ("three suites in this repo already fail that way") WITHOUT LISTING WHICH THREE.
 *
 * THIS IS test/spawn-guard.test.ts'S MOVE ONE LEVEL UP. Its header states the argument in full: the
 * old protection was "successive briefs telling each session not to run that file — a convention
 * that depends on every future reader of every future brief, and that has already failed once," and
 * the fix was to replace the convention with a STRUCTURAL check. Here the convention is "remember
 * that a test can be host-dependent" and the structure is "run both poles and diff the failure
 * SETS".
 *
 * WHY A DIFF AND NOT A COUNT. A count cannot detect a MISSED FORM — the same reason a prior session
 * found `run.start` at 257,438 raw lines but 779 distinct. Two divergences that appear while two
 * others heal is a stable count of four and a completely different suite. Both directions matter and
 * both are real today: `test/fleet-heartbeat.test.ts`'s BSD tests fail on the mini, and
 * `test/recon-gaps-relayed.test.ts`'s byte-identity test fails on a runner.
 *
 * NOT A GATE, DELIBERATELY. Four bounds in this repo have fired on a healthy condition
 * (ci-gate's wait cap, the deploy ceiling consumed by a dry run, the check-wait bound where 21 of 21
 * booked PRs merged, the headroom park). A host-divergence check that blocked merges would be the
 * fifth. {@link runHostParity} returns a verdict and writes a `plan/feedback/` record; it never
 * throws, and its runner always exits 0.
 *
 * THE BASELINE IS DECLARED, NOT DISCOVERED. The divergence set is NON-EMPTY today, so a report that
 * fires every run is noise. {@link HOST_PARITY_BASELINE} is `CI_PARITY_TABLE`'s shape one level down
 * (`src/lib/ci-parity.ts`): a considered exclusion carries a REASON and an absent entry does not
 * look like one. A NEW divergence is the finding; a DECLARED one is silence; and a declared entry
 * that STOPS failing is also reported, because a baseline nobody prunes decays into a mute button.
 */

/** `test/<file>.test.ts::<title>` — the identity a divergence is tracked by. A bare title is not
 *  enough: several titles in this repo appear verbatim in more than one file (`THE OTHER
 *  DIRECTION…`), and a collision would let one pole's failure mask another's. */
export type DivergenceId = string;

/**
 * THE DECLARED DIVERGENCES, each with the reason it is not a defect to chase today.
 *
 * MEASURED on this mini at `11dcbf0` (6,496 tests, 4 failures, 107s) and against the `ci` job's own
 * green requirement. Every entry was re-run IN ISOLATION rather than trusted from a whole-suite
 * run — the three known whole-suite flakes (`test/worker-containment`, the W1-T356 wiring suite, the
 * `lint-plan --base`/`--all` byte-identity test) did not fire in that run at all, which is exactly
 * why they are absent here: a flake is not a divergence and must not be declared as one.
 */
export const HOST_PARITY_BASELINE: DeclaredDivergence[] = [
  {
    test: "test/fleet-heartbeat.test.ts::the BSD/macOS branch of epoch_of computes the SAME age the GNU branch does",
    pole: "mini",
    reason:
      "the BSD_DATE stub emulates BSD by delegating its parse to `/usr/bin/date -u -d`, which ON MACOS IS BSD DATE and rejects -d. Linux-only by construction; the file's own header says the branch 'has never run anywhere'.",
  },
  {
    test: "test/fleet-heartbeat.test.ts::FINDING: a `date` that ACCEPTS -d but ignores it makes every beat report a dead daemon as live",
    pole: "mini",
    reason: "same BSD_DATE stub, same cause — the IGNORES_D variant also delegates to `/usr/bin/date`.",
  },
  {
    test: "test/worker-credential-preflight.test.ts::spawnWorker REFUSES before spawning when the file holds no Claude credential",
    pole: "mini",
    reason:
      "on darwin the classifier reaches the login-keychain re-provisioning path, so the reason class is `credential-item-missing` where a Linux runner reports `credential-file-malformed`.",
  },
  {
    test: "test/worker-credential-preflight.test.ts::spawnWorker does NOT refuse a healthy credential — it reaches the spawn attempt",
    pole: "mini",
    reason: "same darwin keychain path — the preflight refuses before the spawn attempt this asserts is reached.",
  },
  {
    test: "test/recon-gaps-relayed.test.ts::the RECON prompt is byte-identical to origin/main's — this changes the implement side only",
    pole: "ci",
    reason:
      "it runs `git show origin/main:src/run-task.ts`, and `.github/workflows/ci.yml` uses actions/checkout with NO fetch-depth, so that ref does not exist on a runner. DECLARED BY HAND: the ci pole has no machine-readable failure set (see readTapFailures' doc), so nothing populates this automatically.",
  },
];

/** Which machine a divergence belongs to. `mini` is the operator's mac — the host the review judge
 *  runs proofs on. `ci` is `ubuntu-latest`. */
export type HostPole = "mini" | "ci";

/** One entry in {@link HOST_PARITY_BASELINE}: a divergence somebody looked at and chose to keep. */
export interface DeclaredDivergence {
  test: DivergenceId;
  pole: HostPole;
  /** Why this is expected rather than a defect. An entry with no reason is an absent entry wearing
   *  a costume — the distinction `CI_PARITY_TABLE` exists to preserve. */
  reason: string;
}

/** What a TAP stream actually said. `complete` is load-bearing and is checked before `failures` is
 *  ever read: a killed or timed-out run prints every assertion it reached and no totals, so its
 *  failure set is a SUBSET BY CONSTRUCTION and reads as "fewer divergences". */
export interface TapReading {
  complete: boolean;
  failures: DivergenceId[];
  tests?: number;
  failed?: number;
}

/** The set diff, in BOTH directions, plus the third case a count would hide. */
export interface ParityDiff {
  /** Observed on this pole and NOT declared — the finding. */
  undeclared: DivergenceId[];
  /** Declared for this pole and NOT observed — the baseline is stale and would mute a real
   *  divergence if that test ever failed again for a different reason. */
  healed: DeclaredDivergence[];
  /** Declared and observed — silence, but reported so the run can prove it looked. */
  declaredSeen: DeclaredDivergence[];
}

/**
 * `/…/test/foo.test.ts:2:5626` → `test/foo.test.ts`.
 *
 * The two poles report different absolute roots (`/Users/craigoleyagent/…` vs
 * `/home/runner/work/…`), so an identity built on the raw location can never match across them.
 * Anchoring on the LAST `/test/` also survives a checkout whose own path contains the word.
 */
export function normaliseTestPath(location: string): string {
  const withoutPosition = location.replace(/:\d+:\d+$/, "");
  const idx = withoutPosition.lastIndexOf("/test/");
  if (idx >= 0) return withoutPosition.slice(idx + 1);
  return withoutPosition.startsWith("test/") ? withoutPosition : (withoutPosition.split("/").pop() ?? withoutPosition);
}

/**
 * Read a node TAP stream for the identities of the tests that FAILED.
 *
 * TWO STREAMS IN ONE LOG. `scripts/test-with-retry.mjs` re-runs the WHOLE command once on red, so a
 * CI log routinely carries two complete TAP streams — measured live on #1644, where the same test
 * appears as both `not ok 3885` and `ok 3885`. The FINAL run is the one the job's conclusion came
 * from, so this reads the last completed stream and ignores everything before it. Counting both
 * would report a divergence that the retry already cleared.
 *
 * NO SUMMARY, NO RESULT. Without a trailing `# duration_ms` the run never finished, and this returns
 * `complete: false` with an EMPTY failure list that the caller must refuse to diff — never an empty
 * set that reads as "no divergences".
 *
 * WHY THIS PARSES TEXT AT ALL, and it is a fragility worth naming: `.github/workflows/ci.yml`'s `ci`
 * job runs `npm run test:ci` and uploads NOTHING — no artifact, no junit, no TAP file. The only
 * machine-readable trace of a CI failure set is the job log. The mini pole needs no such scraping
 * (this reads its own run's stdout), which is why the mini direction is automated and the ci
 * direction is declared by hand.
 */
export function readTapFailures(tap: string): TapReading {
  const lines = tap.split("\n");
  const summaryAt: number[] = [];
  for (let i = 0; i < lines.length; i++) if (/^# duration_ms\b/.test(lines[i] ?? "")) summaryAt.push(i);
  if (summaryAt.length === 0) return { complete: false, failures: [] };
  const end = summaryAt[summaryAt.length - 1] ?? lines.length;
  const start = summaryAt.length > 1 ? (summaryAt[summaryAt.length - 2] ?? -1) + 1 : 0;

  const failures = new Set<DivergenceId>();
  let tests: number | undefined;
  let failed: number | undefined;
  for (let i = start; i <= end; i++) {
    const line = lines[i] ?? "";
    const totals = /^# (tests|fail) (\d+)$/.exec(line);
    if (totals) {
      if (totals[1] === "tests") tests = Number(totals[2]);
      else failed = Number(totals[2]);
      continue;
    }
    const result = /^not ok \d+ - (.+?)\s*$/.exec(line);
    if (!result) continue;
    const title = result[1] ?? "";
    // The YAML diagnostic block that follows carries `location:`. Scan only until the block ends
    // (`...`) so a later failure's location can never be attributed to this one.
    let file = "";
    for (let j = i + 1; j < lines.length && j < i + 40; j++) {
      const body = lines[j] ?? "";
      if (/^\s*\.\.\.\s*$/.test(body)) break;
      const loc = /^\s*location:\s*'(.+)'\s*$/.exec(body);
      if (loc) {
        file = normaliseTestPath(loc[1] ?? "");
        break;
      }
    }
    failures.add(file ? `${file}::${title}` : title);
  }
  return { complete: true, failures: [...failures].sort(), tests, failed };
}

/**
 * The set diff against the declared list, for ONE pole.
 *
 * Scoped by pole on purpose: a mini run must not report `test/recon-gaps-relayed.test.ts`'s
 * ci-pole entry as healed merely because the mini passes it. That is the whole point of the entry.
 */
export function diffHostParity(input: {
  observed: readonly DivergenceId[];
  pole: HostPole;
  baseline?: readonly DeclaredDivergence[];
}): ParityDiff {
  const declared = (input.baseline ?? HOST_PARITY_BASELINE).filter((d) => d.pole === input.pole);
  const declaredIds = new Set(declared.map((d) => d.test));
  const observed = new Set(input.observed);
  return {
    undeclared: [...observed].filter((id) => !declaredIds.has(id)).sort(),
    healed: declared.filter((d) => !observed.has(d.test)),
    declaredSeen: declared.filter((d) => observed.has(d.test)),
  };
}

/** The three things a run can conclude. `inconclusive` is NOT `clean` — see {@link readTapFailures}. */
export type HostParityStatus = "inconclusive" | "clean" | "drift";

/** One run's whole result, including the text a human reads. */
export interface HostParityOutcome {
  status: HostParityStatus;
  pole: HostPole;
  reading: TapReading;
  diff?: ParityDiff;
  /** Undeclared in the glob run and REPRODUCED when its file was run alone — the reportable set. */
  confirmed: DivergenceId[];
  /** Undeclared in the glob run and PASSED when its file was run alone: a flake, not a divergence. */
  unconfirmed: DivergenceId[];
  report: string;
  /** True iff the feedback sink was invoked. Never true on `inconclusive`. */
  captured: boolean;
}

/** Seams, all injectable so no test spawns a suite or writes a feedback entry. */
export interface HostParityDeps {
  pole: HostPole;
  /** Runs the suite and returns its combined output. A nonzero exit is ORDINARY here (a failing
   *  test), so this must return the output rather than throw on it. */
  runSuite: () => string;
  /**
   * Re-runs ONE undeclared failure's own file, alone, and answers whether it failed again.
   *
   * WHY THIS EXISTS, measured on this checker's FIRST live run: it reported exactly one undeclared
   * entry, and that entry was the W1-T356 wiring test — one of the three known whole-suite flakes.
   * Without this step the tool's own output would have been noise on day one, which is the failure
   * mode the declared baseline exists to prevent. A whole-FILE re-run rather than a
   * `--test-name-pattern` one on purpose: titles here carry regex metacharacters and em dashes, and
   * a name filter that resolves to zero tests reports `ok` for the file wrapper and reads as a pass.
   *
   * Omitted ⇒ every undeclared entry is reported unconfirmed-but-included, the pre-confirmation
   * behaviour, so a caller with no way to re-run still gets the finding rather than silence.
   */
  confirm?: (id: DivergenceId) => boolean;
  /** Where a drift report lands. Omitted ⇒ report-only. */
  capture?: (raw: string) => void;
  baseline?: readonly DeclaredDivergence[];
  headSha?: string;
}

/** The human-facing text, and the body of the `plan/feedback/` record when one is written. */
export function renderHostParityReport(input: {
  pole: HostPole;
  reading: TapReading;
  diff?: ParityDiff;
  headSha?: string;
  confirmed?: readonly DivergenceId[];
  unconfirmed?: readonly DivergenceId[];
}): string {
  const at = input.headSha ? ` at ${input.headSha}` : "";
  if (!input.diff) {
    return (
      `HOST PARITY (${input.pole})${at}: INCONCLUSIVE — the suite produced no trailing summary line, so ` +
      "its failure set is a subset by construction and was NOT diffed. A truncated run is not a result."
    );
  }
  const { undeclared, healed, declaredSeen } = input.diff;
  const confirmed = input.confirmed ?? undeclared;
  const unconfirmed = input.unconfirmed ?? [];
  const head =
    `HOST PARITY (${input.pole})${at}: ${input.reading.tests ?? "?"} tests, ` +
    `${input.reading.failures.length} failing — ${declaredSeen.length} declared, ${confirmed.length} undeclared, ` +
    `${healed.length} declared-but-passing, ${unconfirmed.length} flaky.`;
  const parts = [head];
  if (confirmed.length) {
    parts.push(
      "",
      `NEW DIVERGENCE on ${input.pole} — these failed here, are not in HOST_PARITY_BASELINE, and REPRODUCED ` +
        "when their file was re-run alone:",
      ...confirmed.map((id) => `  - ${id}`),
      "",
      "Either the test is host-dependent (declare it, with the reason) or it is a real break the other " +
        "pole cannot see.",
    );
  }
  if (unconfirmed.length) {
    parts.push(
      "",
      "NOT REPORTED — failed in the glob run and PASSED when its file was re-run alone, so it is a flake " +
        "rather than a host divergence:",
      ...unconfirmed.map((id) => `  - ${id}`),
    );
  }
  if (healed.length) {
    parts.push(
      "",
      `DECLARED BUT PASSING on ${input.pole} — the baseline is stale and would now mute a real failure:`,
      ...healed.map((d) => `  - ${d.test}\n    was: ${d.reason}`),
    );
  }
  return parts.join("\n");
}

/**
 * One parity run, end to end. NEVER THROWS and never gates — the caller's exit code is always 0.
 *
 * A `drift` verdict writes ONE `plan/feedback/` record through the caller's sink. That destination
 * is chosen over a ledger row or a status rung because it is the only one that is tracked, durable
 * past a container, and already read: `captureFeedback` calls `landFeedback`, which rebuilds from
 * origin/main and force-pushes ONE shared `feedback-landing` branch behind ONE gated PR — never a
 * direct push to main, and no PR spam however often this runs.
 */
export function runHostParity(deps: HostParityDeps): HostParityOutcome {
  const reading = readTapFailures(deps.runSuite());
  if (!reading.complete) {
    const report = renderHostParityReport({ pole: deps.pole, reading, headSha: deps.headSha });
    return {
      status: "inconclusive",
      pole: deps.pole,
      reading,
      confirmed: [],
      unconfirmed: [],
      report,
      captured: false,
    };
  }
  const diff = diffHostParity({ observed: reading.failures, pole: deps.pole, baseline: deps.baseline });
  const confirmed: DivergenceId[] = [];
  const unconfirmed: DivergenceId[] = [];
  for (const id of diff.undeclared) {
    if (!deps.confirm || deps.confirm(id)) confirmed.push(id);
    else unconfirmed.push(id);
  }
  const report = renderHostParityReport({
    pole: deps.pole,
    reading,
    diff,
    headSha: deps.headSha,
    confirmed,
    unconfirmed,
  });
  // A flake is NOT drift: an entry that passed alone leaves the declared list correct, so reporting
  // it would be the noise the baseline exists to prevent.
  const drift = confirmed.length > 0 || diff.healed.length > 0;
  let captured = false;
  if (drift && deps.capture) {
    deps.capture(report);
    captured = true;
  }
  return { status: drift ? "drift" : "clean", pole: deps.pole, reading, diff, confirmed, unconfirmed, report, captured };
}
