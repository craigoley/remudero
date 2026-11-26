// W1-T14947 — deploy/recycle-container.sh's drain counts a review lock under state/inflight/reviews whose owner is alive in
// the target container, and ignores one whose owner is gone or that another container wrote. Drives the real script with a
// fake `docker` on PATH.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const RECYCLE = join(REPO_ROOT, "deploy/recycle-container.sh");

// Images and containers are files; `exec <c> kill -0 <pid>` succeeds only for a pid listed in FAKE_ALIVE_PIDS.
const FAKE_DOCKER = `#!/usr/bin/env bash
S="$FAKE_STORE"
case "$1" in
  exec)
    if [ "$3" = kill ] && [ "$4" = -0 ]; then
      case " $FAKE_ALIVE_PIDS " in *" $5 "*) exit 0 ;; esac
      exit 1
    fi
    exit 0 ;;
  pull) : > "$S/images/$PULL_ID"; echo "fixture pulled"; exit 0 ;;
  create) mkdir -p "$S/containers/$3"; echo "$4" > "$S/containers/$3/image"; echo "$3" > "$S/containers/$3/id"; echo "$3"; exit 0 ;;
  container)
    case "$2" in
      inspect) cat "$S/containers/$5/image" 2>/dev/null || exit 1 ;;
      rm) rm -rf "$S/containers/$3" ;;
      run) echo "WORKER-SMOKE PASS fixture" ;;
    esac
    exit 0 ;;
  image)
    case "$2" in
      inspect)
        case "$*" in *Config.Env*) exit 0 ;; esac
        if [ "$3" = --format ]; then [ -e "$S/images/$PULL_ID" ] && echo "$PULL_ID"; exit 0; fi
        [ -e "$S/images/$3" ]; exit ;;
      prune) echo "Total reclaimed space: 0B"; exit 0 ;;
    esac
    exit 0 ;;
  inspect)
    name="\${!#}"
    case "$*" in
      *Config.Env*) echo GH_TOKEN=fixture-token ;;
      *Config.Hostname*) echo "$FAKE_HOSTNAME" ;;
      *Mounts*) printf '%s\\t/home/node/Remudero\\ttrue\\n%s\\t/home/node/.claude\\ttrue\\n' "$RMD_STATE_DIR" "$RMD_CLAUDE_DIR" ;;
      *Config.Image*) echo fixture/remudero:old ;;
      *'{{.Id}}'*) cat "$S/containers/$name/id" 2>/dev/null || exit 1 ;;
      *State.Running*) [ -d "$S/containers/$name" ] || exit 1; echo true ;;
      *) for n in "\${@:4}"; do cat "$S/containers/$n/image" 2>/dev/null; done ;;
    esac
    exit 0 ;;
  ps) case "$*" in *-aq*) ls "$S/containers" ;; esac; exit 0 ;;
  stop) exit 0 ;;
  rm) rm -rf "$S/containers/$2" ;;
  run) mkdir -p "$S/containers/$RMD_DAEMON_CONTAINER"; echo "$PULL_ID" > "$S/containers/$RMD_DAEMON_CONTAINER/image"
       echo "new-$PULL_ID" > "$S/containers/$RMD_DAEMON_CONTAINER/id" ;;
  info) echo "$S" ;;
  system) echo "TYPE TOTAL ACTIVE SIZE" ;;
esac
exit 0
`;

/** Runs one recycle whose state holds a review lock owned by pid 4242 on `lockHost`; the target container's hostname is
 *  `core-host`. Returns its exit code and output. */
