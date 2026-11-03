import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, createConnection } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decodeCodingHostRequest, startCodingHostBridge, createCodingHostBridgeClient,
  bindAuthenticatedHostPeer, bindHostQualifiedBackend,
  HOST_CODING_PROTOCOL } from "#src/lib/model-canary-host-bridge.js";
import { CanarySlotOwner, codingAttemptConsumptionBinding } from "#src/lib/model-canary-owner.js";

const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const uuid = "16b8bf62-5ca9-4c73-a42b-667e746f43e1";
const source = "process.stdin.on('data', b => process.stdout.write(String(b.length)));";
const binding = { caseId: "coding-sum-four-v1", suiteHash: "a".repeat(64), runId: uuid,
  slotId: "b".repeat(64), canaryAttemptId: "c59ef428-4628-4db6-9686-d02b71955e28",
  workerSpawnAttemptId: "2f66ad57-f619-4b14-8524-1f3b9a60b005", sourceDigest: digest(source) };
const slot = { id: binding.slotId, caseId: binding.caseId,
  pin: { model: "test-model", route: "coding-test", effort: "medium", suiteHash: binding.suiteHash, billing: "subscription" as const },
  aaLabel: null };
const request = (extra: Record<string, unknown> = {}) => JSON.stringify({
  version: HOST_CODING_PROTOCOL, kind: "execute", requestId: uuid, binding,
  source, sourceDigest: digest(source), stdin: "1\n2\n3\n4\n", ...extra,
});
const peer = () => bindAuthenticatedHostPeer({ uid: process.getuid!(), gid: process.getgid!(),
  pid: process.pid, cgroup: "/test/remudero-daemon" });
const qualifiedBackend = (execute: Parameters<typeof bindHostQualifiedBackend>[0]["execute"]) =>
  bindHostQualifiedBackend({ execute });

function tempRoot(_prefix: string): string {
  const outsideGit = (candidate: string): boolean => {
    let current = realpathSync(candidate);
    while (true) {
      if (existsSync(join(current, ".git"))) return false;
      const parent = dirname(current);
      if (parent === current) return true;
      current = parent;
    }
  };
  const parent = tmpdir();
  assert.ok(outsideGit(parent), "maintained test scratch is outside git markers");
  return mkdtempSync(join(parent, "cb-"));
}
function ownerAt(root: string): CanarySlotOwner {
  const dir = join(root, "owner"); mkdirSync(dir, { mode: 0o700 });
  return new CanarySlotOwner(dir);
}
const matches = (value: typeof binding) => value.caseId === slot.caseId && value.slotId === slot.id
  && value.suiteHash === slot.pin.suiteHash && value.runId === binding.runId
  && value.canaryAttemptId === binding.canaryAttemptId && value.workerSpawnAttemptId === binding.workerSpawnAttemptId
  && value.sourceDigest === binding.sourceDigest;

test("hostCodingBridgeRejectsUnknownOrOracleWireFields", () => {
  assert.throws(() => decodeCodingHostRequest(request({ expectedStdout: "10\n" })), /request-shape-invalid/);
  assert.throws(() => decodeCodingHostRequest(request({ executable: "/bin/sh" })), /request-shape-invalid/);
  assert.throws(() => decodeCodingHostRequest(request({ profile: { enabled: true } })), /request-shape-invalid/);
});

test("hostCodingBridgeBindsDigestAndAllDistinctAttemptIdentities", () => {
  const decoded = decodeCodingHostRequest(request());
  assert.deepEqual(decoded.binding, binding);
  assert.equal(decoded.sourceDigest, digest(decoded.source));
  assert.throws(() => decodeCodingHostRequest(request({ sourceDigest: "0".repeat(64) })), /request-shape-invalid/);
  assert.throws(() => decodeCodingHostRequest(request({ binding: { ...binding, slotId: "../other" } })), /binding-invalid/);
  assert.throws(() => decodeCodingHostRequest(request({ binding: { ...binding, workerSpawnAttemptId: binding.canaryAttemptId } })),
    /request-shape-invalid|binding-invalid/);
});

