import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "host-update.sh");

/**
 * test/host-update-tmp-paths.test.ts — W1-T2848.
 *
 * `deploy/host-update.sh` wrote two FIXED paths: `/tmp/host-update-docker.err` (redirected to,
 * then read back twice) and `/tmp/host-update-pull.log` (tee'd to, then grepped). `/tmp` is
 * sticky, so on a host with two real accounts whichever ran first owned both names permanently and
 * the second account's redirect failed outright:
 *
 *     deploy/host-update.sh: line 427: /tmp/host-update-docker.err: Permission denied
 *
 * MEASURED on this machine: `/tmp/host-update-docker.err` existed owned by uid `craigoley` mode
 * 0644 while the fleet account is `craigoleyagent`, and 12 tests in host-update-reclaim.test.ts
 * were red because of it — identically at the merge base, so environmental rather than any diff's.
 *
 * THE MISDIAGNOSIS IS THE WORSE HALF. With the redirect refused the conditional fell through and
 * the script announced "host-update: docker is not answering. Check the daemon is up: 'systemctl
 * status docker'." Docker was answering, and `systemctl` does not exist on macOS — the platform
 * this host runs. An operator following that line verbatim gets `command not found` while chasing
 * a healthy daemon.
 *
 * WHY IT SURVIVED THE CAMPAIGN BUILT TO CATCH IT. W1-T2773's `scripts/mkdtemp-callsite-check.mjs`
 * refuses a bare-prefix temp path at author time and W1-T2775 migrated the callsites — but the
 * scanner reads tracked `.ts`/`.mjs` only, so every shell script under `deploy/` sits outside its
 * corpus. Widening that scanner is deliberately out of this task's scope (design (v)).
 *
 * TECHNIQUE, unchanged from test/host-update-reclaim.test.ts: stub `docker` and `az` on PATH, run
 * the REAL script, and assert on what it did. No docker daemon is required. This suite adds one
 * thing to that harness — the docker stub records what the script's OWN temp directory contained
 * at the moment docker was first called, which is the only point in the run where a
 * per-invocation name exists and can be observed from outside.
 */

interface Run {
  status: number;
  stdout: string;
  stderr: string;
  /** Names matching the script's temp prefix that existed in TMPDIR while docker was running. */
  tmpFilesDuringRun: string[];
  /** Names still there after the process exited. */
  tmpFilesAfterRun: string[];
  dockerCalled: boolean;
}

/** The `docker`/`az` stubs, plus the temp-file census this suite needs.
 *
 *  WRITTEN IN BASH for the sibling suite's reason: the script resolves both by BARE NAME off PATH,
 *  and an extensionless node script would need an interpreter that may not be where a test assumes. */
function writeStubs(dir: string): void {
  const docker = [
    "#!/usr/bin/env bash",
    // THE CENSUS, taken on the FIRST docker call — which is `info`, the very call whose stderr the
    // first temp file receives. Anything the script allocated is on disk now and gone by exit, so
    // this is the one observation window.
    'if [ ! -e "$STUB_REC/tmpcensus" ]; then',
    '  ls -1 "$STUB_TMPDIR" 2>/dev/null | grep "^rmd-host-update-" > "$STUB_REC/tmpcensus" || : > "$STUB_REC/tmpcensus"',
    "fi",
    ': > "$STUB_REC/docker-called"',
    'case "$1 $2" in',
    // A REAL directory: the script runs `df -Pk` on it and pipefail turns a df failure into an
    // aborted run.
    '  "info --format")  echo "$STUB_REC"; exit 0 ;;',
    '  "system df")      echo "TYPE TOTAL ACTIVE SIZE"; exit 0 ;;',
    "esac",
    'case "$1" in',
    "  ps) exit 0 ;;",
    "  image)",
    '    if [ "$2" = "inspect" ]; then',
    '      case "$4" in *RepoDigests*) echo "reg.azurecr.io/remudero@sha256:same" ;; *) echo "sha256:idsame" ;; esac',
    "      exit 0",
    "    fi",
    '    echo "Total reclaimed space: 1GB"; exit 0 ;;',
    '  container|builder) echo "Total reclaimed space: 0B"; exit 0 ;;',
    "  pull)",
    // Re-census on the pull too: the SECOND temp file is allocated only here, so a census taken
    // at `info` alone could not see it.
    '    ls -1 "$STUB_TMPDIR" 2>/dev/null | grep "^rmd-host-update-" > "$STUB_REC/tmpcensus-pull" || : > "$STUB_REC/tmpcensus-pull"',
    '    echo "Status: Downloaded newer image"; exit 0 ;;',
    "esac",
    "exit 0",
    "",
  ].join("\n");

  const az = ["#!/usr/bin/env bash", "exit 0", ""].join("\n");
  writeFileSync(join(dir, "docker"), docker, { mode: 0o755 });
  writeFileSync(join(dir, "az"), az, { mode: 0o755 });
  // mkdtemp honours the umask, so the mode above is a request. Make it a fact.
  chmodSync(join(dir, "docker"), 0o755);
  chmodSync(join(dir, "az"), 0o755);
}

