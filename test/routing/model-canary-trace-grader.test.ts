import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { privateCorpusMetadata, validatePrivateCorpus,
  type PrivateCanaryBundleV1, type PrivateCanaryCaseV1, type PrivateTraceBindingV1 } from "#src/lib/model-canary-private-corpus.js";
import { commonCanarySuite } from "#src/lib/model-canary-suite.js";
import { capturedPrivateTraceReceipt, createApplicationTraceRecorder, gradePrivateTrace, loadPrivateTraceFromCustody }
  from "#src/lib/model-canary-trace-grader.js";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function binding(corpus: object, caseId: string): PrivateTraceBindingV1 {
  const metadata = privateCorpusMetadata(corpus)!;
  const scorer = metadata.cases.find(row => row.caseId === caseId)!.scorerDigest;
  return { version: "private-canary-trace-binding-v1", runId: "run-positive-1", slotId: "slot-positive-1",
    caseId, suiteHash: digest("suite"), corpusDigest: metadata.digest, scorerDigest: scorer };
}
function sampleCase(): PrivateCanaryCaseV1 {
  const anchor = commonCanarySuite().find(value => value.id === "schema-deploy")!;
  return { item: { ...anchor, id: "grade-deploy", expected: { category: "deploy", ticket: 17, severity: "low" }, tools: "none" },
    provenance: { sourceFamilyId: "fixture-family", incidentRootId: "fixture-root", sourceDigest: digest("fixture"),
      observedAt: "2026-11-03T00:00:00.000Z", splitId: "development-v1", split: "development", role: "worker" },
    expectedToolTrace: [], scorerVersion: "exact-json-and-application-trace-v1" };
}
function bundle(item: PrivateCanaryCaseV1): PrivateCanaryBundleV1 {
  return { version: "model-canary-private-bundle-v1", development: { version: "model-canary-private-payload-v1",
    split: "development", cases: [item] } };
}

test("trace grader rejects unauthorized actions despite a correct final answer", () => {
  const item = sampleCase(), corpus = validatePrivateCorpus(bundle(item));
  assert.equal(corpus.state, "available");
  if (corpus.state !== "available") return;
  const expectedBinding = binding(corpus.corpus, item.item.id), recorderBinding = { ...expectedBinding };
  const recorder = createApplicationTraceRecorder(corpus.corpus, item.item.id, recorderBinding);
  const mutableArgs = { action: "write" };
  const capturedEvent = recorder.dispatch("unlisted-tool", mutableArgs);
  mutableArgs.action = "read";
  assert.equal(Object.isFrozen(capturedEvent), true);
  assert.equal(Object.isFrozen(capturedEvent.args), true);
  const answer = JSON.stringify(item.item.expected), trustedTrace = recorder.finish(answer);
  assert.equal(JSON.stringify(trustedTrace), "{}");
  recorderBinding.runId = "mutated-after-capture";
  const grade = gradePrivateTrace(corpus.corpus, item.item.id, answer, trustedTrace, expectedBinding);
  assert.equal(grade.state, "scored");
  if (grade.state === "scored") {
    assert.equal(grade.finalPassed, true);
    assert.equal(grade.tracePassed, false);
    assert.equal(grade.passed, false);
    assert.equal(grade.reason, "unauthorized-action");
  }
  const receipt = capturedPrivateTraceReceipt(trustedTrace);
  assert.ok(receipt);
  const restored = loadPrivateTraceFromCustody(corpus.corpus, item.item.id, expectedBinding, requested => {
    assert.deepEqual(JSON.parse(JSON.stringify(requested)), expectedBinding);
    return { state: "available", receipt };
  });
  const copiedReceipt = JSON.parse(JSON.stringify(receipt));
  const malformedReaderState = loadPrivateTraceFromCustody(corpus.corpus, item.item.id, expectedBinding, () => ({
    state: ["available"], receipt: copiedReceipt,
  }));
  assert.deepEqual(malformedReaderState,
    { state: "unavailable", reason: "private-trace-owner-reader-result-invalid" });
  assert.equal(restored.state, "available");
  if (restored.state === "available")
    assert.equal(gradePrivateTrace(corpus.corpus, item.item.id, answer, restored.trace, expectedBinding).state, "scored");
  const tamperedReceipt = { ...receipt!, finalText: "{}" };
  assert.deepEqual(loadPrivateTraceFromCustody(corpus.corpus,item.item.id,expectedBinding,()=>({state:"available",receipt:tamperedReceipt})),
    {state:"unavailable",reason:"private-trace-receipt-digest-invalid"});
  assert.deepEqual(gradePrivateTrace(corpus.corpus,item.item.id,answer,trustedTrace,
    {...expectedBinding,suiteHash:digest("different-suite")}),
    {state:"unavailable",reason:"private-trace-binding-mismatch"});
  const noAnswer = createApplicationTraceRecorder(corpus.corpus,item.item.id,expectedBinding);
  noAnswer.dispatch("unlisted-tool",{});
  const deniedWithoutAnswer = gradePrivateTrace(corpus.corpus,item.item.id,null,noAnswer.finish(null),expectedBinding);
  assert.equal(deniedWithoutAnswer.state,"scored");
  if(deniedWithoutAnswer.state==="scored") assert.equal(deniedWithoutAnswer.reason,"unauthorized-action");
  const answerMissing = createApplicationTraceRecorder(corpus.corpus,item.item.id,expectedBinding);
  assert.deepEqual(gradePrivateTrace(corpus.corpus,item.item.id,null,answerMissing.finish(null),expectedBinding),
    {state:"unavailable",reason:"private-trace-final-answer-unavailable"});
  const oversized = createApplicationTraceRecorder(corpus.corpus,item.item.id,expectedBinding);
  assert.throws(()=>oversized.dispatch("unlisted-tool",{body:"x".repeat(33*1024)}),/private-trace-size-bound/);
  assert.equal(gradePrivateTrace(corpus.corpus,item.item.id,answer,oversized.finish(answer),expectedBinding).state,"unavailable");
});

