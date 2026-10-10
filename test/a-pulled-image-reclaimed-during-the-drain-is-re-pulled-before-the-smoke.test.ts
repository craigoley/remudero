import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../src/lib/tmp.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// One `docker` stub. `$REC/gone` makes the first pulled id vanish before the smoke (another
// instance's `docker image prune -af` during the drain, 2026-10-10 04:44Z); `$REC/repull-fails`
// makes every pull after the first fail.
const DOCKER = String.raw`#!/usr/bin/env bash
printf '%s\n' "$*" >> "$REC/calls"
case "$1" in
  pull)
    n=$(( $(cat "$REC/pulls" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$REC/pulls"
    if [ "$n" -gt 1 ]; then
      [ -f "$REC/repull-fails" ] && exit 1
      echo sha256:REPULLED > "$REC/id"
    fi ;;
  inspect)
    case "$*" in
      *Mounts*) printf '%s\t%s\ttrue\n' "$RMD_STATE_DIR" /home/node/Remudero
               printf '%s\t%s\ttrue\n' "$RMD_CLAUDE_DIR" /home/node/.claude ;;
      *Config.Image*) echo fixture/remudero:old ;;
      *Config.Env*) printf 'PATH=/usr/local/bin\nHOME=/home/node\nGH_TOKEN=fixture-token\n' ;;
      *Image*) cat "$REC/id" 2>/dev/null || echo sha256:PULLED ;;
    esac ;;
  image)
    if [ "$2" = inspect ]; then
      case "$*" in
        *Config.Env*) printf 'PATH=/usr/local/bin\nHOME=/home/node\n' ;;
        *--format*) cat "$REC/id" 2>/dev/null || echo sha256:PULLED ;;
        *sha256:PULLED*) [ -f "$REC/gone" ] && exit 1 ;;
      esac
    fi ;;
  container)
    if [ "$2" = run ]; then
      echo "WORKER-SMOKE FAIL fixture stops here"
      exit 1
    fi ;;
esac
exit 0
`;

function recycle(t: TestContext, flags: string[] = []) {
  const root = makeTempDir("recycle-pin");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const state = join(root, "state-root");
  mkdirSync(bin);
  mkdirSync(state);
  writeFileSync(join(bin, "docker"), DOCKER, { mode: 0o755 });
  writeFileSync(join(bin, "az"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(root, "cash-key"), "fixture-key\n");
  for (const flag of flags) writeFileSync(join(root, flag), "");
  const result = spawnSync("bash", [join(ROOT, "deploy/recycle-container.sh")], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      REC: root,
      RMD_STATE_DIR: state,
      RMD_CLAUDE_DIR: join(root, "claude"),
      RMD_CODEX_DIR: join(root, "absent-codex"),
      RMD_CONTAINER_CONFIG_DIR: join(root, "absent-config"),
      RMD_DAEMON_CONTAINER: "fixture-daemon",
      RMD_RECYCLE_FIRST_BOOT: "1",
      RMD_RECYCLE_SKIP_RECLAIM: "1",
      RMD_RECYCLE_WAIT_S: "1",
      RMD_RECYCLE_POLL_S: "1",
      RMD_RECYCLE_DOCKERENV_PATH: join(root, "absent-dockerenv"),
      RMD_OPENWEIGHT_API_KEY_PATH: join(root, "cash-key"),
      RMD_SCRATCH: "off",
      GH_TOKEN: "fixture-token",
      GH_APP_ID: "",
      GH_APP_INSTALLATION_ID: "",
      GH_APP_PRIVATE_KEY_PATH: "",
    },
  });
  assert.ifError(result.error);
  const calls = readFileSync(join(root, "calls"), "utf8").trim().split("\n");
  return { result, calls, paused: existsSync(join(state, "state/PAUSE")) };
}

test("a recycle proves its pulled image still exists before the smoke and does not re-pull when it does", (t) => {
  const { calls } = recycle(t);
  const check = calls.findIndex(c => c === "image inspect sha256:PULLED");
  assert.ok(check >= 0, "the pulled id is inspected before the smoke");
  assert.ok(check < calls.findIndex(c => c.startsWith("container run ")), "the check precedes the smoke");
  assert.equal(calls.filter(c => c.startsWith("pull ")).length, 1, "a present image is never re-pulled");
});

test("a pulled image reclaimed during the drain is re-pulled once and the smoke runs on the re-pulled id", (t) => {
  const { calls } = recycle(t, ["gone"]);
  assert.equal(calls.filter(c => c.startsWith("pull ")).length, 2);
  const smoke = calls.find(c => c.startsWith("container run "))!;
  assert.match(smoke, /sha256:REPULLED/);
  assert.doesNotMatch(smoke, /sha256:PULLED/);
});

test("a pulled image reclaimed during the drain whose re-pull fails is refused by name, unpaused, never smoked", (t) => {
  const { result, calls, paused } = recycle(t, ["gone", "repull-fails"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /was removed during the drain/);
  assert.equal(calls.filter(c => c.startsWith("container run ")).length, 0);
  assert.equal(paused, false);
});
