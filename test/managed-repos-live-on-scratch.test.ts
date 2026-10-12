import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const LIB = join(import.meta.dirname, "..", "deploy", "scratch-mounts.sh");

function host(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}managed-repos-scratch-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scratch = join(root, "scratch");
  const state = join(root, "state-root");
  const repos = join(state, "repos");
  mkdirSync(scratch);
  mkdirSync(join(repos, "old-clone"), { recursive: true });
  writeFileSync(join(repos, "old-clone", "rollback-marker"), "preserved clone");
  const mounts = join(root, "mounts");
  const switchFile = join(root, "scratch-mounts.on");
  writeFileSync(mounts, `/dev/fixture ${scratch} ext4 rw 0 0\n`);
  writeFileSync(switchFile, "");
  const env = {
    ...process.env,
    RMD_SCRATCH_ROOT: scratch,
    RMD_SCRATCH_MOUNTS_FILE: mounts,
    RMD_SCRATCH_SWITCH: switchFile,
    RMD_SCRATCH: "on",
  };
  return { scratch, state, repos, env, base: join(scratch, "rmd", "state-root") };
}

function run(h: ReturnType<typeof host>, command: string, scratch = "on") {
  const result = spawnSync("bash", ["-eu", "-c", '. "$1"\n' + command, "scratch-test", LIB, h.state], {
    encoding: "utf8",
    env: { ...h.env, RMD_SCRATCH: scratch },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

test("W1-T6364: the scratch plan binds repos before its nested coverage dir", (t) => {
  const h = host(t);
  const args = run(h, 'scratch_plan "$2" remudero-daemon\nprintf "%s\\n" "${SCRATCH_ARGS[@]}"')
    .trim().split("\n");
  const parent = `${h.base}/repos:/home/node/Remudero/repos`;
  const child = `${h.base}/repos-coverage:/home/node/Remudero/repos/.remudero-coverage`;
  const parentIndex = args.indexOf(parent);
  assert.ok(parentIndex > 0, `missing repos bind: ${args.join(" ")}`);
  assert.deepEqual(args.slice(parentIndex - 1, parentIndex + 3), ["-v", parent, "-v", child]);
  assert.equal(existsSync(h.base), false, "planning creates no scratch directories");

  run(h, 'scratch_plan "$2" remudero-daemon\nscratch_prepare');
  const scratchRepos = join(h.base, "repos");
  assert.deepEqual(readdirSync(scratchRepos), [], "managed clones are rebuilt on demand, without migration");
  assert.ok(existsSync(join(h.base, "repos-coverage")), "nested coverage has its own scratch directory");
  const manifest = readFileSync(join(h.state, ".scratch-mounts"), "utf8").trim().split("\n");
  assert.ok(manifest.includes(scratchRepos), "boot-time restore records the managed repos directory");

  rmSync(join(h.scratch, "rmd"), { recursive: true });
  run(h, 'scratch_restore "$2"');
  assert.deepEqual(readdirSync(scratchRepos), [], "restore recreates an empty repos directory after scratch is wiped");
  assert.ok(existsSync(join(h.base, "repos-coverage")));
  assert.equal(readFileSync(join(h.repos, "old-clone", "rollback-marker"), "utf8"), "preserved clone");
});

test("W1-T6364: scratch off leaves repos on the state disk", (t) => {
  const h = host(t);
  const output = run(h, [
    'if scratch_plan "$2" remudero-daemon; then exit 2; else echo "plan:$?"; fi',
    'printf "args:%s dirs:%s binds:%s\\n" "${#SCRATCH_ARGS[@]}" "${#SCRATCH_DIRS[@]}" "$SCRATCH_BINDS"',
    'if scratch_prepare; then exit 3; else echo "prepare:$?"; fi',
  ].join("\n"), "off");
  assert.equal(output, "plan:1\nargs:0 dirs:0 binds:\nprepare:1\n");
  assert.equal(existsSync(h.base), false, "scratch off creates no repos directory on scratch");
  assert.equal(existsSync(join(h.state, ".scratch-mounts")), false);
  assert.deepEqual(readdirSync(h.repos), ["old-clone"]);
  assert.equal(readFileSync(join(h.repos, "old-clone", "rollback-marker"), "utf8"), "preserved clone");
});
