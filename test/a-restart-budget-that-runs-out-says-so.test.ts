/**
 * `test/a-restart-budget-that-runs-out-says-so.test.ts` — W1-T3411.
 *
 * OBSERVED 2026-09-11. `remudero-daemon` runs under Docker's `--restart=on-failure:5`. A plan
 * shard reached `resolveMount`, which throws `MountsError` for a task_type/risk pair with no
 * route (src/lib/mounts.ts). The throw escaped the drain loop, the daemon exited 1 five times,
 * and the restart budget hit 5 of 5: Docker stopped restarting it and the fleet was DOWN — with
 * no escalation, no issue, no ledger row, because the process that would write one is the one
 * that is not running. The board looked ordinary the whole time: open PRs, no new escalation,
 * simply nothing moving. An operator noticed only by hand.
 *
 * THE ASYMMETRY THIS FIXES. A crash loop is loud by construction — something is trying and
 * failing. Exhausting the budget is SILENT by construction: the retries stop, and silence reads
 * exactly like a healthy idle fleet from anywhere off the host. Before this task,
 * `scripts/fleet-heartbeat.sh` already read `RestartCount`/`MaximumRetryCount` (W1-T483) and
 * published the raw numbers — but only as an early warning while the container was still up, and
 * an operator had to do the arithmetic (`restart_count == restart_max`?) themselves; nothing
 * computed or published the ANSWER, and nothing distinguished "still running, at the cap" from
 * "already stopped, and staying stopped".
 *
 * WHAT CLOSES THE GAP. `restart_verdict` (scripts/fleet-heartbeat.sh), derived from the SAME
 * single `docker inspect` call the W1-T483 probe already makes, now extended to also read
 * `.State.Status`:
 *   - `ok`                       — under budget.
 *   - `AT_LIMIT`                 — at the cap, container still `running` (early warning).
 *   - `STOPPED_RETRY_EXHAUSTED`  — at the cap AND no longer running: the fleet-down case.
 *   - `unlimited` / `unknown`    — an uncapped policy, or a failed read.
 * `restart_verdict` is ALWAYS published (never omitted the way the bare numbers are), which is
 * what makes it "a surface that survives the daemon being down": the heartbeat itself runs on the
 * HOST (see the script's own file header, "THE REPORTER MUST NOT DEPEND ON THE THING IT REPORTS
 * ON"), never inside the container, and a stopped-but-not-removed container is still inspectable
 * — `docker rm`/`--rm` is what erases the record, not an ordinary restart-budget exhaustion.
 *
 * THE SHAPE IS THE ESTABLISHED ONE, reused rather than reinvented: stub `docker` via
 * `RMD_HEARTBEAT_DOCKER`, run the REAL committed script through the shared harness
 * (`test/helpers/fleet-heartbeat-harness.ts`, W1-T494/W1-T483), assert on the published payload.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { runBeat } from "./helpers/fleet-heartbeat-harness.js";

/** `key=value` lookup over a published payload — same helper `test/fleet-heartbeat.test.ts` uses. */
function field(payload: string, key: string): string | undefined {
  const line = payload.split("\n").find((l) => l.startsWith(`${key}=`));
  return line === undefined ? undefined : line.slice(key.length + 1);
}

/** A container-runtime stub that answers the ONE `inspect --format` line the script asks for,
 *  ignoring its own argv — same shape `test/fleet-heartbeat.test.ts` already uses for this probe. */
const runtimeStub = (line: string): string => `#!/usr/bin/env bash\nprintf '%s\\n' ${JSON.stringify(line)}\n`;

// `fleet-heartbeat.sh` computes its own "now" via a REAL `date -u` subprocess call, so the fixture
// derives NOW the same way rather than from `new Date()` — see the sibling suite's comment on
// `scripts/clock-shift.mjs` only shifting THIS process's clock, never a child's.
const NOW = new Date(String(spawnSync("date", ["-u", "+%Y-%m-%dT%H:%M:%S.000Z"]).stdout).trim());
const iso = (msAgo: number): string => new Date(NOW.getTime() - msAgo).toISOString();

const LIVE_LEDGER = [
  `{"ts":"${iso(9_000_000)}","step":"daemon.boot","head_sha":"0123456789abcdef0123456789abcdef01234567"}`,
  `{"ts":"${iso(45_000)}","step":"daemon.alive","tick":3,"poll_interval_ms":60000}`,
];

test("criterion 2: a healthy idle fleet reads `ok`, not merely absent noise", () => {
  const beat = runBeat({ ledger: LIVE_LEDGER, dockerStub: runtimeStub("0 5 on-failure running") });
  assert.equal(beat.status, 0);
  assert.equal(field(beat.published, "restart_verdict"), "ok");
});

test("criterion 1+2: AT the cap but still running is a DISTINCT verdict from both healthy-idle and stopped", () => {
  const beat = runBeat({ ledger: LIVE_LEDGER, dockerStub: runtimeStub("5 5 on-failure running") });
  assert.equal(field(beat.published, "restart_verdict"), "AT_LIMIT");
});

