import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T12243: a recycle releases the host recycle lock while it waits for its workers. These drive
// the real deploy/recycle-container.sh and deploy/host-update.sh with a fake `docker` on PATH. The
// fake keeps images and containers as files, and its `image prune` removes every image that no
// container (running or stopped) uses, as `docker image prune -a` does. Each fake call records who
// held the host recycle lock at that moment. No real container or process is touched.

const RECYCLE = join(REPO_ROOT, "deploy/recycle-container.sh");
const HOST_UPDATE = join(REPO_ROOT, "deploy/host-update.sh");
const HOLD = "core-daemon-image-hold";

const FAKE_DOCKER = `#!/usr/bin/env bash
S="$FAKE_STORE"
holder() { cut -d' ' -f1 "$FAKE_LOCK/holder" 2>/dev/null; }
note() { printf '%s\\t%s\\t%s\\n' "$FAKE_ROLE" "$1" "$(holder)" >> "$S/calls"; }
case "$1" in
  pull) note pull; : > "$S/images/$PULL_ID"; echo "fixture pulled"; exit 0 ;;
  create)
    note "create $3"
    [ "\${CREATE_RC:-0}" = 0 ] || { echo "fixture: create refused" >&2; exit "$CREATE_RC"; }
    [ -e "$S/images/$4" ] || { echo "No such image: $4" >&2; exit 1; }
    mkdir "$S/containers/$3" || exit 1
    echo "$4" > "$S/containers/$3/image"; echo "$3" > "$S/containers/$3/id"; echo "$3"; exit 0 ;;
  container)
    case "$2" in
      inspect) cat "$S/containers/$5/image" 2>/dev/null || exit 1 ;;
      rm) note "container-rm $3"; rm -rf "$S/containers/$3" ;;
      run) echo "WORKER-SMOKE PASS fixture" ;;
    esac
    exit 0 ;;
  image)
    case "$2" in
      inspect)
        case "$*" in *Config.Env*) exit 0 ;; esac
        if [ "$3" = --format ]; then [ -e "$S/images/$PULL_ID" ] && echo "$PULL_ID"; exit 0; fi
        [ -e "$S/images/$3" ]; exit ;;
      prune)
        note prune
        for f in "$S"/images/*; do
          [ -e "$f" ] || continue
          cat "$S"/containers/*/image 2>/dev/null | grep -qxF "\${f##*/}" || rm -f "$f"
        done
        echo "Total reclaimed space: 1GB"; exit 0 ;;
    esac
    exit 0 ;;
  inspect)
    name="\${!#}"
    case "$*" in
      *Config.Env*) echo GH_TOKEN=fixture-token ;;
      *Mounts*) printf '%s\\t/home/node/Remudero\\ttrue\\n%s\\t/home/node/.claude\\ttrue\\n' "$RMD_STATE_DIR" "$RMD_CLAUDE_DIR" ;;
      *Config.Image*) echo fixture/remudero:old ;;
      *'{{.Id}}'*) cat "$S/containers/$name/id" 2>/dev/null || exit 1 ;;
      *State.Running*) [ -d "$S/containers/$name" ] || exit 1; echo true ;;
      *) for n in "\${@:4}"; do cat "$S/containers/$n/image" 2>/dev/null; done ;;
    esac
    exit 0 ;;
  ps)
    [ "$FAKE_ROLE" != host-update ] || exit 0
    case "$*" in *-aq*) ls "$S/containers" ;; esac
    exit 0 ;;
  stop) note stop; exit "\${STOP_RC:-0}" ;;
  rm) note "rm $2"; rm -rf "$S/containers/$2" ;;
  run)
    note run
    mkdir -p "$S/containers/$RMD_DAEMON_CONTAINER"
    echo "$PULL_ID" > "$S/containers/$RMD_DAEMON_CONTAINER/image"
    echo "new-$PULL_ID" > "$S/containers/$RMD_DAEMON_CONTAINER/id" ;;
  info) echo "$S" ;;
  system) echo "TYPE TOTAL ACTIVE SIZE" ;;
esac
exit 0
`;

interface Call { role: string; what: string; holder: string }

interface Run {
  child: ChildProcess;
  output: () => string;
  /** The holder pid of the host recycle lock, read at each of the recycle's wait polls. */
  pollHolders: string[];
  waitFor: (text: string) => Promise<void>;
  exited: Promise<number | null>;
}

