import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Config } from "../src/lib/config.js";
import {
  WORKER_SMOKE_MAX_TURNS,
  assessWorkerSmoke,
  runWorkerSmoke,
  workerSmokePrompt,
} from "../src/lib/containment.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { WorkerResult } from "../src/lib/worker.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "recycle-container.sh");

/**
 * W1-T5017. CI fakes the worker query seam and image verification compares binary versions, so an
 * SDK/CLI change could pass both and fail at the first dispatch. The recycle now runs ONE real worker
 * query on the pulled image before it touches the running container. Two halves here: the pure verdict
 * and the bounded runner (injected spawn), and the REAL recycle script driven against a stubbed docker
 * whose smoke container passes, fails or hangs — each arm asserted on the recorded docker calls.
 */

const TOKEN = "smoke-1";
const DENIED = `touch: cannot touch '../${TOKEN}.txt': Operation not permitted`;
const fakeConfig = (): Config => ({ root: mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}worker-smoke-root-`)) }) as unknown as Config;

function result(over: Partial<WorkerResult> = {}): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0.01,
    numTurns: 2,
    text: `REPORT\noutside: ${DENIED}\ninside: ok`,
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    ...over,
  } as WorkerResult;
}

test("W1-T5017: a denied outside write with a clean termination passes the smoke verdict", () => {
  const v = assessWorkerSmoke(TOKEN, { transcript: DENIED, outsideWriteCreated: false, insideWriteCreated: true, isError: false, subtype: "success" });
  assert.equal(v.ok, true, v.reason);
});

test("W1-T5017: an outside write that landed fails the smoke verdict as a containment failure", () => {
  const v = assessWorkerSmoke(TOKEN, { transcript: DENIED, outsideWriteCreated: true, insideWriteCreated: true, isError: false, subtype: "success" });
  assert.equal(v.ok, false);
  assert.match(v.reason, /containment verdict/);
});

test("W1-T5017: a transcript that never reached the write is UNPROVEN, not a pass", () => {
  const v = assessWorkerSmoke(TOKEN, { transcript: "hello", outsideWriteCreated: false, insideWriteCreated: true, isError: false, subtype: "success" });
  assert.equal(v.ok, false);
});

test("W1-T5017: a proven containment verdict without a clean termination still fails", () => {
  for (const subtype of ["error_max_turns", "error_during_execution", undefined]) {
    const v = assessWorkerSmoke(TOKEN, { transcript: DENIED, outsideWriteCreated: false, insideWriteCreated: true, isError: false, subtype });
    assert.equal(v.ok, false, `subtype ${String(subtype)}`);
  }
  const errored = assessWorkerSmoke(TOKEN, { transcript: DENIED, outsideWriteCreated: false, insideWriteCreated: true, isError: true, subtype: "success" });
  assert.equal(errored.ok, false);
});

test("W1-T5017: the runner makes one bounded real spawn and ledgers its verdict", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const rows: Array<Record<string, unknown>> = [];
  const r = await runWorkerSmoke({
    config: fakeConfig(),
    settingsFile: "/unused",
    token: TOKEN,
    initializeRepository: () => {},
    spawn: (async (a: Record<string, unknown>) => {
      seen.push(a);
      return result();
    }) as never,
    ledger: (l) => rows.push(l),
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(seen.length, 1, "exactly one worker query");
  assert.equal(seen[0].maxTurns, WORKER_SMOKE_MAX_TURNS);
  assert.ok(typeof seen[0].maxBudgetUsd === "number" && (seen[0].maxBudgetUsd as number) <= 1, "spend is bounded");
  assert.equal(seen[0].prompt, workerSmokePrompt(TOKEN));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].step, "worker_smoke");
  assert.equal(rows[0].ok, true);
});

test("W1-T5017: a spawn that throws is a FAILED smoke with a ledgered reason, never a rejection", async () => {
  const rows: Array<Record<string, unknown>> = [];
  const r = await runWorkerSmoke({
    config: fakeConfig(),
    settingsFile: "/unused",
    token: TOKEN,
    initializeRepository: () => {},
    spawn: (async () => {
      throw new Error("claude: unsupported sdk/cli pair");
    }) as never,
    ledger: (l) => rows.push(l),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unsupported sdk\/cli pair/);
  assert.equal(rows[0].ok, false);
});

// ── the REAL recycle script against a stubbed docker ────────────────────────────────────────────

interface Call {
  argv: string[];
}

/** SMOKE_MODE: pass | fail | hang. Everything else is the minimum the recycle needs to reach section 6/7. */
function stubDocker(dir: string): void {
  const lines = [
    "#!/usr/bin/env bash",
    'printf "%s" "docker" >> "$STUB_REC/calls"; for a in "$@"; do printf "\\t%s" "$a" >> "$STUB_REC/calls"; done; printf "\\n" >> "$STUB_REC/calls"',
    'case "$1" in',
    "  image)",
    '    if [ "$2" = "inspect" ]; then',
    '      case "$*" in *Config.Env*) echo "PATH=/usr/local/bin"; echo "HOME=/home/node"; echo ""; exit 0 ;; esac',
    '      echo "sha256:PULLEDID"',
    "    fi",
    "    exit 0 ;;",
    "  inspect)",
    "    shift",
    '    fmt=""; if [ "$1" = "--format" ]; then fmt="$2"; shift 2; fi',
    '    case "$fmt" in',
    '      "") exit 0 ;;',
    '      *Mounts*) printf \'%s\\t%s\\ttrue\\n\' "$RMD_STATE_DIR" /home/node/Remudero; printf \'%s\\t%s\\ttrue\\n\' "$RMD_CLAUDE_DIR" /home/node/.claude; exit 0 ;;',
    '      *Config.Image*) echo "test-registry/remudero:old"; exit 0 ;;',
    '      *Config.Env*) echo "PATH=/usr/local/bin"; echo "HOME=/home/node"; echo "GH_TOKEN=captured-token"; echo ""; exit 0 ;;',
    '      *.Image}}*) echo "sha256:PULLEDID"; exit 0 ;;',
    "    esac",
    "    exit 0 ;;",
    "  pull) echo 'Status: Downloaded newer image'; exit 0 ;;",
    "  container)",
    '    if [ "$2" = "run" ]; then',
    '      case "$SMOKE_MODE" in',
    '        pass) echo "WORKER-SMOKE PASS outside-cwd write OS-DENIED"; exit 0 ;;',
    '        fail) echo "WORKER-SMOKE FAIL unclean termination - subtype error_during_execution"; exit 1 ;;',
    "        hang) sleep 30; exit 0 ;;",
    "      esac",
    "    fi",
    "    exit 0 ;;",
    "esac",
    "exit 0",
    "",
  ];
  writeFileSync(join(dir, "docker"), lines.join("\n"), { mode: 0o755 });
  chmodSync(join(dir, "docker"), 0o755);
  writeFileSync(join(dir, "az"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  chmodSync(join(dir, "az"), 0o755);
}

function runRecycle(smokeMode: string, extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}smoke-stub-`));
  const rec = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}smoke-rec-`));
  const state = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}smoke-state-`));
  const claudeDir = join(rec, "claude");
  mkdirSync(claudeDir);
  stubDocker(dir);
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      STUB_REC: rec,
      SMOKE_MODE: smokeMode,
      RMD_STATE_DIR: state,
      RMD_CLAUDE_DIR: claudeDir,
      RMD_CODEX_DIR: join(rec, "absent-codex"),
      RMD_CONTAINER_CONFIG_DIR: join(rec, "absent-config"),
      RMD_RECYCLE_WAIT_S: "1",
      RMD_RECYCLE_POLL_S: "1",
      RMD_RECYCLE_FIRST_BOOT: "1",
      RMD_RECYCLE_SKIP_RECLAIM: "1",
      GH_TOKEN: "",
      GH_APP_ID: "",
      GH_APP_INSTALLATION_ID: "",
      GH_APP_PRIVATE_KEY_PATH: "",
      RMD_RECYCLE_DOCKERENV_PATH: join(tmpdir(), "worker-smoke-test-no-such-dockerenv-marker"),
      ...extraEnv,
    },
  });
  const calls: Call[] = existsSync(join(rec, "calls"))
    ? readFileSync(join(rec, "calls"), "utf8").split("\n").filter(Boolean).map((l) => ({ argv: l.split("\t").slice(1) }))
    : [];
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", calls, state };
}

