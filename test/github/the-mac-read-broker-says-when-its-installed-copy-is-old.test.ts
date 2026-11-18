import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ghCommand, type GhBrokerClientRead } from "#src/lib/gh-read-broker.js";
import { ghArgvIsWrite } from "#src/lib/github-transport.js";
import {
  brokerInstallWorld, brokerSource, installBroker, launchctlCalls, MAC_BROKER_INSTALLER, nextBrokerVersion,
  type BrokerInstallWorld,
} from "#test/helpers/mac-read-broker-install-world.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const READ = ["pr", "view", "7"];
const RESPONSE = { stdout: '{"number":7}\n', stderr: "upstream diagnostic\n", exitCode: 7, outcome: "upstream-error" } as const;

async function clientRead(w: BrokerInstallWorld, checkout: string) {
  let stdout = "";
  let stderr = "";
  const read: GhBrokerClientRead = async (socket, args) => {
    assert.equal(socket, join(dirname(w.heartbeat), "broker.sock"));
    assert.deepEqual(args, READ);
    return RESPONSE;
  };
  const code = await ghCommand(["--", ...READ], { HOME: w.home }, () => 99, read, (stream, text) => {
    if (stream === "stdout") stdout += text;
    else stderr += text;
  }, checkout);
  return { code, stdout, stderr };
}

function installedFixture(w: BrokerInstallWorld, source: ReturnType<typeof brokerSource>) {
  const result = installBroker(w, source);
  assert.equal(result.status, 0, result.stderr);
  const sha = source.git("rev-parse", "HEAD");
  assert.equal(readFileSync(join(w.copies, "current"), "utf8").trim(), sha);
  return sha;
}

test("W1-T13158 criterion 1: a broker source change warns once per checkout commit and preserves the read result", async (t) => {
  const w = brokerInstallWorld(t);
  const source = brokerSource(t);
  const installed = installedFixture(w, source);
  const calls = launchctlCalls(w);
  const changedSource = nextBrokerVersion(source, "v2");
  const manifest = join(w.copies, installed, "source-paths");
  const paths = readFileSync(manifest, "utf8").trim().split("\n");
  assert.ok(paths.includes("src/lib/gh-read-broker.ts"));
  assert.ok(paths.includes("src/run-task.ts"));

  // A path the installed broker used can still matter after the client drops it from its own list.
  writeFileSync(manifest, "broker-policy.yaml\n");
  source.git("checkout", "--quiet", "-b", "old-path", installed);
  writeFileSync(join(source.dir, "broker-policy.yaml"), "values: {}\n");
  source.git("add", "broker-policy.yaml");
  source.git("commit", "--quiet", "-m", "change a path from the installed manifest");
  const changedOldPath = source.git("rev-parse", "HEAD");
  for (const head of [changedOldPath, changedSource]) {
    if (head === changedSource) rmSync(manifest); // A pre-manifest install still reports source drift.
    source.git("checkout", "--quiet", head);
    const result = await clientRead(w, source.dir);
    assert.equal(result.stdout, RESPONSE.stdout);
    assert.equal(result.code, RESPONSE.exitCode);
    const lines = result.stderr.trimEnd().split("\n");
    assert.equal(lines.length, 2, result.stderr);
    assert.match(lines[0]!, /^rmd gh:/);
    assert.ok(lines[0]!.includes(installed.slice(0, 12)), lines[0]);
    assert.ok(lines[0]!.includes(head.slice(0, 12)), lines[0]);
    assert.ok(lines[0]!.includes(`bash '${join(source.dir, "deploy/mac/install-gh-read-broker.sh")}'`), lines[0]);
    assert.equal(lines[1], RESPONSE.stderr.trimEnd());
    assert.equal((await clientRead(w, source.dir)).stderr, RESPONSE.stderr);
  }
  source.git("checkout", "--quiet", changedOldPath);
  assert.equal((await clientRead(w, source.dir)).stderr, RESPONSE.stderr, "returning to a warned commit stays quiet");
  assert.deepEqual(launchctlCalls(w), calls);
});

