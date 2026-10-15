/**
 * W1-T9627 — a daemon that dies before node starts is seen, and its last words are kept.
 *
 * 2026-10-15 08:22–10:29Z: every core boot died in deploy/entrypoint.sh about a second in (`cannot
 * check out main`), so no container wrote `daemon.paths` or `daemon.boot`. progress-watchdog counted
 * failedBoots15m 0 and said STALLED action=recycle, which the launcher's down arm never acts on; the
 * diagnostics bundle listed running containers only; and each 5-minute revive ran `docker rm -f` on
 * the dead container, deleting the only copy of the error, 25 times.
 *
 * The launcher cases render the REAL launcher from deploy/install-host-units.sh into a throwaway
 * tree and run it against a fake `docker` and a fake `rmd`, so no real host is touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CRASH_LOOP_BOOTS,
  REVIVAL_LOG_ENV,
  REVIVAL_LOG_TAIL_BYTES,
  captureDiagnosticsBundle,
  decideProgressWatchdog,
  preNodeDeathRun,
  readRevivalLogTail,
} from "../src/lib/progress-watchdog.js";

const NOW = Date.parse("2026-10-15T09:40:00Z");

/** The ledger as the incident left it: the last healthy generation's rows, then nothing. */
const incidentRows: Array<Record<string, unknown>> = [
  { ts: "2026-10-15T07:50:00Z", step: "daemon.paths", run_id: "healthy" },
  { ts: "2026-10-15T07:50:30Z", step: "daemon.boot", run_id: "healthy" },
  { ts: "2026-10-15T08:20:00Z", step: "sweep.pass", run_id: "healthy", enumerated: 12 },
];

/** One revive line per 5-minute tick from 08:23:53, each reporting the previous container's exit 1. */
function incidentRevivals(n: number, opts: { exit?: string; start?: number } = {}): string {
  const start = opts.start ?? Date.parse("2026-10-15T08:23:53Z");
  const lines: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const ts = new Date(start + i * 5 * 60_000).toISOString().replace(/\.\d+Z$/, "Z");
    // The first revive found the healthy generation's container, which had exited 1 at 08:22:44.
    lines.push(`${ts} revive boot=0 prev_status=exited prev_exit=${opts.exit ?? "1"} prev_restarts=5`);
  }
  return lines.join("\n") + "\n";
}

test("a crash loop before node starts reads CRASH_LOOP, not STALLED with failedBoots15m 0", () => {
  const verdict = decideProgressWatchdog({ rows: incidentRows, nowMs: NOW, openPrCount: 12, revivalLog: incidentRevivals(5) });
  assert.equal(verdict.failedBoots15m, 0, "no container reached daemon.paths, so the old count stays 0");
  assert.equal(verdict.state, "CRASH_LOOP");
  assert.equal(verdict.action, "hold-revive", "the down arm's existing hold path applies to it");
  // Revive j reports how revive j-1's container ended, so five revives evidence four deaths, and
  // no daemon.paths row lies between any two of them.
  assert.equal(verdict.preNodeDeaths, 4);
  assert.match(verdict.reason, /4 revived containers in a row exited 1 before node started/);
  assert.match(verdict.reason, /deploy\/entrypoint\.sh/);

  // The same ledger with no revival log is exactly what the incident produced: STALLED, recycle.
  const blind = decideProgressWatchdog({ rows: incidentRows, nowMs: NOW, openPrCount: 12, revivalLog: "" });
  assert.equal(blind.state, "STALLED");
  assert.equal(blind.action, "recycle");
  assert.equal(blind.preNodeDeaths, 0);
});

test("a pre-node run below the failed-boot bound stays out of CRASH_LOOP", () => {
  const run = preNodeDeathRun(incidentRevivals(CRASH_LOOP_BOOTS), incidentRows);
  assert.equal(run.count, CRASH_LOOP_BOOTS - 1);
  const verdict = decideProgressWatchdog({ rows: incidentRows, nowMs: NOW, openPrCount: 12, revivalLog: incidentRevivals(CRASH_LOOP_BOOTS) });
  assert.notEqual(verdict.state, "CRASH_LOOP");
});

