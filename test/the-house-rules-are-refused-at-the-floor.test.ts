import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Operator ruling 2026-10-10: on one day, and despite every prompt naming the rules, sessions ran `git stash`
// twice, `--no-verify` once, and `pkill -f` over `ssh remudero` once, against a host that is READ-ONLY for
// sessions. hooks/deny-floor.sh rule 16 refuses those shapes at the PreToolUse floor. Each near-miss below is
// paired with the refused shape beside it, so the near-miss test also goes red when the rule is deleted.

const HOOK = fileURLToPath(new URL("../hooks/deny-floor.sh", import.meta.url));

function run(command: string, extraEnv: Record<string, string> = {}): { status: number | null; stderr: string } {
  const env: Record<string, string | undefined> = { ...process.env, ...extraEnv };
  if (!("RMD_HOUSE_RULE_OVERRIDE" in extraEnv)) delete env.RMD_HOUSE_RULE_OVERRIDE;
  const r = spawnSync("bash", [HOOK], {
    cwd: tmpdir(),
    input: JSON.stringify({ tool_name: "Bash", cwd: "/nonexistent-house-rules-cwd", tool_input: { command } }),
    encoding: "utf8",
    env,
  });
  return { status: r.status, stderr: r.stderr };
}

function assertRefused(command: string, rule: RegExp, alternative: RegExp): void {
  const r = run(command);
  assert.equal(r.status, 2, `expected a refusal: ${command}\n${r.stderr}`);
  assert.match(r.stderr, rule, `the refusal names the house rule: ${command}`);
  assert.match(r.stderr, alternative, `the refusal names the safe alternative: ${command}`);
}

function assertAllowed(command: string): void {
  const r = run(command);
  assert.equal(r.status, 0, `expected this to run: ${command}\n${r.stderr}`);
}

test("house rule: every form of git stash is refused at the floor", () => {
  const shapes = [
    "git stash",
    "git stash push -m wip",
    "git stash -u",
    "git stash pop",
    "git stash apply stash@{0}",
    "git stash drop",
    "git -C /tmp/x stash save wip",
    "cd /tmp/x && git stash && git pull --ff-only",
    'bash -c "git stash"',
    "for f in a b; do git stash; done",
    "timeout 10 git stash",
    "env -S 'git stash'",
    "env -S'git stash'",
    "env -i -S 'git stash'",
    "env --split-string='git stash'",
    "env -S 'RMD_HOUSE_RULE_OVERRIDE=stash git stash'",
    "env -S 'git' stash",
    "env -P /usr/bin git stash",
    "env -u HOME git stash",
  ];
  for (const command of shapes) assertRefused(command, /house rule: never stash/, /commit by explicit path|copy the file aside/i);
});

test("house rule: --no-verify, git commit -n and a core.hooksPath override are refused at the floor", () => {
  for (const command of [
    "git commit --no-verify -m x",
    "git commit -nm 'msg'",
    "git commit -a -n -m x",
    "git push --no-verify origin HEAD",
    "git push --no-veri origin HEAD",
    "git merge --no-verify origin/main",
  ]) {
    assertRefused(command, /house rule: never --no-verify/, /fix what the hook reports/i);
  }
  for (const command of [
    "git -c core.hooksPath=/dev/null commit -m x",
    "git -c core.hookspath= push origin HEAD",
    `GIT_CONFIG_PARAMETERS="'core.hooksPath'='/dev/null'" git commit -m x`,
    "git config core.hooksPath /dev/null",
    "git config --unset core.hooksPath",
    "git config --remove-section core",
  ]) {
    assertRefused(command, /house rule: never bypass the hooks/, /fix what the hook reports/i);
  }
});

