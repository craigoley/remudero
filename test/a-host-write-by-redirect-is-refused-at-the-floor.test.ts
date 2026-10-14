import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// W1-T9238: rule 16 refused kill, docker restart and rm -rf sent to `ssh remudero` but passed
// `ssh remudero 'ps aux > /tmp/.x'`, a `| tee /dev/shm/x` and `> ~/out.txt`, so agents wrote files on the
// READ-ONLY fleet host three times on 2026-10-12/13. Each refused shape sits beside an allowed near-miss.

const HOOK = fileURLToPath(new URL("../hooks/deny-floor.sh", import.meta.url));

function run(command: string, extraEnv: Record<string, string> = {}): { status: number | null; stderr: string } {
  const env: Record<string, string | undefined> = { ...process.env, ...extraEnv };
  if (!("RMD_HOUSE_RULE_OVERRIDE" in extraEnv)) delete env.RMD_HOUSE_RULE_OVERRIDE;
  const r = spawnSync("bash", [HOOK], {
    cwd: tmpdir(),
    input: JSON.stringify({ tool_name: "Bash", cwd: "/nonexistent-host-write-cwd", tool_input: { command } }),
    encoding: "utf8",
    env,
  });
  return { status: r.status, stderr: r.stderr };
}

function assertRefused(command: string, target: RegExp): void {
  const r = run(command);
  assert.equal(r.status, 2, `expected a refusal: ${command}\n${r.stderr}`);
  assert.match(r.stderr, /fleet host is READ-ONLY/, `the refusal names the host rule: ${command}`);
  assert.match(r.stderr, /file write on the fleet host/, `the refusal says a file write: ${command}`);
  assert.match(r.stderr, target, `the refusal names the redirect or tee target: ${command}`);
  assert.match(r.stderr, /Stream the output back to the Mac/, `the refusal names the alternative: ${command}`);
}

function assertAllowed(command: string): void {
  const r = run(command);
  assert.equal(r.status, 0, `expected this to run: ${command}\n${r.stderr}`);
}

test("W1-T9238: a redirect into a host path over ssh is refused", () => {
  const shapes: Array<[string, RegExp]> = [
    ["ssh remudero 'ps aux > /tmp/.x'", /> \/tmp\/\.x/],
    ["ssh remudero 'cat foo > ~/out.txt'", /> ~\/out\.txt/],
    ["ssh remudero 'ps aux >> /tmp/log'", />> \/tmp\/log/],
    ["ssh remudero 'ps aux >/dev/shm/x'", />\/dev\/shm\/x/],
    ["ssh remudero 'docker logs core 2> /tmp/err'", /2> \/tmp\/err/],
    ["ssh remudero 'docker logs core &> /tmp/all'", /&> \/tmp\/all/],
    ["ssh remudero 'ps aux >| /tmp/clobber'", /over ssh \(`>/],
    ["ssh remudero 'docker logs core 2>&1 > /tmp/x'", /> \/tmp\/x/],
    ["ssh remudero \"ps aux | grep node > /tmp/n\"", /> \/tmp\/n/],
    ["ssh remudero bash -c 'ps aux > /tmp/y'", /> \/tmp\/y/],
    ["ssh -o BatchMode=yes remudero 'ps aux > /tmp/z'", /> \/tmp\/z/],
  ];
  for (const [command, target] of shapes) assertRefused(command, target);
  // the near-miss beside the first shape: the same query with the redirect left out runs
  assertAllowed("ssh remudero 'ps aux'");
  assertAllowed("ssh remudero 'cat foo'");
});

test("W1-T9238: tee into a host path over ssh is refused", () => {
  const shapes: Array<[string, RegExp]> = [
    ["ssh remudero 'docker logs core 2>&1 | tee /dev/shm/x'", /tee \/dev\/shm\/x/],
    ["ssh remudero 'ps aux | tee -a /tmp/log'", /tee \/tmp\/log/],
    ["ssh remudero 'ps aux | sudo tee /tmp/root-owned'", /tee \/tmp\/root-owned/],
    ["ssh remudero <<'EOF'\nps aux | tee /tmp/heredoc\nEOF", /tee \/tmp\/heredoc/],
    ["ssh remudero <<< 'ps aux | tee /tmp/herestring'", /tee \/tmp\/herestring/],
    ["ssh remudero 'docker exec core tee /tmp/in-container'", /tee \/tmp\/in-container/],
    ["ssh remudero docker exec core tee /tmp/in-container", /tee \/tmp\/in-container/],
    ["echo hi | ssh remudero 'tee /tmp/piped'", /tee \/tmp\/piped/],
  ];
  for (const [command, target] of shapes) assertRefused(command, target);
  // near-misses: tee with no file operand, or only /dev/null, still runs
  assertAllowed("ssh remudero 'ps aux | tee'");
  assertAllowed("ssh remudero 'ps aux | tee /dev/null'");
  assertAllowed("ssh remudero 'ps aux | tee -a /dev/null'");
});

test("W1-T9238: dev-null, fd duplication and local redirects still run", () => {
  for (const command of [
    "ssh remudero 'ps aux > /dev/null'",
    "ssh remudero 'docker logs core 2>/dev/null'",
    "ssh remudero 'docker logs core 2>&1'",
    "ssh remudero 'docker logs core 2>&1 | grep error'",
    "ssh remudero 'echo oops >&2'",
    "ssh remudero 'ps aux &> /dev/null'",
    "ssh remudero 'ps aux' > ~/ps.txt",
    "ssh remudero 'ps aux' >> ~/ps.txt",
    "ssh remudero ps aux 2> ~/err.txt",
    "ssh remudero cat f 2>&1 | tee ~/local",
    "ssh remudero 'docker logs core' 2>&1 | tee /tmp/local-copy",
    "ssh remudero 'ps aux | awk \"\\$3>5\"'",
    "ps aux > /tmp/local-only",
    "echo hi | tee /tmp/local-only",
  ]) {
    assertAllowed(command);
  }
  // the host-write refusals beside them are not the same shape: the redirect INSIDE the quotes is judged
  assert.equal(run("ssh remudero 'ps aux > /tmp/.x' > ~/local").status, 2);
  // RMD_HOUSE_RULE_OVERRIDE=host keeps working as for the other host refusals
  const overridden = run("ssh remudero 'ps aux > /tmp/.x'", { RMD_HOUSE_RULE_OVERRIDE: "host" });
  assert.equal(overridden.status, 0);
  assert.match(overridden.stderr, /OVERRIDDEN/);
});
