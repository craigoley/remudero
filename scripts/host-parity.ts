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
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { captureFeedback } from "../src/lib/feedback.js";
import { readTapFailures, runHostParity, type HostPole } from "../src/lib/host-parity.js";

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

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** darwin is the judge's pole. Anything else running this is a runner or a container, and its
 *  failure set belongs to the OTHER side of the diff. */
const pole: HostPole = process.platform === "darwin" ? "mini" : "ci";

const headSha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout?.trim();

const outcome = runHostParity({
  pole,
  headSha: headSha || undefined,
  // `npm test`, not `test:ci` — the retry wrapper would hide exactly the intermittency this is
  // trying to characterise, and `readTapFailures` handles a doubled stream only because the OTHER
  // pole's log has one.
  runSuite: () => runNodeTest(repoRoot, "test/**/*.test.ts"),
  // Re-run the offender's own FILE alone. A run that produced no summary line is INCONCLUSIVE, and
  // an inconclusive re-run must not clear a divergence — so it counts as confirmed.
  confirm: (id) => {
    const file = id.slice(0, id.indexOf("::"));
    const again = readTapFailures(runNodeTest(repoRoot, file));
    return !again.complete || again.failures.includes(id);
  },
  // `origin: "cli"` because this IS a CLI invocation and the origin enum is closed (`cli|ui|issue`
  // plus `issue#<n>`/`alert#<id>`); widening it would ripple into the schema validator, the console
  // and `rmd trace` for a provenance the report's own first line already states.
  // HOST_PARITY_REPORT_ONLY=1 prints the verdict and writes nothing — the switch an operator wants
  // the first time, and the one that let this be proven end to end without an outward write.
  capture:
    process.env.HOST_PARITY_REPORT_ONLY === "1"
      ? undefined
      : (raw) => captureFeedback(repoRoot, { raw, origin: "cli" }),
});

process.stdout.write(`${outcome.report}\n`);
if (outcome.captured) process.stdout.write("wrote a plan/feedback/ record for the drift above\n");
process.exitCode = 0;