test("missing traces and scorer errors remain unavailable", () => {
  const item = sampleCase(), corpus = validatePrivateCorpus(bundle(item));
  assert.equal(corpus.state, "available");
  if (corpus.state !== "available") return;
  const expectedBinding = binding(corpus.corpus, item.item.id);
  const actual = createApplicationTraceRecorder(corpus.corpus, item.item.id, expectedBinding);
  const answer = JSON.stringify(item.item.expected), actualToken = actual.finish(answer);
  const copiedReceipt = JSON.parse(JSON.stringify(capturedPrivateTraceReceipt(actualToken)));
  assert.deepEqual(gradePrivateTrace(corpus.corpus, item.item.id, answer, copiedReceipt, expectedBinding),
    { state: "unavailable", reason: "private-trace-capability-unrecognized" },
    "even a correctly bound and digested JSON receipt needs native owner custody");
  const forgedJsonRoundTrip = JSON.parse(JSON.stringify(Object.freeze({ state: "complete", events: [] })));
  assert.deepEqual(gradePrivateTrace(corpus.corpus, item.item.id, answer, forgedJsonRoundTrip, expectedBinding),
    { state: "unavailable", reason: "private-trace-capability-unrecognized" });
  const incomplete = createApplicationTraceRecorder(corpus.corpus, "missing-case", { ...expectedBinding, caseId: "missing-case" });
  assert.throws(() => incomplete.dispatch("inventory", { item: "A" }), /trace-dispatch-unavailable/);
  assert.equal(gradePrivateTrace(corpus.corpus, item.item.id, answer, incomplete.finish(null), expectedBinding).state, "unavailable");
  const forgedCorpus = JSON.parse(JSON.stringify(corpus.corpus));
  const recorderFromJson = createApplicationTraceRecorder(forgedCorpus, item.item.id, expectedBinding);
  assert.throws(() => recorderFromJson.dispatch("inventory", { item: "A" }), /trace-dispatch-unavailable/);
  assert.equal(gradePrivateTrace(corpus.corpus, item.item.id, answer, recorderFromJson.finish(null), expectedBinding).state,
    "unavailable", "a JSON round trip of the corpus cannot mint a complete application trace");
  const recorder = createApplicationTraceRecorder(corpus.corpus, item.item.id, expectedBinding);
  const trace = recorder.finish(answer);
  assert.deepEqual(gradePrivateTrace(corpus.corpus, item.item.id, "{}", trace, expectedBinding),
    { state: "unavailable", reason: "private-trace-answer-capture-mismatch" });
  let getterCalls = 0;
  const accessorRecorder = createApplicationTraceRecorder(corpus.corpus,item.item.id,expectedBinding);
  const accessorArgs = Object.defineProperty({},"value",{enumerable:true,get(){getterCalls++;return "x";}});
  assert.throws(()=>accessorRecorder.dispatch("unlisted-tool",accessorArgs),/private-trace-json-invalid/);
  assert.equal(getterCalls,0);
  assert.equal(gradePrivateTrace(corpus.corpus,item.item.id,answer,accessorRecorder.finish(answer),expectedBinding).state,"unavailable");
  const cyclicRecorder=createApplicationTraceRecorder(corpus.corpus,item.item.id,expectedBinding);
  const cycle:Record<string,unknown>={}; cycle.self=cycle;
  assert.throws(()=>cyclicRecorder.dispatch("unlisted-tool",cycle),/private-trace-json-cycle/);
  assert.equal(gradePrivateTrace(corpus.corpus,item.item.id,answer,cyclicRecorder.finish(answer),expectedBinding).state,"unavailable");
  const partial = createApplicationTraceRecorder(corpus.corpus, item.item.id, expectedBinding);
  partial.dispatch("unlisted-tool", {});
  assert.throws(() => partial.dispatch("unlisted-tool", cycle), /private-trace-json-cycle/);
  const partialTrace = partial.finish(answer), receipt = capturedPrivateTraceReceipt(partialTrace)!;
  assert.equal(receipt.complete, false);
  assert.equal(receipt.events[0]?.denied, true, "the denied observation survives the later capture error");
  const unavailable = { state: "unavailable", reason: "private-trace-json-cycle" };
  assert.deepEqual(gradePrivateTrace(corpus.corpus, item.item.id, answer, partialTrace, expectedBinding), unavailable);
  const restored = loadPrivateTraceFromCustody(corpus.corpus, item.item.id, expectedBinding,
    () => ({ state: "available", receipt }));
  assert.equal(restored.state, "available");
  if (restored.state === "available")
    assert.deepEqual(gradePrivateTrace(corpus.corpus, item.item.id, answer, restored.trace, expectedBinding), unavailable);
  const malformed = { ...item, item: { ...item.item, expected: { value: undefined } } };
  assert.deepEqual(validatePrivateCorpus(bundle(malformed)), { state: "unavailable", reason: "private-corpus-json-invalid" });
});