function runHostUpdate(opts: { tmpdirOverride?: string } = {}): Run {
  const stubs = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}hu-tmp-stub-`));
  const rec = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}hu-tmp-rec-`));
  const state = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}hu-tmp-state-`));
  const scriptTmp = opts.tmpdirOverride ?? mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}hu-tmp-scratch-`));
  writeStubs(stubs);
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${stubs}:${process.env.PATH ?? ""}`,
      STUB_REC: rec,
      STUB_TMPDIR: scriptTmp,
      STUB_MODE: "ok",
      TMPDIR: scriptTmp,
      RMD_STATE_DIR: state,
    },
  });
  const census = (name: string): string[] => {
    try {
      return readFileSync(join(rec, name), "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  let after: string[] = [];
  try {
    after = readdirSync(scriptTmp).filter((f) => f.startsWith("rmd-host-update-"));
  } catch {
    after = [];
  }
  let dockerCalled = true;
  try {
    readFileSync(join(rec, "docker-called"));
  } catch {
    dockerCalled = false;
  }
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    tmpFilesDuringRun: [...census("tmpcensus"), ...census("tmpcensus-pull")],
    tmpFilesAfterRun: after,
    dockerCalled,
  };
}

/** The script's EXECUTABLE lines — every `#` comment and blank line stripped. A source assertion
 *  that reads the whole file would pass on a fixed path merely because the rationale comment quotes
 *  the old one, which is the `#339`/W1-T281 shape (a proof that greps a COMMENT). */
function executableLines(): string[] {
  return readFileSync(SCRIPT, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

// ── acceptance 1 + 4: neither path is a fixed literal, and each run gets its own ───────────────

test("W1-T2848 (acceptance 1a): no executable line in host-update.sh names a fixed /tmp/host-update-* path", () => {
  const offenders = executableLines().filter((l) => /\/tmp\/host-update-[A-Za-z0-9_.-]+/.test(l));
  assert.deepEqual(offenders, [], "a fixed name in a sticky directory is owned by whoever ran first");
  // The CONTROL for the comment-stripping above: the rationale comment DOES still quote the old
  // paths, so a whole-file read would have found matches. If this ever reads 0, the filter is
  // wrong rather than the source being clean, and the assertion above would be vacuous.
  const inComments = readFileSync(SCRIPT, "utf8")
    .split("\n")
    .filter((l) => l.trim().startsWith("#") && /\/tmp\/host-update-/.test(l));
  assert.ok(inComments.length > 0, "the old names are still quoted in prose — so the filter is doing real work");
});

test("W1-T2848 (acceptance 4): the temp files are created per invocation — two runs allocate DIFFERENT names, observed from inside the run", () => {
  const first = runHostUpdate();
  const second = runHostUpdate();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.ok(first.tmpFilesDuringRun.length >= 2, `expected both temp files during the run, saw ${JSON.stringify(first.tmpFilesDuringRun)}`);
  assert.ok(second.tmpFilesDuringRun.length >= 2, JSON.stringify(second.tmpFilesDuringRun));
  const overlap = first.tmpFilesDuringRun.filter((n) => second.tmpFilesDuringRun.includes(n));
  assert.deepEqual(overlap, [], "a name reused across two runs is a name a second account can be locked out of");
});

test("W1-T2848 (acceptance 1b): every allocated name carries the rmd- prefix, so the existing sweep can reap one the trap missed", () => {
  const run = runHostUpdate();
  assert.equal(run.status, 0, run.stderr);
  for (const name of run.tmpFilesDuringRun) {
    assert.ok(
      name.startsWith(RMD_TMP_PREFIX),
      `${name} would be a fresh permanent leak — sweepStaleTempDirs reaps only ${RMD_TMP_PREFIX}* (W1-T2773)`,
    );
  }
});

// ── acceptance 3: removed on exit, not traded for a new leak ───────────────────────────────────

test("W1-T2848 (acceptance 3): both temp files exist DURING the run and are gone after it — a per-invocation name is not a licence to leak", () => {
  const run = runHostUpdate();
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.tmpFilesDuringRun.length >= 2, "the during-run census is the positive control for the after-run zero");
  assert.deepEqual(run.tmpFilesAfterRun, [], "the EXIT trap removes both");
});

// ── acceptance 2: a temp-file failure is reported as one, never as docker being down ───────────

test("W1-T2848 (acceptance 2): when the temp file cannot be created the script names THAT, names the directory, and never blames docker", () => {
  const missing = join(tmpdir(), `${RMD_TMP_PREFIX}hu-tmp-does-not-exist-${process.pid}`);
  const run = runHostUpdate({ tmpdirOverride: missing });
  assert.notEqual(run.status, 0, "an unusable temp directory is a refusal, not a silent continue");
  assert.match(run.stderr, /cannot create a temporary file/i, "says what actually failed");
  assert.ok(run.stderr.includes(missing), "and names the directory, so the operator can act on it");
  assert.doesNotMatch(
    run.stderr,
    /docker is not answering/,
    "the old behaviour: the redirect failed, the conditional fell through, and a healthy daemon was blamed",
  );
  assert.equal(run.dockerCalled, false, "docker was never contacted, so it cannot be the diagnosis");
});

// ── the fourth remedy line: no systemctl on a platform that lacks it ───────────────────────────

test("W1-T2848: the docker-is-down remedy is platform-gated — systemctl is never the advice on Darwin", () => {
  const lines = executableLines();
  const systemctl = lines.filter((l) => l.includes("systemctl"));
  assert.ok(systemctl.length > 0, "the Linux advice is still there — this is not a deletion");
  assert.ok(
    lines.some((l) => /uname -s/.test(l)) && lines.some((l) => /Darwin/.test(l)),
    "and it is now reached only after a platform test, with a Darwin arm beside it",
  );
  const darwinArm = lines.findIndex((l) => /Darwin/.test(l));
  const systemctlLine = lines.findIndex((l) => l.includes("systemctl"));
  assert.ok(darwinArm >= 0 && darwinArm < systemctlLine, "the Darwin arm is taken BEFORE the systemctl fallback");
});

// ── the script still parses, and the sibling suite's subject is unchanged in behaviour ─────────

test("W1-T2848: host-update.sh still parses under bash -n — the smallest guard against a shell edit that only looks right", () => {
  const r = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
