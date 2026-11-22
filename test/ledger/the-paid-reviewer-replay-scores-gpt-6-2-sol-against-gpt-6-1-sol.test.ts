import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";
import { activateBenchmarkPaidPilot, parsePaidPilotRequest } from "#src/lib/benchmark-paid-pilot.js";
import { CASH_RESPONSES_DEPLOYMENTS } from "#src/lib/cash-responses.js";
import type { Config } from "#src/lib/config.js";
import { appendLedger } from "#src/lib/ledger.js";
import { ledgerLivePath, readLedgerUnionRecordsSync } from "#src/lib/ledger-union.js";
import type { PairedReviewCase } from "#src/lib/paired-review-eval.js";
import { pairedReviewerReplayCommand, replayPairedReviews, reviewerReplayStack, sealedReviewer } from "#src/lib/replay-harness.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const older = "gpt-6.1-sol";
const newer = "gpt-6.2-sol";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const idle = { liveness: { state: "up" as const, quiet: true as const },
  headroom: { billingMode: "subscription" as const, session: { percentUsed: 20 }, weekly: [{ label: "all", percentUsed: 20 }] } };

function fixture(t: TestContext) {
  const { dir: root } = ownedFixtureDir(t, "reviewer-model-comparison");
  const config = { root, claudeBin: "/unused", dailyCapUsd: 100,
    workerProviders: { enabled: ["cash"], cashEndpoint: "https://default.example.test/",
    cashDeploymentEndpoints: { [older]: { endpoint: "https://older.example.test/", keyEnv: "RMD_CASH_OLDER_API_KEY" },
      [newer]: { endpoint: "https://newer.example.test/", keyEnv: "RMD_CASH_NEWER_API_KEY" } } } } as Config;
  const context = "Review the change to the value.";
  const mechanism = { text: "negative value", path: "value.ts", line: 1, remedy: "use a positive value" };
  const now = new Date().toISOString();
  const repos = ["fixture/alpha", "fixture/beta", "fixture/gamma"];
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const trustPath = join(root, "trust.json");
  writeFileSync(trustPath, JSON.stringify([{ id: "scorer", role: "scorer", subject: "independent",
    publicKey: publicKey.export({ type: "spki", format: "pem" }) }]));
  const cases = repos.map((repo, index) => {
    const source = gitRepo({ scope: t });
    source.addRemote("origin", `https://github.com/${repo}.git`);
    const commit = (value: number) => {
      writeFileSync(join(source.dir, "value.ts"), `export const value = ${value};\n`);
      source.git("add", "value.ts"); source.git("commit", "-qm", "fixture");
      return source.git("rev-parse", "HEAD");
    };
    const baseSha = commit(index);
    const bug = { headSha: commit(-1), outcome: "mechanism-failed" };
    source.git("checkout", "-q", "--detach", baseSha);
    const benign = { headSha: commit(10), outcome: "passed" };
    const pair: PairedReviewCase = { id: `pair-${index}`, corpusTaskId: `T-PAIR-${index}`, repo, baseSha, createdAt: now,
      taskContextDigest: hash(context), changedFileShapeDigest: hash(source.git("diff", "--name-status", baseSha, bug.headSha)),
      issueCategory: index === 0 ? "wiring" : "logic", sealedMechanismDigest: hash(mechanism),
      bug: { headSha: bug.headSha, label: "faulty", evidence: { kind: "executable-falsifier", observed: true, digest: hash(bug) } },
      benign: { headSha: benign.headSha, label: "benign", evidence: { kind: "executable-falsifier", observed: true, digest: hash(benign) } } };
    const corpus = { taskId: pair.corpusTaskId, baseSha, headSha: bug.headSha, mergedAt: now, creditSource: "ledger", heldOut: true,
      freshness: { ageDays: 0 }, spec: { type: "implement", verify: "auto", files: ["value.ts"] },
      proofs: [{ claim: "sealed", proof: "unit test: private", holdout: true }] };
    const payload = JSON.stringify({ version: "paired-review-case-evidence-v1", pairDigest: hash(pair), corpusDigest: hash(corpus),
      repo, baseSha, bug, benign, context, mechanism, observedAt: now, scorerRevision: reviewerReplayStack(config).scorer });
    return { pair, corpus, sourceDir: source.dir, evidence: { keyId: "scorer", payload,
      signature: sign(null, Buffer.from(payload), privateKey).toString("base64") } };
  });
  const casesPath = join(root, "cases.json");
  writeFileSync(casesPath, JSON.stringify({ version: "paired-review-live-cases-v1", cases }));
  const activate = (model: string, stack = reviewerReplayStack(config, model)) => {
    const stateDir = join(root, model);
    mkdirSync(stateDir);
    const request = parsePaidPilotRequest({ version: "benchmark-paid-pilot-request-v1", pilotId: model,
      approval: { reference: "fixture-consent", approvedAt: now }, repos: repos.map((repo) => ({ repo, consentReceipt: repo })),
      pseudonymSalt: "fixture-salt", assignmentSeed: "seed-0",
      arms: { paid: { provider: "cash", model, effort: "medium" }, control: { provider: "subscription", model: "control", effort: "medium" } },
      revisions: { harnessRevision: stack.harness, promptRevision: stack.prompt, toolRevision: stack.tool,
        scorerRevision: stack.scorer, environmentRevision: stack.environment },
      strataRevision: "strata", population: cases.map(({ pair }) => ({ taskId: pair.corpusTaskId, repo: pair.repo, taskClass: "reviewer", risk: "low" })),
      primaryOutcome: "verified-completion", maturityDays: 14, design: "paired", paired: { samplingRate: 1, maxPairs: 3, shadow: true },
      protocolText: "Fixture reviewer scope", reviewerReplay: { version: "paid-reviewer-replay-v1", cashReserveUsdPerCall: 2,
        cases: cases.map(({ pair }) => ({ id: pair.id, corpusTaskId: pair.corpusTaskId, repo: pair.repo, baseSha: pair.baseSha,
          bugHeadSha: pair.bug.headSha, benignHeadSha: pair.benign.headSha, sealedManifestDigest: hash(pair) })) } });
    assert.ok(request.ok);
    const aaBody = { version: "benchmark-aa-v1" };
    const aaReport = { ...aaBody, receipt: { version: "benchmark-aa-receipt-v1", state: "observed", asOf: now,
      verdict: "no-integrity-concern-detected", winnerDeclared: false, reportHash: hash(aaBody), trialId: "fixture-aa",
      allocationReceiptHash: hash("allocation"), stackHash: hash("stack") } };
    const activated = activateBenchmarkPaidPilot({ request: request.request, nowIso: now, aaReport, existing: [] });
    assert.ok(activated.ok);
    const protocolFile = `benchmark-paid-pilot-v1.${model}.protocol.json`;
    writeFileSync(join(stateDir, protocolFile), JSON.stringify({ protocol: activated.protocol, receipt: activated.receipt }));
    writeFileSync(ledgerLivePath(stateDir), "");
    const args = (phase = "aa") => ["--pilot", model, "--phase", phase, "--cases", casesPath, "--trust", trustPath,
      "--state-dir", stateDir, "--confirm-spend"];
    return { stateDir, args, protocolFile, protocol: activated.protocol };
  };
  const printed: string[] = [];
  const command = (args: string[], readIdle = async () => idle) => pairedReviewerReplayCommand(args, replayPairedReviews,
    { config, readIdle, print: (line) => printed.push(line) });
  return { config, cases, context, mechanism, activate, command, printed };
}

