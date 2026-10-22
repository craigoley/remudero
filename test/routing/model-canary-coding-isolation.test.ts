import assert from "node:assert/strict";
import test from "node:test";
import { codingIsolationPlan, codingIsolationInspectionMatches, gradeCodingSandboxValues } from "#src/lib/model-canary-coding-isolation.js";

const nonce = "a".repeat(32), image = "sha256:" + "b".repeat(64);
const plan = () => codingIsolationPlan(image, "/tmp/rmd-coding-isolated-" + nonce, nonce);
function inspect() {
  const p = plan();
  return { Image: image, Name: `/${p.name}`, Config: { User: "65534:65534", Entrypoint: ["node"],
    Cmd: ["--max-old-space-size=64", "/input/harness.mjs"], Env: ["PATH=/usr/local/bin:/usr/bin:/bin", "NODE_VERSION=24.21.0"] },
    HostConfig: { Runtime: "runsc", NetworkMode: "none", ReadonlyRootfs: true, Privileged: false,
      NanoCpus: 1_000_000_000, Memory: p.limits.memoryBytes, MemorySwap: p.limits.memoryBytes,
      PidsLimit: 32, IpcMode: "none", PidMode: "", CapDrop: ["ALL"], CapAdd: [],
      SecurityOpt: ["no-new-privileges=true"], Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=8m,mode=1777" },
      Ulimits: [{ Name: "nofile", Hard: 64, Soft: 64 }] },
    Mounts: [{ Type: "bind", RW: false, Source: p.solution, Destination: "/input/solution.mjs" },
      { Type: "bind", RW: false, Source: p.harness, Destination: "/input/harness.mjs" }] };
}

test("coding isolation preparation names an immutable runsc plan and cannot qualify an executor", () => {
  const p = plan();
  assert.equal(p.executorQualified, false); assert.equal(p.limits.cpus, 1); assert.equal(p.limits.memoryBytes, 256 * 1024 ** 2);
  for (const value of ["--runtime=runsc", "--network=none", "--pull=never", "--read-only", "--cap-drop=ALL"])
    assert.ok(p.create.includes(value));
  assert.equal(p.create.filter(v => v.startsWith("type=bind,")).length, 2);
  for (const [i, root, n] of [["node:latest", p.directory, nonce], [image, "/tmp/../tmp/rmd-coding-isolated-" + nonce, nonce],
    [image, p.directory + ",dst=/secrets", nonce], [image, p.directory, "not-a-nonce"]])
    assert.throws(() => codingIsolationPlan(i!, root!, n!), TypeError);
});

test("sandbox settings inspection refuses widened memory network root credentials mounts and default runtime", () => {
  const p = plan();
  assert.equal(codingIsolationInspectionMatches(p, inspect()), true, "synthetic settings control, not real isolation qualification");
  const mutations = [
    (v: ReturnType<typeof inspect>) => { v.HostConfig.Runtime = "runc"; },
    (v: ReturnType<typeof inspect>) => { v.HostConfig.NetworkMode = "host"; },
    (v: ReturnType<typeof inspect>) => { v.HostConfig.Memory *= 2; },
    (v: ReturnType<typeof inspect>) => { v.HostConfig.MemorySwap *= 2; },
    (v: ReturnType<typeof inspect>) => { v.HostConfig.NanoCpus *= 2; },
    (v: ReturnType<typeof inspect>) => { v.HostConfig.PidsLimit = -1; },
    (v: ReturnType<typeof inspect>) => { v.HostConfig.Privileged = true; },
    (v: ReturnType<typeof inspect>) => { v.HostConfig.PidMode = "host"; },
    (v: ReturnType<typeof inspect>) => { v.HostConfig.ReadonlyRootfs = false; },
    (v: ReturnType<typeof inspect>) => { v.HostConfig.CapAdd = ["SYS_ADMIN"]; },
    (v: ReturnType<typeof inspect>) => { v.HostConfig.SecurityOpt.push("seccomp=unconfined"); },
    (v: ReturnType<typeof inspect>) => { v.Config.User = "root"; },
    (v: ReturnType<typeof inspect>) => { v.Config.Env.push("ANTHROPIC_API_KEY=synthetic-forbidden"); },
    (v: ReturnType<typeof inspect>) => { v.Mounts[0]!.RW = true; },
    (v: ReturnType<typeof inspect>) => { v.Mounts[0]!.Source = "/etc/shadow"; },
    (v: ReturnType<typeof inspect>) => { v.Mounts.push({ Type: "bind", RW: false, Source: "/var/run/docker.sock", Destination: "/docker.sock" }); },
    (v: ReturnType<typeof inspect>) => { v.HostConfig.Tmpfs["/tmp"] = "rw,size=8g"; },
  ];
  for (const mutate of mutations) { const value = inspect(); mutate(value); assert.equal(codingIsolationInspectionMatches(p, value), false); }
  for (const unknown of [undefined, null, [], {}, { Image: image }]) assert.equal(codingIsolationInspectionMatches(p, unknown), false);
});

test("host coding grades only complete matching behavior values and never a container's done or TAP claim", () => {
  const expected = new Map<string, unknown>([["one", 7], ["two", { a: 1, b: 2 }]]);
  const envelope = { protocol: "coding-values-v1", nonce, results: [{ id: "two", value: { b: 2, a: 1 } }, { id: "one", value: 7 }] };
  const good = gradeCodingSandboxValues(nonce, expected, JSON.stringify(envelope));
  assert.equal(good.passed, true); assert.equal(good.state, "complete");
  assert.equal("executorQualified" in good && good.executorQualified, false);
  assert.equal("resourceEvidence" in good && good.resourceEvidence, null);
  const wrong = structuredClone(envelope); wrong.results[1]!.value = 6;
  assert.equal(gradeCodingSandboxValues(nonce, expected, JSON.stringify(wrong)).passed, false);
  for (const raw of ["done", "# tests 2\n# pass 2\n# fail 0", "{}", JSON.stringify({ ...envelope, nonce: "c".repeat(32) }),
    JSON.stringify({ ...envelope, results: [] }), JSON.stringify({ ...envelope, results: [envelope.results[0], envelope.results[0]] }),
    JSON.stringify({ ...envelope, passed: true }), JSON.stringify({ ...envelope, results: [{ id: "one", value: 7 }] }), "x".repeat(65_537)])
    assert.equal(gradeCodingSandboxValues(nonce, expected, raw).passed, null);
  assert.equal(gradeCodingSandboxValues(nonce, new Map(), JSON.stringify(envelope)).passed, null);
});