test("house rule: destructive process control sent over ssh remudero is refused at the floor", () => {
  for (const command of [
    "ssh remudero 'pkill -f node'",
    "env -S 'ssh remudero killall node'",
    "ssh remudero killall node",
    "ssh remudero 'kill 4242'",
    "ssh remudero 'pgrep node | xargs kill'",
    'ssh remudero "docker restart rmd-core"',
    "ssh remudero 'docker stop rmd-core'",
    "ssh remudero 'docker kill rmd-core'",
    "ssh remudero 'docker container rm -f rmd-core'",
    "ssh remudero 'docker compose -f x.yml down'",
    "ssh -t remudero 'sudo systemctl restart rmd-daemon'",
    "ssh remudero 'systemctl stop rmd-daemon'",
    "ssh remudero rm -rf /home/node/Remudero/lanes/x",
    "ssh remudero 'cd ~/Remudero/remudero && git worktree prune'",
    `ssh remudero "docker exec rmd-core sh -c 'kill 1'"`,
    "ssh remudero bash <<< 'killall node'",
    "ssh remudero bash <<'EOF'\ndocker ps\ndocker restart rmd-core\nEOF",
    "env -S 'ssh remudero bash' <<'EOF'\nkillall node\nEOF",
    "echo 'docker stop rmd-core' | ssh remudero bash",
    "ssh remudero 'git stash'",
  ]) {
    const r = run(command);
    assert.equal(r.status, 2, `expected a refusal: ${command}\n${r.stderr}`);
    if (command.endsWith("'git stash'")) continue;
    assert.match(r.stderr, /READ-ONLY for sessions \(house rule\)/, `the refusal names the house rule: ${command}`);
    assert.match(r.stderr, /Report to the operator with the exact command/, `the refusal names the safe alternative: ${command}`);
  }
});

test("house rule near-misses still run, each beside the refused shape it resembles", () => {
  const pairs: [allowed: string, refused: string][] = [
    ["git stash list", "git stash"],
    ["git stash show -p stash@{0}", "git stash pop"],
    ["env -S 'echo git stash'", "env -S 'git stash'"],
    ["env -S 'echo x; git stash'", "env -S 'git stash'"],
    ["env -P /usr/bin echo git stash", "env -P /usr/bin git stash"],
    ["env -S 'git stash list'", "env -S 'git stash pop'"],
    ["git log --no-verify-foo", "git commit --no-verify -m x"],
    ["git push -n origin HEAD", "git push --no-verify origin HEAD"],
    ["git commit -am 'msg -n here'", "git commit -an -m x"],
    ['git commit -m "never --no-verify, never git stash"', "git commit --no-verify -m x"],
    ["git config core.hooksPath hooks", "git config core.hooksPath /dev/null"],
    ["git config --get core.hooksPath", "git config --unset core.hooksPath"],
    ["grep -rn 'git stash' doctrine/", "git stash"],
    ["ssh remudero 'ps aux | grep [n]ode'", "ssh remudero 'pkill -f node'"],
    ["ssh remudero 'ps -eo pid,pcpu,rss,args --sort=-rss | head -20'", "ssh remudero 'kill 4242'"],
    ["ssh remudero 'kill -0 4242'", "ssh remudero 'kill 4242'"],
    ["env -S 'ssh remudero ps aux'", "env -S 'ssh remudero kill 4242'"],
    [`ssh remudero 'docker ps; docker logs --tail 50 rmd-core; docker inspect -f "{{.State.Status}}" rmd-core'`, "ssh remudero 'docker restart rmd-core'"],
    ["ssh remudero 'systemctl status rmd-daemon'", "ssh remudero 'systemctl restart rmd-daemon'"],
    ["ssh remudero 'git -C ~/Remudero/remudero worktree list'", "ssh remudero 'git -C ~/Remudero/remudero worktree prune'"],
    ["ssh some-other-host 'pkill -f node'", "ssh remudero 'pkill -f node'"],
    ["pkill -f a-local-process", "ssh remudero 'pkill -f a-local-process'"],
    ["cat > notes.md <<'EOF'\ngit stash\nEOF", "bash <<'EOF'\ngit stash\nEOF"],
  ];
  for (const [allowed, refused] of pairs) {
    assertAllowed(allowed);
    assert.equal(run(refused).status, 2, `the refused neighbour of a near-miss: ${refused}`);
  }
});

test("house rule override is honoured from the session environment only, and never inline", () => {
  const viaEnv = run("git stash", { RMD_HOUSE_RULE_OVERRIDE: "stash" });
  assert.equal(viaEnv.status, 0, viaEnv.stderr);
  assert.match(viaEnv.stderr, /OVERRIDDEN by RMD_HOUSE_RULE_OVERRIDE \(an operator choice on the record\)/);

  const otherRule = run("git stash", { RMD_HOUSE_RULE_OVERRIDE: "host" });
  assert.equal(otherRule.status, 2, "an override names its rule; overriding host does not release stash");

  const inline = run("RMD_HOUSE_RULE_OVERRIDE=stash git stash");
  assert.equal(inline.status, 2, "an inline assignment is the agent's own text and is ignored");
  assert.match(inline.stderr, /house rule: never stash/);
});
