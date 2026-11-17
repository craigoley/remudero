// W1-T13337: the first shadow pass on the host (2026-11-17 07:41Z) logged source_partial with nothing
// else, so nobody could tell a stale snapshot from a missing coverage source. The refused result now
// names each failed qualification check; the accept or refuse decision itself is unchanged.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { inboxGardenerGaps, runInboxGardener, type InboxGardenerPack, type InboxGardenerPorts } from "#src/lib/inbox-gardener.js";
import { INBOX_STALE_AFTER_MS } from "#src/lib/inbox-freshness.js";
import { sameInboxGardenerScope, type InboxGardenerScope } from "#src/lib/inbox-retirement.js";
import type { Clock } from "#src/lib/clock.js";

const NOW = Date.parse("2026-11-17T08:00:00.000Z");
const SCOPE: InboxGardenerScope = { repository: "craigoley/remudero", instance: "core", root: "/r" };
const SOURCES = ["plan", "registry", "github", "ledger", "threads"] as const;

function pack(over: Partial<InboxGardenerPack> = {}): InboxGardenerPack {
  return { scope: SCOPE, snapshotKey: "b".repeat(64), generatedAt: new Date(NOW - 60_000).toISOString(), checkedAt: new Date(NOW).toISOString(),
    codeSha: "a".repeat(40), coverage: { plan: "observed", registry: "observed", github: "observed", ledger: "observed", threads: "observed" },
    candidates: [], ledgerEventIds: new Set(), ...over };
}
const clock: Clock = { now: () => NOW, date: () => new Date(NOW), iso: () => new Date(NOW).toISOString() } as Clock;

function stateDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-gardener-gap-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function ports(p: InboxGardenerPack, calls: string[]): InboxGardenerPorts {
  return { capture: async () => p, proof: async () => { calls.push("proof"); return undefined; },
    judge: async () => { calls.push("judge"); return { decision: "needs_triage", reason: "r" }; },
    mirror: async () => { calls.push("mirror"); } };
}
const pass = (t: TestContext, p: InboxGardenerPack, calls: string[] = []) =>
  runInboxGardener({ stateDir: stateDir(t), scope: SCOPE, ports: ports(p, calls), mode: "shadow", clock });

// The predicate as it stood at origin/main before W1-T13337, kept verbatim as the reference.
const oldQualified = (p: InboxGardenerPack, scope: InboxGardenerScope, now: number) =>
  sameInboxGardenerScope(p.scope, scope) && /^[a-f0-9]{40}$/.test(p.codeSha) && /^[a-f0-9]{64}$/.test(p.snapshotKey) &&
  Number.isFinite(Date.parse(p.generatedAt)) && now - Date.parse(p.generatedAt) >= 0 && now - Date.parse(p.generatedAt) <= INBOX_STALE_AFTER_MS &&
  Object.values(p.coverage).every(x => x === "observed");

test("W1-T13337 criterion 1: a source_partial pass carries gaps, the sorted list of every failed qualification check", async t => {
  const bad = pack({ scope: { ...SCOPE, instance: "other" }, codeSha: "nope", snapshotKey: "", generatedAt: "not a date",
    coverage: { plan: "unavailable", registry: "observed", github: "partial", ledger: "observed", threads: "unavailable" } });
  const result = await pass(t, bad);
  assert.deepEqual(result, { state: "source_partial", complete: false, retired: 0, judged: 0,
    gaps: ["code_sha", "coverage:github", "coverage:plan", "coverage:threads", "generated_at", "scope", "snapshot_key"] });
  for (const source of SOURCES) {
    const one = await pass(t, pack({ coverage: { ...pack().coverage, [source]: "partial" } }));
    assert.deepEqual("gaps" in one && one.gaps, [`coverage:${source}`], `a ${source} source that is not observed is named alone`);
  }
});

test("W1-T13337 criterion 2: a stale pack names stale with its age, and a qualifying pack runs as before with no gaps", async t => {
  const stale = await pass(t, pack({ generatedAt: new Date(NOW - INBOX_STALE_AFTER_MS - 1).toISOString() }));
  assert.deepEqual(stale, { state: "source_partial", complete: false, retired: 0, judged: 0, gaps: ["stale"], age_ms: INBOX_STALE_AFTER_MS + 1 });
  const future = await pass(t, pack({ generatedAt: new Date(NOW + 5).toISOString() }));
  assert.deepEqual(future, { state: "source_partial", complete: false, retired: 0, judged: 0, gaps: ["stale"], age_ms: -5 }, "a pack from the future is not current either");
  const edge = await pass(t, pack({ generatedAt: new Date(NOW - INBOX_STALE_AFTER_MS).toISOString() }));
  assert.equal(edge.state, "complete", "exactly the staleness bound still qualifies");
  const ok = await pass(t, pack());
  assert.deepEqual(ok, { state: "complete", complete: true, evaluated: 0, retired: 0, judged: 0, proofReads: 0 });
  assert.equal("gaps" in ok, false);
});

test("W1-T13337 criterion 3: invariant qualification-unchanged, the accept or refuse decision matches the old predicate on every pack", async t => {
  const variants: Partial<InboxGardenerPack>[] = [{}, { scope: { ...SCOPE, root: "/x" } }, { codeSha: "A".repeat(40) }, { codeSha: "a".repeat(39) },
    { snapshotKey: "b".repeat(63) }, { generatedAt: "" }, { generatedAt: new Date(NOW).toISOString() },
    { generatedAt: new Date(NOW - INBOX_STALE_AFTER_MS).toISOString() }, { generatedAt: new Date(NOW - INBOX_STALE_AFTER_MS - 1).toISOString() },
    { generatedAt: new Date(NOW + 1).toISOString() }, ...SOURCES.flatMap(s => (["partial", "unavailable"] as const).map(v => ({ coverage: { ...pack().coverage, [s]: v } })))];
  let accepted = 0, refused = 0;
  for (const a of variants) for (const b of variants) {
    const p = pack({ ...a, ...b, coverage: { ...pack().coverage, ...a.coverage, ...b.coverage } });
    const old = oldQualified(p, SCOPE, NOW), gaps = inboxGardenerGaps(p, SCOPE, NOW);
    assert.equal(gaps.length === 0, old, JSON.stringify({ ...p, ledgerEventIds: undefined }));
    if (old) accepted++; else refused++;
  }
  assert.ok(accepted > 0 && refused > 0, `both outcomes exercised: ${accepted} accepted, ${refused} refused`);
  const calls: string[] = [];
  const refusedPass = await pass(t, pack({ codeSha: "", candidates: [{ proposal: { id: "x" } } as never] }), calls);
  assert.equal(refusedPass.state, "source_partial");
  assert.deepEqual(calls, [], "a refused pack reaches no mirror, proof read, judge or retirement");
});