function fixture(t: TestContext) {
  const owned = ownedFixtureDir(t, "recycle-lock-wait");
  const root = owned.dir;
  const store = join(root, "store");
  const lock = join(root, "recycle-container.lock");
  for (const dir of ["bin", "home", "claude", "tmp", "store/images", "store/containers"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "bin/docker"), FAKE_DOCKER, { mode: 0o755 });
  writeFileSync(join(root, "bin/az"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(root, "key"), "fixture-key\n", { mode: 0o600 });
  writeFileSync(join(store, "images/sha256:old"), "");
  writeFileSync(join(store, "images/sha256:unused"), "");
  for (const name of ["core-daemon", "site-daemon"]) {
    mkdirSync(join(store, "containers", name));
    writeFileSync(join(store, "containers", name, "image"), "sha256:old\n");
    writeFileSync(join(store, "containers", name, "id"), `old-${name}\n`);
  }
  const base: NodeJS.ProcessEnv = {
    ...process.env, HOME: join(root, "home"), PATH: `${join(root, "bin")}:${process.env.PATH}`,
    FAKE_STORE: store, FAKE_LOCK: lock, RMD_CLAUDE_DIR: join(root, "claude"),
    RMD_CODEX_DIR: join(root, "absent-codex"), RMD_CONTAINER_CONFIG_DIR: join(root, "absent-config"),
    RMD_RECYCLE_FIRST_BOOT: "1", RMD_RECYCLE_POLL_S: "1", RMD_RECYCLE_DOCKERENV_PATH: join(root, "no-marker"),
    RMD_OPENWEIGHT_API_KEY_PATH: join(root, "key"), TMPDIR: join(root, "tmp"),
    GH_TOKEN: "fixture-token", GH_APP_ID: "", GH_APP_INSTALLATION_ID: "", GH_APP_PRIVATE_KEY_PATH: "",
    RMD_RECYCLE_HOST_LOCK: lock, RMD_RECYCLE_LOCK_POLL_S: "1", RMD_INSTANCE_REGISTRY: undefined,
  };
  const readHolder = () => {
    try { return readFileSync(join(lock, "holder"), "utf8").split(" ")[0]; } catch { return ""; }
  };
  const stateOf = (role: string) => join(root, role);
  const busy = (role: string) => join(stateOf(role), "state/inflight/W1-T12243.lock");
  const launch = (script: string, args: string[], env: NodeJS.ProcessEnv): Run => {
    const child = spawn("bash", [script, ...args], { cwd: REPO_ROOT, detached: true, env });
    let out = "";
    const pollHolders: string[] = [];
    const waiters: Array<{ text: string; resolve: () => void }> = [];
    const seen = () => {
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (out.includes(waiters[i].text)) waiters.splice(i, 1)[0].resolve();
      }
    };
    child.stdout!.on("data", (b: Buffer) => {
      const text = String(b);
      out += text;
      for (const line of text.split("\n")) {
        if (line.endsWith("— polling")) pollHolders.push(readHolder());
      }
      seen();
    });
    child.stderr!.on("data", (b: Buffer) => { out += String(b); seen(); });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => resolve(code ?? (signal ? -1 : null)));
    });
    owned.until(exited);
    t.after(() => {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* the fixture process group already exited */ }
      }
    });
    return {
      child, pollHolders, exited, output: () => out,
      waitFor: (text) => new Promise<void>((resolve) => { waiters.push({ text, resolve }); seen(); }),
    };
  };
  const recycle = (role: string, extra: NodeJS.ProcessEnv = {}, workerBusy = false): Run => {
    mkdirSync(join(stateOf(role), "state/inflight"), { recursive: true });
    if (workerBusy) writeFileSync(busy(role), JSON.stringify({
      pid: 1, host: "fixture-host", run_id: `run-busy-${role}`, startedAt: new Date().toISOString(),
    }));
    return launch(RECYCLE, [], {
      ...base, FAKE_ROLE: role, RMD_STATE_DIR: stateOf(role), RMD_DAEMON_CONTAINER: `${role}-daemon`,
      PULL_ID: `sha256:${role}-new`, RMD_RECYCLE_WAIT_S: "60", RMD_RECYCLE_LOCK_WAIT_S: "30", ...extra,
    });
  };
  const hostUpdate = (): Run => {
    mkdirSync(stateOf("host-update"), { recursive: true });
    return launch(HOST_UPDATE, ["--reclaim-only"], {
      ...base, FAKE_ROLE: "host-update", RMD_STATE_DIR: stateOf("host-update"), PULL_ID: "sha256:none",
      RMD_RECLAIM_LOCK_WAIT_S: "0", RMD_GIT_RECLAIM_DIRS: "",
    });
  };
  const calls = (): Call[] => {
    try {
      return readFileSync(join(store, "calls"), "utf8").trim().split("\n").filter(Boolean).map((line) => {
        const [role, what, holder] = line.split("\t");
        return { role, what, holder: holder ?? "" };
      });
    } catch { return []; }
  };
  const ended = (role: string) => readFileSync(join(stateOf(role), "state/ledger.ndjson"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line)).filter((row) => row.step === "recycle.ended");
  const hasImage = (id: string) => existsSync(join(store, "images", id));
  const hasContainer = (name: string) => existsSync(join(store, "containers", name));
  return { root, store, lock, recycle, hostUpdate, busy, calls, ended, hasImage, hasContainer, readHolder };
}

