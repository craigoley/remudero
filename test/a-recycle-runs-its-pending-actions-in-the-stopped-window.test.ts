import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = process.cwd();
const ACTIONS_LIB = join(REPO_ROOT, "deploy", "recycle-actions.sh");
const SESSIONS_LIB = join(REPO_ROOT, "deploy", "codex-sessions-mount.sh");
const SESSIONS_ACTION = join(REPO_ROOT, "deploy", "recycle-actions", "codex-sessions-to-data-disk.sh");

function fixture(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}recycle-actions-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function bash(script: string, env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, ...env } });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function action(dir: string, name: string, body: string, phase = "stopped"): void {
  writeFileSync(join(dir, `${name}.sh`), `#!/usr/bin/env bash\n# phase: ${phase}\n${body}\n`);
}

function pending(state: string, ...names: string[]): void {
  mkdirSync(join(state, "recycle-actions", "pending"), { recursive: true });
  for (const n of names) writeFileSync(join(state, "recycle-actions", "pending", n), "");
}

const entries = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);

test("W1-T9071: a recycle runs its pending actions in the stopped window", (t) => {
  const root = fixture(t);
  const actions = join(root, "actions");
  const state = join(root, "state");
  mkdirSync(actions);
  action(actions, "touches-a-file", `printf '%s %s\\n' "$RECYCLE_ACTION_PHASE" "$RECYCLE_ACTION_CODEX_DIR" > "$1/touched"`);
  action(actions, "fails", "exit 3");
  action(actions, "sleeps", "sleep 5");
  action(actions, "later", "touch \"$1/later-ran\"", "post-start");
  writeFileSync(join(actions, "no-phase.sh"), "#!/usr/bin/env bash\ntrue\n");
  pending(state, "touches-a-file", "fails", "sleeps", "later", "no-phase", "not-reviewed", "Bad_Name");

  const r = bash(`. "${ACTIONS_LIB}"; CODEX_DIR=/codex; recycle_actions_run stopped "${state}"; echo "rc=$?"`,
    { RMD_RECYCLE_ACTIONS_DIR: actions, RMD_RECYCLE_ACTION_TIMEOUT_S: "1" });
  assert.match(r.stdout, /rc=0$/m, "an action never fails the recycle");
  assert.equal(readFileSync(join(state, "touched"), "utf8"), "stopped /codex\n", "the action ran once with the caller's codex dir");
  const done = entries(join(state, "recycle-actions", "done"));
  const failed = entries(join(state, "recycle-actions", "failed"));
  assert.deepEqual(done.map((n) => n.split(".")[0]), ["touches-a-file"]);
  assert.deepEqual(failed.map((n) => n.split(".")[0]).sort(), ["Bad_Name", "fails", "no-phase", "not-reviewed", "sleeps"]);
  assert.deepEqual(entries(join(state, "recycle-actions", "pending")), ["later"], "another phase's action waits for its phase");
  const log = readFileSync(join(state, "recycle-actions", "log"), "utf8");
  assert.match(log, /action=sleeps rc=124 reason=timed out after 1s/);
  assert.match(log, /action=fails rc=3 reason=exited 3/);
  assert.match(log, /action=not-reviewed rc=2 reason=no reviewed script/);
  assert.match(r.stderr, /fails FAILED \(exited 3\) — the recycle continues without it/);

  // The post-start phase then runs what waited, and an empty or absent pending dir is a no-op.
  bash(`. "${ACTIONS_LIB}"; recycle_actions_run post-start "${state}"`, { RMD_RECYCLE_ACTIONS_DIR: actions });
  assert.ok(existsSync(join(state, "later-ran")));
  assert.deepEqual(entries(join(state, "recycle-actions", "pending")), []);
  assert.equal(bash(`. "${ACTIONS_LIB}"; recycle_actions_run stopped "${join(root, "nowhere")}"; echo "rc=$?"`).stdout.trim(), "rc=0");
});

test("the sessions bind is planned only from this instance's own ready file", (t) => {
  const root = fixture(t);
  const plan = (state: string) => bash(`. "${SESSIONS_LIB}"; if codex_sessions_plan "${state}"; then echo "ARGS ${"$"}{CODEX_SESSIONS_ARGS[*]}"; else echo "NONE"; fi; echo "$CODEX_SESSIONS_NOTE"`).stdout;
  const state = join(root, "state");
  mkdirSync(state);
  assert.match(plan(state), /^NONE\nnot moved/);
  writeFileSync(join(state, "codex-sessions.ready"), "relative/path\n");
  assert.match(plan(state), /NOT USED — .* names no absolute directory/);
  writeFileSync(join(state, "codex-sessions.ready"), `${join(root, "missing")}\n`);
  assert.match(plan(state), /NOT USED — .*missing \(from .*\) is missing/);
  mkdirSync(join(root, "sessions"));
  writeFileSync(join(state, "codex-sessions.ready"), `${join(root, "sessions")}\n`);
  assert.match(plan(state), new RegExp(`^ARGS -v ${join(root, "sessions")}:/home/node/.codex/sessions\\nfrom `));
});