test("hostCodingBridgeDefaultOffCreatesNoSocketOrBackendCall", async () => {
  const root = tempRoot("rmd-coding-bridge-off-");
  const socketPath = join(root, "n");
  try {
    assert.equal(await startCodingHostBridge({ socketPath, operations: null, executionTimeoutMs: 1_000 }), null);
    assert.equal(createCodingHostBridgeClient(null), null);
    assert.equal(existsSync(socketPath), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("hostCodingBridgeRefusesSocketPathsBeyondTheNativeAddressLimitBeforeListen", async () => {
  const root = tempRoot("bridge-path-bound-");
  const owner = ownerAt(root);
  const backend = qualifiedBackend(async () => { throw new Error("path refusal must not reach backend"); });
  const socketPath = join(root, "x".repeat(120));
  try {
    await assert.rejects(() => startCodingHostBridge({ enabled: true, socketPath, executionTimeoutMs: 1_000,
      operations: { authenticate: async () => peer(), expectedPeer: { uid: process.getuid!(), cgroup: "/test/remudero-daemon" },
        owner, backend } }), /host-bridge-socket-path-invalid/);
    assert.equal(existsSync(socketPath), false);
  } finally { owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test("hostCodingBridgeNeverReexecutesAlreadyConsumedAttempt", async () => {
  const root = tempRoot("rmd-coding-bridge-refused-");
  const owner = ownerAt(root); assert.equal(owner.claim(slot), "claimed");
  assert.equal(owner.consumeCodingAttempt(slot, { runId: binding.runId, canaryAttemptId: binding.canaryAttemptId,
    workerSpawnAttemptId: binding.workerSpawnAttemptId, sourceDigest: binding.sourceDigest }).state, "consumed");
  const socketPath = join(root, "s");
  let backendCalls = 0;
  const backend = qualifiedBackend(async () => { backendCalls++; throw new Error("must-not-start"); });
  const server = await startCodingHostBridge({ enabled: true, socketPath, executionTimeoutMs: 2_000,
    operations: { authenticate: async () => peer(), expectedPeer: { uid: process.getuid!(), cgroup: "/test/remudero-daemon" },
      owner, backend } });
  assert.ok(server);
  const client = createCodingHostBridgeClient({ enabled: true, socketPath, timeoutMs: 5_000 });
  assert.ok(client);
  try {
    const first = await client.execute({ binding, source, sourceDigest: digest(source), stdin: "1\n2\n3\n4\n" }, new AbortController().signal);
    const duplicate = await client.execute({ binding, source, sourceDigest: digest(source), stdin: "1\n2\n3\n4\n" }, new AbortController().signal);
    assert.equal(first.state, "uncertain", "already-consumed may represent an in-flight or lost-closure attempt");
    assert.equal(duplicate.state, "uncertain");
    assert.equal(backendCalls, 0);
  } finally { await server!.close(); owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test("hostCodingBridgeRefusedOwnerAttemptNeverInvokesBackend", async () => {
  const root = tempRoot("rmd-coding-bridge-owner-refused-");
  const owner = ownerAt(root); assert.equal(owner.claim(slot), "claimed");
  const socketPath = join(root, "s"); let backendCalls = 0;
  const backend = qualifiedBackend(async () => { backendCalls++; throw new Error("must-not-start"); });
  const server = await startCodingHostBridge({ enabled: true, socketPath, executionTimeoutMs: 2_000,
    operations: { authenticate: async () => peer(), expectedPeer: { uid: process.getuid!(), cgroup: "/test/remudero-daemon" },
      owner: { resolveClaimedCodingSlot: () => null, consumeCodingAttempt: owner.consumeCodingAttempt.bind(owner) }, backend } });
  assert.ok(server);
  const client = createCodingHostBridgeClient({ enabled: true, socketPath, timeoutMs: 5_000 })!;
  try {
    const result = await client.execute({ binding, source, sourceDigest: digest(source), stdin: "1\n2\n3\n4\n" }, new AbortController().signal);
    assert.equal(result.state, "unavailable");
    if (result.state === "unavailable") assert.equal(result.reason, "slot-authority-unavailable");
    assert.equal(backendCalls, 0);
  } finally { await server!.close(); owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test("hostCodingBridgeDisconnectAbortsBackendAndWaitsForClosureBeforeServerClose", async () => {
  const root = tempRoot("rmd-coding-bridge-cancel-");
  const owner = ownerAt(root); assert.equal(owner.claim(slot), "claimed");
  const socketPath = join(root, "s");
  let started!: () => void, abortSeen!: () => void, releaseClosure!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const abortPromise = new Promise<void>(resolve => { abortSeen = resolve; });
  const closureGate = new Promise<void>(resolve => { releaseClosure = resolve; });
  let candidateClosed = false, serverClosed = false;
  const backend = qualifiedBackend(async ({ signal, binding: fullBinding, attempt }) => {
    started();
    await new Promise<void>(resolve => {
      const onAbort = () => { abortSeen(); void closureGate.then(resolve); };
      if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
    });
    candidateClosed = true;
    assert.deepEqual(codingAttemptConsumptionBinding(attempt), fullBinding);
    return { sourceDigest: digest(source), candidateExitCode: 0, stdout: "10\n", stderr: "",
      hostExecutionId: "rmd-coding-test.service", hostReceiptId: uuid, receiptDigest: "c".repeat(64),
      closureProved: true, limitsReadBack: true };
  });
  const server = await startCodingHostBridge({ enabled: true, socketPath, executionTimeoutMs: 10_000,
    operations: { authenticate: async () => peer(), expectedPeer: { uid: process.getuid!(), cgroup: "/test/remudero-daemon" },
      owner, backend } });
  assert.ok(server);
  let closedServer = false;
  const socket = createConnection({ path: socketPath });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => { socket.write(request() + "\n"); resolve(); });
      socket.once("error", reject);
    });
    await startedPromise;
    socket.destroy();
    await abortPromise;
    const closing = server!.close().then(() => { serverClosed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(serverClosed, false, "host close must await backend's closure barrier");
    releaseClosure();
    await closing;
    closedServer = true;
    assert.equal(candidateClosed, true);
    assert.equal(serverClosed, true);
  } finally { socket.destroy(); if (!closedServer) { releaseClosure(); await server!.close(); } owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test("hostCodingBridgeClientRejectsExtraResponseFieldsAndDecodesSplitUtf8", async () => {
  const runFake = async (extra: Record<string, unknown>, splitUtf8: boolean, closedUnavailable = false) => {
    const root = tempRoot("rmd-coding-bridge-client-"), socketPath = join(root, "s");
    const fake = createServer(socket => {
      let body = "";
      socket.on("data", chunk => {
        body += chunk.toString("utf8");
        const newline = body.indexOf("\n");
        if (newline < 0) return;
        const req = JSON.parse(body.slice(0, newline));
        const replyBinding = { ...req.binding, codingExecutionAttemptId: "fd52e8ab-c357-40cb-98dd-4cf0a8bb5762" };
        const replyValue = closedUnavailable
          ? { version: HOST_CODING_PROTOCOL, kind: "result", requestId: req.requestId, state: "closed-unavailable",
            binding: replyBinding, reason: "resource-readback-incomplete", configured: null, observed: null,
            candidateOutput: null, execution: { hostStarted: "yes", closure: "proven", hostExecutionId: "rmd-coding-test.service" }, ...extra }
          : { version: HOST_CODING_PROTOCOL, kind: "result", requestId: req.requestId,
            state: "complete", binding: replyBinding, sourceDigest: req.sourceDigest, candidateExitCode: 0,
            stdout: splitUtf8 ? "café\n" : "10\n", stderr: "", hostExecutionId: "rmd-coding-test.service", hostReceiptId: uuid,
            execution: { hostStarted: "yes", closure: "proven", hostExecutionId: "rmd-coding-test.service" },
            receiptDigest: "d".repeat(64), ...extra };
        const reply = Buffer.from(JSON.stringify(replyValue) + "\n");
        if (splitUtf8) {
          const point = reply.indexOf(Buffer.from("é")) + 1;
          socket.write(reply.subarray(0, point));
          setImmediate(() => socket.end(reply.subarray(point)));
        } else socket.end(reply);
      });
    });
    await new Promise<void>(resolve => fake.listen(socketPath, resolve));
    chmodSync(socketPath, 0o600);
    try {
      const client = createCodingHostBridgeClient({ enabled: true, socketPath, timeoutMs: 3_000 })!;
      return await client.execute({ binding, source, sourceDigest: digest(source), stdin: "1\n2\n3\n4\n" },
        new AbortController().signal);
    } finally {
      await new Promise<void>(resolve => fake.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  };
  const rejected = await runFake({ error: "credential-leak" }, false);
  assert.equal(rejected.state, "uncertain", "a malformed post-request response cannot imply safe non-execution");
  const accepted = await runFake({}, true);
  assert.equal(accepted.state, "complete");
  if (accepted.state === "complete") assert.equal(accepted.stdout, "café\n");
  const closed = await runFake({}, false, true);
  assert.equal(closed.state, "closed-unavailable", "proven closure with missing metrics stays unavailable, not uncertain or passed");
});