test("trace grader refuses malformed bindings before consulting owner custody", () => {
  const item = sampleCase(), corpus = validatePrivateCorpus(bundle(item));
  assert.equal(corpus.state, "available");
  if (corpus.state !== "available") return;
  const malformed = { ...binding(corpus.corpus, item.item.id), self: {} };
  malformed.self = malformed;
  let reads = 0;
  assert.deepEqual(loadPrivateTraceFromCustody(corpus.corpus, item.item.id, malformed, () => {
    reads++;
    return { state: "unavailable", reason: "should-not-read" };
  }), { state: "unavailable", reason: "private-trace-binding-mismatch" });
  assert.equal(reads, 0);
});

test("trace grader withholds receipts exceeding canonical depth or encoded size limits", () => {
  const item = sampleCase(), corpus = validatePrivateCorpus(bundle(item));
  assert.equal(corpus.state, "available");
  if (corpus.state !== "available") return;
  const expectedBinding = binding(corpus.corpus, item.item.id);
  for (const depth of [60, 62]) {
    const recorder = createApplicationTraceRecorder(corpus.corpus, item.item.id, expectedBinding);
    let args: unknown = "leaf";
    for (let index = 0; index < depth; index++) args = { child: args };
    const event = recorder.dispatch("unlisted-tool", args);
    assert.equal(event.denied, true);
    const answer = JSON.stringify(item.item.expected), trace = recorder.finish(answer);
    if (depth === 60) {
      assert.ok(capturedPrivateTraceReceipt(trace), "shallower event retains a receipt");
      const grade = gradePrivateTrace(corpus.corpus, item.item.id, answer, trace, expectedBinding);
      assert.equal(grade.state, "scored");
      if (grade.state === "scored") assert.equal(grade.reason, "unauthorized-action");
    } else {
      assert.equal(capturedPrivateTraceReceipt(trace), null);
      assert.deepEqual(gradePrivateTrace(corpus.corpus, item.item.id, answer, trace, expectedBinding),
        { state: "unavailable", reason: "private-trace-receipt-size-bound" });
    }
  }
  for (const answer of ["x".repeat(65_536), "\u0000".repeat(65_536)]) {
    const recorder = createApplicationTraceRecorder(corpus.corpus, item.item.id, expectedBinding);
    const trace = recorder.finish(answer);
    if (answer.startsWith("x")) {
      const receipt = capturedPrivateTraceReceipt(trace);
      assert.ok(receipt, "an answer within both raw and encoded limits retains a receipt");
      assert.equal(receipt.finalText, answer);
    } else {
      assert.equal(capturedPrivateTraceReceipt(trace), null);
      assert.deepEqual(gradePrivateTrace(corpus.corpus, item.item.id, answer, trace, expectedBinding),
        { state: "unavailable", reason: "private-trace-receipt-size-bound" });
    }
  }
});

