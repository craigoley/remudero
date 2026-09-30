// W1-T4915: an agent that hand-runs the coverage suite (`node --experimental-test-coverage ...`)
// without CI's `--enable-source-maps` gets `DA:` lines located against the tsx-transpiled JS, so
// every changed line reads uncovered. Rule 13 of hooks/deny-floor.sh refuses that run at the program
// position of a command segment and names the script that reproduces CI. Every case goes through the
// hook's real entry point (`bash hooks/deny-floor.sh`, JSON on stdin), the way the harness calls it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HOOK_PATH = fileURLToPath(new URL("../hooks/deny-floor.sh", import.meta.url));

function run(command: string): { status: number | null; stderr: string } {
  const cacheHome = mkdtempSync(join(tmpdir(), "rmd-denyfloor-cov-"));
  try {
    const r = spawnSync("bash", [HOOK_PATH], {
      input: JSON.stringify({ tool_input: { command } }),
      encoding: "utf8",
      env: { ...process.env, XDG_CACHE_HOME: cacheHome },
    });
    return { status: r.status, stderr: r.stderr };
  } finally {
    rmSync(cacheHome, { recursive: true, force: true });
  }
}

const REFUSAL = /deny-floor: blocked . a coverage run without --enable-source-maps/;
const REMEDY = "npm run diff-coverage:local -- <test files>";

const RAW_RUNS = [
  "node --experimental-test-coverage --import tsx --test test/foo.test.ts",
  "node --import tsx --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=lcov.info --test test/foo.test.ts",
  "cd /home/user/wt-1 && node --experimental-test-coverage --import tsx --test test/foo.test.ts 2>&1 | tail -20",
  "timeout 600 node --experimental-test-coverage --import tsx --test test/foo.test.ts",
  "timeout -k 5 --signal=TERM 600 node --experimental-test-coverage --test test/foo.test.ts",
  "time node --experimental-test-coverage --test test/foo.test.ts",
  "env FOO=1 node --experimental-test-coverage --test test/foo.test.ts",
  "FOO=1 /usr/bin/node --experimental-test-coverage --test test/foo.test.ts",
  "nice -n 10 node --experimental-test-coverage --test test/foo.test.ts",
  "for f in a b; do node --experimental-test-coverage --test test/$f.test.ts; done",
  "echo start\nnode --experimental-test-coverage --test test/foo.test.ts",
  "(node --experimental-test-coverage --test test/foo.test.ts)",
  "echo $(node --experimental-test-coverage --test test/foo.test.ts)",
  "cat <<EOF > note.txt\nhello\nEOF\nnode --experimental-test-coverage --test test/foo.test.ts",
  "echo 'a; b' && node --experimental-test-coverage --test test/foo.test.ts",
];

test("W1-T4915: a coverage run without --enable-source-maps is refused with the local script named", () => {
  for (const command of RAW_RUNS) {
    const { status, stderr } = run(command);
    assert.equal(status, 2, `must refuse: ${command}`);
    assert.match(stderr, REFUSAL, command);
    assert.ok(stderr.includes(REMEDY), `must name the remedy: ${command}`);
  }
});

test("W1-T4915: the same run with --enable-source-maps is allowed", () => {
  for (const command of [
    "node --experimental-test-coverage --enable-source-maps --import tsx --test test/foo.test.ts",
    "node --enable-source-maps --import tsx --experimental-test-coverage --test test/foo.test.ts",
    'NODE_OPTIONS="--enable-source-maps --max-old-space-size=4096" node --experimental-test-coverage --test test/foo.test.ts',
    "NODE_OPTIONS=--enable-source-maps timeout 600 node --experimental-test-coverage --test test/foo.test.ts",
    "export NODE_OPTIONS=--enable-source-maps; node --experimental-test-coverage --test test/foo.test.ts",
    "env NODE_OPTIONS=--enable-source-maps node --experimental-test-coverage --test test/foo.test.ts",
  ]) {
    const { status, stderr } = run(command);
    assert.equal(status, 0, `must allow: ${command} (${stderr})`);
  }
});

test("W1-T4915: a command that only names the flag as text is allowed", () => {
  for (const command of [
    "grep -rn -- '--experimental-test-coverage' .github/workflows/ci.yml",
    "grep -rn experimental-test-coverage scripts/",
    "pgrep -af 'node --experimental-test-coverage'",
    "pkill -f -- --experimental-test-coverage",
    "sed -n '1,20p' scripts/diff-coverage-local.mjs | grep -- --experimental-test-coverage",
    "cat scripts/diff-coverage-local.mjs # node --experimental-test-coverage --test x",
    'echo "run: node --experimental-test-coverage --test test/foo.test.ts"',
    'echo "first; node --experimental-test-coverage --test test/foo.test.ts"',
    "echo 'x' && echo 'node --experimental-test-coverage --test a.ts'",
    "cat > run.sh <<'EOF'\nnode --experimental-test-coverage --test test/foo.test.ts\nEOF",
    "cat <<-EOF\n\tnode --experimental-test-coverage --test test/foo.test.ts\n\tEOF\ntrue",
    "node -e 'console.log(\"--experimental-test-coverage\")'",
    "git commit -m 'document node --experimental-test-coverage'",
    "node --import tsx --test test/foo.test.ts",
  ]) {
    const { status, stderr } = run(command);
    assert.equal(status, 0, `must allow: ${command} (${stderr})`);
  }
});

test("W1-T4915: the local script and npm run spawn the flags themselves and are untouched", () => {
  for (const command of [
    "npm run diff-coverage:local -- test/foo.test.ts",
    "node scripts/diff-coverage-local.mjs test/foo.test.ts",
    "npm run diff-coverage:local -- --dry-run test/foo.test.ts",
    "./bin/rmd preflight --coverage",
  ]) {
    const { status, stderr } = run(command);
    assert.equal(status, 0, `must allow: ${command} (${stderr})`);
  }
});

test("W1-T4915: an unterminated quote or a lone escape does not crash the scan", () => {
  for (const command of ['echo "unterminated', "echo it\\", "echo a\\;b && node --experimental-test-coverage --test x.ts"]) {
    const { status } = run(command);
    assert.ok(status === 0 || status === 2, `must not crash: ${command}`);
  }
  assert.equal(run("echo a\\;b && node --experimental-test-coverage --test x.ts").status, 2);
});

test("W1-T4915: the earlier arms keep refusing beside the new one", () => {
  const force = run("git push --force origin main");
  assert.equal(force.status, 2);
  assert.match(force.stderr, /git push --force to a default branch/);
  const parallel = run("node --test test/ & node --test test/ &");
  assert.equal(parallel.status, 2);
  assert.match(parallel.stderr, /W1-T4106/);
});
