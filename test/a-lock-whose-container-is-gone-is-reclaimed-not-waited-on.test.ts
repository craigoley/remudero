import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * W1-T2556. `deploy/recycle-container.sh` counted `state/inflight/*.lock` as a blind FILE, and its
 * own header said the honest thing a host-side script can do with a lock naming a container that
 * might be gone is "read it, or let the next boot decide" (W1-T978's reclaim). That deferral is
 * sound reasoning from `isHolderStale`'s container branch (src/lib/fs-race-safe.ts), which can only
 * run FROM INSIDE a container — but it is unsound HERE, because this recycle is the thing that
 * produces the next boot. MEASURED 2026-09-01: `state/inflight/W1-T2525.lock` named
 * `{"pid":57,"host":"8c8fc20029e2"}`; `docker ps -a` reported `8c8fc20029e2` as `exited`; the
 * recycle waited its full bound and refused, twice, until an operator moved the file by hand after
 * reading the same container id this script already had.
 *
 * This suite drives the REAL script with a stubbed `docker`/`az` on PATH — the same technique
 * test/recycle-container.test.ts and test/a-recycle-refuses-a-state-dir-that-is-not-a-checkout.test.ts
 * use — and proves the ONE new, narrow, positive classification: a `state/inflight/*.lock` moves
 * out of the blocking set only when its `host` is BOTH shaped like a docker container id AND
 * `docker inspect` gives a DEFINITIVE dead answer (absent, or present but not running). Everything
 * else — a running container, a non-container-shaped host, or an unreadable/malformed lock — is
 * left exactly as conservative as before this task.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "recycle-container.sh");

interface Call {
  bin: string;
  argv: string[];
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
  calls: Call[];
}

/** The six declared runtime names (deploy/runtime-env-vars.sh), one fixture value each — enough
 *  to clear section 3's capture/drift checks without exercising them, which have their own
 *  dedicated suites (test/recycle-container.test.ts, test/recycle-capture-falls-back-to-the-shell.test.ts). */
const DECLARED_RUNTIME_ENV_LINES = [
  "GH_TOKEN=captured-token-value",
  "RMD_RESTART_THROTTLE_S=300",
  "RMD_FRESHNESS_RESTART_MAX=100",
  "GH_APP_ID=app-id-fixture",
  "GH_APP_INSTALLATION_ID=install-id-fixture",
  "GH_APP_PRIVATE_KEY_PATH=/path/to/key.pem",
];

/**
 * A `docker` stub whose ONLY interesting branch is `inspect --format '{{.State.Running}}' <name>`:
 * it answers `true` for every name in `STUB_RUNNING_HOSTS`, `false` for every name in
 * `STUB_STOPPED_HOSTS` (space-separated env vars), and FAILS (exit 1 — "no such container") for
 * anything else, INCLUDING every container-shaped id this suite never mentions — the same answer
 * docker gives for a real id it has never heard of. Every other docker call is the same minimal
 * "always succeeds" shape test/a-recycle-refuses-a-state-dir-that-is-not-a-checkout.test.ts uses,
 * because this suite's only concern is the inflight-lock reclaim, not orchestration or drift.
 */