const verb = (c: Call) => c.argv[0];
const isSmoke = (c: Call) => c.argv[0] === "container" && c.argv[1] === "run";

test("W1-T5017: recycle refuses a replacement image whose real worker smoke fails", () => {
  const run = runRecycle("fail");
  assert.notEqual(run.status, 0, `a failed smoke must refuse: ${run.stdout}`);
  assert.match(run.stderr, /REFUSING — the real worker smoke FAILED/);
  assert.match(run.stderr, /WORKER-SMOKE FAIL/, "the smoke's own explanation reaches the operator");
  assert.equal(run.calls.filter(isSmoke).length, 1, "the smoke must actually have run (positive control)");
  for (const forbidden of ["stop", "rm", "run"]) {
    assert.equal(run.calls.filter((c) => verb(c) === forbidden).length, 0, `docker ${forbidden} must not run after a failed smoke`);
  }
  assert.ok(!existsSync(join(run.state, "state", "PAUSE")), "the rollback must take the recycle's own pause off");
  assert.match(run.stderr, /STILL RUNNING on its current image/);
});

test("W1-T5017: recycle invokes exactly one real worker smoke, on the pulled image, before the old container is stopped", () => {
  const run = runRecycle("pass");
  assert.equal(run.status, 0, `expected success: ${run.stderr}`);
  const smokeAt = run.calls.findIndex(isSmoke);
  const stopAt = run.calls.findIndex((c) => verb(c) === "stop");
  assert.equal(run.calls.filter(isSmoke).length, 1);
  assert.ok(smokeAt >= 0 && stopAt > smokeAt, "the smoke runs before docker stop");
  assert.ok(run.calls[smokeAt].argv.includes("sha256:PULLEDID"), "the smoke runs the PULLED image");
  assert.match(run.stdout, /worker smoke PASSED/);
  assert.ok(run.calls.some((c) => verb(c) === "run"), "the replacement still starts after a passing smoke");
});

test("W1-T5017: a smoke that hangs past its bound is a failure, not a wait", { skip: spawnSync("sh", ["-c", "command -v timeout"]).status !== 0 }, () => {
  const run = runRecycle("hang", { RMD_RECYCLE_SMOKE_TIMEOUT_S: "1" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /smoke FAILED \(exit 124\)/);
  assert.equal(run.calls.filter((c) => verb(c) === "stop").length, 0);
});