function mockCash(t: TestContext, f: ReturnType<typeof fixture>, options: { servedModel?: string; omitUsage?: boolean } = {}) {
  for (const key of ["RMD_CASH_OLDER_API_KEY", "RMD_CASH_NEWER_API_KEY"]) {
    const previous = process.env[key];
    process.env[key] = key;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const calls: { model: string; effort: string }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const { model, reasoning: { effort } } = body;
    const latest = model === newer;
    assert.equal(new URL(url).hostname, latest ? "newer.example.test" : "older.example.test");
    assert.equal(new Headers(init.headers).get("api-key"), latest ? "RMD_CASH_NEWER_API_KEY" : "RMD_CASH_OLDER_API_KEY");
    assert.equal(body.tools, undefined);
    calls.push({ model, effort });
    const { headSha } = JSON.parse(String(body.input[1].content).split("\n").at(-1)!);
    const index = f.cases.findIndex(({ pair }) => pair.bug.headSha === headSha || pair.benign.headSha === headSha);
    assert.ok(index >= 0);
    const bug = f.cases[index]!.pair.bug.headSha === headSha;
    const finding = { id: "finding", path: f.mechanism.path, line: f.mechanism.line,
      mechanism: f.mechanism.text, remedy: f.mechanism.remedy };
    const verdict = bug && (latest || index === 0) ? "fail" : "pass";
    const findings = verdict === "fail" || (!bug && latest && index > 0) ? [finding] : [];
    const usage = options.omitUsage ? undefined
      : { input_tokens: 30 + index, output_tokens: 11 + Number(bug), input_tokens_details: { cached_tokens: 3, cache_write_tokens: 0 } };
    return new Response(JSON.stringify({ id: `served-${calls.length}`, model: options.servedModel ?? model,
      reasoning: { effort }, status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ verdict, findings }) }] }],
      usage }));
  });
  return calls;
}