describe("test/deploy/a-recycle-releases-the-host-lock-while-it-waits-for-workers.test.ts", { timeout: 600_000 }, () => {
  test("W1-T12243 criterion 1: a second recycle takes the host lock while the first waits for its workers", async (t) => {
    const f = fixture(t);
    const core = f.recycle("core", {}, true);
    await core.waitFor("— polling");
    assert.equal(f.readHolder(), "", `the waiting recycle must not hold the lock:\n${core.output()}`);
    const site = f.recycle("site");
    assert.equal(await site.exited, 0, site.output());
    assert.equal(core.child.exitCode, null, "the first recycle is still in its wait");
    assert.doesNotMatch(site.output(), /deploy\.recycle_waiting/, "the second recycle never waited for the lock");
    const siteCalls = f.calls().filter((c) => c.role === "site");
    for (const what of ["pull", "stop", "run", "prune"]) {
      const call = siteCalls.find((c) => c.what === what);
      assert.ok(call, `site ran docker ${what}`);
      assert.equal(call.holder, String(site.child.pid), `site held the lock for docker ${what}`);
    }
    assert.ok(core.pollHolders.length > 0);
    assert.ok(!core.pollHolders.includes(String(core.child.pid)), `core held the lock in a poll: ${core.pollHolders}`);
    rmSync(f.busy("core"));
    assert.equal(await core.exited, 0, core.output());
    assert.equal(f.ended("core")[0].host_lock_in_wait, "released");
  });

  test("W1-T12243 criterion 2: a stopped container keeps the pulled image through the other prunes in the wait", async (t) => {
    const f = fixture(t);
    const core = f.recycle("core", {}, true);
    await core.waitFor("— polling");
    const create = f.calls().find((c) => c.role === "core" && c.what === `create ${HOLD}`);
    assert.ok(create, core.output());
    assert.equal(create.holder, String(core.child.pid), "the hold container is made before the lock is released");
    assert.equal(readFileSync(join(f.store, "containers", HOLD, "image"), "utf8").trim(), "sha256:core-new");
    const site = f.recycle("site");
    assert.equal(await site.exited, 0, site.output());
    assert.equal(f.hasImage("sha256:unused"), false, "positive control: the site prune removes an unused image");
    assert.equal(f.hasImage("sha256:core-new"), true, "the site prune keeps the image core pulled");
    writeFileSync(join(f.store, "images/sha256:unused"), "");
    const nightly = f.hostUpdate();
    // Its exit status also reports the git reclaim, which has no target in this fixture.
    assert.notEqual(await nightly.exited, null, nightly.output());
    const prune = f.calls().find((c) => c.role === "host-update" && c.what === "prune");
    assert.ok(prune, `host-update ran its image prune in the wait:\n${nightly.output()}`);
    assert.equal(f.hasImage("sha256:unused"), false, "positive control: the nightly prune removes an unused image");
    assert.equal(f.hasImage("sha256:core-new"), true, "the nightly prune keeps the image core pulled");
    rmSync(f.busy("core"));
    assert.equal(await core.exited, 0, core.output());
    assert.doesNotMatch(core.output(), /is gone after the wait/);
  });

  test("W1-T12243 criterion 3: after the wait the recycle takes the lock again before docker stop and holds it to its end", async (t) => {
    const f = fixture(t);
    const core = f.recycle("core", {}, true);
    await core.waitFor("— polling");
    const site = f.recycle("site");
    assert.equal(await site.exited, 0, site.output());
    rmSync(f.busy("core"));
    assert.equal(await core.exited, 0, core.output());
    assert.match(core.output(), /host recycle lock taken again after the wait/);
    const coreCalls = f.calls().filter((c) => c.role === "core");
    const pid = String(core.child.pid);
    for (const what of ["stop", `rm core-daemon`, "run", "prune"]) {
      const call = coreCalls.find((c) => c.what === what);
      assert.ok(call, `core ran docker ${what}`);
      assert.equal(call.holder, pid, `core held the lock for docker ${what}`);
    }
    assert.equal(existsSync(f.lock), false, "the lock is released at the end");
  });

  for (const [exit, extra, busy, rc] of [
    ["success", {}, false, 0],
    ["refusal", { RMD_RECYCLE_WAIT_S: "1" }, true, 1],
    ["error", { STOP_RC: "7" }, false, 7],
    ["signal", {}, true, 143],
  ] as const) {
    test(`W1-T12243 criterion 4: the hold container is removed on ${exit}`, async (t) => {
      const f = fixture(t);
      const core = f.recycle("core", extra, busy);
      if (exit === "signal") {
        await core.waitFor("— polling");
        assert.equal(f.hasContainer(HOLD), true, "positive control: the hold container exists in the wait");
        process.kill(-core.child.pid!, "SIGTERM");
      }
      assert.equal(await core.exited, rc, core.output());
      assert.ok(f.calls().some((c) => c.what === `create ${HOLD}`), "the hold container was made");
      assert.ok(f.calls().some((c) => c.what === `container-rm ${HOLD}`), core.output());
      assert.equal(f.hasContainer(HOLD), false);
      assert.equal(existsSync(f.lock), false);
    });
  }

  test("W1-T12243 criterion 5: a recycle that cannot make the hold container holds the lock for the whole wait", async (t) => {
    const f = fixture(t);
    const core = f.recycle("core", { CREATE_RC: "1" }, true);
    await core.waitFor("— polling");
    const site = f.recycle("site", { RMD_RECYCLE_LOCK_WAIT_S: "1" });
    assert.equal(await site.exited, 1, site.output());
    assert.match(site.output(), /deploy\.recycle_waiting/);
    assert.equal(f.calls().some((c) => c.role === "site" && c.what === "pull"), false, "site pulled nothing");
    rmSync(f.busy("core"));
    assert.equal(await core.exited, 0, core.output());
    assert.ok(core.pollHolders.length >= 1, core.output());
    assert.deepEqual([...new Set(core.pollHolders)], [String(core.child.pid)], "core held the lock at every poll");
    const row = f.ended("core")[0];
    assert.equal(row.host_lock_in_wait, "held");
    assert.match(row.host_lock_note, /docker create core-daemon-image-hold failed: fixture: create refused/);
  });

  for (const change of ["target", "pause"] as const) {
    test(`a recycle that finds its ${change} changed after the wait stops nothing`, async (t) => {
      const f = fixture(t);
      const core = f.recycle("core", {}, true);
      await core.waitFor("— polling");
      if (change === "target") writeFileSync(join(f.store, "containers/core-daemon/id"), "replaced-in-the-wait\n");
      else rmSync(join(f.root, "core/state/PAUSE"));
      rmSync(f.busy("core"));
      assert.equal(await core.exited, 1, core.output());
      assert.match(core.output(), change === "target"
        ? /REFUSING — after the wait, core-daemon is now replaced-in-the-wait, not old-core-daemon/
        : /REFUSING — after the wait, the PAUSE this recycle wrote is no longer on disk/);
      assert.equal(f.calls().some((c) => c.role === "core" && c.what === "stop"), false);
      assert.equal(existsSync(join(f.root, "core/state/PAUSE")), false);
      assert.equal(f.hasContainer(HOLD), false);
    });
  }
});