test("a container that reached node, a clean exit, a host boot, a release or an unvouched interval ends the run", () => {
  const log = incidentRevivals(6);
  const reviveTimes = log.trim().split("\n").map((l) => Date.parse(l.split(" ")[0]));

  // The newest container wrote daemon.paths: the loop is over, whatever came before it.
  const recovered = [...incidentRows, { ts: new Date(reviveTimes[5] + 30_000).toISOString(), step: "daemon.paths", run_id: "fixed" }];
  assert.equal(preNodeDeathRun(log, recovered).count, 0);

  // A container between revives 2 and 3 reached node: only the deaths after it are in the run.
  const between = [...incidentRows, { ts: new Date(reviveTimes[2] + 30_000).toISOString(), step: "daemon.paths", run_id: "mid" }];
  assert.equal(preNodeDeathRun(log, between).count, 2);

  // Exit 0 is a clean stop and `none` is nothing to revive; neither is a death.
  assert.equal(preNodeDeathRun(incidentRevivals(6, { exit: "0" }), incidentRows).count, 0);
  assert.equal(preNodeDeathRun(incidentRevivals(6, { exit: "none" }), incidentRows).count, 0);

  // A host boot ended the previous container, not a crash.
  const booted = log.trim().split("\n");
  booted[3] = booted[3].replace("boot=0", "boot=1");
  assert.equal(preNodeDeathRun(booted.join("\n") + "\n", incidentRows).count, 2);

  // A release means the input changed: deaths before it judged other code. Same second as the revive.
  const released = log.trim().split("\n");
  released.splice(4, 0, `${released[4].split(" ")[0]} crash-loop-release sha=new digest=sha256:one was sha=old`);
  assert.equal(preNodeDeathRun(released.join("\n") + "\n", incidentRows).count, 1);
  assert.equal(preNodeDeathRun(log + `${new Date(NOW).toISOString()} crash-loop-release sha=x was sha=y\n`, incidentRows).count, 0);

  // A revive older than every ledger row read: no row can say it never reached node.
  const lateRows = [{ ts: "2026-10-15T08:40:00Z", step: "sweep.pass", run_id: "healthy", enumerated: 12 }];
  assert.equal(preNodeDeathRun(log, lateRows).count, 1);
  assert.equal(preNodeDeathRun(log, []).count, 0, "no rows, no evidence");

  // Other revival-log lines are skipped, and an empty log is no run.
  assert.equal(preNodeDeathRun(`junk\n${log}2026-10-15T09:00:00Z watchdog-verdict state=STALLED\n`, incidentRows).count, 5);
  assert.equal(preNodeDeathRun("", incidentRows).count, 0);
});

