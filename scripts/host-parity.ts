#!/usr/bin/env -S node --import tsx
/**
 * scripts/host-parity.ts — the SECOND POLE, run on the machine CI cannot be.
 *
 *   node --import tsx scripts/host-parity.ts
 *
 * Runs the whole suite HERE, diffs its failure set against `HOST_PARITY_BASELINE`, prints the
 * report, and writes ONE `plan/feedback/` record when the set has moved. ALWAYS EXITS 0 — this is
 * a report, never a gate (src/lib/host-parity.ts's header says why a fifth bound is the wrong
 * shape).
 *
 * WHY THE MINI AND NOT A CI MATRIX LEG. A `macos-latest` runner cannot reproduce this pole: it has
 * no MagicDNS FQDN (so git rejects its guessed committer, where the mini accepts one — #1645's whole
 * cause), no operator-populated `$HOME`, and no login keychain holding a real credential (the two
 * `worker-credential-preflight` divergences). A matrix leg would be a THIRD machine with its own
 * divergences, not a mirror of the judge. The judge's host must run it, because the judge's host is
 * what the verdict depends on.
 *
 * THE SCHEDULE IS AN OPERATOR ACTION and is deliberately not installed here. A launchd agent beside
 * the two that already exist is the whole of it — `com.remudero.supervisor` runs `rmd deploy-run` on
 * a `StartInterval` today, and this wants a `StartCalendarInterval` (once a day is plenty; the
 * divergence set moves when a fixture is written, not hourly). MEASURED COST on this host, with the
 * daemon dispatching and workers live: 107s for 6,496 tests. It does not need an idle gate.
 *
 * W1-T918: THIS FILE WAS `runHostParity`'S ONLY CALLER, AND NOTHING CALLED *IT* — no workflow, no
 * npm script, no daemon rung, and (before this change) no test either: every existing assertion in
 * test/host-parity.test.ts drove `runHostParity` directly from src/lib/host-parity.ts, so the
 * wiring in this file was itself unexercised. `runHostParityCli` below is the seam that fixes both
 * problems at once: it is the same logic the bottom-of-file entrypoint runs, pulled into an
 * exported, dependency-injected function so a test can be the "actual caller" the acceptance
 * criterion asks for, without spawning the real suite or writing a real feedback record. The
 * module-top-level block that used to run unconditionally now only fires when this file is
 * executed directly (`isMainModule`), so importing it — which a test must do to reach
 * `runHostParityCli` — no longer has the side effect of running the whole suite.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { captureFeedback } from "../src/lib/feedback.js";
import {
  HOST_PARITY_BASELINE,
  readTapFailures,
  resolveHostPole,
  runHostParity,
  type DeclaredDivergence,
  type DivergenceId,
  type HostParityOutcome,
  type HostPole,
} from "../src/lib/host-parity.js";

/** One `node --test` invocation, returning its combined output. A nonzero exit is a failing test,
 *  which is the ordinary case here — never a throw. */
