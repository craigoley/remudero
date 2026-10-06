// W1-T6030: a hand-typed `node --test` over this repo's test files that skips
// `--import ./test/setup/tmp-hygiene.ts` runs uncontained — no gh refusal stub, live push URLs, the
// shell's real GH_TOKEN, no gc-disable — and its reds read as regressions. Rule 15 of
// hooks/deny-floor.sh refuses that run at the program position of a command segment, only where the
// checkout (the payload cwd, or a leading `cd <dir>`) actually carries the preload. Every case goes
// through the hook's real entry point (`bash hooks/deny-floor.sh`, JSON on stdin), the way the
// harness calls it, with a fixture checkout so the result never depends on where the suite runs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HOOK_PATH = fileURLToPath(new URL("../hooks/deny-floor.sh", import.meta.url));

interface Fixture { root: string; withPreload: string; without: string }

function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-denyfloor-preload-")));
  const withPreload = join(root, "wt-remudero");
  const without = join(root, "wt-other");
  mkdirSync(join(withPreload, "test", "setup"), { recursive: true });
  mkdirSync(join(withPreload, "src"), { recursive: true });
  writeFileSync(join(withPreload, "test", "setup", "tmp-hygiene.ts"), "export {};\n");
  mkdirSync(join(without, "test"), { recursive: true });
  return { root, withPreload, without };
}

function run(command: string, cwd: string): { status: number | null; stderr: string } {
  const cacheHome = mkdtempSync(join(tmpdir(), "rmd-denyfloor-preload-cache-"));
  try {
    const r = spawnSync("bash", [HOOK_PATH], {
      input: JSON.stringify({ cwd, tool_input: { command } }),
      encoding: "utf8",
      env: { ...process.env, XDG_CACHE_HOME: cacheHome },
    });
    return { status: r.status, stderr: r.stderr };
  } finally {
    rmSync(cacheHome, { recursive: true, force: true });
  }
}

const REFUSAL = /deny-floor: blocked . a hand-run `node --test` without the setup preload \(W1-T6030\)/;
const REMEDY = "--import ./test/setup/tmp-hygiene.ts";

const BARE_RUNS = [
  "node --test --import tsx test/run-task.test.ts",
  "node --import tsx --test test/git-fixture-gc-hygiene.test.ts",
  "node --import tsx --test 'test/*.test.ts'",
  "node --import tsx --test ./test/a.test.ts ./test/b.test.ts 2>&1 | tail -20",
  "timeout 600 node --import tsx --test test/a.test.ts",
  "time node --import tsx --test test/a.test.ts",
  "env FOO=1 node --import tsx --test test/a.test.ts",
  "FOO=1 /usr/bin/node --import tsx --test test/a.test.ts",
  "nice -n 10 node --import tsx --test test/a.test.ts",
  "node --import tsx --test --test-name-pattern 'W1-T6030' test/a.test.ts",
  "node --import tsx --import ./test/setup/no-live-remote.ts --test test/a.test.ts",
  "echo start; node --import tsx --test test/a.test.ts",
  "cat <<EOF > note.txt\nhello\nEOF\nnode --import tsx --test test/a.test.ts",
];

