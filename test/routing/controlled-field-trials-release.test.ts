/**
 * W1-T10843 — THE CONTROLLED field-trials-v1 RELEASE. A registered randomized epoch becomes the site's
 * controlled release (exact per-arm counts, task-bootstrap intervals, pre-registered secondaries, a
 * bucketed crossover) or a NAMED refusal that emits nothing. Fixtures only: no network, no live ledger.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildControlledFieldTrialsRelease, crossoverBucket, type ControlledEpoch, type ControlledReleaseInput, type EpochAssignment,
  type EpochTaskOutcome,
} from "#src/lib/field-trials-controlled-release.js";
import { fieldTrialsCommand, unavailableLedger, writeControlledCandidate, buildFieldTrialsFlowSnapshot, type FieldTrialsConsent }
  from "#src/lib/field-trials-flow.js";
import { ROUTING_DRAW_METHOD } from "#src/lib/worker-provider.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

/**
 * The site's parser, VENDORED for the contract. Source: craigoley/remudero-site lib/field-trials-release.ts
 * `parseFieldTrialsRelease` at site commit b80fbbb (the base keys), extended with the optional `adherence` and
 * `secondary` keys of PORTAL-T43 (remudero-site PR #205). Transcribed from the task record's reading of that
 * parser: exact key set, exactly two arms, distinct ids, 0 < observed <= assigned, 0 <= successes <= observed,
 * ciLower <= rate <= ciUpper within [0, 1].
 */
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const BASE_KEYS = ["schema", "releaseId", "status", "publicationScope", "publishedAt", "evidence", "randomizationUnit", "metric",
  "intervalMethod", "corpusRevision", "harnessRevision", "scorerRevision", "assignmentAudit", "sourceRepos",
  "consentRegistryRevision", "arms"];
const OPTIONAL_KEYS = ["adherence", "secondary"];
function siteParse(value: unknown, allowedRepos: readonly string[]): { ok: true } | { ok: false; reason: string } {
  const bad = (reason: string) => ({ ok: false as const, reason });
  if (typeof value !== "object" || value === null || Array.isArray(value)) return bad("not-object");
  const r = value as Record<string, any>;
  const keys = Object.keys(r);
  if (BASE_KEYS.some((key) => !keys.includes(key)) || keys.some((key) => ![...BASE_KEYS, ...OPTIONAL_KEYS].includes(key))) return bad("keys");
  const literal: Record<string, string> = { schema: "field-trials-v1", status: "published", publicationScope: "public-opt-in",
    evidence: "controlled", randomizationUnit: "task", metric: "verified_completion", intervalMethod: "bootstrap-95-task", assignmentAudit: "pass" };
  for (const [key, expected] of Object.entries(literal)) if (r[key] !== expected) return bad(key);
  if (!ID.test(r.releaseId)) return bad("releaseId");
  if (typeof r.publishedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.publishedAt)
    || new Date(r.publishedAt).toISOString() !== r.publishedAt) return bad("publishedAt");
  for (const key of ["corpusRevision", "harnessRevision", "scorerRevision", "consentRegistryRevision"]) if (!ID.test(r[key])) return bad(key);
  if (!Array.isArray(r.sourceRepos) || r.sourceRepos.length === 0 || r.sourceRepos.some((repo: string) => !allowedRepos.includes(repo))) return bad("sourceRepos");
  if (!Array.isArray(r.arms) || r.arms.length !== 2) return bad("arms");
  const armKeys = ["modelId", "assigned", "observed", "successes", "ciLower", "ciUpper"];
  for (const arm of r.arms) {
    if (Object.keys(arm).sort().join() !== [...armKeys].sort().join() || !ID.test(arm.modelId)) return bad("arm-shape");
    if (!Number.isInteger(arm.assigned) || !Number.isInteger(arm.observed) || !Number.isInteger(arm.successes)) return bad("arm-integers");
    if (!(arm.observed > 0 && arm.observed <= arm.assigned && arm.successes >= 0 && arm.successes <= arm.observed)) return bad("arm-counts");
    const rate = arm.successes / arm.observed;
    if (!(arm.ciLower >= 0 && arm.ciUpper <= 1 && arm.ciLower <= rate && rate <= arm.ciUpper)) return bad("arm-interval");
  }
  if (r.arms[0].modelId === r.arms[1].modelId) return bad("arms-distinct");
  if (r.adherence !== undefined) {
    if (!["<5%", "5-15%", "15-30%", ">30%"].includes(r.adherence.crossoverPctBucket) || r.adherence.analysis !== "intent-to-treat") return bad("adherence");
  }
  if (r.secondary !== undefined) {
    if (!Array.isArray(r.secondary) || r.secondary.length > 3) return bad("secondary");
    for (const entry of r.secondary) {
      if (!["first_pass_success", "repair_rounds_mean"].includes(entry.metric) || entry.intervalMethod !== "bootstrap-95-task"
        || !Array.isArray(entry.arms) || entry.arms.length !== 2) return bad("secondary-entry");
      for (const arm of entry.arms) {
        if (!r.arms.some((a: { modelId: string }) => a.modelId === arm.arm) || !(arm.ciLower <= arm.value && arm.value <= arm.ciUpper) || arm.ciLower < 0) return bad("secondary-arm");
      }
    }
  }
  return { ok: true };
}