function writeStubs(dir: string): void {
  const docker = [
    "#!/usr/bin/env bash",
    'rec() { printf "%s" "docker" >> "$STUB_REC/calls"; for a in "$@"; do printf "\\t%s" "$a" >> "$STUB_REC/calls"; done; printf "\\n" >> "$STUB_REC/calls"; }',
    'rec "$@"',
    'case "$1" in',
    "  image)",
    '    if [ "$2" = "inspect" ]; then echo "sha256:PULLEDID"; exit 0; fi',
    "    exit 0 ;;",
    "  inspect)",
    "    shift",
    '    fmt=""',
    '    if [ "$1" = "--format" ]; then fmt="$2"; shift 2; fi',
    '    name="${1:-}"',
    '    case "$fmt" in',
    '      "{{.State.Running}}")',
    '        for h in ${STUB_RUNNING_HOSTS:-}; do [ "$h" = "$name" ] && { echo "true"; exit 0; }; done',
    '        for h in ${STUB_STOPPED_HOSTS:-}; do [ "$h" = "$name" ] && { echo "false"; exit 0; }; done',
    "        exit 1 ;;", // docker has never heard of this id — ABSENT
    "      *Config.Image*) echo \"test-registry/remudero:old\"; exit 0 ;;",
    "      *Config.Env*)",
    ...DECLARED_RUNTIME_ENV_LINES.map((l) => `        echo "${l}"`),
    '        echo ""',
    "        exit 0 ;;",
    "      *Mounts*)",
    '        printf "%s\\t/home/node/Remudero\\ttrue\\n" "${RMD_STATE_DIR:-$HOME/rmd-state2}"',
    '        printf "%s\\t/home/node/.claude\\ttrue\\n" "${RMD_CLAUDE_DIR:-$HOME/.claude}"',
    '        codex="${RMD_CODEX_DIR:-$HOME/.codex}"; [ ! -d "$codex" ] || printf "%s\\t/home/node/.codex\\ttrue\\n" "$codex"',
    '        config="${RMD_CONTAINER_CONFIG_DIR:-$HOME/.config/remudero-container}"; [ ! -d "$config" ] || printf "%s\\t/home/node/.config/remudero\\ttrue\\n" "$config"',
    "        exit 0 ;;",
    "      *.Image}}*) echo \"sha256:PULLEDID\"; exit 0 ;;",
    '      "")',
    "        exit 0 ;;", // bare `docker inspect <container-name>`: the daemon container exists
    "    esac",
    "    exit 0 ;;",
    '  pull) echo "Status: Downloaded newer image"; exit 0 ;;',
    "  exec) exit 0 ;;", // no lane-less workers in this suite — never the concern under test
    "  stop|rm|run) exit 0 ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n");

  const az = ["#!/usr/bin/env bash", "exit 0", ""].join("\n");

  writeFileSync(join(dir, "docker"), docker, { mode: 0o755 });
  writeFileSync(join(dir, "az"), az, { mode: 0o755 });
  chmodSync(join(dir, "docker"), 0o755);
  chmodSync(join(dir, "az"), 0o755);
}

interface RunOpts {
  scriptPath?: string;
  stateDir?: string;
  runningHosts?: string[];
  stoppedHosts?: string[];
}

function runRecycle(opts: RunOpts = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), "rmd-reclaim-stub-"));
  const rec = mkdtempSync(join(tmpdir(), "rmd-reclaim-rec-"));
  const state = opts.stateDir ?? mkdtempSync(join(tmpdir(), "rmd-reclaim-state-"));
  writeStubs(dir);
  const r = spawnSync("bash", [opts.scriptPath ?? SCRIPT], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      STUB_REC: rec,
      STUB_RUNNING_HOSTS: (opts.runningHosts ?? []).join(" "),
      STUB_STOPPED_HOSTS: (opts.stoppedHosts ?? []).join(" "),
      RMD_STATE_DIR: state,
      RMD_RECYCLE_WAIT_S: "1",
      RMD_RECYCLE_POLL_S: "1",
      // First-boot: this suite drives the inflight-lock reclaim, never the STATE_DIR-is-a-checkout
      // predicate (test/a-recycle-refuses-a-state-dir-that-is-not-a-checkout.test.ts owns that).
      RMD_RECYCLE_FIRST_BOOT: "1",
      GH_TOKEN: "",
      // A path that (almost certainly) does not exist, so the "never run inside a container" guard
      // does not fire merely because THIS test runner is itself sandboxed inside one.
      RMD_RECYCLE_DOCKERENV_PATH: join(tmpdir(), "reclaim-test-no-such-dockerenv-marker"),
    },
  });
  let calls: Call[] = [];
  try {
    calls = readFileSync(join(rec, "calls"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [bin, ...argv] = l.split("\t");
        return { bin, argv };
      });
  } catch {
    calls = [];
  }
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", calls };
}