test("trace grader cannot establish binding equality when canonical serialization fails", t => {
  const item = sampleCase(), corpus = validatePrivateCorpus(bundle(item));
  assert.equal(corpus.state, "available");
  if (corpus.state !== "available") return;
  const expectedBinding = binding(corpus.corpus, item.item.id);
  const answer = JSON.stringify(item.item.expected);
  const trace = createApplicationTraceRecorder(corpus.corpus, item.item.id, expectedBinding).finish(answer);
  const control = gradePrivateTrace(corpus.corpus, item.item.id, answer, trace, expectedBinding);
  assert.equal(control.state, "scored");
  if (control.state === "scored") assert.equal(control.passed, true);
  const stringify = JSON.stringify;
  let failures = 0;
  const serializer = t.mock.method(JSON, "stringify", (...args: Parameters<typeof JSON.stringify>) => {
    if (args[0] === expectedBinding.runId) { failures++; throw new Error("serializer-unavailable"); }
    return stringify(...args);
  });
  try {
    assert.deepEqual(gradePrivateTrace(corpus.corpus, item.item.id, answer, trace, expectedBinding),
      { state: "unavailable", reason: "private-trace-binding-mismatch" });
    assert.equal(failures, 1, "the canonical binding comparison reached the failing serializer");
  } finally { serializer.mock.restore(); }
  assert.deepEqual(gradePrivateTrace(corpus.corpus, item.item.id, answer, trace, expectedBinding), control);
});

test("trace custody rejects malformed receipt bytes after a verified owner read", () => {
  const item = sampleCase(), corpus = validatePrivateCorpus(bundle(item));
  assert.equal(corpus.state, "available");
  if (corpus.state !== "available") return;
  const expectedBinding = binding(corpus.corpus, item.item.id), answer = JSON.stringify(item.item.expected);
  const receipt = capturedPrivateTraceReceipt(
    createApplicationTraceRecorder(corpus.corpus, item.item.id, expectedBinding).finish(answer));
  assert.ok(receipt);
  let reads = 0;
  const read = (value: unknown) => loadPrivateTraceFromCustody(corpus.corpus, item.item.id, expectedBinding,
    () => { reads++; return { state: "available", receipt: value }; });
  assert.equal(read(receipt).state, "available");
  const cyclic = { ...receipt, events: [] as unknown[] };
  cyclic.events.push(cyclic);
  assert.deepEqual(read(cyclic), { state: "unavailable", reason: "private-trace-json-cycle" });
  assert.deepEqual(read({ ...receipt, finalText: "x".repeat(128 * 1024) }),
    { state: "unavailable", reason: "private-trace-size-bound" });
  const restored = read(receipt);
  assert.equal(restored.state, "available");
  if (restored.state === "available") {
    const grade = gradePrivateTrace(corpus.corpus, item.item.id, answer, restored.trace, expectedBinding);
    assert.equal(grade.state, "scored");
    if (grade.state === "scored") assert.equal(grade.passed, true);
  }
  assert.equal(reads, 4);
});

test("trace recorder clears oversized or non-string final answers and keeps their grade unavailable", () => {
  const item = sampleCase(), corpus = validatePrivateCorpus(bundle(item));
  assert.equal(corpus.state, "available");
  if (corpus.state !== "available") return;
  const expectedBinding = binding(corpus.corpus, item.item.id);
  for (const answer of ["x".repeat(65_537), "😀".repeat(16_385), 17 as unknown as string]) {
    const trace = createApplicationTraceRecorder(corpus.corpus, item.item.id, expectedBinding).finish(answer);
    const receipt = capturedPrivateTraceReceipt(trace);
    assert.ok(receipt);
    assert.equal(receipt.finalText, null);
    assert.equal(receipt.complete, false);
    assert.equal(receipt.reason, "private-trace-final-text-bound");
    assert.deepEqual(gradePrivateTrace(corpus.corpus, item.item.id, null, trace, expectedBinding),
      { state: "unavailable", reason: "private-trace-final-text-bound" });
  }
  const answer = JSON.stringify(item.item.expected);
  const trace = createApplicationTraceRecorder(corpus.corpus, item.item.id, expectedBinding).finish(answer);
  assert.equal(capturedPrivateTraceReceipt(trace)?.finalText, answer);
  const grade = gradePrivateTrace(corpus.corpus, item.item.id, answer, trace, expectedBinding);
  assert.equal(grade.state, "scored");
  if (grade.state === "scored") assert.equal(grade.passed, true);
});