const SOL = "gpt-6.1-sol";
const SON = "claude-sonnet-5.5";
const REPO = "craigoley/remudero";
const HEX = (c: string) => c.repeat(40);
const PINS = { harness: HEX("a"), prompt: HEX("b"), tool: HEX("c"), scorer: HEX("d"), environment: HEX("e") };
const CONSENT: FieldTrialsConsent = { version: "field-trials-consent-v1", repos: [{ repo: REPO, rights: "aggregate-opt-in", receipt: "receipt-1" }] };
const EPOCH: ControlledEpoch = { epochId: "sol61-vs-sonnet55", arms: [SOL, SON], randomizationUnit: "task", drawMethod: ROUTING_DRAW_METHOD,
  drawProbability: 0.5, window: { start: "2026-09-27T00:00:00.000Z", end: "2026-10-24T23:59:59.000Z" },
  stopping: { afterIso: "2026-10-27T00:00:00.000Z", minObservedPerArm: 10 }, seed: "seed-1", corpusRevision: HEX("f"), sourceRepos: [REPO] };
const AS_OF = "2026-10-28T00:00:00.000Z";
const START = Date.UTC(2026, 8, 28);

function fixture(opts: { cross?: boolean } = {}): { assignments: EpochAssignment[]; outcomes: EpochTaskOutcome[] } {
  const assignments: EpochAssignment[] = [];
  const outcomes: EpochTaskOutcome[] = [];
  for (let i = 0; i < 80; i += 1) {
    const arm = i % 2 === 0 ? SOL : SON;
    const other = arm === SOL ? SON : SOL;
    const at = START + i * 3_600_000;
    const crossed = opts.cross !== false && (arm === SOL ? i % 4 === 0 : i % 10 === 1);
    assignments.push({ taskId: `t${i}`, at: new Date(at).toISOString(), assignedArm: arm, servedArm: crossed ? other : arm, propensity: 0.5 });
    if (i % 4 === 1) assignments.push({ taskId: `t${i}`, at: new Date(at + 86_400_000).toISOString(), assignedArm: arm, servedArm: arm, propensity: 0.5 });
    const lost = arm === SOL ? i % 10 === 0 : i % 7 === 1;
    outcomes.push({ taskId: `t${i}`, outcome: i === 2 ? "unobserved" : lost ? "not-merged" : "merged",
      mergedAt: lost || i === 2 ? null : new Date(at + 2 * 86_400_000).toISOString(), fixRounds: i % 9 === 0 ? 2 : i % 3 === 0 ? 1 : 0,
      ...(i % 3 === 0 ? { repairedBy: SON } : {}) });
  }
  return { assignments, outcomes };
}

function input(over: Partial<ControlledReleaseInput> = {}, data = fixture()): ControlledReleaseInput {
  return { epoch: EPOCH, ...data, pins: PINS, consent: CONSENT, asOf: AS_OF, siteAcceptsSecondary: true, ...over };
}

function built(over: Partial<ControlledReleaseInput> = {}, data = fixture()) {
  const result = buildControlledFieldTrialsRelease(input(over, data));
  assert.equal(result.state, "candidate", JSON.stringify(result));
  return result.state === "candidate" ? result : (undefined as never);
}

