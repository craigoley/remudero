/** Synthetic byte profiles; requested repetition never certifies a provider cache hit. */
import { createHash, randomUUID } from "node:crypto";
import { canarySuiteDigest, type CanaryCase } from "./model-canary-suite.js";
import { executeCanary, type CanaryExecutionPorts, type CanaryPin } from "./model-canary-runner.js";
import type { CanaryRun } from "./model-canary-metrics.js";

export function contextCanaryProtocol(bytes: 2048 | 16384 | 65536,
  treatment: "first-use" | "repeat", namespace: string) {
  if (![2048, 16384, 65536].includes(bytes) || !["first-use", "repeat"].includes(treatment)
    || typeof namespace !== "string" || !/^[a-f0-9]{64}$/.test(namespace))
    throw new Error("canary-context-profile-invalid");
  const header = `Synthetic document namespace ${namespace}. D1: the verified value is 23.\n`;
  const padding = "Irrelevant padding contains no additional D1 facts.\n";
  const document = header + padding.repeat(Math.ceil((bytes - header.length) / padding.length))
    .slice(0, bytes - header.length);
  const prompt = 'Use only D1. Ignore padding. Return only JSON {"answer":number,"sources":string[]}.\n'
    + document + '\nQuestion: What is the D1 verified value?';
  const phases = treatment === "repeat" ? ["primer", "probe"] : ["probe"];
  const cases: CanaryCase[] = phases.map(phase => ({ id: `context-${bytes}-${treatment}-${phase}`,
    family: "evidence", prompt, expected: { answer: 23, sources: ["D1"] }, tools: "none", cadence: "weekly" }));
  const suiteHash = createHash("sha256").update(JSON.stringify([
    "canary-context-v1", bytes, treatment, namespace, canarySuiteDigest(cases),
  ])).digest("hex");
  return { version: "canary-context-v1" as const, bytes, byteUnit: "utf8-bytes" as const,
    treatment, namespace, phases, cases, suiteHash, promptBytes: Buffer.byteLength(prompt),
    cacheGuarantee: "none" as const, sampleUnit: "whole-profile" as const };
}

/** All calls are admitted separately; primer usage belongs to the same task as the probe. */
export async function executeContextCanary(protocol: ReturnType<typeof contextCanaryProtocol>,
  pin: CanaryPin, ports: CanaryExecutionPorts, wallMs = 120_000) {
  const expected = contextCanaryProtocol(protocol.bytes, protocol.treatment, protocol.namespace);
  if (JSON.stringify(protocol) !== JSON.stringify(expected) || pin.suiteHash !== protocol.suiteHash
    || !Number.isFinite(wallMs) || wallMs < 1 || wallMs > 120_000)
    throw new Error("canary-context-protocol-invalid");
  const started = ports.monotonicMs(), run: CanaryRun = { id: randomUUID(),
    caseId: `context-${protocol.bytes}-${protocol.treatment}`, suiteHash: protocol.suiteHash,
    model: pin.model, route: pin.route, effort: pin.effort, family: "evidence",
    verified: true, totalDurationMs: null, attempts: [] };
  const phases: { phase: string; verified: boolean | null; attemptIds: string[] }[] = [];
  for (const [index, item] of protocol.cases.entries()) {
    const remaining = wallMs - (ports.monotonicMs() - started);
    if (!Number.isFinite(remaining) || remaining <= 0) { run.verified = null; break; }
    const result = await executeCanary(item, pin, { ...ports, save: async () => {} },
      { maxCalls: 1, wallMs: remaining, maxOutputBytes: 4096 });
    run.attempts.push(...result.run.attempts);
    phases.push({ phase: protocol.phases[index]!, verified: result.run.verified,
      attemptIds: result.run.attempts.map(a => a.id) });
    if (result.run.verified === null) { run.verified = null; break; }
    if (!result.run.verified) run.verified = false;
  }
  const elapsed = ports.monotonicMs() - started;
  run.totalDurationMs = Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
  run.outcomeReason = run.verified === null ? "unresolved-context-profile"
    : run.verified ? "verified" : "context-profile-incorrect";
  const probe = phases.find(p => p.phase === "probe"), attempt = probe?.attemptIds.length === 1
    ? run.attempts.find(a => a.id === probe.attemptIds[0]) : undefined;
  const cache = attempt?.cacheReadTokens;
  const probeCache = cache === undefined || cache === null || !Number.isSafeInteger(cache) || cache < 0
    ? "unavailable" as const : cache > 0 ? "observed-read" as const : "observed-zero" as const;
  run.contextProfile = { version: protocol.version, bytes: protocol.bytes, treatment: protocol.treatment,
    byteUnit: protocol.byteUnit, cacheGuarantee: protocol.cacheGuarantee, phases, probeCache };
  await ports.save(run, null);
  return { run, phases, bytes: protocol.bytes, byteUnit: protocol.byteUnit,
    treatment: protocol.treatment, sampleUnit: protocol.sampleUnit, cacheGuarantee: protocol.cacheGuarantee,
    probeCache };
}