test("criterion 1: an EXHAUSTED, STOPPED container is reported — the fleet-down case this task exists for", () => {
  // The container itself answers `exited`: docker never removes a container's own record on a
  // restart-budget stop (only `docker rm`/`--rm` does, and `--rm` cannot combine with a restart
  // policy at all), so the read succeeds exactly as it would for a running one.
  const beat = runBeat({ ledger: LIVE_LEDGER, dockerStub: runtimeStub("5 5 on-failure exited") });
  // THE BEAT ITSELF STILL PUBLISHES AND PUSHES — the surface that survives the daemon being down.
  // The heartbeat runs on the HOST, independent of the container (file header: "THE REPORTER MUST
  // NOT DEPEND ON THE THING IT REPORTS ON"), so a dead container does not stop this beat.
  assert.equal(beat.status, 0, "a beat reporting an exhausted, stopped container must still succeed");
  assert.ok(
    beat.calls.some((c) => c.argv.some((a) => a === "push")),
    "it must still reach the remote — a silent beat here is indistinguishable from a power cut",
  );
  assert.equal(field(beat.published, "restart_verdict"), "STOPPED_RETRY_EXHAUSTED");
});

test("criterion 2: healthy-idle, at-limit and stopped-exhausted are three DISTINCT words, not one collapsed value", () => {
  const ok = field(runBeat({ ledger: LIVE_LEDGER, dockerStub: runtimeStub("0 5 on-failure running") }).published, "restart_verdict");
  const atLimit = field(runBeat({ ledger: LIVE_LEDGER, dockerStub: runtimeStub("5 5 on-failure running") }).published, "restart_verdict");
  const stopped = field(runBeat({ ledger: LIVE_LEDGER, dockerStub: runtimeStub("5 5 on-failure exited") }).published, "restart_verdict");
  assert.equal(ok, "ok");
  assert.equal(atLimit, "AT_LIMIT");
  assert.equal(stopped, "STOPPED_RETRY_EXHAUSTED");
  const values = new Set([ok, atLimit, stopped]);
  assert.equal(values.size, 3, `the three conditions must read as three distinct verdicts, got: ${[...values].join(", ")}`);
});

test("an UNCAPPED policy still reads `unlimited`, never an exhausted verdict", () => {
  const beat = runBeat({ ledger: LIVE_LEDGER, dockerStub: runtimeStub("9 0 unless-stopped running") });
  assert.equal(field(beat.published, "restart_verdict"), "unlimited");
});

test("a FAILED read reads `unknown`, never `ok` — the absent-never-reassuring law applies to the verdict too", () => {
  // No docker stub at all: the script is pointed at a runtime path that does not exist, the same
  // no-runtime case the sibling suite uses to exercise the absent-numeric-fields branch.
  const beat = runBeat({ ledger: LIVE_LEDGER });
  assert.equal(beat.status, 0, "an unreadable budget must not fail the beat");
  assert.equal(field(beat.published, "restart_verdict"), "unknown");
  assert.notEqual(field(beat.published, "restart_verdict"), "ok", "a failed read must never look healthy");
});

test("a STATUS the runtime could not answer, at the cap, defaults to the ALARMING verdict, not the reassuring one", () => {
  // Three tokens instead of four: `.State.Status` came back empty. `read` leaves the fourth
  // variable unset rather than erroring, so this is a real reachable shape, not a contrived one.
  const beat = runBeat({ ledger: LIVE_LEDGER, dockerStub: runtimeStub("5 5 on-failure") });
  assert.equal(
    field(beat.published, "restart_verdict"),
    "STOPPED_RETRY_EXHAUSTED",
    "an unrecognised status at the cap must default to the WORSE case, never to AT_LIMIT",
  );
});

test("MUTANT: dropping the running-status check collapses AT_LIMIT and STOPPED_RETRY_EXHAUSTED into one value", () => {
  const beat = runBeat({
    ledger: LIVE_LEDGER,
    dockerStub: runtimeStub("5 5 on-failure exited"),
    mutate: ['if [ "$RESTART_STATE" = "running" ]; then', 'if true; then'],
  });
  // THE MUTANT MUST PRODUCE THE DEFECT: with the status check replaced by an unconditional true,
  // a STOPPED, EXHAUSTED container is misreported as merely AT_LIMIT — exactly the silent-down
  // case this task exists to close, resurrected. Proves the running-status branch is load-bearing.
  assert.equal(
    field(beat.published, "restart_verdict"),
    "AT_LIMIT",
    "the mutation must actually blur the two cases together — otherwise this test proves nothing",
  );
});

test("MUTANT: defaulting the verdict to `ok` on a FAILED read is caught — the absent value must stay unknown", () => {
  const beat = runBeat({
    ledger: LIVE_LEDGER,
    // No dockerStub: an unreadable budget, same as the "FAILED read" test above. The default
    // `RESTART_VERDICT="unknown"` is never reassigned on this path, so mutating IT is what proves
    // the guard load-bearing — the case-statement branches would hide a mutation of any of them.
    mutate: ['RESTART_VERDICT="unknown"', 'RESTART_VERDICT="ok"'],
  });
  assert.equal(
    field(beat.published, "restart_verdict"),
    "ok",
    "the mutation must actually surface the false-healthy default — otherwise this test proves nothing",
  );
});
