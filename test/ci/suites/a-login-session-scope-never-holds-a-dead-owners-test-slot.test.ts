import assert from "node:assert/strict";
import { hostname } from "node:os";
import { test } from "node:test";
import { probeReservedTree, readTestSlotCgroup, type TestSlotHolder } from "#src/lib/test-slot.js";

// Measured on the Azure host 2026-10-27: an operator shell reached over SSH sits in a systemd-logind
// login scope, and sshd, the login shell and the agent CLI are all ancestors of the preflight they start.
const loginScope = "/user.slice/user-1000.slice/session-2646.scope";
const jobScope = "/user.slice/user-1000.slice/run-t10870.scope";
const failure = (code: string) => Object.assign(new Error(code), { code });
const stat = (pid: number, ppid: number, group: number, start = 100): string =>
  `${pid} (proc) S ${ppid} ${group} ${"0 ".repeat(16)}${start} 0`;

/** The owner plus its own ancestors, each in its own group: sshd x2, bash and claude for a login scope. */
function membership(path: string) {
  const procs = [
    { pid: 800, ppid: 1, group: 800 },
    { pid: 801, ppid: 800, group: 801 },
    { pid: 802, ppid: 801, group: 802 },
    { pid: 803, ppid: 802, group: 803 },
    { pid: process.pid, ppid: 803, group: 900 },
  ];
  const stats = new Map(procs.map(p => [p.pid, stat(p.pid, p.ppid, p.group)]));
  stats.set(1, stat(1, 0, 1, 1));
  const cgroupReads: string[] = [];
  const recorded = readTestSlotCgroup({ platform: "linux", read: name => {
    if (name === "/proc/self/cgroup") return `0::${path}\n`;
    const pid = name === "/proc/self/stat" ? process.pid : Number(name.split("/")[2]);
    const found = stats.get(pid);
    if (found === undefined || !name.endsWith("/stat")) throw failure("ENOENT");
    return found;
  }, readCgroup: name => {
    cgroupReads.push(name);
    return `${procs.map(p => p.pid).join("\n")}\n`;
  } });
  return { recorded, cgroupReads };
}

function deadOwner(path: string): TestSlotHolder {
  const at = new Date().toISOString();
  return { pid: 1489644, host: hostname(), bootId: "boot", pidNs: "ns", ownerUid: process.getuid?.(),
    processStart: "proc:100", ownerNonce: "dead-owner", startedAt: at, heartbeatAt: at,
    label: "author preflight", workIdentity: "reservation-marker-v1", cgroupScope: { path, dedicated: true } };
}

/** The owner pid is gone; its scope still holds the login's processes, none carrying the reservation marker. */
function scopeHost(path: string) {
  const reads: string[] = [];
  return {
    reads, platform: "linux" as const, hostname, bootId: "boot", pidNs: "ns", list: () => ["800", "801", "802", "803"],
    read: (name: string): string => {
      reads.push(name);
      if (name === "/proc/1489644/stat") throw failure("ENOENT");
      const pid = Number(name.split("/")[2]);
      if (name.endsWith("/stat")) return stat(pid, pid - 1, pid, 200);
      if (name.endsWith("/environ")) return "HOME=/home/azureuser\0";
      throw failure("EACCES");
    },
    readCgroup: (name: string): string => {
      reads.push(name);
      assert.ok(name.startsWith(`/sys/fs/cgroup${path}/`), name);
      if (name.endsWith("/cgroup.procs")) return "800\n801\n802\n803\n";
      return "populated 1\nfrozen 0\n";
    },
  };
}

test("test/ci/suites/a-login-session-scope-never-holds-a-dead-owners-test-slot.test.ts", async t => {
  await t.test("an owner in a login session scope records it as not dedicated", () => {
    const { recorded } = membership(loginScope);
    assert.equal(recorded?.path, loginScope);
    assert.equal(recorded?.dedicated, false, JSON.stringify(recorded));
    assert.match(recorded?.reason ?? "", /login session/);
    for (const path of ["/user.slice/user-1000.slice/session-c1.scope", "/user.slice/user-0.slice/session-7.scope"]) {
      const other = membership(path).recorded;
      assert.equal(other?.dedicated, false, path);
      assert.match(other?.reason ?? "", /login session/, path);
    }
  });

  await t.test("a stored dedicated record for a login session is not read as live from that session's processes", () => {
    const held = deadOwner(loginScope);
    const host = scopeHost(loginScope);
    const evidence = probeReservedTree(held, host);
    assert.notEqual(evidence.state, "live", evidence.reason);
    assert.notEqual(evidence.state, "ended", "a login's processes are no proof the owner's work ended either");
    assert.notEqual(evidence.coverage, "cgroup-scope");
    assert.equal(host.reads.some(name => name.startsWith("/sys/fs/cgroup")), false, "the login's cgroup is never read as the owner's");
    assert.ok(host.reads.includes("/proc/800/environ"), "the record falls to the reservation-marker scan");
  });

  await t.test("a systemd-run job scope wrapping the owner is still dedicated and still held while it holds work", () => {
    const { recorded, cgroupReads } = membership(jobScope);
    assert.deepEqual(recorded, { path: jobScope, dedicated: true });
    assert.deepEqual(cgroupReads, [`/sys/fs/cgroup${jobScope}/cgroup.procs`]);
    const held = deadOwner(jobScope);
    const evidence = probeReservedTree(held, scopeHost(jobScope));
    assert.equal(evidence.state, "live", evidence.reason);
    assert.equal(evidence.coverage, "cgroup-scope");
    assert.equal(evidence.reason, "dedicated scope still holds processes");
    // A job scope named like a session but outside a user slice is not a logind login.
    const lookalike = "/system.slice/session-9.scope";
    assert.equal(membership(lookalike).recorded?.dedicated, true);
    assert.equal(probeReservedTree(deadOwner(lookalike), scopeHost(lookalike)).state, "live");
  });
});