const isRm = (c: Call) => c.bin === "docker" && c.argv[0] === "rm";
const isRun = (c: Call) => c.bin === "docker" && c.argv[0] === "run";

function makeInflightDir(state: string): string {
  const d = join(state, "state", "inflight");
  mkdirSync(d, { recursive: true });
  return d;
}

// ── ACCEPTANCE 1: a lock whose container docker reports absent is reclaimed, not waited on ──────

test("W1-T2556: an inflight lock naming a container docker has never heard of is reclaimed and the recycle proceeds", () => {
  const state = mkdtempSync(join(tmpdir(), "rmd-reclaim-state-"));
  const inflightDir = makeInflightDir(state);
  const lockPath = join(inflightDir, "W1-T2525.lock");
  writeFileSync(lockPath, JSON.stringify({ pid: 57, host: "8c8fc20029e2", startedAt: "2026-09-01T00:00:00Z" }));

  // Neither RUNNING nor STOPPED — this host is entirely unknown to the stubbed docker, exactly
  // like `docker inspect` on an id it has never heard of.
  const run = runRecycle({ stateDir: state });

  assert.equal(run.status, 0, `expected the recycle to proceed, got status ${run.status}: ${run.stderr}`);
  assert.ok(run.calls.filter(isRm).length > 0, "the old container must actually be replaced");
  assert.ok(run.calls.filter(isRun).length > 0, "a replacement must start");
  assert.match(run.stderr, /ABSENT \(docker inspect: no such container\)/);
  assert.ok(!existsSync(lockPath), "the original lock path must no longer exist there — it was MOVED");
});

test("W1-T2556: MEASURED SHAPE — a lock naming a container docker KNOWS but reports exited/not-running is reclaimed too", () => {
  // The actual 2026-09-01 incident: `docker ps -a` showed the container as `exited`, not gone from
  // docker's inventory — a strictly WEAKER claim than "docker inspect fails outright" (ACCEPTANCE
  // 1), and the one this task's own rationale names explicitly ("absent OR not running").
  const state = mkdtempSync(join(tmpdir(), "rmd-reclaim-state-"));
  const inflightDir = makeInflightDir(state);
  const lockPath = join(inflightDir, "W1-T2525.lock");
  writeFileSync(lockPath, JSON.stringify({ pid: 57, host: "8c8fc20029e2", startedAt: "2026-09-01T00:00:00Z" }));

  const run = runRecycle({ stateDir: state, stoppedHosts: ["8c8fc20029e2"] });

  assert.equal(run.status, 0, `expected the recycle to proceed, got status ${run.status}: ${run.stderr}`);
  assert.ok(run.calls.filter(isRm).length > 0, "the old container must actually be replaced");
  assert.ok(run.calls.filter(isRun).length > 0, "a replacement must start");
  assert.match(run.stderr, /NOT RUNNING \(docker inspect: State\.Running=false\)/);
  assert.ok(!existsSync(lockPath), "the original lock path must no longer exist there — it was MOVED");
});

// ── ACCEPTANCE 2: a lock whose container is RUNNING still blocks exactly as today ────────────────

test("W1-T2556: an inflight lock naming a RUNNING container still refuses the recycle, untouched", () => {
  const state = mkdtempSync(join(tmpdir(), "rmd-reclaim-state-"));
  const inflightDir = makeInflightDir(state);
  const lockPath = join(inflightDir, "W1-T404.lock");
  writeFileSync(lockPath, JSON.stringify({ pid: 123, host: "5efb86ede91b", startedAt: "2026-08-18T22:00:00Z" }));

  const run = runRecycle({ stateDir: state, runningHosts: ["5efb86ede91b"] });

  assert.notEqual(run.status, 0, "a lock whose container is genuinely running must still refuse");
  assert.match(run.stderr, /REFUSING — 1 lane-holding/);
  assert.equal(run.calls.filter(isRm).length, 0, "the container must not be removed");
  assert.equal(run.calls.filter(isRun).length, 0, "no replacement may start");
  assert.ok(existsSync(lockPath), "a lock naming a live container must never be moved");
});