test("W1-T13448 criterion 1: only pinned Sol models and their own cash efforts reach transport", async (t) => {
  const f = fixture(t);
  const calls = mockCash(t, f);
  const { pair, sourceDir } = f.cases[0]!;
  const review = sealedReviewer({ config: f.config, sources: new Map([[pair.repo, sourceDir]]),
    contexts: new Map([[pair.taskContextDigest, f.context]]), reserveUsd: 2 });
  const attempt = (model: string, effort: string, stack = reviewerReplayStack(f.config, model)) => review({
    opaqueArmId: "opaque", repo: pair.repo, baseSha: pair.baseSha, headSha: pair.bug.headSha,
    taskContextDigest: pair.taskContextDigest, changedFileShapeDigest: pair.changedFileShapeDigest,
    stack, selectionPropensity: 0.5, requestedModel: model, requestedEffort: effort });
  for (const [model, efforts] of [[newer, CASH_RESPONSES_DEPLOYMENTS[newer]!], [older, ["low", "medium", "high", "xhigh", "max"]]] as const) {
    for (const effort of efforts) assert.equal((await attempt(model, effort)).servedModel, model);
  }
  const count = calls.length;
  for (const [model, effort] of [[newer, "ultra"], [older, "ultra"], ["gpt-6.1-terra", "low"]] as const) {
    await assert.rejects(attempt(model, effort, reviewerReplayStack(f.config, older)), /reviewer-provider-or-effort-unsupported/);
  }
  await assert.rejects(attempt(newer, "low", reviewerReplayStack(f.config, older)), /reviewer-stack-deviation/);
  const moved = structuredClone(f.config);
  moved.workerProviders!.cashDeploymentEndpoints![newer]!.endpoint = "https://moved.example.test/";
  assert.notEqual(reviewerReplayStack(moved, newer).environment, reviewerReplayStack(f.config, newer).environment);
  assert.deepEqual(reviewerReplayStack(moved, older), reviewerReplayStack(f.config, older));
  const wrongPin = f.activate(newer, reviewerReplayStack(f.config, older));
  assert.equal(await f.command(wrongPin.args()), 2);
  assert.match(f.printed.at(-1)!, /reviewer-evidence-or-stack-unpinned/);
  assert.equal(await f.command(["--describe-stack", "--model", "gpt-6.1-terra"]), 2);
  assert.match(f.printed.at(-1)!, /reviewer-provider-or-effort-unsupported/);
  assert.equal(calls.length, count);
});

test("a different served model is receipted but receives no grade", async (t) => {
  const f = fixture(t);
  const calls = mockCash(t, f, { servedModel: older });
  const pilot = f.activate(newer);
  assert.equal(await f.command(pilot.args()), 1);
  assert.ok(calls.length > 0);
  const { report } = JSON.parse(f.printed.at(-1)!);
  assert.equal(report.gradedPairs, 0);
  assert.ok(report.pairs.every((pair: { state: string }) => pair.state === "incomplete"));
  const rows = reviewerRows(pilot.stateDir);
  assert.ok(rows.some((row) => row.step === "reviewer_replay.receipt" && row.served_model === older && row.requested_model === newer));
});

test("a 6.2 call without measured usage retains its reserve and leaves the grade incomplete", async (t) => {
  const f = fixture(t);
  const calls = mockCash(t, f, { omitUsage: true });
  const pilot = f.activate(newer);
  assert.equal(await f.command(pilot.args()), 1);
  assert.equal(calls.length, 1);
  const rows = reviewerRows(pilot.stateDir);
  assert.equal(rows.find((row) => row.step === "reviewer_replay.receipt")?.total_cost_usd, null);
  assert.match(f.printed.at(-1)!, /cost-evidence-missing/);
  assert.equal(JSON.parse(f.printed.at(-1)!).report.costMissingArms, 1);
});