test("the deny floor refuses a hand-run node --test over this repo's test files that lacks the tmp-hygiene preload", () => {
  const f = fixture();
  try {
    for (const command of BARE_RUNS) {
      const { status, stderr } = run(command, f.withPreload);
      assert.equal(status, 2, `must refuse: ${command}`);
      assert.match(stderr, REFUSAL, command);
      assert.ok(stderr.includes(REMEDY), `must name the preload: ${command}`);
      assert.ok(!stderr.includes("npm test --"), `must not route to npm test -- <file>: ${command}`);
    }
    // A leading `cd` into the checkout carries the rule, from a cwd that has no preload.
    for (const command of [
      `cd ${f.withPreload} && node --import tsx --test test/a.test.ts`,
      `cd ${f.withPreload}/src && cd .. && node --import tsx --test test/a.test.ts`,
      "cd wt-remudero && node --import tsx --test test/a.test.ts",
    ]) {
      const { status, stderr } = run(command, command.startsWith("cd wt-") ? f.root : f.without);
      assert.equal(status, 2, `must refuse after cd: ${command}`);
      assert.match(stderr, REFUSAL, command);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("the deny floor admits the same run with the preload in either --import form", () => {
  const f = fixture();
  try {
    for (const command of [
      "node --test --import tsx --import ./test/setup/tmp-hygiene.ts test/run-task.test.ts",
      "node --test --import tsx --import=./test/setup/tmp-hygiene.ts test/run-task.test.ts",
      "node --import tsx --import test/setup/tmp-hygiene.ts --test 'test/*.test.ts'",
      `node --import tsx --import ${f.withPreload}/test/setup/tmp-hygiene.ts --test test/a.test.ts`,
      'node --import tsx --import "./test/setup/tmp-hygiene.ts" --test test/a.test.ts',
      "timeout 600 node --import tsx --import ./test/setup/tmp-hygiene.ts --test test/a.test.ts 2>&1 | tail",
      'NODE_OPTIONS="--import ./test/setup/tmp-hygiene.ts" node --import tsx --test test/a.test.ts',
      `cd ${f.withPreload} && node --test --import tsx --import=./test/setup/tmp-hygiene.ts test/a.test.ts`,
    ]) {
      const { status, stderr } = run(command, f.withPreload);
      assert.equal(status, 0, `must allow: ${command} (${stderr})`);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("the deny floor never refuses in a checkout without the preload file", () => {
  const f = fixture();
  try {
    for (const command of [
      "node --import tsx --test test/a.test.ts",
      "node --test 'test/*.test.ts'",
      `cd ${f.without} && node --import tsx --test test/a.test.ts`,
    ]) {
      const { status, stderr } = run(command, f.without);
      assert.equal(status, 0, `must allow without the preload file: ${command} (${stderr})`);
    }
    // A `cd` AWAY from the checkout carrying the preload takes the run out of the rule's reach.
    const away = run(`cd ${f.without} && node --import tsx --test test/a.test.ts`, f.withPreload);
    assert.equal(away.status, 0, away.stderr);
    // No payload cwd and no `cd`: the rule has no checkout to judge and stays silent.
    assert.equal(run("node --import tsx --test test/a.test.ts", "").status, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("the deny floor never refuses a command that only names the run", () => {
  const f = fixture();
  try {
    for (const command of [
      "grep -rn 'node --test --import tsx test/' docs/",
      "pgrep -af 'node --import tsx --test test/a.test.ts'",
      'echo "run: node --import tsx --test test/a.test.ts"',
      "git commit -m 'note: node --import tsx --test test/a.test.ts fails without the preload'",
      "cat > run.sh <<'EOF'\nnode --import tsx --test test/a.test.ts\nEOF",
      "cat scripts/check.mjs # node --test test/a.test.ts",
      "node -e 'console.log(1)' --test test/a.test.ts",
      // Not over test/ files: no path or glob under test/ is named.
      "node --import tsx --test",
      "node --test scripts/x.test.mjs",
      "node --import tsx test/setup/tmp-hygiene.ts",
      "npm test",
      "npm run test:ci",
    ]) {
      const { status, stderr } = run(command, f.withPreload);
      assert.equal(status, 0, `must allow: ${command} (${stderr})`);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("W1-T6030: the earlier test-run arms keep refusing beside the new one", () => {
  const f = fixture();
  try {
    const cov = run("node --experimental-test-coverage --import tsx --test test/a.test.ts", f.withPreload);
    assert.equal(cov.status, 2);
    assert.match(cov.stderr, /W1-T4915/);
    const parallel = run("node --test test/ & node --test test/ &", f.withPreload);
    assert.equal(parallel.status, 2);
    assert.match(parallel.stderr, /W1-T4106/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