test("W1-T10843: the controlled release passes the site field-trials-v1 parser", () => {
  const { release } = built();
  assert.deepEqual(siteParse(release, [REPO]), { ok: true });
  assert.deepEqual(Object.keys(release).sort(), [...BASE_KEYS, ...OPTIONAL_KEYS].sort());
  assert.deepEqual([release.evidence, release.randomizationUnit, release.metric, release.intervalMethod, release.assignmentAudit],
    ["controlled", "task", "verified_completion", "bootstrap-95-task", "pass"]);
  assert.deepEqual(release.arms.map((arm) => arm.modelId), [SOL, SON]);
  assert.equal(release.publishedAt, AS_OF);
  assert.deepEqual(siteParse({ ...release, evidence: "observational" }, [REPO]), { ok: false, reason: "evidence" }, "the vendored parser is not vacuous");
  assert.deepEqual(siteParse({ ...release, arms: [release.arms[0]] }, [REPO]), { ok: false, reason: "arms" });
  assert.deepEqual(siteParse({ ...release, nBucket: "10-20" }, [REPO]), { ok: false, reason: "keys" });
  // a registered-but-malformed revision is refused here, before the site would reject it
  const refused = buildControlledFieldTrialsRelease(input({ pins: { ...PINS, scorer: null } }));
  assert.deepEqual([refused.state, (refused as { reason: string }).reason], ["refused", "revision-unavailable"]);
});

test("W1-T10843: a failing assignment audit or an unreached horizon emits no release", () => {
  const refusedWith = (over: Partial<ControlledReleaseInput>, data = fixture()) => {
    const result = buildControlledFieldTrialsRelease(input(over, data));
    assert.equal(result.state, "refused", JSON.stringify(result));
    assert.equal("release" in result, false, "a refusal carries no artifact");
    return result as { reason: string; detail: string };
  };
  const data = fixture();
  assert.equal(refusedWith({}, { ...data, assignments: data.assignments.map((row, i) => i === 3 ? { ...row, propensity: "unavailable" } : row) }).detail, "propensity-missing");
  assert.equal(refusedWith({}, { ...data, assignments: data.assignments.map((row, i) => i === 3 ? { ...row, propensity: 0.7 } : row) }).detail,
    "propensity-differs-from-registered-draw");
  assert.equal(refusedWith({}, { ...data, assignments: data.assignments.map((row, i) => i % 5 === 0 ? { ...row, servedArm: null } : row) }).detail,
    "served-model-missingness");
  assert.equal(refusedWith({}, { ...data, assignments: data.assignments.map((row) => row.assignedArm === SON && row.taskId !== "t1" ? { ...row, assignedArm: SOL } : row) }).detail,
    "arm-balance");
  assert.equal(refusedWith({}, { ...data, assignments: data.assignments.map((row, i) => i === 4 ? { ...row, assignedArm: "gpt-6.1-terra" } : row) }).detail,
    "assigned-arm-outside-registered-arms");
  assert.equal(refusedWith({}, { assignments: [], outcomes: [] }).detail, "no-assignments-in-window");
  assert.equal(refusedWith({ asOf: "2026-10-26T00:00:00.000Z" }).reason, "horizon-not-reached", "inside the 72 h censoring margin");
  assert.equal(refusedWith({ epoch: { ...EPOCH, stopping: { ...EPOCH.stopping, minObservedPerArm: 500 } } }).reason, "horizon-not-reached");
  assert.equal(refusedWith({ epoch: { ...EPOCH, stopping: { ...EPOCH.stopping, afterIso: "2026-11-30T00:00:00.000Z" } } }).reason, "horizon-not-reached");
  assert.equal(refusedWith({ consent: null }).reason, "no-consent-receipt");
  assert.equal(refusedWith({ consent: "consent-invalid" }).reason, "consent-invalid");
  assert.equal(refusedWith({ consent: { ...CONSENT, repos: [{ ...CONSENT.repos[0]!, revoked: true }] } }).reason, "source-consent-missing");
  assert.equal(refusedWith({ consent: { ...CONSENT, repos: [{ ...CONSENT.repos[0]!, rights: "private" }] } }).reason, "source-consent-missing");
  assert.equal(refusedWith({ epoch: { ...EPOCH, sourceRepos: [REPO, "acme/other"] } }).reason, "source-consent-missing");
  assert.equal(refusedWith({ epoch: { ...EPOCH, sourceRepos: [] } }).reason, "source-consent-missing");
  assert.equal(refusedWith({ epoch: { ...EPOCH, arms: [SOL, SOL] } }).reason, "epoch-not-registered");
  assert.equal(refusedWith({ epoch: { ...EPOCH, drawMethod: "manual" } }).reason, "epoch-not-registered");
  assert.equal(refusedWith({ epoch: { ...EPOCH, window: { start: EPOCH.window.end, end: EPOCH.window.start } } }).reason, "epoch-not-registered");
  assert.equal(refusedWith({ epoch: { ...EPOCH, epochId: "has space" } }).reason, "epoch-not-registered");
  const noOutcomeForArm = refusedWith({}, { ...data, outcomes: data.outcomes.filter((row) => Number(row.taskId.slice(1)) % 2 === 1) });
  assert.equal(noOutcomeForArm.reason, "horizon-not-reached", "an arm none of whose tasks reached the outcome window is not a result");
  // the audit alone decides "pass": a clean fixture is the only one that yields a release
  assert.equal(built().release.assignmentAudit, "pass");
});