function fireHook(w: BrokerInstallWorld, command: string) {
  const result = spawnSync("/bin/bash", [join(REPO_ROOT, "hooks/deny-floor.sh")], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: "utf8",
    env: {
      ...w.env, RMD_GH_CACHE_HOME: join(w.home, ".cache"), XDG_CACHE_HOME: join(w.home, ".cache"),
      RMD_GH_COOLDOWN_S: "180", RMD_DENY_FLOOR_ONLY: "gh-read",
    },
  });
  return { code: result.status, stderr: result.stderr };
}

test("W1-T13158 criterion 2: the read floor names a broker directory without a heartbeat and prints the restore command", (t) => {
  const w = brokerInstallWorld(t);
  mkdirSync(dirname(w.heartbeat), { recursive: true });
  assert.equal(fireHook(w, "gh pr view 7").code, 0);
  const missing = fireHook(w, "gh pr view 8");
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /floor 180s/);
  const down = missing.stderr.split("\n").filter((line) => line.includes("is DOWN"));
  assert.deepEqual(down, [
    `  The read broker installed for this account is DOWN: no heartbeat was ever written, so every session shares this floor. Restore it: bash ${MAC_BROKER_INSTALLER}`,
  ]);

  writeFileSync(w.heartbeat, "10\n");
  utimesSync(w.heartbeat, 1, 1);
  const stale = fireHook(w, "gh pr view 8");
  assert.equal(stale.code, 2);
  assert.match(stale.stderr, /is DOWN: its last heartbeat was .* ago/);
  assert.ok(stale.stderr.includes(`Restore it: bash ${MAC_BROKER_INSTALLER}`));
  assert.deepEqual(launchctlCalls(w), []);
});

test("W1-T13158 criterion 3: matching and unrelated revisions are quiet and routing stays the same", async (t) => {
  const w = brokerInstallWorld(t);
  const source = brokerSource(t);
  const installed = installedFixture(w, source);
  const calls = launchctlCalls(w);
  assert.equal((await clientRead(w, source.dir)).stderr, RESPONSE.stderr);
  source.git("checkout", "--quiet", "-b", "unrelated");
  writeFileSync(join(source.dir, "README.md"), "unrelated\n");
  source.git("add", "README.md");
  source.git("commit", "--quiet", "-m", "unrelated");
  assert.equal((await clientRead(w, source.dir)).stderr, RESPONSE.stderr);

  const raw = fireHook(w, "gh pr view 7");
  assert.equal(raw.code, 2);
  assert.match(raw.stderr, /routed - a live GitHub read broker/);
  assert.equal(fireHook(w, "rmd gh -- pr view 7").code, 0);
  assert.equal(fireHook(w, "gh api rate_limit").code, 0);
  const write = ["pr", "comment", "7", "--body", "note"];
  assert.equal(ghArgvIsWrite(write), true);
  assert.equal(fireHook(w, `gh ${write.join(" ")}`).code, 0);
  assert.equal(await ghCommand(["--", ...write], { HOME: w.home }, () => 99, undefined, () => {}, source.dir), 2);
  assert.deepEqual(launchctlCalls(w), calls);

  const current = join(w.copies, "current");
  writeFileSync(current, `${"a".repeat(40)}\n`);
  assert.equal((await clientRead(w, source.dir)).stderr, RESPONSE.stderr, "an unknown installed commit stays quiet");
  rmSync(current);
  assert.equal((await clientRead(w, source.dir)).stderr, RESPONSE.stderr, "missing install metadata stays quiet");
  writeFileSync(current, `${installed}\n`);
  rmSync(w.heartbeat);
  const staleHead = nextBrokerVersion(source, "stale install with no heartbeat");
  const stderr = t.mock.method(process.stderr, "write", () => true);
  try {
    assert.equal(await ghCommand(["--", ...READ], { HOME: w.home }, (args) => {
      assert.deepEqual(args, READ);
      return 9;
    }, undefined, undefined, source.dir), 9, "a missing heartbeat still takes the direct route");
  } finally {
    stderr.mock.restore();
  }
  assert.equal(stderr.mock.callCount(), 1);
  assert.match(String(stderr.mock.calls[0]?.arguments[0]), new RegExp(`^rmd gh: .* ${staleHead.slice(0, 12)}\\b`));
});
