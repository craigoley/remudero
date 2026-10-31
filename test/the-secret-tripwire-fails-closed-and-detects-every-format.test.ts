import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gitRepo } from "#test/helpers/git-repo.js";

const scriptPath = fileURLToPath(new URL("../.github/scripts/leak-grep.sh", import.meta.url));
const fixtureEnv: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete fixtureEnv[key];
const realGit = execFileSync("bash", ["-c", "command -v git"], { env: fixtureEnv, encoding: "utf8" }).trim();

// Deliberately synthetic and built at runtime: these fixtures must exercise the scanner without
// becoming plaintext-secret matches in this test's own tracked source.
const formats = [
  { name: "AWS access key", value: "AKIA" + "A".repeat(16) },
  ...["", "RSA", "EC", "OPENSSH", "DSA", "PGP"].map(kind => ({
    name: `${kind || "generic"} PEM marker`,
    value: ["-----BEGIN", kind, "PRIVATE KEY-----"].filter(Boolean).join(" "),
  })),
  ...["p", "o", "u", "s", "r"].map(kind => ({ name: `GitHub ${kind} token`, value: `gh${kind}_` + "A".repeat(36) })),
  ...["b", "a", "p", "r", "s"].map(kind => ({ name: `Slack ${kind} token`, value: `xox${kind}-` + "A".repeat(10) })),
  { name: "Google API key", value: "AIza" + "A".repeat(35) },
  { name: "Stripe live key", value: "sk_live_" + "A".repeat(24) },
  { name: "npm token", value: "npm_" + "A".repeat(36) },
];

function fixture(contents = "ordinary tracked text\n") {
  const repo = gitRepo({ kind: "secret-tripwire", seedCommit: false }), root = repo.dir;
  const script = join(root, ".github/scripts/leak-grep.sh");
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, readFileSync(scriptPath));
  writeFileSync(join(root, "tracked.txt"), contents);
  repo.git("add", ".");
  return { root, script, git: repo.git, cleanup: repo.cleanup };
}

function scan(fx: ReturnType<typeof fixture>, env: NodeJS.ProcessEnv = fixtureEnv, cwd = fx.root) {
  const result = spawnSync("bash", [fx.script], { cwd, env, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.error, undefined, "the actual scanner must start and finish");
  assert.equal(result.signal, null, "the scanner must not be timed out or killed");
  return result;
}

function failingGit(fx: ReturnType<typeof fixture>, status: number, command: "grep" | "rev-parse" | "pem" | "missing-worktree" = "grep") {
  const bin = join(fx.root, "fake-bin");
  mkdirSync(bin);
  const condition = command === "pem" ? '[[ "$1" = grep && "$*" = *"PRIVATE KEY"* ]]'
    : `[[ "$1" = ${command === "missing-worktree" ? "rev-parse" : command} ]]`;
  writeFileSync(join(bin, "git"), [
    "#!/usr/bin/env bash",
    `if ${condition}; then`,
    command === "missing-worktree" ? '  echo "$RMD_TRIPWIRE_TEST_MISSING_ROOT"' : '  echo "partial scan output must not be credited"',
    '  echo "synthetic Git failure" >&2',
    `  exit ${status}`,
    "fi",
    'exec "$RMD_TRIPWIRE_TEST_GIT" "$@"',
    "",
  ].join("\n"), { mode: 0o755 });
  return { ...fixtureEnv, PATH: `${bin}:${fixtureEnv.PATH}`, RMD_TRIPWIRE_TEST_GIT: realGit,
    RMD_TRIPWIRE_TEST_MISSING_ROOT: join(fx.root, "does-not-exist") };
}

test("the secret tripwire reports clean only after all formats scan benign tracked content", () => {
  const fx = fixture();
  try {
    const result = scan(fx);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /leak-grep: clean/);
    assert.equal(result.stderr, "");
  } finally { fx.cleanup(); }
});

for (const format of formats) {
  test(`the secret tripwire detects a synthetic ${format.name} through the actual script`, () => {
    const fx = fixture(`${format.value}\n`);
    try {
      const result = scan(fx);
      assert.equal(result.status, 1, "a detected format is a match, not a failed or clean scan");
      assert.match(result.stdout, /tracked\.txt:1:/);
      assert.ok(result.stdout.includes(format.value), "the declared format must actually match");
      assert.match(result.stderr, /FAILED — plaintext secret pattern/);
      assert.doesNotMatch(result.stdout, /leak-grep: clean/);
    } finally { fx.cleanup(); }
  });
}

test("the secret tripwire preserves its tracked-file scope and its scanner-source exclusion", () => {
  const fx = fixture();
  try {
    const marker = formats[0]!.value;
    writeFileSync(join(fx.root, "untracked.txt"), marker);
    writeFileSync(join(fx.root, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(fx.root, "ignored.txt"), marker);
    writeFileSync(fx.script, readFileSync(fx.script, "utf8") + `\n# ${marker}\n`);
    fx.git("add", ".gitignore", ".github/scripts/leak-grep.sh");
    const result = scan(fx);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /leak-grep: clean/);
    assert.equal(result.stderr, "");
  } finally { fx.cleanup(); }
});

for (const status of [2, 127, 128, 129]) {
  test(`the secret tripwire fails closed when Git grep exits ${status} instead of reporting no matches`, () => {
    const fx = fixture();
    try {
      const result = scan(fx, failingGit(fx, status));
      assert.equal(result.status, 2, "scanner errors remain distinct from a secret match");
      assert.match(result.stderr, new RegExp(`git grep failed \\(exit ${status}\\); scan incomplete`));
      assert.doesNotMatch(result.stdout, /leak-grep: clean|partial scan output/);
    } finally { fx.cleanup(); }
  });
}

test("the secret tripwire reports a later Git error even after detecting an earlier format", () => {
  const fx = fixture(`${formats[0]!.value}\n`);
  try {
    const result = scan(fx, failingGit(fx, 129, "pem"));
    assert.equal(result.status, 2);
    assert.match(result.stdout, /tracked\.txt:1:/, "the earlier AWS scan really found its fixture");
    assert.match(result.stderr, /git grep failed \(exit 129\); scan incomplete/);
    assert.doesNotMatch(result.stdout, /leak-grep: clean|partial scan output/);
  } finally { fx.cleanup(); }
});

test("the secret tripwire fails closed when Git cannot locate the worktree", () => {
  const fx = fixture();
  try {
    const result = scan(fx, failingGit(fx, 128, "rev-parse"));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /git rev-parse failed \(exit 128\); scan incomplete/);
    assert.doesNotMatch(result.stdout, /leak-grep: clean|partial scan output/);
  } finally { fx.cleanup(); }
});

test("the secret tripwire fails closed outside a Git worktree", () => {
  const fx = fixture(), outside = mkdtempSync(join(tmpdir(), "rmd-tripwire-outside-"));
  try {
    const result = scan(fx, fixtureEnv, outside);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /git rev-parse failed.*scan incomplete/);
    assert.doesNotMatch(result.stdout, /leak-grep: clean/);
  } finally { fx.cleanup(); rmSync(outside, { recursive: true, force: true }); }
});

test("the secret tripwire fails closed when the resolved worktree cannot be entered", () => {
  const fx = fixture();
  try {
    const result = scan(fx, failingGit(fx, 0, "missing-worktree"));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /cannot enter Git worktree; scan incomplete/);
    assert.doesNotMatch(result.stdout, /leak-grep: clean/);
  } finally { fx.cleanup(); }
});