async function recycleWithReviewLock(t: TestContext, alivePids: string, lockHost = "core-host"): Promise<{ code: number | null; out: string }> {
  const owned = ownedFixtureDir(t, "recycle-review-lock");
  const root = owned.dir;
  const store = join(root, "store");
  for (const dir of ["bin", "home", "claude", "tmp", "store/images", "store/containers/core-daemon", "core/state/inflight/reviews"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, "bin/docker"), FAKE_DOCKER, { mode: 0o755 });
  writeFileSync(join(root, "bin/az"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(root, "key"), "fixture-key\n", { mode: 0o600 });
  writeFileSync(join(store, "images/sha256:old"), "");
  writeFileSync(join(store, "containers/core-daemon/image"), "sha256:old\n");
  writeFileSync(join(store, "containers/core-daemon/id"), "old-core-daemon\n");
  writeFileSync(join(root, "core/state/inflight/reviews/review-run-a.lock"),
    JSON.stringify({ pid: 4242, run_id: "run-a", host: lockHost, startedAt: new Date().toISOString() }));
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: join(root, "home"), PATH: `${join(root, "bin")}:${process.env.PATH}`,
    FAKE_STORE: store, FAKE_ALIVE_PIDS: alivePids, FAKE_HOSTNAME: "core-host", RMD_CLAUDE_DIR: join(root, "claude"),
    RMD_CODEX_DIR: join(root, "absent-codex"), RMD_CONTAINER_CONFIG_DIR: join(root, "absent-config"),
    RMD_RECYCLE_FIRST_BOOT: "1", RMD_RECYCLE_POLL_S: "1", RMD_RECYCLE_DOCKERENV_PATH: join(root, "no-marker"),
    RMD_OPENWEIGHT_API_KEY_PATH: join(root, "key"), TMPDIR: join(root, "tmp"),
    GH_TOKEN: "fixture-token", GH_APP_ID: "", GH_APP_INSTALLATION_ID: "", GH_APP_PRIVATE_KEY_PATH: "",
    RMD_RECYCLE_HOST_LOCK: join(root, "recycle-container.lock"), RMD_RECYCLE_LOCK_POLL_S: "1", RMD_INSTANCE_REGISTRY: undefined,
    RMD_STATE_DIR: join(root, "core"), RMD_DAEMON_CONTAINER: "core-daemon", PULL_ID: "sha256:core-new",
    RMD_RECYCLE_WAIT_S: "2", RMD_RECYCLE_LOCK_WAIT_S: "30",
  };
  const child = spawn("bash", [RECYCLE], { cwd: REPO_ROOT, detached: true, env });
  let out = "";
  child.stdout.on("data", (b: Buffer) => { out += String(b); });
  child.stderr.on("data", (b: Buffer) => { out += String(b); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (c, signal) => resolve(c ?? (signal ? -1 : null)));
  });
  owned.until(Promise.resolve(code));
  return { code, out };
}

describe("test/deploy/a-recycle-drain-counts-in-flight-review-locks.test.ts", { timeout: 300_000 }, () => {
  test("W1-T14947 a recycle drain waits on a live review lock", async (t) => {
    const live = await recycleWithReviewLock(t, "4242");
    assert.match(live.out, /1 lane-holding \+ 0 lane-less worker\(s\) still in flight/, live.out);
    assert.equal(live.code, 1, `the bounded wait refuses rather than kill the live review:\n${live.out}`);
    assert.match(live.out, /reviews\/review-run-a\.lock \(a live review, W1-T14947\)/);
    assert.doesNotMatch(live.out, /no in-flight workers — safe to proceed/);
    const blockers = JSON.parse(/recycle-blockers-json: (\[.*\])/.exec(live.out)?.[1] ?? "[]") as Array<Record<string, unknown>>;
    assert.deepEqual(blockers.filter((b) => b.kind === "lock").map((b) => [b.task_id, b.run_id]), [["reviews/review-run-a", "run-a"]],
      "the refusal names the review lock as a blocker the supervisor can watch settle");

    const gone = await recycleWithReviewLock(t, "");
    assert.match(gone.out, /no in-flight workers — safe to proceed/, `a lock whose owner is gone does not block:\n${gone.out}`);

    const replaced = await recycleWithReviewLock(t, "4242", "replaced-container-host");
    assert.match(replaced.out, /no in-flight workers — safe to proceed/,
      `a lock another container wrote does not block, even when its pid number is alive here:\n${replaced.out}`);
  });
});