test("W1-T10843: arm counts and intervals come from task-level outcomes", () => {
  const data = fixture();
  const { release } = built({}, data);
  const cutoff = Date.parse(EPOCH.window.end) + 72 * 3_600_000;
  for (const arm of release.arms) {
    const tasks = data.assignments.filter((row) => row.assignedArm === arm.modelId && row.taskId === `t${row.taskId.slice(1)}`)
      .map((row) => row.taskId).filter((id, i, all) => all.indexOf(id) === i);
    const rows = tasks.map((id) => data.outcomes.find((o) => o.taskId === id)!);
    const observed = rows.filter((o) => o.outcome !== "unobserved");
    const merged = observed.filter((o) => o.outcome === "merged" && Date.parse(o.mergedAt!) <= cutoff);
    assert.deepEqual([arm.assigned, arm.observed, arm.successes], [tasks.length, observed.length, merged.length], arm.modelId);
    const rate = arm.successes / arm.observed;
    assert.ok(arm.ciLower < rate && rate < arm.ciUpper, `${arm.modelId}: a real interval around ${rate}`);
    assert.ok(arm.ciLower >= 0 && arm.ciUpper <= 1);
  }
  assert.equal(release.arms[0].assigned, 40);
  assert.equal(release.arms[0].observed, 39, "the unobserved task is assigned but not observed");
  // one task's outcome moves exactly that arm's successes by one
  const flipped = built({}, { ...data, outcomes: data.outcomes.map((o) => o.taskId === "t4" ? { ...o, outcome: "not-merged", mergedAt: null } : o) });
  assert.equal(flipped.release.arms[0].successes, release.arms[0].successes - 1);
  assert.equal(flipped.release.arms[1].successes, release.arms[1].successes);
  // a merge after the 72 h margin is read as not merged
  const late = built({}, { ...data, outcomes: data.outcomes.map((o) => o.taskId === "t4" ? { ...o, mergedAt: "2026-11-20T00:00:00.000Z" } : o) });
  assert.equal(late.release.arms[0].successes, release.arms[0].successes - 1);
  // the interval is reproducible from the registered seed; the seed moves no count
  assert.deepEqual(built({}, data).release, release);
  const reseeded = built({ epoch: { ...EPOCH, seed: "seed-2" } }, data).release;
  assert.deepEqual(reseeded.arms.map((a) => [a.assigned, a.observed, a.successes]), release.arms.map((a) => [a.assigned, a.observed, a.successes]));
  assert.ok(reseeded.arms.every((a) => a.ciLower < a.successes / a.observed && a.successes / a.observed < a.ciUpper));
});