// ── ACCEPTANCE 3: a host that cannot be resolved is left alone and still blocks ──────────────────

test("W1-T2556: an inflight lock whose host is not container-id-shaped cannot be resolved and still refuses", () => {
  const state = mkdtempSync(join(tmpdir(), "rmd-reclaim-state-"));
  const inflightDir = makeInflightDir(state);
  const lockPath = join(inflightDir, "W1-T900.lock");
  // "prod-box-3" is a free-form, human-named host — never shaped like a docker container id
  // (12 or 64 lowercase hex chars), so this script can never even meaningfully ask docker about it.
  writeFileSync(lockPath, JSON.stringify({ pid: 200, host: "prod-box-3", startedAt: "2026-08-18T22:00:00Z" }));

  const run = runRecycle({ stateDir: state });

  assert.notEqual(run.status, 0, "an unresolvable host must still refuse — unchanged conservatism");
  assert.match(run.stderr, /REFUSING — 1 lane-holding/);
  assert.equal(run.calls.filter(isRm).length, 0, "the container must not be removed");
  assert.ok(existsSync(lockPath), "a lock this script cannot resolve must never be moved");
  assert.equal(
    run.calls.some((c) => c.bin === "docker" && c.argv[0] === "inspect" && c.argv.includes("prod-box-3")),
    false,
    "a non-container-shaped host is never even passed to docker inspect",
  );
});

// ── ACCEPTANCE 4: an unreadable or malformed lock is left alone and still blocks ─────────────────

test("W1-T2556: a malformed inflight lock (no host field) is left alone and still refuses", () => {
  const state = mkdtempSync(join(tmpdir(), "rmd-reclaim-state-"));
  const inflightDir = makeInflightDir(state);
  const lockPath = join(inflightDir, "W1-T111.lock");
  writeFileSync(lockPath, "not even json");

  const run = runRecycle({ stateDir: state });

  assert.notEqual(run.status, 0, "a malformed lock must still refuse — unchanged conservatism");
  assert.match(run.stderr, /REFUSING — 1 lane-holding/);
  assert.equal(run.calls.filter(isRm).length, 0, "the container must not be removed");
  assert.ok(existsSync(lockPath), "an unreadable lock must never be moved");
});

// ── ACCEPTANCE 5: every reclaimed lock is printed in full before it is acted on ──────────────────

test("W1-T2556: a reclaimed lock is printed in full — pid, host and startedAt — before it is moved", () => {
  const state = mkdtempSync(join(tmpdir(), "rmd-reclaim-state-"));
  const inflightDir = makeInflightDir(state);
  writeFileSync(
    join(inflightDir, "W1-T2525.lock"),
    JSON.stringify({ pid: 57, host: "deadbeef0001", startedAt: "2026-09-01T00:00:00Z" }, null, 2),
  );

  const run = runRecycle({ stateDir: state });

  assert.equal(run.status, 0, `expected success, got ${run.status}: ${run.stderr}`);
  const printedAt = run.stderr.indexOf('"pid": 57');
  const movedAt = run.stderr.indexOf("moved aside to");
  assert.ok(printedAt >= 0, "the lock's pid must be printed in full");
  assert.ok(movedAt >= 0, "the moved-aside confirmation must be printed");
  assert.ok(printedAt < movedAt, "the lock content must be printed BEFORE the move is confirmed");
  assert.match(run.stderr, /deadbeef0001/, "the holder host must be printed in full");
});

// ── ACCEPTANCE 6: a reclaimed lock is preserved, never unlinked ──────────────────────────────────

