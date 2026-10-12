import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import { OPPORTUNITY_EVIDENCE_FILE, OPPORTUNITY_EVIDENCE_MAX_BYTES, OPPORTUNITY_STATES,
  projectGardenerOpportunityEvidence, readGardenerOpportunityEvidence } from "../src/lib/gardener-opportunity-evidence.js";
import { createGardenerRuntimeWriter } from "../src/lib/gardener-runtime.js";
import { buildGardenersRoute } from "../src/lib/gardeners-route.js";

const stamp = "2026-10-11T12:00:00.000Z";
const clock = fixedClock(Date.parse(stamp));
const repository = "acme/app";
const row = (state = "pending", key = "debt-1", at = "2026-10-10T12:00:00.000Z") => ({
  key: `${repository}/${key}`, candidate: { repo: repository, key, observedAt: at, privatePrompt: "PRIVATE" },
  proposalId: "proposal-1", sourceIds: ["source-1"], at, state, reason: "PRIVATE", privatePath: "/home/operator/private",
});
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "rmd-opportunity-evidence-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, OPPORTUNITY_EVIDENCE_FILE);
  return { dir, path, write: (value: unknown) => writeFile(path, JSON.stringify(value)) };
}

test("gardener opportunities read real saved classifications without inventing freshness or verified benefit", async (t) => {
  const f = await fixture(t);
  await f.write(OPPORTUNITY_STATES.map((state, i) => row(state, `key-${i}`, i === 0 ? stamp : undefined)));
  const result = await readGardenerOpportunityEvidence(f.dir, repository.toUpperCase(), clock);
  assert.equal(result.state, "reported");
  if (result.state !== "reported") throw new Error("positive corpus refused");
  assert.equal(result.total, 8);
  assert.deepEqual(result.counts, Object.fromEntries(OPPORTUNITY_STATES.map((state) => [state, 1])));
  assert.equal(result.oldestReconciledAt, "2026-10-10T12:00:00.000Z");
  assert.equal(result.latestReconciledAt, stamp);
  assert.equal(result.readAt, stamp);
  assert.equal(result.countSemantics, "reported_states_not_verified_outcomes");
  assert.equal(result.coverage, "saved-opportunity-registry");
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  assert.ok(!JSON.stringify(result).includes("/home/"));
});

test("gardener opportunities preserve missing unreadable malformed and oversized instead of zero", async (t) => {
  const f = await fixture(t);
  const read = () => readGardenerOpportunityEvidence(f.dir, repository, clock);
  const reason = async () => { const result = await read(); assert.equal(result.state, "unavailable"); return result.state === "unavailable" ? result.reason : null; };
  assert.equal(await reason(), "not_collected");
  await writeFile(f.path, "[truncated"); assert.equal(await reason(), "malformed");
  await f.write({}); assert.equal(await reason(), "malformed");
  await writeFile(f.path, "x".repeat(OPPORTUNITY_EVIDENCE_MAX_BYTES + 1)); assert.equal(await reason(), "oversized");
  await f.write(Array.from({ length: 513 }, (_, i) => row("pending", `key-${i}`))); assert.equal(await reason(), "oversized");
  await rm(f.path); await mkdir(f.path); assert.equal(await reason(), "unreadable");
  await rm(f.path, { recursive: true }); await writeFile(f.path, "not-a-directory");
  assert.equal((await readGardenerOpportunityEvidence(f.path, repository, clock)).state, "unavailable");
});

test("gardener opportunities refuse a real named pipe without waiting for a writer", async (t) => {
  const f = await fixture(t);
  await f.write([row()]);
  assert.equal((await readGardenerOpportunityEvidence(f.dir, repository, clock)).state, "reported", "the ordinary file is a positive control");
  await rm(f.path);
  execFileSync("mkfifo", [f.path]);
  const module = new URL("../src/lib/gardener-opportunity-evidence.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval",
    `import { readGardenerOpportunityEvidence } from ${JSON.stringify(module)};
     console.log(JSON.stringify(await readGardenerOpportunityEvidence(${JSON.stringify(f.dir)}, ${JSON.stringify(repository)})));`],
    { encoding: "utf8", timeout: 5000 });
  assert.equal(child.error, undefined, "nonregular input must not hang in open before the type check");
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.state, "unavailable"); assert.equal(result.reason, "unreadable");
  assert.equal(result.total, undefined);
});