function reviewerRows(stateDir: string) {
  return readLedgerUnionRecordsSync(stateDir).rows as {
    step: string; total_cost_usd: number | null; input_tokens: number; output_tokens: number;
    served_model: string; requested_model: string; stack_deviations: string[]; observed_stack: unknown;
    reviewer_replay: { report_file: string; report_digest: string };
  }[];
}

test("W1-T13448 criterion 2: the implicit and explicit 6.1 pins share the existing report and receipts", async (t) => {
  const f = fixture(t);
  mockCash(t, f);
  const implicit = reviewerReplayStack(f.config);
  assert.deepEqual(reviewerReplayStack(f.config, older), implicit);
  assert.equal(await f.command(["--describe-stack"]), 0);
  assert.deepEqual(JSON.parse(f.printed.at(-1)!), implicit);
  assert.equal(await f.command(["--describe-stack", "--model", older]), 0);
  assert.deepEqual(JSON.parse(f.printed.at(-1)!), implicit);
  assert.equal(await f.command(["--describe-stack", "--model", newer]), 0);
  const newerPin = JSON.parse(f.printed.at(-1)!);
  assert.deepEqual(newerPin, reviewerReplayStack(f.config, newer));
  assert.notEqual(newerPin.environment, implicit.environment);
  const pilot = f.activate(older, implicit);
  assert.equal(await f.command(pilot.args("comparison")), 2);
  assert.equal(JSON.parse(f.printed.at(-1)!).reason, "reviewer-aa-missing");
  assert.deepEqual(reviewerRows(pilot.stateDir), []);
  assert.equal(await f.command(pilot.args()), 0);
  const result = JSON.parse(f.printed.at(-1)!);
  const rows = reviewerRows(pilot.stateDir);
  assert.deepEqual(rows.map((row) => row.step), [...Array.from({ length: 6 }, () =>
    ["reviewer_replay.reserve", "reviewer_replay.receipt"]).flat(), "reviewer_replay.result"]);
  for (const row of rows.filter((row) => row.step === "reviewer_replay.receipt")) {
    assert.equal(row.requested_model, older);
    assert.equal(row.served_model, older);
    assert.deepEqual(row.stack_deviations, []);
    assert.deepEqual(row.observed_stack, implicit);
  }
  const evidence = rows.at(-1)!.reviewer_replay;
  assert.equal(evidence.report_digest, hash(result.report));
  assert.deepEqual(JSON.parse(readFileSync(join(pilot.stateDir, evidence.report_file), "utf8")),
    { version: "paid-reviewer-report-v1", phase: "aa", protocolDigest: pilot.protocol.digest, report: result.report });
});