test("the verdict reads the revival log the launcher names in RMD_REVIVAL_LOG, and a missing one is no evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-prenode-env-"));
  const prior = process.env[REVIVAL_LOG_ENV];
  try {
    const path = join(dir, "rmd-revivals.log");
    writeFileSync(path, incidentRevivals(5));
    process.env[REVIVAL_LOG_ENV] = path;
    assert.equal(decideProgressWatchdog({ rows: incidentRows, nowMs: NOW, openPrCount: 12 }).state, "CRASH_LOOP");
    process.env[REVIVAL_LOG_ENV] = join(dir, "absent.log");
    assert.equal(decideProgressWatchdog({ rows: incidentRows, nowMs: NOW, openPrCount: 12 }).state, "STALLED");
    assert.equal(readRevivalLogTail(undefined), "");

    // The log is append-only for the host's life: only its tail is read, cut at a whole line.
    const big = join(dir, "big.log");
    const filler = "2026-10-01T00:00:00Z watchdog-verdict state=STALLED action=capture-diagnostics bundle=skipped\n";
    writeFileSync(big, filler.repeat(Math.ceil((REVIVAL_LOG_TAIL_BYTES * 2) / filler.length)) + incidentRevivals(5));
    const tail = readRevivalLogTail(big);
    assert.ok(tail.length <= REVIVAL_LOG_TAIL_BYTES);
    assert.ok(tail.startsWith("2026-"), "the cut line is dropped");
    process.env[REVIVAL_LOG_ENV] = big;
    assert.equal(decideProgressWatchdog({ rows: incidentRows, nowMs: NOW, openPrCount: 12 }).preNodeDeaths, 4);
  } finally {
    if (prior === undefined) delete process.env[REVIVAL_LOG_ENV];
    else process.env[REVIVAL_LOG_ENV] = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a diagnostics bundle captures the log of a stopped remudero container (docker ps -a)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-prenode-bundle-"));
  try {
    const calls: string[][] = [];
    const run = (file: string, args: string[]): string => {
      calls.push([file, ...args]);
      if (args[0] !== "ps") return `log of ${args.at(-1)}\n`;
      // Only `-a` lists the dead daemon; plain `docker ps` would list serve alone.
      return args.includes("-a")
        ? "remudero-daemon\tExited (1) 3 seconds ago\nremudero-serve\tUp 2 hours\ncloudflared\tUp 2 hours\n"
        : "remudero-serve\nunrelated\n";
    };
    const verdict = decideProgressWatchdog({ rows: incidentRows, nowMs: NOW, openPrCount: 12, revivalLog: incidentRevivals(5) });
    const result = captureDiagnosticsBundle(dir, NOW, verdict, incidentRows, { run });
    assert.equal(result.written, true);
    assert.deepEqual(calls[0], ["docker", "ps", "-a", "--format", "{{.Names}}\t{{.Status}}"]);
    const logs = readdirSync(result.dir!).filter((n) => n.startsWith("docker-logs-")).map((n) => readFileSync(join(result.dir!, n), "utf8"));
    assert.ok(logs.includes("# remudero-daemon\nlog of remudero-daemon\n"), JSON.stringify(logs));
    assert.equal(logs.length, 2, "remudero containers only, running or exited");
    assert.match(readFileSync(join(result.dir!, "docker-ps.txt"), "utf8"), /remudero-daemon\tExited \(1\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the launcher ─────────────────────────────────────────────────────────────────────────────

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

interface Host {
  root: string;
  stateDir: string;
  launcher: string;
  revivals: string;
  rmdLog: string;
  dockerLog: string;
  env: NodeJS.ProcessEnv;
}

/** A rendered launcher whose daemon container is DOWN: exited 1 after five restarts, its log holding
 *  the entrypoint's last words. `docker logs` answers only while the container exists. */
function downHost(opts: { logsFail?: boolean } = {}): Host {
  const root = mkdtempSync(join(tmpdir(), "rmd-prenode-launcher-"));
  const stateDir = join(root, "state-root");
  const stub = join(root, "stubbin");
  const daemonTree = join(stateDir, "remudero");
  for (const dir of [join(stateDir, "state"), stub, join(daemonTree, "bin")]) mkdirSync(dir, { recursive: true });
  const rmdLog = join(root, "rmd.log");
  const dockerLog = join(root, "docker.log");
  const removed = join(root, "removed");
  writeExecutable(
    join(daemonTree, "bin", "rmd"),
    `#!/usr/bin/env bash\necho "RMD_REVIVAL_LOG=\${RMD_REVIVAL_LOG:-unset} $*" >> "${rmdLog}"\n` +
      `if [ "$1" = progress-watchdog ]; then echo '{"state":"STALLED","action":"recycle","failedBoots15m":0}'; fi\nexit 0\n`,
  );
  writeExecutable(
    join(stub, "docker"),
    [
      "#!/usr/bin/env bash",
      `echo "$*" >> "${dockerLog}"`,
      'case "$1" in',
      "  ps) : ;;",
      `  inspect) [ -e "${removed}" ] && exit 1`,
      '    case "$*" in',
      "      *State.Status*) echo exited ;;",
      "      *State.ExitCode*) echo 1 ;;",
      "      *RestartCount*) echo 5 ;;",
      "    esac ;;",
      opts.logsFail
        ? '  logs) echo "Error response from daemon: can not get logs" >&2; exit 1 ;;'
        : `  logs) [ -e "${removed}" ] && exit 1; echo "entrypoint: syncing deploy code"; echo "entrypoint: FATAL -- cannot check out main" >&2 ;;`,
      `  rm) touch "${removed}" ;;`,
      '  image) echo "sha256:image-one" ;;',
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  writeExecutable(join(stub, "findmnt"), "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(join(stateDir, "state", "ledger.ndjson"), `${JSON.stringify(incidentRows[0])}\n`);
  const revivals = join(root, "revivals.log");
  const launcher = join(root, "rmd-relaunch.sh");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RMD_STATE_DIR: stateDir,
    RMD_UNIT_DIR: join(root, "systemd"),
    RMD_BIN_DIR: join(root, "bin"),
    RMD_LAUNCHER_PATH: launcher,
    RMD_REVIVAL_LOG: revivals,
    RMD_NODE_MAX_OLD_SPACE_MB: "8192",
    RMD_CASH_SECRET_DIR: join(root, "no-secrets"),
    PATH: `${stub}:${process.env.PATH ?? ""}`,
  };
  const install = spawnSync("bash", ["deploy/install-host-units.sh", "--install"], { encoding: "utf8", env });
  assert.equal(install.status, 0, `render failed: ${install.stderr}`);
  // The tick runs as systemd runs it: nothing names the revival log in its environment.
  const tickEnv = { ...env };
  delete tickEnv.RMD_REVIVAL_LOG;
  return { root, stateDir, launcher, revivals, rmdLog, dockerLog, env: tickEnv };
}

const read = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");

test("a daemon that dies before node starts keeps its log through the revive that removes it", () => {
  const h = downHost();
  try {
    const r = spawnSync("bash", [h.launcher], { encoding: "utf8", env: h.env });
    assert.equal(r.status, 0, r.stderr);
    const calls = read(h.dockerLog).split("\n");
    const logsAt = calls.findIndex((c) => /^logs --tail 200 remudero-daemon$/.test(c));
    const rmAt = calls.findIndex((c) => /^rm -f remudero-daemon$/.test(c));
    assert.ok(logsAt >= 0, `the revive must read the dead container's log:\n${read(h.dockerLog)}`);
    assert.ok(rmAt > logsAt, "the log is read BEFORE docker rm -f deletes it");

    const revive = read(h.revivals).split("\n").filter((l) => / revive boot=0 /.test(l));
    assert.equal(revive.length, 1, read(h.revivals));
    assert.match(revive[0], / prev_status=exited prev_exit=1 prev_restarts=5 log=\S+$/);
    const kept = revive[0].replace(/.* log=/, "");
    assert.ok(kept.startsWith(join(h.stateDir, "state", "diagnostics", "revive-")), kept);
    const text = read(kept);
    assert.match(text, /FATAL -- cannot check out main/, "stderr is kept too: the entrypoint's die() writes there");
    assert.match(text, /^# docker logs --tail 200 remudero-daemon, kept before the revive removed it$/m);

    // The verdict this tick read was asked with the revival log named, so preNodeDeathRun sees it.
    assert.match(read(h.rmdLog), new RegExp(`^RMD_REVIVAL_LOG=${h.revivals} progress-watchdog --json --state-root `, "m"));
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a revive whose log capture fails still revives, and keeps docker's own refusal", () => {
  const h = downHost({ logsFail: true });
  try {
    const r = spawnSync("bash", [h.launcher], { encoding: "utf8", env: h.env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(read(h.dockerLog), /^rm -f remudero-daemon$/m, "the revive goes ahead");
    const revive = read(h.revivals).split("\n").find((l) => / revive boot=0 /.test(l)) ?? "";
    const kept = revive.replace(/.* log=/, "");
    assert.match(read(kept), /can not get logs/);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});
