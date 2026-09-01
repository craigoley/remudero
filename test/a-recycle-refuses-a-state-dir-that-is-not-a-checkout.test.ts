import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * W1-T2555. `deploy/recycle-container.sh` derives `STATE_DIR="${RMD_STATE_DIR:-${HOME:-/root}/rmd-state}"`
 * and never tested it for existence before this task. `find` over a directory that is not there
 * correctly returns nothing, so the "no blocking locks under <path>" line printed the exact wording
 * an idle fleet produces over a corpus that had never been opened — and
 * `docker run -v "${STATE_DIR}:/home/node/Remudero"` would then have had DOCKER ITSELF create that
 * empty directory and boot a daemon with no repo, no plan and no ledger. MEASURED 2026-09-01: only
 * an unrelated `docker rm` race stopped that mount from happening.
 *
 * This suite drives the REAL script with a stubbed `docker`/`az` on PATH (the same technique
 * test/recycle-container.test.ts uses) and proves the new guard: STATE_DIR must exist, contain
 * `state/`, and contain the checkout deploy/entrypoint.sh actually clones into
 * (`STATE_DIR/remudero/.git`) — or the operator must say, explicitly, that this is a first boot.
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A minimal `docker`/`az` stub: no container ever exists, a pull and a run always succeed. Every
 *  test in this suite cares about the STATE_DIR guard, never about docker orchestration itself —
 *  that behaviour has its own dedicated suite, test/recycle-container.test.ts. */