test("gardener opportunities refuse an entire mixed invalid duplicate or future corpus", () => {
  const variants = [null, [], { ...row(), candidate: null }, { ...row(), candidate: { ...row().candidate, repo: "bad-repo" } },
    { ...row(), key: "wrong-join" }, { ...row(), proposalId: "" }, { ...row(), sourceIds: [null] },
    { ...row(), sourceIds: Array(65).fill("source") }, { ...row(), at: "bad-time" }, { ...row(), state: "successful" },
    { ...row(), candidate: { ...row().candidate, key: "" } }, { ...row(), candidate: { ...row().candidate, observedAt: "invalid" } }];
  for (const value of variants) assert.equal(projectGardenerOpportunityEvidence([row(), value], repository, clock).state, "unavailable");
  for (const [rows, expected] of [
    [[row(), row()], "malformed"],
    [[{ ...row(), key: "other/repo/debt-1", candidate: { ...row().candidate, repo: "other/repo" } }], "repository_mismatch"],
    [[row("pending", "debt-1", "2026-10-11T12:01:01.000Z")], "clock_skew"],
    [[{ ...row(), candidate: { ...row().candidate, observedAt: stamp } }], "clock_skew"],
  ] as const) {
    const result = projectGardenerOpportunityEvidence(rows, repository, clock);
    assert.equal(result.state === "unavailable" && result.reason, expected);
  }
});

test("gardener opportunities distinguish an empty saved registry from a producer timestamp", async (t) => {
  const f = await fixture(t); await f.write([]);
  const result = await readGardenerOpportunityEvidence(f.dir, repository, clock);
  assert.equal(result.state, "reported");
  if (result.state !== "reported") throw new Error("valid empty registry refused");
  assert.equal(result.total, 0); assert.equal(result.latestReconciledAt, null); assert.equal(result.oldestReconciledAt, null);
  assert.ok(Object.values(result.counts).every((n) => n === 0));
  assert.equal((await readGardenerOpportunityEvidence(f.dir, undefined, clock)).state, "unavailable");
  assert.equal(projectGardenerOpportunityEvidence([], "../private", clock).state, "unavailable");
});

test("gardener opportunities refuse a descriptor that changes or grows while reading", async (t) => {
  const f = await fixture(t); await f.write([row()]);
  const changingOpen: typeof open = (async (path: string, flags: string) => {
    const handle = await open(path, flags);
    return { stat: () => handle.stat(), close: () => handle.close(), read: async (...args: Parameters<typeof handle.read>) => {
      const read = await (handle.read as (...a: typeof args) => ReturnType<typeof handle.read>)(...args);
      if (read.bytesRead > 0) await writeFile(f.path, "[]");
      return read;
    } } as typeof handle;
  }) as typeof open;
  const changed = await readGardenerOpportunityEvidence(f.dir, repository, clock, changingOpen);
  assert.equal(changed.state === "unavailable" && changed.reason, "corpus_changed");
  const growingOpen: typeof open = (async () => ({ stat: async () => ({ isFile: () => true, size: 1 }),
    close: async () => {}, read: async (_buffer: Buffer, _offset: number, length: number) => ({ bytesRead: length }) })) as unknown as typeof open;
  const grew = await readGardenerOpportunityEvidence(f.dir, repository, clock, growingOpen);
  assert.equal(grew.state === "unavailable" && grew.reason, "oversized");
});

test("gardener opportunities do not mislabel a non-parser failure as malformed JSON", async (t) => {
  const f = await fixture(t); await f.write([row()]);
  let reads = 0;
  const failingClock = { ...clock, iso() { if (++reads === 1) throw new Error("PRIVATE clock failure"); return stamp; } };
  const result = await readGardenerOpportunityEvidence(f.dir, repository, failingClock);
  assert.equal(result.state === "unavailable" && result.reason, "unreadable");
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
});

test("gardener route keeps valid process receipts when independent opportunity evidence is absent or malformed", async (t) => {
  const f = await fixture(t);
  const writer = createGardenerRuntimeWriter({ stateDir: f.dir, repository, daemonRunId: "boot-1", clock,
    gardens: [{ name: "plan", enabled: true, cadenceMs: 60_000, scope: "repository" }], log: () => {} });
  await writer.flush();
  const route = buildGardenersRoute({ stateDir: f.dir, repository, clock });
  const invoke = async () => {
    let status = 0, body = "";
    await route.handler({} as never, { writeHead(n: number) { status = n; }, end(s: string) { body = s; } } as never, { params: {} });
    assert.equal(status, 200); return JSON.parse(body);
  };
  let response = await invoke();
  assert.equal(response.gardens.length, 1); assert.equal(response.opportunityEvidence.reason, "not_collected");
  await writeFile(f.path, "bad-json"); response = await invoke();
  assert.equal(response.opportunityEvidence.reason, "malformed"); assert.equal(response.outcomeAssessment, "not_collected");
  assert.equal(response.spend, null);
  await f.write([row()]); response = await invoke();
  assert.equal(response.opportunityEvidence.total, 1); assert.equal(response.opportunityEvidence.counts.pending, 1);
});