test("W1-T2556: a reclaimed lock is moved aside byte-identical, with its reason recorded alongside it — never deleted", () => {
  const state = mkdtempSync(join(tmpdir(), "rmd-reclaim-state-"));
  const inflightDir = makeInflightDir(state);
  const original = { pid: 57, host: "8c8fc20029e2", startedAt: "2026-09-01T00:00:00Z" };
  writeFileSync(join(inflightDir, "W1-T2525.lock"), JSON.stringify(original));

  const run = runRecycle({ stateDir: state });
  assert.equal(run.status, 0, `expected success, got ${run.status}: ${run.stderr}`);

  const reclaimedDir = join(inflightDir, "reclaimed");
  assert.ok(existsSync(reclaimedDir), "reclaimed locks land in a dedicated subdirectory, never deleted");
  const entries = readdirSync(reclaimedDir);
  const lockEntry = entries.find((e) => e.startsWith("W1-T2525.lock") && !e.endsWith(".reason"));
  const reasonEntry = entries.find((e) => e.endsWith(".reason"));
  assert.ok(lockEntry, `the moved lock must exist under ${reclaimedDir}, found: ${entries.join(", ")}`);
  assert.ok(reasonEntry, "a sibling .reason file must record why this lock was reclaimed");

  assert.deepEqual(
    JSON.parse(readFileSync(join(reclaimedDir, lockEntry!), "utf8")),
    original,
    "the moved lock's content must be byte-identical to the original — not merely present",
  );
  const reason = readFileSync(join(reclaimedDir, reasonEntry!), "utf8");
  assert.match(reason, /8c8fc20029e2/, "the reason must name the host that was judged dead");
  assert.match(reason, /ABSENT/, "the reason must name what docker actually reported");
});

test("W1-T2556: this script never issues rm/unlink against a reclaimed lock — asserted from the source", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const lines = src.split("\n").filter((l) => !l.trim().startsWith("#"));
  const deletesALock = lines.some((l) => /\brm\s+-f\s+"\$\{(DRAIN_LOCK|INFLIGHT_DIR)/.test(l) || /\bunlink\b/.test(l));
  assert.equal(deletesALock, false, "no line may unlink a lock file — reclaiming must only ever move one");
});

// ── ACCEPTANCE 7: THE FALSIFIER — restoring the blind file count re-deadlocks on a dead lock ─────

test("W1-T2556: MUTANT: removing the reclaim step restores the deadlock — the falsifier is load-bearing", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const anchor = "waited=0\nwhile :; do\n  reclaim_dead_inflight_locks\n  n=0\n";
  assert.equal(src.split(anchor).length - 1, 1, "the mutation target must be unique");
  const mutated = src.replace(anchor, "waited=0\nwhile :; do\n  n=0\n");
  const dir = mkdtempSync(join(tmpdir(), "rmd-reclaim-mutant-"));
  const mutant = join(dir, "recycle-container.sh");
  writeFileSync(mutant, mutated, { mode: 0o755 });
  chmodSync(mutant, 0o755);

  const state = mkdtempSync(join(tmpdir(), "rmd-reclaim-state-"));
  const inflightDir = makeInflightDir(state);
  writeFileSync(join(inflightDir, "W1-T2525.lock"), JSON.stringify({ pid: 57, host: "8c8fc20029e2", startedAt: "2026-09-01T00:00:00Z" }));

  const mutantRun = runRecycle({ scriptPath: mutant, stateDir: state });
  assert.notEqual(mutantRun.status, 0, "without the reclaim step, a provably-dead lock must deadlock the recycle again");
  assert.equal(mutantRun.calls.filter(isRm).length, 0, "the mutant must never reach docker rm");

  // …and the REAL script, on the identical fixture, proceeds — the same claim ACCEPTANCE 1 makes,
  // restated here as the falsifying half of the same property.
  const state2 = mkdtempSync(join(tmpdir(), "rmd-reclaim-state-"));
  const inflightDir2 = makeInflightDir(state2);
  writeFileSync(join(inflightDir2, "W1-T2525.lock"), JSON.stringify({ pid: 57, host: "8c8fc20029e2", startedAt: "2026-09-01T00:00:00Z" }));
  const realRun = runRecycle({ stateDir: state2 });
  assert.equal(realRun.status, 0, "the real script must proceed on the identical fixture");
});
