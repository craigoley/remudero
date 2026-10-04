import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { BENCHMARK_AA_RECEIPT_VERSION, BENCHMARK_AA_VERSION } from "../src/lib/benchmark-aa.js";
import { activateBenchmarkPaidPilot, buildPaidPilotReport, paidArmPauseReasons, paidPilotArmAdmission, parsePaidPilotRequest,
  readPaidPilotEvidence } from "../src/lib/benchmark-paid-pilot.js";
import type { Config } from "../src/lib/config.js";
import type { GoldenCorpusItem } from "../src/lib/golden-corpus.js";
import type { PairedReviewCase } from "../src/lib/paired-review-eval.js";
import { reviewerReplayStack, sealedReviewer } from "../src/lib/replay-harness.js";
import { verifyReviewerCaseEvidence } from "../src/lib/review-finding-evidence.js";
import { benchmarkReviewerReplayCommand, HANDLERS } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const idle = { liveness: { state: "up" as const, quiet: true as const },
  headroom: { billingMode: "subscription" as const, session: { percentUsed: 20 }, weekly: [{ label: "all", percentUsed: 20 }] } };

function fixture(t: TestContext, identity = { repo: "fixture/alpha", id: "pair-live", taskId: "T-LIVE" }) {
  const root = mkdtempSync(join(tmpdir(), "rmd-reviewer-live-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = gitRepo({ seedCommit: false, kind: "reviewer-live-source" });
  t.after(() => repository.cleanup());
  const source = repository.dir;
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  const git = repository.git;
  repository.addRemote("origin", `https://github.com/${identity.repo}.git`);
  mkdirSync(join(source, "lib")); writeFileSync(join(source, "lib", "stable.ts"), "export const stable = true;\n");
  git("add", "lib/stable.ts");
  const commit = (text: string) => {
    writeFileSync(join(source, "value.ts"), text);
    git("add", "value.ts"); git("commit", "--quiet", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  const baseSha = commit("export const value = 0;\n");
  const bugHeadSha = commit("export const value = -1;\n");
  git("checkout", "--quiet", "--detach", baseSha);
  const benignHeadSha = commit("export const value = 1;\n");
  const config = { root, claudeBin: "/unused", dailyCapUsd: 10,
    workerProviders: { enabled: ["cash"], cashEndpoint: "https://example.test/", cashWebSearch: true } } as Config;
  const stack = reviewerReplayStack(config);
  const now = new Date().toISOString();
  const context = "Review the change to the value constant.";
  const mechanism = { text: "negative value", path: "value.ts", line: 1, remedy: "use a positive value" };
  const bug = { headSha: bugHeadSha, outcome: "mechanism-failed" };
  const benign = { headSha: benignHeadSha, outcome: "passed" };
  const pair: PairedReviewCase = { id: identity.id, corpusTaskId: identity.taskId, repo: identity.repo, createdAt: now,
    baseSha, taskContextDigest: hash(context), changedFileShapeDigest: hash(git("diff", "--name-status", baseSha, bugHeadSha)),
    issueCategory: "wiring", sealedMechanismDigest: hash(mechanism),
    bug: { headSha: bugHeadSha, label: "faulty", evidence: { kind: "executable-falsifier", observed: true, digest: hash(bug) } },
    benign: { headSha: benignHeadSha, label: "benign", evidence: { kind: "executable-falsifier", observed: true, digest: hash(benign) } } };
  const corpus: GoldenCorpusItem = { taskId: pair.corpusTaskId, baseSha, headSha: bugHeadSha, mergedAt: now,
    creditSource: "ledger", heldOut: true, freshness: { ageDays: 0 },
    spec: { type: "implement", verify: "auto", files: ["value.ts"] },
    proofs: [{ claim: "sealed", proof: "unit test: private falsifier", holdout: true }] };
  const keys = generateKeyPairSync("ed25519");
  const payload = JSON.stringify({ version: "paired-review-case-evidence-v1", pairDigest: hash(pair), corpusDigest: hash(corpus),
    repo: pair.repo, baseSha, bug, benign, context, mechanism, observedAt: now, scorerRevision: stack.scorer });
  const evidence = { keyId: `scorer-${identity.repo.replace("/", "-")}`, payload,
    signature: sign(null, Buffer.from(payload), keys.privateKey).toString("base64") };
  const trustPath = join(root, "trust.json");
  writeFileSync(trustPath, JSON.stringify([{ id: evidence.keyId, role: "scorer", subject: "independent",
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }) }]));
  const casesPath = join(root, "cases.json");
  const entry = { pair, corpus, evidence, sourceDir: source };
  const saveCases = () => writeFileSync(casesPath, JSON.stringify({ version: "paired-review-live-cases-v1", cases: [entry] }));
  saveCases();
  const request = parsePaidPilotRequest({ version: "benchmark-paid-pilot-request-v1", pilotId: "live-fixture",
    approval: { reference: "fixture-consent", approvedAt: now },
    repos: ["fixture/alpha", "fixture/beta", "fixture/gamma"].map((repo) => ({ repo, consentReceipt: `consent:${repo}` })),
    pseudonymSalt: "private-salt", assignmentSeed: "seed-live",
    arms: { paid: { provider: "cash", model: "gpt-6.1-sol", effort: "medium" },
      control: { provider: "subscription", model: "control", effort: "medium" } },
    revisions: { harnessRevision: stack.harness, promptRevision: stack.prompt, toolRevision: stack.tool,
      scorerRevision: stack.scorer, environmentRevision: stack.environment },
    strataRevision: "strata-live", population: [{ taskId: pair.corpusTaskId, repo: pair.repo, taskClass: "reviewer", risk: "low" }],
    primaryOutcome: "verified-completion", maturityDays: 14, design: "paired", paired: { samplingRate: 1, maxPairs: 1, shadow: true },
    protocolText: "Explicit fixture scope", reviewerReplay: { version: "paid-reviewer-replay-v1", cashReserveUsdPerCall: 2,
      cases: [{ id: pair.id, corpusTaskId: pair.corpusTaskId, repo: pair.repo, baseSha,
        bugHeadSha, benignHeadSha, sealedManifestDigest: hash(pair) }] } });
  assert.ok(request.ok);
  const body = { version: BENCHMARK_AA_VERSION };
  const aaReport = { ...body, receipt: { version: BENCHMARK_AA_RECEIPT_VERSION, state: "observed", asOf: now,
      verdict: "no-integrity-concern-detected", winnerDeclared: false, reportHash: hash(body), trialId: "fixture-aa",
      allocationReceiptHash: hash("allocation"), stackHash: hash("stack") } };
  const activated = activateBenchmarkPaidPilot({ request: request.request, nowIso: now, existing: [], aaReport });
  assert.ok(activated.ok);
  const protocol = activated.protocol;
  const protocolPath = join(stateDir, "benchmark-paid-pilot-v1.live-fixture.protocol.json");
  const activate = () => writeFileSync(protocolPath, JSON.stringify({ protocol, receipt: activated.receipt }));
  writeFileSync(join(stateDir, "ledger.ndjson"), "");
  const args = ["--pilot", protocol.pilotId, "--phase", "aa", "--cases", casesPath, "--trust", trustPath,
    "--state-dir", stateDir, "--confirm-spend"];
  return { root, source, stateDir, config, stack, pair, corpus, entry, saveCases, args, activate, protocol, git, protocolPath,
    keys, payload, trustPath, casesPath, request: request.request, aaReport };
}

test("W1-T4956: operator replay refuses unactivated or unverified cases", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const lines: string[] = [];
  const deps = { config: f.config, readIdle: async () => idle, print: (line: string) => lines.push(line),
    provider: async () => { calls++; throw new Error("must not spend"); } };
  assert.equal(await benchmarkReviewerReplayCommand(f.args, deps), 2);
  assert.match(lines.at(-1)!, /protocol-unreadable/);
  f.activate();
  assert.equal(await benchmarkReviewerReplayCommand(f.args.filter((arg) => arg !== "--confirm-spend"), deps), 2);
  f.entry.pair.benign.headSha = "f".repeat(40); f.saveCases();
  assert.equal(await benchmarkReviewerReplayCommand(f.args, deps), 2);
  assert.equal(calls, 0);
  assert.match(lines.at(-1)!, /case-evidence-unverified/);
});

test("W1-T4956: sealed reviewer materializes exact heads without a writable remote", async (t) => {
  const f = fixture(t);
  const paths: string[] = [];
  const review = sealedReviewer({ config: f.config, sources: new Map([[f.pair.repo, f.source]]), reserveUsd: 2,
    contexts: new Map([[f.pair.taskContextDigest, "Review the change to the value constant."]]),
    provider: async (args, _config, selection) => {
      paths.push(args.cwd);
      assert.equal(existsSync(join(args.cwd, ".git")), false);
      assert.equal(readFileSync(join(args.cwd, "value.ts"), "utf8"), "export const value = -1;\n");
      assert.deepEqual(args.tools, []);
      assert.equal(args.maxTurns, 1);
      assert.ok(!args.prompt.includes("private falsifier"));
      assert.ok(!args.prompt.includes("sealedMechanismDigest"));
      assert.match(args.prompt, new RegExp(f.pair.bug.headSha));
      return { isError: false, apiError: false, text: JSON.stringify({ verdict: "pass", findings: [] }),
        sessionId: "provider-session", servedModel: selection.model, effort: selection.effort,
        workerDurationMs: 5, costUsd: 0.01, tokens: { input: 10, output: 2 } };
    } });
  const output = await review({ opaqueArmId: "opaque", repo: f.pair.repo, baseSha: f.pair.baseSha,
    headSha: f.pair.bug.headSha, taskContextDigest: f.pair.taskContextDigest,
    changedFileShapeDigest: f.pair.changedFileShapeDigest, stack: f.stack, selectionPropensity: 0.5,
    requestedModel: "gpt-6.1-sol", requestedEffort: "medium" });
  assert.equal(output.servedModel, "gpt-6.1-sol");
  assert.deepEqual(output.observedStack, f.stack);
  assert.ok(paths.every((path) => !existsSync(path)));
});

test("W1-T4956: paid provider failure keeps its reserve and normal PR flow continues", async (t) => {
  const f = fixture(t); f.activate();
  let calls = 0;
  const lines: string[] = [];
  const code = await benchmarkReviewerReplayCommand(f.args, { config: f.config, readIdle: async () => idle,
    print: (line) => lines.push(line), provider: async () => { calls++; throw new Error("billed then disconnected"); } });
  assert.equal(code, 1);
  assert.equal(calls, 1);
  const evidence = await readPaidPilotEvidence(f.stateDir, f.protocol);
  const pause = paidArmPauseReasons(f.protocol, evidence, new Date().toISOString());
  assert.equal(pause.spend?.missingReceipts, 1);
  assert.equal(pause.spend?.cashEstimateUsd, 2);
  const report = buildPaidPilotReport({ protocol: f.protocol, evidence, nowIso: new Date().toISOString() });
  assert.equal(report.cash.spentEstimateUsd, null);
  assert.equal(paidPilotArmAdmission({ protocol: f.protocol, lane: "review", taskId: f.pair.corpusTaskId,
    evidence, nowIso: new Date().toISOString() }).ordinaryFlow, "continues");
  assert.ok(lines.some((line) => line.includes("replay-error")));
  assert.ok(!readFileSync(join(f.stateDir, "ledger.ndjson"), "utf8").includes('"step":"review.posted"'));
});

test("the production cash adapter records actual receipts without giving the model tools", async (t) => {
  const f = fixture(t); f.activate();
  const previousKey = process.env.RMD_OPENWEIGHT_API_KEY;
  process.env.RMD_OPENWEIGHT_API_KEY = "fixture-key";
  t.after(() => {
    if (previousKey === undefined) delete process.env.RMD_OPENWEIGHT_API_KEY;
    else process.env.RMD_OPENWEIGHT_API_KEY = previousKey;
  });
  let calls = 0;
  let observedEffort: string | undefined = "medium";
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, "gpt-6.1-sol");
    assert.deepEqual(body.reasoning, { effort: "medium" });
    assert.equal(body.tools, undefined);
    assert.equal(body.store, false);
    const prompt = body.input[1].content as string;
    assert.ok(!prompt.includes("private falsifier"));
    assert.ok(!prompt.includes("independent-scorer"));
    return new Response(JSON.stringify({ id: `served-${calls}`, model: "gpt-6.1-sol", reasoning: { effort: observedEffort }, status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ verdict: "pass", findings: [] }) }] }],
      usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } }));
  });
  assert.equal(await benchmarkReviewerReplayCommand(f.args, { config: f.config, readIdle: async () => idle, print: () => {} }), 0);
  assert.equal(calls, 2);
  const evidence = await readPaidPilotEvidence(f.stateDir, f.protocol);
  assert.equal(paidArmPauseReasons(f.protocol, evidence, new Date().toISOString()).spend?.cashReceipts, 2);
  assert.equal(evidence.rows.filter((row) => row.step === "reviewer_replay.receipt").every((row) => row.servedModel === "gpt-6.1-sol"), true);
  const receipts = readFileSync(join(f.stateDir, "ledger.ndjson"), "utf8").split("\n").filter(Boolean).map((row) => JSON.parse(row))
    .filter((row) => row.step === "reviewer_replay.receipt");
  assert.deepEqual(receipts.map((row) => row.stack_deviations), [[], []]);
  assert.deepEqual(receipts[0].observed_stack, f.stack);
  assert.equal(await benchmarkReviewerReplayCommand(f.args.map((arg) => arg === "aa" ? "comparison" : arg),
    { config: f.config, readIdle: async () => idle, print: () => {} }), 2);
  assert.equal(calls, 2, "one A/A group cannot authorize comparison");
  observedEffort = undefined;
  assert.equal(await benchmarkReviewerReplayCommand(f.args, { config: f.config, readIdle: async () => idle, print: () => {} }), 1);
  const later = readFileSync(join(f.stateDir, "ledger.ndjson"), "utf8").split("\n").filter(Boolean).map((row) => JSON.parse(row))
    .filter((row) => row.step === "reviewer_replay.receipt").slice(2);
  assert.equal(later.length, 2);
  assert.ok(later.every((row) => row.served_effort === null && row.requested_effort === "medium"));
});