/** A codex home, a destination, a `stat` that reports them on different filesystems, and a docker
 *  that reports the given containers' mounts. */
function sessionsFixture(root: string, containers: Record<string, string[]>): { env: Record<string, string>; src: string; dst: string; state: string } {
  const codex = join(root, "codex");
  const src = join(codex, "sessions");
  const dst = join(root, "data-disk", "codex-sessions");
  const state = join(root, "state");
  const bin = join(root, "bin");
  for (const d of [join(src, "2026", "10", "01"), state, bin]) mkdirSync(d, { recursive: true });
  writeFileSync(join(src, "2026", "10", "01", "rollout-a.jsonl"), "a\n");
  writeFileSync(join(src, "2026", "10", "01", "rollout-b.jsonl"), "b\n");
  const old = new Date(Date.UTC(2026, 9, 1));
  for (const f of ["rollout-a.jsonl", "rollout-b.jsonl"]) utimesSync(join(src, "2026", "10", "01", f), old, old);
  writeFileSync(join(bin, "fake-stat"), `#!/usr/bin/env bash\ncase "$3" in ${root}/data-disk*) echo 2 ;; *) echo 1 ;; esac\n`);
  const cases = Object.entries(containers).map(([name, mounts]) => `  ${name}) printf '%s' '${mounts.map((m) => `${m};`).join("")}' ;;`).join("\n");
  writeFileSync(join(bin, "fake-docker"), [
    "#!/usr/bin/env bash",
    `[ "$1" = ps ] && { printf '%s\\n' ${Object.keys(containers).map((c) => `'${c}'`).join(" ") || "''"}; exit 0; }`,
    'name="${@: -1}"',
    'case "$name" in',
    cases,
    "  *) exit 1 ;;",
    "esac",
  ].join("\n"));
  chmodSync(join(bin, "fake-stat"), 0o755);
  chmodSync(join(bin, "fake-docker"), 0o755);
  return {
    src, dst, state,
    env: { RECYCLE_ACTION_CODEX_DIR: codex, RMD_CODEX_SESSIONS_DIR: dst, RMD_CODEX_SESSIONS_STAT: join(bin, "fake-stat"), RMD_CODEX_SESSIONS_DOCKER: join(bin, "fake-docker") },
  };
}

test("the sessions action copies, marks this instance ready, and prunes only when no live container still writes the source", (t) => {
  const root = fixture(t);
  const codex = join(root, "codex");
  // Another live instance still binds the codex home without the new sessions bind: copy, keep the source.
  const shared = sessionsFixture(root, { "remudero-site-daemon": [`${codex}=/home/node/.codex`] });
  const first = bash(`bash "${SESSIONS_ACTION}" "${shared.state}"`, shared.env);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(readFileSync(join(shared.dst, "2026", "10", "01", "rollout-a.jsonl"), "utf8"), "a\n");
  assert.equal(readFileSync(join(shared.state, "codex-sessions.ready"), "utf8"), `${shared.dst}\n`);
  assert.ok(existsSync(join(shared.src, "2026", "10", "01", "rollout-a.jsonl")), "a live writer keeps the source");
  assert.match(first.stdout, /kept the source: still written by remudero-site-daemon/);

  // Once every other live container binds the destination, the last pass prunes the source.
  const moved = sessionsFixture(root, { "remudero-site-daemon": [`${codex}=/home/node/.codex`, `${shared.dst}=/home/node/.codex/sessions`] });
  const last = bash(`bash "${SESSIONS_ACTION}" "${moved.state}"`, moved.env);
  assert.equal(last.status, 0, last.stdout + last.stderr);
  assert.ok(!existsSync(join(moved.src, "2026", "10", "01", "rollout-a.jsonl")), "the source is pruned");
  assert.equal(readFileSync(join(moved.dst, "2026", "10", "01", "rollout-b.jsonl"), "utf8"), "b\n", "nothing is lost");
});

test("the sessions action refuses what would free nothing or lose data, and leaves the instance unchanged", (t) => {
  const root = fixture(t);
  const f = sessionsFixture(root, {});
  const run = (env: Record<string, string>) => bash(`bash "${SESSIONS_ACTION}" "${f.state}"`, { ...f.env, ...env });
  assert.equal(run({ RMD_CODEX_SESSIONS_STAT: "stat", RMD_CODEX_SESSIONS_DIR: join(root, "same-disk") }).status, 5, "same filesystem");
  assert.equal(run({ RECYCLE_ACTION_CODEX_DIR: "" }).status, 2);
  assert.equal(run({ RMD_CODEX_SESSIONS_DIR: "relative" }).status, 2);
  assert.equal(run({ RECYCLE_ACTION_CODEX_DIR: join(root, "no-codex") }).status, 3);
  assert.ok(!existsSync(join(f.state, "codex-sessions.ready")), "no refusal marks the instance ready");
  const unreadable = run({ RMD_CODEX_SESSIONS_DOCKER: join(root, "no-such-docker") });
  assert.equal(unreadable.status, 0);
  assert.match(unreadable.stdout, /kept the source: docker could not be read/);
  assert.ok(existsSync(join(f.src, "2026", "10", "01", "rollout-a.jsonl")));
});