function runNodeTest(cwd: string, target: string): string {
  const r = spawnSync(
    "node",
    ["--test", "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts", target],
    { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  return `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
}

/**
 * THE THIRD STATE `runHostParity`'S OWN VERDICT CANNOT EXPRESS. `clean` means "every observed
 * failure was declared" — that is indistinguishable from "nothing is declared and nothing was
 * diffed against". `azure` sat at zero declared entries for exactly that reason: an empty pole
 * read as parity-clean instead of never-baselined, so eleven real container divergences went
 * unnoticed rather than merely undeclared.
 *
 * PURE and independent of `runHostParity`'s own diff: this does not recompute `healed`/`undeclared`
 * (that stays in src/lib/host-parity.ts — clause (i) of the task design forbids the duplicate). It
 * only asks whether the declared list has anything to diff against FOR THIS POLE in the first
 * place. A pole that DOES have declared entries is never flagged here, however many of them heal or
 * however clean the run — that is the false-positive containment the task design calls for.
 */
export function reportUnbaselinedPole(pole: HostPole, baseline: readonly DeclaredDivergence[]): string | undefined {
  if (baseline.some((d) => d.pole === pole)) return undefined;
  return (
    `HOST PARITY (${pole}): UNBASELINED — HOST_PARITY_BASELINE declares NO entries for this pole. ` +
    "A clean report from here is indistinguishable from a pole nobody has ever run this check on; " +
    "populate it with a repetition-confirmed run before trusting silence from this pole."
  );
}

/** Everything `runHostParityCli` needs, all injectable — the seam a test uses to reach the real
 *  wiring below without spawning a suite, shelling to git, or writing a feedback entry. */
export interface HostParityCliDeps {
  pole: HostPole;
  baseline?: readonly DeclaredDivergence[];
  headSha?: string;
  runSuite: () => string;
  confirm?: (id: DivergenceId) => boolean;
  capture?: (raw: string) => void;
  write: (text: string) => void;
}

export interface HostParityCliResult {
  outcome: HostParityOutcome;
  /** Whether `deps.pole` had zero declared entries in the baseline used for this run. */
  unbaselined: boolean;
}

/**
 * THE ACTUAL INVOKER. Calls the library's `runHostParity` (never re-implements its diff), appends
 * the unbaselined-pole notice this task adds, and writes the combined text through `deps.write`.
 * This is the function both the CLI entrypoint below and test/host-parity.test.ts call — the
 * runner is "reachable from a caller that actually runs" because this IS that caller, exercised
 * directly rather than only through the module-level side effect a test cannot safely trigger.
 */
export function runHostParityCli(deps: HostParityCliDeps): HostParityCliResult {
  const baseline = deps.baseline ?? HOST_PARITY_BASELINE;
  const outcome = runHostParity({
    pole: deps.pole,
    headSha: deps.headSha,
    runSuite: deps.runSuite,
    confirm: deps.confirm,
    capture: deps.capture,
    baseline,
  });
  const unbaselinedNotice = reportUnbaselinedPole(deps.pole, baseline);
  const lines = [outcome.report];
  if (unbaselinedNotice) lines.push("", unbaselinedNotice);
  if (outcome.captured) lines.push("wrote a plan/feedback/ record for the drift above");
  deps.write(`${lines.join("\n")}\n`);
  return { outcome, unbaselined: unbaselinedNotice !== undefined };
}

/** True only when this file is the process's entrypoint (`node --import tsx scripts/host-parity.ts`
 *  or `bin/rmd`'s equivalent), never when another module imports it — which is what lets a test
 *  import `runHostParityCli` above without triggering a real suite run as a side effect of import. */
function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

/**
 * PURE half of the `confirm` seam: given the id under test and the TAP text from re-running ITS
 * FILE alone, decide whether the divergence is confirmed. A run that produced no summary line is
 * INCONCLUSIVE, and an inconclusive re-run must not clear a divergence — so it counts as
 * confirmed. Split out of the entrypoint below so this decision — the actual logic, not the
 * `spawnSync` that feeds it — is covered by a fixture test directly, matching
 * `reportUnbaselinedPole`'s split from `runHostParity` above.
 */
export function isConfirmedDivergence(id: DivergenceId, rerunOutput: string): boolean {
  const again = readTapFailures(rerunOutput);
  return !again.complete || again.failures.includes(id);
}

/**
 * PURE half of the `capture` seam: HOST_PARITY_REPORT_ONLY=1 prints the verdict and writes
 * nothing — the switch an operator wants the first time, proven end to end without an outward
 * write. Split out so a fixture test can drive the decision without needing the real
 * `captureFeedback` write.
 */
export function shouldCaptureCli(env: NodeJS.ProcessEnv): boolean {
  return env.HOST_PARITY_REPORT_ONLY !== "1";
}

// diff-cov: process-boundary — spawns the real suite (107s) + re-execs git, runnable only as `node scripts/host-parity.ts` itself, never under `npm test`; every decision called out to below is covered directly.
if (isMainModule()) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  // The pole/headSha/runSuite/confirm/capture wiring below calls resolveHostPole,
  // isConfirmedDivergence, shouldCaptureCli and runHostParityCli — each covered directly above
  // and in test/host-parity.test.ts; only the process-boundary glue around them is exempt here.
  const pole: HostPole = resolveHostPole({ platform: process.platform, env: process.env, inContainer: existsSync("/.dockerenv") });
  const headSha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout?.trim();
  runHostParityCli({
    pole,
    headSha: headSha || undefined,
    // `npm test`, not `test:ci` — the retry wrapper would hide exactly the intermittency this is
    // trying to characterise, and `readTapFailures` handles a doubled stream only because the OTHER
    // pole's log has one.
    runSuite: () => runNodeTest(repoRoot, "test/**/*.test.ts"),
    confirm: (id) => isConfirmedDivergence(id, runNodeTest(repoRoot, id.slice(0, id.indexOf("::")))),
    // `origin: "cli"` because this IS a CLI invocation and the origin enum is closed (`cli|ui|issue`
    // plus `issue#<n>`/`alert#<id>`); widening it would ripple into the schema validator, the console
    // and `rmd trace` for a provenance the report's own first line already states.
    capture: shouldCaptureCli(process.env) ? (raw) => captureFeedback(repoRoot, { raw, origin: "cli" }) : undefined,
    write: (text) => process.stdout.write(text),
  });
  process.exitCode = 0;
}