test("a hidden rotation containing a paid receipt refuses the next reviewer call", async (t) => {
  const f = fixture(t); f.activate();
  const write = fs.writeSync;
  let hidden = false;
  t.mock.method(fs, "writeSync", (...args: Parameters<typeof fs.writeSync>) => {
    const result = Reflect.apply(write, fs, args);
    if (String(args[1]).includes('"step":"reviewer_replay.receipt"')) {
      const archive = join(f.stateDir, "ledger.2099-01-01T00-00-00-000Z.ndjson");
      fs.renameSync(join(f.stateDir, "ledger.ndjson"), archive);
      writeFileSync(join(f.stateDir, "ledger.ndjson"), "");
      fs.renameSync(archive, join(f.root, "hidden.ndjson"));
      hidden = true;
    }
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  let calls = 0;
  const lines: string[] = [];
  assert.equal(await benchmarkReviewerReplayCommand(f.args, { config: f.config, readIdle: async () => idle,
    print: (line) => lines.push(line), provider: async (_args, _config, selection) => {
      calls++;
      return { isError: false, apiError: false, text: JSON.stringify({ verdict: "pass", findings: [] }),
        sessionId: "served", servedModel: selection.model, effort: selection.effort, workerDurationMs: 5,
        costUsd: 0.01, tokens: { input: 10, output: 2 } };
    } }), 1);
  assert.equal(hidden, true);
  assert.equal(calls, 1);
  assert.match(lines.at(-1)!, /reviewer-spend-history-disappeared/);
});

test("a writable remote or failed snapshot cleanup is withheld and retains the paid reserve", async (t) => {
  for (const failure of ["remote", "cleanup"]) {
    const f = fixture(t); f.activate();
    let calls = 0;
    const lines: string[] = [];
    const remove = fs.rmSync;
    assert.equal(await benchmarkReviewerReplayCommand(f.args, { config: f.config, readIdle: async () => idle,
      print: (line) => lines.push(line), provider: async (args, _config, selection) => {
        calls++;
        if (failure === "remote") {
          chmodSync(args.cwd, 0o755);
          mkdirSync(join(args.cwd, ".git"));
          writeFileSync(join(args.cwd, ".git", "config"), "[remote origin]\nurl = https://github.com/fixture/alpha.git\n");
        } else t.mock.method(fs, "rmSync", (path: fs.PathLike, options?: fs.RmDirOptions) => {
          if (String(path).includes("rmd-paid-reviewer-")) throw new Error("cleanup unavailable");
          remove(path, options);
        });
        return { isError: false, apiError: false, text: JSON.stringify({ verdict: "pass", findings: [] }),
          sessionId: "served", servedModel: selection.model, effort: selection.effort, workerDurationMs: 5,
          costUsd: 0.01, tokens: { input: 10, output: 2 } };
      } }), 1);
    t.mock.restoreAll();
    assert.equal(calls, 1);
    assert.match(lines.at(-1)!, /replay-error/);
    assert.equal((await readPaidPilotEvidence(f.stateDir, f.protocol)).rows.some((row) => row.step === "reviewer_replay.receipt"), false);
  }
});

test("the live command withholds unknown verdicts and unsigned evidence", async (t) => {
  const f = fixture(t); f.activate();
  const lines: string[] = [];
  let calls = 0;
  const provider = async (_args: unknown, _config: unknown, selection: { model: string; effort: string }) => {
    calls++;
    return { isError: false, apiError: false, text: JSON.stringify({ verdict: "unknown", findings: [] }),
      sessionId: "served", servedModel: selection.model, effort: selection.effort, workerDurationMs: 5,
      costUsd: 0.01, tokens: { input: 10, output: 2 } };
  };
  assert.equal(await benchmarkReviewerReplayCommand(f.args, { config: f.config, readIdle: async () => idle,
    print: (line) => lines.push(line), provider }), 1);
  assert.match(lines.at(-1)!, /verdict-unknown/);
  assert.match(lines.at(-1)!, /"gradedPairs":0/);
  const unknown = JSON.parse(lines.at(-1)!).report.pairs[0];
  assert.equal(unknown.bugDetected, null);
  assert.equal(unknown.benignSpecific, null);
  assert.equal(unknown.diagnosisCredit, null);
  assert.equal(calls, 2);
  f.entry.evidence.signature = "A".repeat(86) + "=="; f.saveCases();
  assert.equal(await benchmarkReviewerReplayCommand(f.args, { config: f.config, readIdle: async () => idle,
    print: (line) => lines.push(line), provider }), 2);
  assert.equal(calls, 2);
});

test("scorer authentication distinguishes invalid, untrusted and unreadable evidence", (t) => {
  const f = fixture(t);
  const keys = JSON.parse(readFileSync(f.trustPath, "utf8"));
  const verify = (raw: unknown, trust: unknown = keys) => verifyReviewerCaseEvidence(f.pair, f.corpus, raw, trust,
    f.stack.scorer, new Date().toISOString());
  assert.equal(verify(f.entry.evidence).ok, true);
  assert.deepEqual(verify({}), { ok: false, reason: "case-evidence-or-trust-invalid" });
  assert.deepEqual(verify(f.entry.evidence, []), { ok: false, reason: "case-evidence-scorer-untrusted" });
  assert.deepEqual(verify(f.entry.evidence, [{ ...keys[0], role: "operator" }]),
    { ok: false, reason: "case-evidence-scorer-untrusted" });
  const unreadableKey = verify(f.entry.evidence, [{ ...keys[0], publicKey: "invalid public key" }]);
  assert.equal(unreadableKey.ok, false);
  if (!unreadableKey.ok) assert.match(unreadableKey.reason, /^case-evidence-verification-failed:/);
  const signPayload = (payload: string) => ({ ...f.entry.evidence, payload,
    signature: sign(null, Buffer.from(payload), f.keys.privateKey).toString("base64") });
  assert.deepEqual(verify(signPayload("{}")), { ok: false, reason: "case-evidence-payload-invalid" });
  assert.deepEqual(verify(signPayload("not-json")), { ok: false, reason: "case-evidence-verification-failed:malformed-json" });
  const wrongHead = JSON.parse(f.payload);
  wrongHead.benign.headSha = "f".repeat(40);
  assert.deepEqual(verify(signPayload(JSON.stringify(wrongHead))), { ok: false, reason: "case-evidence-source-binding-invalid" });
});

test("operator preparation rejects unknown source identity, incomplete population and busy fleet before spending", async (t) => {
  const f = fixture(t); f.activate();
  let calls = 0;
  const lines: string[] = [];
  const deps = { config: f.config, readIdle: async () => idle, print: (line: string) => lines.push(line),
    provider: async () => { calls++; throw new Error("must not spend"); } };
  assert.equal(await benchmarkReviewerReplayCommand(["--confirm-spend", "--pilot", "bad/identity"], deps), 2);
  assert.match(lines.at(-1)!, /arguments-invalid/);
  writeFileSync(f.casesPath, JSON.stringify({ version: "paired-review-live-cases-v1", cases: [] }));
  assert.equal(await benchmarkReviewerReplayCommand(f.args, deps), 2);
  assert.match(lines.at(-1)!, /case-population-mismatch/);
  f.saveCases();
  f.git("remote", "set-url", "origin", "https://github.com/fixture/wrong.git");
  assert.equal(await benchmarkReviewerReplayCommand(f.args, deps), 2);
  assert.match(lines.at(-1)!, /source-repo-mismatch/);
  f.git("remote", "set-url", "origin", "https://github.com/fixture/alpha.git");
  assert.equal(await benchmarkReviewerReplayCommand(f.args, { ...deps,
    readIdle: async () => ({ ...idle, liveness: { state: "down" } }) }), 2);
  assert.match(lines.at(-1)!, /not in quiet mode/);
  assert.equal(calls, 0);
  assert.equal(await benchmarkReviewerReplayCommand(["--describe-stack"], deps), 0);
  assert.deepEqual(JSON.parse(lines.at(-1)!), f.stack);
});

test("the default operator idle reader observes the real ledger and measured usage", async (t) => {
  const f = fixture(t); f.activate();
  const lines: string[] = [];
  let measured = 0;
  let calls = 0;
  const deps = { config: f.config, print: (line: string) => lines.push(line),
    usageDeps: { viaSdk: async () => { measured++; return idle.headroom; } },
    provider: async () => { calls++; throw new Error("provider failure"); } };
  assert.equal(await benchmarkReviewerReplayCommand(f.args, deps), 2);
  assert.match(lines.at(-1)!, /not in quiet mode/);
  writeFileSync(join(f.stateDir, "ledger.ndjson"), JSON.stringify({ ts: new Date().toISOString(),
    step: "daemon.idle_starved.pulse", instance: "operator-reviewer" }) + "\n");
  assert.equal(await benchmarkReviewerReplayCommand(f.args, deps), 1);
  assert.equal(calls, 1);
  assert.equal(measured, 2);
});

test("the sealed runner rejects unsupported effort, changed stack, oversized and symlinked snapshots", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const settings = { config: f.config, sources: new Map([[f.pair.repo, f.source]]), reserveUsd: 2,
    contexts: new Map([[f.pair.taskContextDigest, "Review the change to the value constant."]]),
    provider: async () => { calls++; throw new Error("must not spend"); } };
  const arm = { opaqueArmId: "opaque", repo: f.pair.repo, baseSha: f.pair.baseSha, headSha: f.pair.bug.headSha,
    taskContextDigest: f.pair.taskContextDigest, changedFileShapeDigest: f.pair.changedFileShapeDigest,
    stack: f.stack, selectionPropensity: 0.5 as const, requestedModel: "gpt-6.1-sol", requestedEffort: "medium" };
  await assert.rejects(sealedReviewer(settings)({ ...arm, requestedEffort: "unknown" }), /effort-unsupported/);
  await assert.rejects(sealedReviewer(settings)({ ...arm, stack: { ...arm.stack, tool: "a".repeat(64) } }), /stack-deviation/);
  await assert.rejects(sealedReviewer({ ...settings, contexts: new Map() })(arm), /source-or-context-missing/);
  await assert.rejects(sealedReviewer({ ...settings, reserveUsd: 0.00001 })(arm), /call-exceeds-reserve/);
  symlinkSync("/etc/passwd", join(f.source, "link"));
  f.git("add", "link"); f.git("commit", "--quiet", "-m", "symlink fixture");
  await assert.rejects(sealedReviewer(settings)({ ...arm, headSha: f.git("rev-parse", "HEAD") }), /link-or-submodule/);
  f.git("reset", "--hard", arm.headSha);
  writeFileSync(join(f.source, "value.ts"), "a".repeat(512 * 1024));
  f.git("add", "value.ts"); f.git("commit", "--quiet", "-m", "oversize fixture");
  await assert.rejects(sealedReviewer(settings)({ ...arm, headSha: f.git("rev-parse", "HEAD") }), /unrepresentable/);
  assert.equal(calls, 0);
});

test("worker reentry cannot activate an operator reviewer call", async (t) => {
  const previous = process.env.REMUDERO_WORKER_SCOPE;
  process.env.REMUDERO_WORKER_SCOPE = "fixture-worker";
  t.after(() => {
    if (previous === undefined) delete process.env.REMUDERO_WORKER_SCOPE;
    else process.env.REMUDERO_WORKER_SCOPE = previous;
  });
  const lines: string[] = [];
  assert.equal(await benchmarkReviewerReplayCommand(["--confirm-spend"], { print: (line) => lines.push(line) }), 2);
  assert.match(lines.at(-1)!, /operator-command-required/);
});

test("a clean live A/A receipt admits private descriptive comparison on fresh isolated arms", async (t) => {
  const ids: string[] = [];
  for (let i = 0; ids.filter(Boolean).length < 2; i++) {
    const id = `live-aa-${i}`;
    ids[parseInt(hash(`seed-live:${id}`).slice(0, 2), 16) % 2] = id;
  }
  const f = fixture(t, { repo: "fixture/alpha", id: ids[0]!, taskId: "T-ALPHA" });
  const second = fixture(t, { repo: "fixture/beta", id: ids[1]!, taskId: "T-BETA" });
  const activation = activateBenchmarkPaidPilot({ nowIso: new Date().toISOString(), existing: [], aaReport: f.aaReport,
    request: { ...f.request, population: [...f.request.population, ...second.request.population],
      paired: { ...f.request.paired!, maxPairs: 2 }, reviewerReplay: { ...f.request.reviewerReplay!,
        cases: [...f.request.reviewerReplay!.cases, ...second.request.reviewerReplay!.cases] } } });
  assert.ok(activation.ok);
  writeFileSync(f.protocolPath, JSON.stringify({ protocol: activation.protocol, receipt: activation.receipt }));
  writeFileSync(f.casesPath, JSON.stringify({ version: "paired-review-live-cases-v1", cases: [f.entry, second.entry] }));
  writeFileSync(f.trustPath, JSON.stringify([...JSON.parse(readFileSync(f.trustPath, "utf8")),
    ...JSON.parse(readFileSync(second.trustPath, "utf8"))]));
  const paths: string[] = [];
  const lines: string[] = [];
  const deps = { config: f.config, readIdle: async () => idle, print: (line: string) => lines.push(line),
    provider: async (args: { cwd: string; prompt: string },
      _config: Config, selection: { model: string; effort: string }) => {
      paths.push(args.cwd);
      assert.equal(existsSync(join(args.cwd, ".git")), false);
      assert.equal(args.prompt.includes("private falsifier"), false);
      const faulty = args.prompt.includes("value = -1");
      return { isError: false, apiError: false, text: JSON.stringify({ verdict: faulty ? "fail" : "pass",
        findings: faulty ? [{ id: "finding", path: "value.ts", line: 1, mechanism: "negative value", remedy: "use a positive value" }] : [] }),
        sessionId: `served-${paths.length}`, servedModel: selection.model, effort: selection.effort,
        workerDurationMs: 5, costUsd: 0.01, tokens: { input: 10, output: 2 } };
    } };
  const comparison = f.args.map((arg) => arg === "aa" ? "comparison" : arg);
  assert.equal(await benchmarkReviewerReplayCommand(comparison, deps), 2);
  assert.equal(paths.length, 0);
  assert.equal(await benchmarkReviewerReplayCommand(f.args, deps), 0);
  assert.equal(JSON.parse(lines.at(-1)!).aaVerdict, "no-integrity-concern-detected");
  assert.equal(await benchmarkReviewerReplayCommand(comparison, deps), 0);
  const result = JSON.parse(lines.at(-1)!);
  assert.equal(result.report.byModel[0].model, "gpt-6.1-sol");
  assert.equal(result.report.byModel[0].diagnosisCredit, 2);
  assert.equal(result.report.winnerClaim, "unsupported");
  assert.equal(new Set(paths).size, 8);
  assert.ok(paths.every((path) => !existsSync(path)));
});

test("the registered operator subcommand refuses before reading host config without explicit spend consent", async (t) => {
  assert.equal(await HANDLERS.get("benchmark-paid-pilot")!(["replay"]), 2);
  const f = fixture(t);
  assert.equal(await HANDLERS.get("benchmark-paid-pilot")!(["report", "--pilot", "missing-fixture", "--state-dir", f.stateDir]), 2);
});