test("W1-T13448 criterion 3: compare shared graded cases and the cost recorded by the cash receipts", async (t) => {
  const f = fixture(t);
  const calls = mockCash(t, f);
  const a = f.activate(older);
  const b = f.activate(newer);
  const reports = [];
  for (const pilot of [a, b]) {
    assert.equal(await f.command(pilot.args()), 0, f.printed.at(-1));
    assert.equal(await f.command(pilot.args("comparison")), 0, f.printed.at(-1));
    const rows = reviewerRows(pilot.stateDir).slice(-13);
    const receipts = rows.filter((row) => row.step === "reviewer_replay.receipt");
    assert.equal(receipts.length, 6);
    assert.ok(receipts.every((row) => row.input_tokens >= 30 && row.output_tokens >= 11
      && row.total_cost_usd !== null && row.total_cost_usd > 0 && row.total_cost_usd < 0.001));
    reports.push({ path: rows.at(-1)!.reviewer_replay.report_file,
      cost: receipts.reduce((cost, row) => cost + row.total_cost_usd!, 0) });
  }
  const [first, second] = reports;
  assert.ok(first && second);
  copyFileSync(join(b.stateDir, b.protocolFile), join(a.stateDir, b.protocolFile));
  const secondName = "sol-candidate.json";
  const secondFile = join(a.stateDir, secondName);
  copyFileSync(join(b.stateDir, second.path), secondFile);
  const args = ["--compare", first.path, "--with", secondFile, "--state-dir", a.stateDir];
  const noIdleRead = async (): Promise<never> => { throw new Error("comparison requested idle state"); };
  const count = calls.length;
  appendLedger(ledgerLivePath(a.stateDir), { step: "test.fixture", run_id: "unrelated", task_id: "unrelated" });
  const ledger = reviewerRows(a.stateDir);
  assert.equal(await f.command(args, noIdleRead), 0);
  const { file } = JSON.parse(f.printed.at(-1)!);
  assert.match(basename(file), /^benchmark-paid-pilot-v1\.gpt-6\.1-sol\.vs\.gpt-6\.2-sol\.reviewer-comparison\.\d+\.json$/);
  assert.equal(statSync(join(a.stateDir, basename(file))).mode & 0o777, 0o600);
  const comparison = JSON.parse(readFileSync(join(a.stateDir, basename(file)), "utf8"));
  assert.deepEqual(comparison.byModel.map(({ cashCostUsd, cashCostPerDetectedDefectUsd, ...counts }: Record<string, number>) => counts),
    [{ model: older, gradedPairs: 3, defectsDetected: 1, benignFalseComments: 0 },
      { model: newer, gradedPairs: 3, defectsDetected: 3, benignFalseComments: 2 }]);
  for (const [index, model] of comparison.byModel.entries()) {
    assert.ok(Math.abs(model.cashCostUsd - reports[index]!.cost) < 1e-12);
    assert.equal(model.cashCostPerDetectedDefectUsd, model.cashCostUsd / model.defectsDetected);
  }
  assert.deepEqual(comparison.paired, { sharedCases: 3, aOnly: 0, bOnly: 2, difference: -2 / 3, exactMcNemarPValue: 0.5 });

  const original = JSON.parse(readFileSync(secondFile, "utf8"));
  const files = readdirSync(a.stateDir);
  for (const [reason, edit] of [
    ["incomplete", (data: typeof original) => { data.report.pairs.pop(); }],
    ["incomplete", (data: typeof original) => { data.report.pairs[0].state = "ungradable"; }],
    ["cost-missing", (data: typeof original) => { data.report.pairs[0].cashCostUsd = null; }],
    ["cost-mismatch", (data: typeof original) => { data.report.cashCostUsd += 1; }],
    ["model-mismatch", (data: typeof original) => { data.report.pairs[0].models.bug = older; }],
    ["protocol-mismatch", (data: typeof original) => { data.protocolDigest = "f".repeat(64); }],
    ["report-invalid", (data: typeof original) => { data.version = "unknown"; }],
    ["scope-mismatch", (data: typeof original) => { data.report.pairs[0].sealedManifestDigest = "f".repeat(64); }],
  ] as const) {
    const data = structuredClone(original);
    edit(data);
    writeFileSync(secondFile, JSON.stringify(data));
    assert.equal(await f.command(args, noIdleRead), 2);
    assert.equal(JSON.parse(f.printed.at(-1)!).reason, `reviewer-comparison-${reason}:${secondName}`);
    assert.deepEqual(readdirSync(a.stateDir), files);
  }
  writeFileSync(secondFile, "{");
  assert.equal(await f.command(args, noIdleRead), 2);
  assert.equal(JSON.parse(f.printed.at(-1)!).reason, `reviewer-comparison-report-unreadable:${secondName}`);
  assert.equal(await f.command(["--compare", first.path, "--state-dir", a.stateDir], noIdleRead), 2);
  assert.equal(JSON.parse(f.printed.at(-1)!).reason, "reviewer-comparison-arguments-invalid");
  const protocolFile = join(a.stateDir, b.protocolFile);
  const otherScope = JSON.parse(readFileSync(protocolFile, "utf8"));
  const changed = structuredClone(original);
  otherScope.protocol.reviewerReplay.cases[0].sealedManifestDigest = "f".repeat(64);
  const { digest: _oldDigest, ...body } = otherScope.protocol;
  otherScope.protocol.digest = hash(body);
  changed.protocolDigest = otherScope.protocol.digest;
  changed.report.pairs[0].sealedManifestDigest = "f".repeat(64);
  writeFileSync(protocolFile, JSON.stringify(otherScope));
  writeFileSync(secondFile, JSON.stringify(changed));
  assert.equal(await f.command(args, noIdleRead), 2);
  assert.equal(JSON.parse(f.printed.at(-1)!).reason, `reviewer-comparison-scope-mismatch:${secondName}`);
  assert.equal(await f.command(["--compare", first.path, "--with", first.path, "--state-dir", a.stateDir], noIdleRead), 2);
  assert.equal(JSON.parse(f.printed.at(-1)!).reason, `reviewer-comparison-same-model:${first.path}`);
  assert.deepEqual(readdirSync(a.stateDir), files);
  assert.deepEqual(reviewerRows(a.stateDir), ledger);
  assert.equal(calls.length, count);
});
