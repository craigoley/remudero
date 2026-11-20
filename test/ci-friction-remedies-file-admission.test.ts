/**
 * Machine-filing admission (W1-T3843) runs on every filing PR's `rmd lint-plan --base`. Until
 * 2026-10-02 the only ci-friction shape it admitted was one docs file nothing reads, so every remedy
 * the gardener filed was built as a paragraph (#8302 #8476 #8507 #8514 #8544 #8546). A remedy now
 * names the code that owns its cause and the regression test its build writes — a path that cannot
 * exist yet — and admission must take it as a parked proposal, as it does the legacy shape.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CI_FRICTION_REMEDIES_FILE, ciFrictionRemedyTestTitle, ciFrictionShardStem, ciFrictionShardYaml } from "#src/lib/ci-friction-gardener.js";
import { lintTask, sizingViolation } from "#src/lib/task-linter.js";
import { loadPlanFromYaml, machineFilingAdmissionViolations, newTestPath, resolveNewPathApprovalFacts, taskIntentDigest, type NewPathApprovalFacts, type Task } from "#src/lib/plan.js";
import { machineShardFilingRefusal, machineShardLandingRefusal } from "#src/lib/machine-filing.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { createConfirmNonceStore, createService, makeConfirmNonceRoute, operatorSessionIdentityProvider, type OperatorJwk } from "#src/lib/service.js";
import { makeNewPathApprovalIssuerRoutes } from "#src/lib/serve.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function admit(yaml: string, pathExists = (p: string) => existsSync(join(REPO_ROOT, p))): string[] {
  const plan = loadPlanFromYaml(yaml, "ci-friction-fixture");
  return machineFilingAdmissionViolations(plan.tasks[0]!, { plan, releasedIds: new Set(), pathExists });
}

test("a ci-friction remedy naming its owning code and a new regression test is admitted as a parked proposal", () => {
  const yaml = ciFrictionShardYaml(
    { price: { cause: { kind: "check", name: "fixture-never-built" }, minutes: 12, rounds: 3, prs: 2 }, rung: 1, owner: { files: ["src/run-task.ts"], why: [] }, rounds: [] },
    "W1-T99999",
  );
  const files = loadPlanFromYaml(yaml, "x").tasks[0]!.files;
  assert.deepEqual(files, ["src/run-task.ts", newTestPath("check-fixture-never-built", ["src/run-task.ts"], "ci-friction-gardener")]);
  assert.equal(existsSync(join(REPO_ROOT, files[1]!)), false, "the regression test does not exist before the build writes it");
  assert.deepEqual(admit(yaml), []);
});

test("an invented source path is still refused, and a remedy with no owning code is not a parked shape", () => {
  const invented = ciFrictionShardYaml(
    { price: { cause: { kind: "check", name: "x" }, minutes: 1, rounds: 1, prs: 1 }, rung: 1, owner: { files: ["src/lib/no-such-module.ts"], why: [] }, rounds: [] },
    "W1-T99998",
  );
  assert.match(admit(invented).join("; "), /exist in neither the checkout nor the base tree: src\/lib\/no-such-module\.ts$/);
  const testOnly = invented.replace("    - src/lib/no-such-module.ts\n", "");
  const reasons = admit(testOnly).join("; ");
  assert.match(reasons, /verify:human — not auto-runnable/);
  assert.match(reasons, /exist in neither the checkout nor the base tree: test\/[\w-]+\/check-x\.test\.ts/);
});

test("the legacy docs-only ci-friction shard still files, so existing records keep admitting", () => {
  const legacy = [
    "- id: W1-T99996", '  title: "legacy"', "  repo: remudero", "  depends_on: []", "  type: implement", "  verify: human", "  risk: low",
    "  status: queued", "  attempts: 0", "  author_class: machine", '  origin: "ci-friction:check:reviewer-unmet"', "  files:", `    - ${CI_FRICTION_REMEDIES_FILE}`,
    "  acceptance:", '    - claim: "c"', `      proof: "grep: ci-friction:check:reviewer-unmet in ${CI_FRICTION_REMEDIES_FILE}"`, "",
  ].join("\n");
  assert.deepEqual(admit(legacy), []);
});

test("a drafted remedy passes the base linter's sizing and admission checks with an executable proof its build must pass", () => {
  const key = "check:ci-log:coverage-ratchet";
  const yaml = ciFrictionShardYaml(
    { price: { cause: { kind: "check", name: "ci-log:coverage-ratchet" }, minutes: 1441, rounds: 457, prs: 291 }, rung: 1, owner: { files: ["src/lib/ci-parity.ts", "src/run-task.ts"], why: ["a", "b"] }, rounds: [] },
    "W1-T99995",
  );
  const plan = loadPlanFromYaml(yaml, "x");
  const task = plan.tasks[0]!;
  const stem = ciFrictionShardStem(key);
  const testPath = newTestPath(stem, ["src/lib/ci-parity.ts"], "ci-friction-gardener");
  assert.deepEqual(task.files, ["src/lib/ci-parity.ts", testPath], "one owner file plus a test named for the shard, in its computed folder");
  assert.equal(sizingViolation(task, { duplicateSlug: stem }), undefined, "the test is the shard's own falsifier, so the span is one concern");
  const proof = task.acceptance?.[0]?.proof ?? "";
  assert.equal(proof, `unit test: ${ciFrictionRemedyTestTitle("W1-T99995", key)}`);
  assert.equal(proof.split(" in ").length, 1, "the executable title has no grep path delimiter");
  assert.equal(ciFrictionRemedyTestTitle("W1-T1", "check:pass in ci"), "W1-T1: check:pass within ci is prevented, not retried");
  const lint = lintTask(task, { duplicateSlug: stem, machineFilingAdmission: { plan, releasedIds: new Set(), pathExists: (p) => existsSync(join(REPO_ROOT, p)) } });
  assert.deepEqual(lint.violations.filter((v) => v.severity === "block"), []);
});

test("a long measured cause gets an executable proof admitted by the unchanged plan policy", () => {
  const name = "ci-log:coverage-ratchet:diff-coverage-blocked-this-diff-adds-source-line-s-with-zero";
  const key = `check:${name}`;
  const yaml = ciFrictionShardYaml({ price: { cause: { kind: "check", name }, minutes: 1441, rounds: 457, prs: 291 },
    rung: 1, owner: { files: ["src/lib/ci-parity.ts"], why: ["real diff-coverage refusal"] }, rounds: [] }, "W1-T99990");
  const plan = loadPlanFromYaml(yaml, "long measured cause");
  const task = plan.tasks[0]!;
  const verdict = lintTask(task, { duplicateSlug: ciFrictionShardStem(key),
    machineFilingAdmission: { plan, releasedIds: new Set(), pathExists: p => existsSync(join(REPO_ROOT, p)) } });
  assert.deepEqual(verdict.violations.filter(v => v.severity === "block"), [], "the actual rendered task must file");
  assert.equal(task.acceptance![0]!.proof, `unit test: ${ciFrictionRemedyTestTitle(task.id, key)}`);
  assert.ok(task.origin?.includes(key), "the full measured cause is retained in provenance");
  assert.ok(JSON.stringify(task.rationale).includes(key), "compacting a test title does not discard diagnosis");
});


test("a census remedy proves its diagnosed mechanism while retaining healthy refusals and measured costs", () => {
  const owner = "src/lib/ci-friction-remedy.ts";
  const cause = { kind: "fix_refusal" as const, name: "census-precheck" };
  const key = "fix_refusal:census-precheck";
  const price = { cause, minutes: 6, rounds: 2, prs: 2 };
  const details = ["census-precheck: this branch grows 1 census count(s) CI will refuse: fixture-copy: real branch finding",
    "census-precheck: census snapshot reader crashed"];
  const rounds = details.map((detail, index) => ({ pr: 13000 + index, causeKey: key, minutes: 3,
    at: "2026-10-26T12:00:00Z", detail }));
  const retained = JSON.stringify({ price, rounds });
  const yaml = ciFrictionShardYaml({ price, rung: 1, owner: { files: [owner], why: ["concrete runner signature"] }, rounds }, "W1-T99989");
  const task = loadPlanFromYaml(yaml, "census mechanism contract").tasks[0]!;
  assert.equal(task.acceptance![0]!.claim, `the diagnosed census runner failure owned by ${owner} is prevented or self-healed while healthy branch findings still refuse publication`);
  assert.equal(task.acceptance![0]!.proof, "unit test: W1-T99989: the diagnosed census runner failure is prevented while healthy findings remain refused");
  assert.match(task.note!, /execute the diagnosed failure through the real owner path/);
  assert.match(task.note!, /retain a control that a healthy branch finding is still refused/);
  assert.match(task.note!, /class-wide cost observations and after-window measurement remain unchanged/);
  assert.ok(details.every(detail => task.rationale!.includes(detail)));
  assert.equal(JSON.stringify({ price, rounds }), retained);
  assert.equal(task.verify, "human");
  assert.ok(task.origin!.includes(key));
  const plan = loadPlanFromYaml(yaml, "census mechanism admission");
  assert.deepEqual(lintTask(task, { duplicateSlug: ciFrictionShardStem(key), machineFilingAdmission: { plan, releasedIds: new Set(), pathExists: p => existsSync(join(REPO_ROOT, p)) } }).violations.filter(v => v.severity === "block"), []);
  for (const name of ["other-refusal", "census-precheck-other"]) {
    const other = loadPlanFromYaml(ciFrictionShardYaml({ price: { ...price, cause: { ...cause, name } }, rung: 1,
      owner: { files: [owner], why: [] }, rounds: [] }, "W1-T99988"), "unrelated contract").tasks[0]!;
    assert.equal(other.acceptance![0]!.claim, `a recorded fix_refusal:${name} round, replayed through the real code path in ${owner}, is prevented or self-healed without dispatching a fix round`);
    assert.equal(other.acceptance![0]!.proof, `unit test: W1-T99988: fix_refusal:${name} is prevented, not retried`);
  }
});

test("every drafted remedy claims a mechanism a review can judge from the diff, never the after-window outcome", () => {
  const owner = "src/lib/prompt-render.ts";
  const key = "check:body-coverage";
  const rounds = [{ pr: 13946, causeKey: key, minutes: 2, at: "2026-10-24T13:44:46.109Z", detail: "body-coverage round" }];
  const yaml = ciFrictionShardYaml({ price: { cause: { kind: "check", name: "body-coverage" }, minutes: 20.3, rounds: 10, prs: 10 },
    rung: 1, owner: { files: [owner, "src/cli/commands/fix.ts"], why: ["names body-coverage"] }, rounds }, "W1-T99987");
  const task = loadPlanFromYaml(yaml, "mechanism claim").tasks[0]!;
  const claim = task.acceptance![0]!.claim;
  assert.equal(claim, `a recorded ${key} round, replayed through the real code path in ${owner}, is prevented or self-healed without dispatching a fix round`);
  assert.doesNotMatch(claim, /no longer/, "the outcome over future windows is the gardener's measurement, not the build's claim");
  assert.equal(task.acceptance![0]!.proof, `unit test: ${ciFrictionRemedyTestTitle("W1-T99987", key)}`, "the proof title is unchanged");
  assert.match(task.note!, /replay one recorded round of this cause through the real owner path/);
  assert.match(task.rationale!, /not assert a label, prompt text or report wording/);
  assert.match(task.rationale!, /after-window measurement decides that/);
  const plan = loadPlanFromYaml(yaml, "mechanism claim admission");
  assert.deepEqual(lintTask(task, { duplicateSlug: ciFrictionShardStem(key), machineFilingAdmission: { plan, releasedIds: new Set(),
    pathExists: p => existsSync(join(REPO_ROOT, p)) } }).violations.filter(v => v.severity === "block"), []);
});

// ── W1-T10331: an explicitly approved new path versus an invented filing path ──────────────────
const NEW_PATH = "src/lib/approved-new-module.ts";
const NOW = Date.now();

function newPathYaml(over: { id?: string; ref?: string | null; extra?: string[]; hold?: boolean; design?: string; verify?: string } = {}): string {
  return [
    `- id: ${over.id ?? "W1-T99950"}`, '  title: "approved new path"', "  repo: remudero", "  depends_on: []", "  type: implement",
    `  verify: ${over.verify ?? "auto"}`, "  risk: high", "  status: queued", "  attempts: 0", "  author_class: machine",
    ...(over.hold ? ["  dispatch_hold: true"] : []),
    ...(over.ref === null ? [] : [`  new_path_approval_ref: ${over.ref ?? "npa-ref-1"}`]),
    `  design: ${JSON.stringify(over.design ?? "one design")}`,
    "  files:", "    - src/lib/plan.ts", `    - ${NEW_PATH}`, ...(over.extra ?? []).map((f) => `    - ${f}`),
    "  acceptance:", '    - claim: "c"', '      proof: "grep: approvedNewModule in src/lib/plan.ts"', "",
  ].join("\n");
}

const taskOf = (yaml: string): Task => loadPlanFromYaml(yaml, "new-path-fixture").tasks[0]!;

const present = (p: string): boolean => existsSync(join(REPO_ROOT, p));

function decide(yaml: string, facts?: NewPathApprovalFacts | ((t: Task) => NewPathApprovalFacts | undefined), exists = present, nowMs = NOW): string[] {
  const plan = loadPlanFromYaml(yaml, "new-path-fixture");
  const task = plan.tasks[0]!;
  const newPathApproval = typeof facts === "function" ? facts(task) : facts;
  return machineFilingAdmissionViolations(task, { plan, releasedIds: new Set(), pathExists: exists, newPathApproval, nowMs });
}

function jwt(privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = b64({ alg: "RS256", kid: "new-path-test" });
  const payload = b64({ iss: "https://issuer.example", sub: "operator-a", azp: "https://console.example", iat: Math.floor(NOW / 1000), exp: Math.floor(NOW / 1000) + 600, fva: [0, 0] });
  return `${head}.${payload}.${sign("RSA-SHA256", Buffer.from(`${head}.${payload}`), privateKey).toString("base64url")}`;
}

async function withIssuer<T>(yaml: string, run: (input: { facts: NewPathApprovalFacts; ref: string; server: ReturnType<typeof createService>; base: string; token: string; operatorHeaders: Record<string, string>; binding: { origin: string; issuerId: string; epoch: number; policy: string; repository: string; instance: string; audience: string }; stateRoot: string }) => Promise<T>): Promise<T> {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "new-path-test", alg: "RS256", use: "sig" } as OperatorJwk;
  const keys = { key: async (kid: string) => kid === "new-path-test" ? jwk : undefined };
  const provider = operatorSessionIdentityProvider({ issuer: "https://issuer.example", allowedOrigins: ["https://console.example"], operatorUserIds: ["operator-a"], keys, clock: { now: () => NOW, date: () => new Date(NOW), iso: () => new Date(NOW).toISOString() } });
  const store = createConfirmNonceStore();
  const binding = { origin: "http://127.0.0.1", issuerId: "issuer-test", epoch: 1, policy: "policy-v1", repository: "remudero", instance: "core", audience: "lint-plan" };
  const stateRoot = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}new-path-issuer-`));
  const token = "a".repeat(64);
  const server = createService({ tokens: { read: token, write: token }, routes: [
    { ...makeConfirmNonceRoute(store), tier: "low" },
    ...makeNewPathApprovalIssuerRoutes({ binding, repository: "remudero", instance: "core", repoRoot: REPO_ROOT, stateRoot,
      clock: { now: () => NOW, date: () => new Date(NOW), iso: () => new Date(NOW).toISOString() } }),
  ], operatorSession: provider, enforceWriteTiers: true, confirmNonces: store });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  binding.origin = base;
  try {
    const operatorToken = jwt(pair.privateKey);
    const headers = { "content-type": "application/json", "x-rmd-operator-session": operatorToken };
    const preview = await fetch(`${base}/v1/new-path-approval/preview`, { method: "POST", headers, body: JSON.stringify({ taskYaml: yaml, approvedMissingPaths: [NEW_PATH] }) });
    assert.equal(preview.status, 200);
    const previewBody = await preview.json() as { previewId: string; ref: string };
    const payload = JSON.stringify({ previewId: previewBody.previewId });
    const nonceResponse = await fetch(`${base}/v1/confirm`, { method: "POST", headers, body: JSON.stringify({ method: "POST", path: "/v1/new-path-approval/confirm", payload }) });
    assert.equal(nonceResponse.status, 200);
    const nonce = (await nonceResponse.json() as { nonce: string }).nonce;
    const confirmed = await fetch(`${base}/v1/new-path-approval/confirm`, { method: "POST", headers: { ...headers, "x-confirm-nonce": nonce }, body: payload });
    assert.equal(confirmed.status, 200);
    const resolved = await resolveNewPathApprovalFacts({ ...taskOf(yaml), new_path_approval_ref: previewBody.ref }, binding, token, { fetchImpl: fetch });
    if (resolved.state === "unknown") throw new Error(resolved.reason);
    return await run({ facts: resolved.facts, ref: previewBody.ref, server, base, token, operatorHeaders: headers, binding, stateRoot });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(stateRoot, { recursive: true, force: true });
  }
}

test("new path admission binds the explicit approval to the exact task and declared paths", async () => {
  assert.equal(existsSync(join(REPO_ROOT, NEW_PATH)), false, "the approved path is genuinely absent");
  await withIssuer(newPathYaml({ ref: null }), async ({ facts, ref, binding, stateRoot }) => {
    const yaml = newPathYaml({ ref });
    assert.deepEqual(decide(yaml, facts), []);
    assert.match(decide(newPathYaml({ id: "W1-T99951", ref }), facts).join(";"), /approval is for task W1-T99950/);
    assert.match(decide(newPathYaml({ ref: "npa-ref-2" }), facts).join(";"), /different reference/);
    assert.match(decide(newPathYaml({ ref, design: "a changed design" }), facts).join(";"), /task changed since it was approved/);
    const extra = decide(newPathYaml({ ref, extra: ["src/lib/other-missing-module.ts"] }), facts);
    assert.match(extra.join(";"), /task changed since it was approved/);
    assert.match(extra.join(";"), /exist in neither.*approved-new-module\.ts.*other-missing-module\.ts/);
    assert.match(decide(yaml, facts, present, NOW + 31 * 60_000).join(";"), /not currently valid/);
    const wrongEpoch = { ...binding, epoch: binding.epoch + 1 };
    const wrongBinding = await resolveNewPathApprovalFacts(taskOf(yaml), wrongEpoch, "a".repeat(64));
    assert.equal(wrongBinding.state, "unknown", "facts from an older issuer policy epoch cannot be used");
    assert.ok(existsSync(join(stateRoot, "state", "new-path-approval-audit.ndjson")), "the resolved authority has a durable audit record");
    return Promise.resolve();
  });
});

test("new path admission refuses missing drifted and unsupported authority before staging", async () => {
  const text = newPathYaml();
  assert.match(decide(text).join(";"), /no prepared verified facts/);
  const copied = { ...({} as NewPathApprovalFacts) };
  assert.match(decide(text, copied).join(";"), /not verified by a trusted issuer/);
  const precheck = machineShardFilingRefusal(text, "W1-T99950.yaml", { pathExists: present });
  assert.match(precheck ?? "", /no prepared verified facts/);
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}new-path-admission-`));
  try {
    mkdirSync(join(root, "plan/tasks.d"), { recursive: true });
    mkdirSync(join(root, "src/lib"), { recursive: true });
    writeFileSync(join(root, "src/lib/plan.ts"), "// present\n");
    writeFileSync(join(root, "plan/tasks.d/W1-T99950-approved-new-path.yaml"), text);
    const landing = machineShardLandingRefusal(root, ["plan/tasks.d/W1-T99950-approved-new-path.yaml"]);
    assert.match(landing ?? "", /no prepared verified facts/);
    assert.equal(existsSync(join(root, NEW_PATH)), false, "nothing was staged or created");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("new path admission agrees between the real filing precheck and plan lint", async () => {
  const admissionOf = (reasons: string | undefined): string[] =>
    (reasons ?? "").split("; ").filter((r) => /exist in neither|new-path approval|dependency/.test(r)).map((r) => r.replace(/^W1-T\d+: machine-filing-admission: /, ""));
  await withIssuer(newPathYaml({ ref: null }), async ({ facts, ref, base, operatorHeaders, binding, token }) => {
    const yaml = newPathYaml({ ref });
    const plan = loadPlanFromYaml(yaml, "parity");
    const task = plan.tasks[0]!;
    const precheck = machineShardFilingRefusal(yaml, "W1-T99950.yaml", { pathExists: present, newPathApproval: facts, nowMs: NOW });
    const lint = lintTask(task, { machineFilingAdmission: { plan, releasedIds: new Set(), pathExists: present, newPathApproval: facts, nowMs: NOW } })
      .violations.filter((v) => v.check === "machine-filing-admission").map((v) => v.message);
    const direct = decide(yaml, facts);
    assert.equal(precheck?.includes(": machine-filing-admission: ") ?? false, direct.length > 0, `${precheck}`);
    assert.deepEqual(lint, direct.length > 0 ? [direct.join("; ")] : []);
    assert.deepEqual(admissionOf(precheck), direct);

    const revokePayload = JSON.stringify({ ref });
    const nonceResponse = await fetch(`${base}/v1/confirm`, { method: "POST", headers: operatorHeaders,
      body: JSON.stringify({ method: "POST", path: "/v1/new-path-approval/revoke", payload: revokePayload }) });
    assert.equal(nonceResponse.status, 200);
    const nonce = (await nonceResponse.json() as { nonce: string }).nonce;
    const revoked = await fetch(`${base}/v1/new-path-approval/revoke`, { method: "POST",
      headers: { ...operatorHeaders, "x-confirm-nonce": nonce }, body: revokePayload });
    assert.equal(revoked.status, 200, "the same verified operator can revoke with fresh step-up and a consumed action nonce");
    const replay = await fetch(`${base}/v1/new-path-approval/revoke`, { method: "POST",
      headers: { ...operatorHeaders, "x-confirm-nonce": nonce }, body: revokePayload });
    assert.equal(replay.status, 403, "the action nonce cannot be replayed");
    const oversized = await fetch(`${base}/v1/new-path-approval/confirm`, { method: "POST", headers: operatorHeaders, body: "x".repeat(4097) });
    assert.equal(oversized.status, 413, "the dispatcher refuses an oversized raw body before nonce consumption or handler work");
    const afterRevoke = await resolveNewPathApprovalFacts(task, binding, token);
    assert.equal(afterRevoke.state, "unknown");
    return Promise.resolve();
  });
});

test("new path admission preserves legacy proposals and independent owner holds", async () => {
  // no reference and no facts: the legacy invented-path refusal is byte-identical
  const invented = decide(newPathYaml({ ref: null }));
  assert.deepEqual(invented, [`task W1-T99950 declares file path(s) that exist in neither the checkout nor the base tree: ${NEW_PATH}`]);
  // an approval never releases a human gate, an unmet dependency, a block or a dispatch hold
  await withIssuer(newPathYaml({ ref: null, verify: "human" }), async ({ facts, ref }) => {
    const human = decide(newPathYaml({ verify: "human", ref }), facts).join(";");
    assert.match(human, /verify:human — not auto-runnable/);
    assert.doesNotMatch(human, /exist in neither/);
    return Promise.resolve();
  });
  await withIssuer(newPathYaml({ ref: null, hold: true }), ({ facts, ref }) => {
    const held = taskOf(newPathYaml({ hold: true, ref }));
    assert.equal(held.dispatch_hold, true);
    assert.deepEqual(decide(newPathYaml({ hold: true, ref }), facts), [], "a hold permits filing and still holds dispatch");
    const blocked = newPathYaml({ hold: true, ref }).replace("status: queued", "status: blocked");
    assert.match(decide(blocked, facts).join(";"), /task changed since it was approved|is blocked/);
    const base = taskOf(newPathYaml({ hold: true, ref }));
    assert.equal(taskIntentDigest(base), taskIntentDigest({ ...base, new_path_approval_ref: "other-ref" }));
    assert.notEqual(taskIntentDigest(base), taskIntentDigest({ ...base, rationale: "x" }));
    assert.throws(() => taskOf(newPathYaml({ ref: "has space" })), /new_path_approval_ref/);
    return Promise.resolve();
  });
});