test("W1-T10843: the controlled release is a candidate and is never published automatically", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}controlled-release-`));
  try {
    const out = join(root, "out");
    const epochFile = { epoch: EPOCH, ...fixture(), stack: Object.fromEntries(Object.entries(PINS).map(([k, v]) => [`${k}Revision`, { state: "observed", value: v }])) };
    const result = writeControlledCandidate(out, epochFile, CONSENT, AS_OF, true);
    assert.equal(result.state, "candidate");
    const files = readdirSync(join(out, "controlled")).sort();
    assert.equal(files.length, 2);
    assert.ok(files.some((f) => f.endsWith(".candidate.json")) && files.some((f) => f.endsWith(".sidecar.private.json")));
    assert.deepEqual(readdirSync(out), ["controlled"], "nothing but the candidate directory: no manifest entry, no release directory");
    const candidate = JSON.parse(readFileSync(join(out, result.state === "candidate" ? result.file : ""), "utf8"));
    assert.deepEqual(siteParse(candidate, [REPO]), { ok: true });
    const sidecar = JSON.parse(readFileSync(join(out, "controlled", files.find((f) => f.endsWith(".sidecar.private.json"))!), "utf8"));
    assert.equal(sidecar.seed, "seed-1");
    assert.equal(sidecar.repairedBy.t3, SON, "the repairing model is private sidecar data");
    assert.equal(JSON.stringify(candidate).includes("seed-1"), false, "the seed never rides in the release");
    assert.equal(JSON.stringify(candidate).includes("t3"), false);
    assert.ok(["no-detectable-difference", "interval-excludes-zero"].includes(sidecar.reportingRule));
    // the existing flow reaches the builder; a refusal writes nothing and fails the pass, and nothing is published
    const dir = join(root, "flow");
    mkdirSync(dir);
    const epochPath = join(root, "epoch.json");
    const consentPath = join(root, "consent.json");
    writeFileSync(epochPath, JSON.stringify(epochFile));
    writeFileSync(consentPath, JSON.stringify(CONSENT));
    const printed: string[] = [];
    const run = (extra: string[], siteAcceptsSecondary?: boolean) => fieldTrialsCommand(
      ["--source", "core=craigoley/remudero", "--ledger", `core=${root}`, "--out-dir", dir, "--consent", consentPath, "--offline", ...extra],
      buildFieldTrialsFlowSnapshot, { nowIso: AS_OF, print: (l) => printed.push(l), printError: () => undefined,
        readLedger: async () => unavailableLedger("fixture"), resolveConfig: () => ({ root }),
        ...(siteAcceptsSecondary === undefined ? {} : { siteAcceptsSecondary }) });
    assert.equal(await run(["--controlled-epoch", epochPath]), 1);
    assert.match(printed.join("\n"), /controlled release refused \(site-secondary-unavailable/);
    assert.equal(existsSync(join(dir, "controlled")), false, "a refusal emits no candidate");
    await run(["--controlled-epoch", epochPath], true);
    assert.match(printed.join("\n"), /controlled candidate: controlled\/controlled-[0-9a-f]{16}\.candidate\.json \(never published/);
    assert.equal(readdirSync(join(dir, "controlled")).length, 2);
    assert.equal(existsSync(join(dir, "releases")), false, "no observational release rode along");
    await run(["--controlled-epoch", join(root, "missing.json")], true);
    assert.match(printed.join("\n"), /controlled release refused \(controlled-epoch-invalid\)/);
    printed.length = 0;
    await run(["--controlled-epoch", epochPath, "--json"], true);
    assert.equal(JSON.parse(printed[0]!).controlled.state, "candidate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T10843: the Sol x Sonnet release carries pre-registered secondaries and adherence", () => {
  const data = fixture();
  const { release, sidecar } = built({}, data);
  const firstAssignment = new Map<string, EpochAssignment>();
  for (const row of data.assignments) if (!firstAssignment.has(row.taskId)) firstAssignment.set(row.taskId, row);
  // ITT by FIRST assignment: a task served by the other arm stays in its assigned arm
  const assignedSol = [...firstAssignment.values()].filter((row) => row.assignedArm === SOL);
  const servedSol = [...firstAssignment.values()].filter((row) => row.servedArm === SOL);
  assert.notEqual(assignedSol.length, servedSol.length, "the fixture's crossover separates assigned from served");
  assert.equal(release.arms[0].assigned, assignedSol.length);
  const uncrossed = built({}, fixture({ cross: false })).release;
  assert.deepEqual(release.arms, uncrossed.arms, "the arms are identical whoever served the tasks");
  // adherence: crossed over all assignments in the window, bucketed
  const crossed = data.assignments.filter((row) => row.servedArm !== row.assignedArm).length;
  assert.deepEqual(sidecar.crossover, { crossed, assignments: data.assignments.length });
  assert.equal(release.adherence.crossoverPctBucket, "15-30%");
  assert.equal(uncrossed.adherence.crossoverPctBucket, "<5%");
  assert.equal(release.adherence.analysis, "intent-to-treat");
  assert.deepEqual([[0, 1, "<5%"], [5, 100, "5-15%"], [15, 100, "15-30%"], [30, 100, "15-30%"], [31, 100, ">30%"], [1386, 6115, "15-30%"]]
    .map(([c, n]) => crossoverBucket(c as number, n as number)), ["<5%", "5-15%", "15-30%", "15-30%", ">30%", "15-30%"]);
  // secondaries: first-pass success and repair rounds, each per arm with a task-bootstrap interval
  assert.deepEqual(release.secondary.map((s) => s.metric), ["first_pass_success", "repair_rounds_mean"]);
  assert.ok(release.secondary.every((s) => s.intervalMethod === "bootstrap-95-task" && s.arms.length === 2));
  const [firstPass, repair] = release.secondary;
  for (const [index, arm] of release.arms.entries()) {
    const rows = [...firstAssignment.values()].filter((row) => row.assignedArm === arm.modelId).map((row) => data.outcomes.find((o) => o.taskId === row.taskId)!);
    const observed = rows.filter((o) => o.outcome !== "unobserved");
    const clean = observed.filter((o) => o.outcome === "merged" && o.fixRounds === 0).length;
    assert.equal(firstPass!.arms[index]!.arm, arm.modelId);
    assert.ok(Math.abs(firstPass!.arms[index]!.value - clean / observed.length) < 1e-9);
    assert.ok(clean < arm.successes, "repair rounds make first-pass strictly lower than the merge rate");
    const mean = rows.reduce((sum, o) => sum + o.fixRounds, 0) / rows.length;
    assert.equal(repair!.arms[index]!.value, Math.round(mean * 10) / 10, "one decimal, over every assigned task");
    for (const s of [firstPass!, repair!]) assert.ok(s.arms[index]!.ciLower <= s.arms[index]!.value && s.arms[index]!.value <= s.arms[index]!.ciUpper);
  }
  // exact per-arm counts, no bucket on the arms; no ranking word anywhere
  assert.ok(release.arms.every((arm) => Object.keys(arm).sort().join() === "assigned,ciLower,ciUpper,modelId,observed,successes"));
  assert.ok(["no-detectable-difference", "interval-excludes-zero"].includes(sidecar.reportingRule));
  assert.equal(sidecar.difference.minus, SON);
  assert.deepEqual(siteParse(release, [REPO]), { ok: true });
  // the first assignment, not a later one, fixes the arm
  const reassigned = data.assignments.map((row) => row.taskId === "t0" ? { ...row, at: "2026-09-27T12:00:00.000Z" } : row)
    .concat({ taskId: "t0", at: "2026-09-27T00:30:00.000Z", assignedArm: SON, servedArm: SON, propensity: 0.5 });
  const flipped = built({}, { ...data, assignments: reassigned }).release;
  assert.equal(flipped.arms[0].assigned, release.arms[0].assigned - 1, "t0's earliest assignment was the other arm");
});

test("W1-T10843: no merge-only release before the site accepts secondaries", () => {
  for (const siteAcceptsSecondary of [undefined, false]) {
    const result = buildControlledFieldTrialsRelease({ ...input(), ...(siteAcceptsSecondary === undefined ? { siteAcceptsSecondary: undefined } : { siteAcceptsSecondary }) });
    assert.equal(result.state, "refused");
    assert.equal((result as { reason: string }).reason, "site-secondary-unavailable");
    assert.equal("release" in result, false, "no merge-only release is emitted");
  }
  assert.equal(buildControlledFieldTrialsRelease(input()).state, "candidate", "the same input releases once the site accepts the keys");
});