function writeStubs(dir: string): void {
  const docker = [
    "#!/usr/bin/env bash",
    'rec() { printf "%s" "docker" >> "$STUB_REC/calls"; for a in "$@"; do printf "\\t%s" "$a" >> "$STUB_REC/calls"; done; printf "\\n" >> "$STUB_REC/calls"; }',
    'rec "$@"',
    'case "$1" in',
    "  inspect)",
    "    shift",
    '    fmt=""',
    '    if [ "$1" = "--format" ]; then fmt="$2"; shift 2; fi',
    '    if [ -z "$fmt" ]; then',
    "      exit 1", // no container by this name ever exists in this suite
    "    fi",
    '    case "$fmt" in',
    "      *.Image*) echo \"sha256:PULLEDID\"; exit 0 ;;",
    "    esac",
    "    exit 0 ;;",
    "  image)",
    '    if [ "$2" = "inspect" ]; then echo "sha256:PULLEDID"; exit 0; fi',
    "    exit 0 ;;",
    '  pull) echo "Status: Downloaded newer image"; exit 0 ;;',
    "  exec) exit 0 ;;",
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
  /** Sets RMD_STATE_DIR. Omit (with `home` set instead) to exercise the bare default. */
  stateDir?: string;
  /** Sets HOME, only meaningful when `stateDir` is omitted. */
  home?: string;
  scriptPath?: string;
  extraEnv?: Record<string, string>;
  extraArgs?: string[];
}

function runRecycle(opts: RunOpts): Run {
  const dir = mkdtempSync(join(tmpdir(), "a-recycle-checkout-stub-"));
  const rec = mkdtempSync(join(tmpdir(), "a-recycle-checkout-rec-"));
  writeStubs(dir);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH ?? ""}`,
    STUB_REC: rec,
    RMD_RECYCLE_WAIT_S: "1",
    RMD_RECYCLE_POLL_S: "1",
    GH_TOKEN: "",
    // Points at a path that (almost certainly) does not exist, so the "never run inside a
    // container" guard does not fire merely because the TEST RUNNER itself is sandboxed.
    RMD_RECYCLE_DOCKERENV_PATH: join(tmpdir(), "a-recycle-checkout-no-such-dockerenv-marker"),
  };
  delete env.RMD_STATE_DIR;
  delete env.RMD_RECYCLE_FIRST_BOOT;
  if (opts.stateDir !== undefined) env.RMD_STATE_DIR = opts.stateDir;
  if (opts.home !== undefined) env.HOME = opts.home;
  Object.assign(env, opts.extraEnv ?? {});

  const r = spawnSync("bash", [opts.scriptPath ?? SCRIPT, ...(opts.extraArgs ?? [])], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env,
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

const isRun = (c: Call) => c.bin === "docker" && c.argv[0] === "run";

/** A genuine checkout: STATE_DIR/state/ and STATE_DIR/remudero/.git both present. */
function makeRealCheckout(): string {
  const state = mkdtempSync(join(tmpdir(), "a-recycle-checkout-real-"));
  mkdirSync(join(state, "state"), { recursive: true });
  mkdirSync(join(state, "remudero", ".git"), { recursive: true });
  return state;
}

// ── ACCEPTANCE 1: a STATE_DIR that does not exist is refused before anything is touched ─────────

test("W1-T2555: a STATE_DIR that does not exist is refused before anything is stopped, removed or mounted", () => {
  const parent = mkdtempSync(join(tmpdir(), "a-recycle-checkout-parent-"));
  const missing = join(parent, "does-not-exist");
  const run = runRecycle({ stateDir: missing });

  assert.notEqual(run.status, 0, "a nonexistent STATE_DIR must refuse, not proceed");
  assert.match(run.stderr, /REFUSING — STATE_DIR resolved to/);
  assert.match(run.stderr, new RegExp(escapeRegex(missing)), "the RESOLVED path must be named");
  assert.match(run.stderr, /the directory does NOT exist/);
  assert.equal(run.calls.length, 0, "no docker or az command of any kind may run before this refusal");
});

// ── ACCEPTANCE 2: a STATE_DIR that exists but holds no state/ is refused the same way ───────────

test("W1-T2555: a STATE_DIR that exists but holds no state/ directory is refused the same way", () => {
  const empty = mkdtempSync(join(tmpdir(), "a-recycle-checkout-empty-"));
  const run = runRecycle({ stateDir: empty });

  assert.notEqual(run.status, 0, "an empty directory is not a checkout and must refuse");
  assert.match(run.stderr, /REFUSING — STATE_DIR resolved to/);
  assert.match(run.stderr, /the directory exists/, "existence and checkout-ness are reported separately");
  assert.match(run.stderr, new RegExp(`${escapeRegex(join(empty, "state"))} is MISSING`));
  assert.equal(run.calls.length, 0, "no docker or az command of any kind may run before this refusal");
});

test("W1-T2555: a state/ directory with no checkout beside it is refused too — both markers are required", () => {
  const partial = mkdtempSync(join(tmpdir(), "a-recycle-checkout-partial-"));
  mkdirSync(join(partial, "state"), { recursive: true });
  const run = runRecycle({ stateDir: partial });

  assert.notEqual(run.status, 0, "state/ alone, with no repo checkout, must still refuse");
  assert.match(run.stderr, new RegExp(`${escapeRegex(join(partial, "state"))} is present`));
  assert.match(run.stderr, new RegExp(`${escapeRegex(join(partial, "remudero", ".git"))} is MISSING`));
  assert.equal(run.calls.length, 0);
});

// ── ACCEPTANCE 3: the refusal names the RESOLVED path and how it was resolved ───────────────────

test("W1-T2555: the refusal names the resolved path and that it came from RMD_STATE_DIR", () => {
  const missing = join(mkdtempSync(join(tmpdir(), "a-recycle-checkout-src-")), "typo-d-path");
  const run = runRecycle({ stateDir: missing });
  assert.match(run.stderr, new RegExp(`STATE_DIR resolved to ${escapeRegex(missing)} \\(RMD_STATE_DIR=${escapeRegex(missing)}\\)`));
});

test("W1-T2555: the refusal names the resolved path and that it came from the bare default when RMD_STATE_DIR is unset", () => {
  const home = mkdtempSync(join(tmpdir(), "a-recycle-checkout-home-"));
  const run = runRecycle({ home });
  const expected = join(home, "rmd-state");
  assert.match(run.stderr, new RegExp(`STATE_DIR resolved to ${escapeRegex(expected)}`));
  assert.match(run.stderr, /the default \$\{HOME:-\/root\}\/rmd-state/, "how it was resolved must be named, not merely the path");
  assert.equal(run.calls.length, 0);
});

// ── ACCEPTANCE 4: every line reporting on locks names the directory it actually read ────────────

test("W1-T2555: every line reporting on locks names the directory it actually read", () => {
  const state = makeRealCheckout();
  mkdirSync(join(state, "state", "inflight"), { recursive: true });
  const drainLock = join(state, "state", "drain.lock");
  const inflightLock = join(state, "state", "inflight", "W1-T2555.lock");
  writeFileSync(drainLock, JSON.stringify({ pid: 46 }));
  writeFileSync(inflightLock, JSON.stringify({ pid: 99 }));

  // GH_TOKEN empty: the run prints the locks (section 2) and THEN refuses at the credential
  // capture (section 3) — this test measures only the print step, same technique
  // test/recycle-container.test.ts's own "every blocking lock is printed" test uses.
  const run = runRecycle({ stateDir: state, extraEnv: { GH_TOKEN: "" } });
  assert.notEqual(run.status, 0);
  assert.match(run.stdout, new RegExp(`${escapeRegex(drainLock)} is PRESENT`));
  assert.match(run.stdout, new RegExp(`${escapeRegex(inflightLock)} is PRESENT`));
});

test("W1-T2555: the zero-locks line also names the directory it actually read", () => {
  const state = makeRealCheckout();
  // GH_TOKEN empty again: no lock exists here, so section 2 prints the zero-locks line, then
  // section 3 refuses on the missing credential — same measurement technique as the test above.
  const run = runRecycle({ stateDir: state, extraEnv: { GH_TOKEN: "" } });
  assert.notEqual(run.status, 0);
  assert.match(run.stdout, new RegExp(`no blocking locks under ${escapeRegex(join(state, "state"))}`));
});

// ── ACCEPTANCE 5: a real state directory still proceeds exactly as it does today ────────────────

test("W1-T2555: a real state directory still proceeds exactly as it does today", () => {
  const state = makeRealCheckout();
  const run = runRecycle({ stateDir: state, extraEnv: { GH_TOKEN: "fixture-token" } });
  assert.equal(run.status, 0, `expected a clean recycle, got ${run.status}: ${run.stderr}`);
  assert.ok(run.calls.some(isRun), "the daemon must still be started against a genuine checkout");
  assert.doesNotMatch(run.stderr, /REFUSING — STATE_DIR/, "a genuine checkout must never trip the new guard");
});

// ── ACCEPTANCE 6: a deliberate first-boot is possible, and only by explicit operator opt-in ─────

test("W1-T2555: a deliberate first-boot on a nonexistent path proceeds with the RMD_RECYCLE_FIRST_BOOT=1 opt-in", () => {
  const parent = mkdtempSync(join(tmpdir(), "a-recycle-checkout-firstboot-env-"));
  const missing = join(parent, "brand-new-host");
  const run = runRecycle({ stateDir: missing, extraEnv: { RMD_RECYCLE_FIRST_BOOT: "1", GH_TOKEN: "fixture-token" } });
  assert.equal(run.status, 0, `the explicit opt-in must let a fresh host recycle: ${run.stderr}`);
  assert.ok(run.calls.some(isRun), "the daemon must start on a genuinely fresh host");
});

test("W1-T2555: a deliberate first-boot on a nonexistent path proceeds with the --first-boot flag", () => {
  const parent = mkdtempSync(join(tmpdir(), "a-recycle-checkout-firstboot-flag-"));
  const missing = join(parent, "brand-new-host");
  const run = runRecycle({ stateDir: missing, extraEnv: { GH_TOKEN: "fixture-token" }, extraArgs: ["--first-boot"] });
  assert.equal(run.status, 0, `--first-boot must let a fresh host recycle: ${run.stderr}`);
  assert.ok(run.calls.some(isRun), "the daemon must start on a genuinely fresh host");
});

test("W1-T2555: the first-boot opt-in also covers an EXISTING but empty path — still only via the explicit flag", () => {
  const empty = mkdtempSync(join(tmpdir(), "a-recycle-checkout-firstboot-empty-"));
  const refused = runRecycle({ stateDir: empty, extraEnv: { GH_TOKEN: "fixture-token" } });
  assert.notEqual(refused.status, 0, "without the opt-in, empty-but-existing must still refuse");

  const allowed = runRecycle({ stateDir: empty, extraEnv: { RMD_RECYCLE_FIRST_BOOT: "1", GH_TOKEN: "fixture-token" } });
  assert.equal(allowed.status, 0, `with the explicit opt-in the same path must proceed: ${allowed.stderr}`);
  assert.ok(allowed.calls.some(isRun));
});

// ── ACCEPTANCE 7: removing the existence check lets the run reach docker run — the falsifier ────

test("W1-T2555: MUTANT: removing the checkout-existence guard lets a nonexistent STATE_DIR reach docker run", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const startAnchor = 'if [ "${FIRST_BOOT}" != "1" ]; then\n';
  const endAnchor = '\nfi\n\n# ── 2. EVERY BLOCKING LOCK IS PRINTED IN FULL';

  const startIdx = src.indexOf(startAnchor);
  assert.ok(startIdx >= 0, "the guard's opening line must still be present");
  assert.equal(src.indexOf(startAnchor, startIdx + 1), -1, "the guard's opening line must be unique");

  const endIdx = src.indexOf(endAnchor, startIdx);
  assert.ok(endIdx > startIdx, "the guard's closing 'fi' before section 2 must still be present");

  const cutEnd = endIdx + "\nfi".length;
  const mutated = src.slice(0, startIdx) + src.slice(cutEnd);
  assert.notEqual(mutated, src, "the mutation must actually remove something");

  const dir = mkdtempSync(join(tmpdir(), "a-recycle-checkout-mutant-"));
  const mutant = join(dir, "recycle-container.sh");
  writeFileSync(mutant, mutated, { mode: 0o755 });
  chmodSync(mutant, 0o755);

  const missing = join(mkdtempSync(join(tmpdir(), "a-recycle-checkout-mutant-target-")), "still-does-not-exist");

  const mutantRun = runRecycle({ stateDir: missing, scriptPath: mutant, extraEnv: { GH_TOKEN: "fixture-token" } });
  assert.ok(
    mutantRun.calls.some(isRun),
    `the mutant must actually reach docker run against a nonexistent STATE_DIR, or this proves nothing about the guard: ${mutantRun.stderr}`,
  );

  const realRun = runRecycle({ stateDir: missing, extraEnv: { GH_TOKEN: "fixture-token" } });
  assert.ok(!realRun.calls.some(isRun), "the real, unmutated script must never reach docker run against that same path");
});
