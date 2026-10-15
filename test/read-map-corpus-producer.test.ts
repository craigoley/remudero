import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assessReadMapCorpus, collectReadMapCorpus, corpusDigest, prepareReadMapCorpus, readCorpusBytes, readMapSummary, validateCorpusManifest } from "../scripts/lib/read-map-corpus.mjs";
import { main } from "../scripts/read-map-corpus.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TSX = import.meta.resolve("tsx");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const counts = { tests: 1, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0 };
function control() {
  const suites = ["test/a-reader.test.ts", "test/b-other.test.ts"].map(path => ({ path, blob: "a".repeat(40), sha256: sha(path), bytes: 1 }));
  const manifest = { format: "rmd-read-map-run-manifest-v1", root: ROOT, head: "a".repeat(40), tree: "b".repeat(40), runId: "12345678-1234-1234-1234-123456789012", preparedAtMs: 1,
    suites, suitesSha256: corpusDigest(suites), nodeVersion: process.version, nodeSha256: "c".repeat(64), mode: "shadow", skipsNothing: true,
    inputs: ["package-lock.json", "test/setup/read-map.ts", "test/setup/tmp-hygiene.ts", "scripts/lib/read-map-summary-reporter.mjs", "scripts/lib/read-map-corpus.mjs", "scripts/read-map-corpus.mjs"].map(path => ({ path, sha256: "c".repeat(64) })) };
  const summaries = [...suites.map(x => readMapSummary({ type: "test:summary", data: { file: join(ROOT, x.path), success: true, counts: { ...counts } } }, manifest)),
    readMapSummary({ type: "test:summary", data: { success: true, counts: { ...counts, tests: 2, passed: 2 } } }, manifest)];
  const records = new Map(suites.map(x => [x.path, { sha256: "d".repeat(64), modifiedMs: 2,
    value: { format: "rmd-read-record-v2", suite: x.path, reads: x.path.includes("reader") ? ["deploy/unit.json"] : [], listed: [], unknownDescriptors: false } }]));
  return { manifest, summaries, records };
}
test("read map corpus producer keeps complete observations shadow-only and never exports a pruning grant", () => {
  const { manifest, summaries, records } = control(), report = assessReadMapCorpus(manifest, summaries, records, true);
  assert.equal(report.state, "OBSERVED_NOT_QUALIFIED"); assert.equal(report.problems.length, 0);
  assert.equal(report.expectedSuites, 2); assert.equal(report.observedSuites, 2);
  assert.equal(report.dispatchAllowed, false); assert.equal(report.liveNarrowingAllowed, false);
  assert.equal(report.qualification.heldOutFalseNegatives, "NOT_ESTABLISHED");
});
test("a missing read record cannot be promoted into trustworthy empty corpus evidence", () => {
  const { manifest, summaries, records } = control(); records.delete("test/a-reader.test.ts");
  assert.match(assessReadMapCorpus(manifest, summaries, records, true).problems.join("\n"), /record is absent malformed or stale/);
});
test("unrun suites and unclosed global output stay incomplete", () => {
  const { manifest, summaries, records } = control(); summaries.splice(0, 1);
  assert.match(assessReadMapCorpus(manifest, summaries, records, true).problems.join("\n"), /suite outcome is missing/);
  summaries.pop(); assert.match(assessReadMapCorpus(manifest, summaries, records, true).problems.join("\n"), /closed positive final summary/);
});
test("a suite skip cancellation failure or zero tests is not producer qualification", () => {
  for (const key of ["skipped", "cancelled", "failed"]) {
    const { manifest, summaries, records } = control(); summaries[0]!.counts[key] = 1;
    assert.equal(assessReadMapCorpus(manifest, summaries, records, true).state, "INCOMPLETE");
  }
  const { manifest, summaries, records } = control(); summaries[0]!.counts.tests = 0;
  assert.equal(assessReadMapCorpus(manifest, summaries, records, true).state, "INCOMPLETE");
});
test("a stale record unknown descriptor or legacy record keeps the observation incomplete", () => {
  for (const mutate of [(x: ReturnType<typeof control>["records"]) => { x.get("test/a-reader.test.ts")!.modifiedMs = 0; },
    (x: ReturnType<typeof control>["records"]) => { x.get("test/a-reader.test.ts")!.value.unknownDescriptors = true; },
    (x: ReturnType<typeof control>["records"]) => { x.get("test/a-reader.test.ts")!.value.format = "rmd-read-record-v1"; }]) {
    const { manifest, summaries, records } = control(); mutate(records);
    assert.equal(assessReadMapCorpus(manifest, summaries, records, true).state, "INCOMPLETE");
  }
});
test("foreign repeated or mixed-head summaries cannot substitute for missing suites", () => {
  for (const mutate of [(s: ReturnType<typeof control>["summaries"]) => { s[1] = s[0]; },
    (s: ReturnType<typeof control>["summaries"]) => { s[0]!.suite = "test/foreign.test.ts"; },
    (s: ReturnType<typeof control>["summaries"]) => { s[0]!.head = "c".repeat(40); },
    (s: ReturnType<typeof control>["summaries"]) => { s[0]!.runId = "different-run"; }]) {
    const { manifest, summaries, records } = control(); mutate(summaries);
    assert.equal(assessReadMapCorpus(manifest, summaries, records, true).state, "INCOMPLETE");
  }
});
test("drifted source and mismatched whole-run counts remain explicit", () => {
  const { manifest, summaries, records } = control();
  assert.match(assessReadMapCorpus(manifest, summaries, records, false).problems.join("\n"), /runtime drifted/);
  summaries.at(-1)!.counts.tests = 3; summaries.at(-1)!.counts.passed = 3;
  assert.match(assessReadMapCorpus(manifest, summaries, records, true).problems.join("\n"), /does not reconcile/);
});
test("repeated or early global summary and records without outcomes refuse", () => {
  const { manifest, summaries, records } = control(); summaries.unshift(summaries.at(-1));
  assert.match(assessReadMapCorpus(manifest, summaries, records, true).problems.join("\n"), /repeated or not final/);
  records.set("test/foreign.test.ts", records.values().next().value!);
  assert.match(assessReadMapCorpus(manifest, summaries, records, true).problems.join("\n"), /no closed suite outcome/);
});
test("physical manifest cannot hide duplicate paths changed bytes traversal or changed producer inputs", () => {
  const { manifest } = control(); assert.equal(validateCorpusManifest(manifest), manifest);
  manifest.suites[0]!.sha256 = "e".repeat(64); assert.throws(() => validateCorpusManifest(manifest), /physical/);
  manifest.suitesSha256 = corpusDigest(manifest.suites); manifest.suites[0]!.path = "test/../unsafe.test.ts";
  assert.throws(() => validateCorpusManifest(manifest), /physical/);
  const other = control().manifest; other.inputs[0]!.path = "../outside.json";
  assert.throws(() => validateCorpusManifest(other), /runtime inputs/);
});
test("custom read map reporter captures summary only never private stdout or test bodies", () => {
  const { manifest } = control(); assert.equal(readMapSummary({ type: "test:stdout", data: { message: "private" } }, manifest), undefined);
  const event = readMapSummary({ type: "test:summary", data: { file: join(ROOT, "test/a-reader.test.ts"), success: false, counts } }, manifest)!;
  assert.equal(event.suite, "test/a-reader.test.ts"); assert.equal(event.success, false); assert.equal("message" in event, false);
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "rmd-read-map-producer-")), root = join(home, "repo"), directory = join(home, "run");
  mkdirSync(root); const put = (path: string, body: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); };
  for (const path of ["scripts/lib/read-map-corpus.mjs", "scripts/lib/read-map-summary-reporter.mjs", "scripts/read-map-corpus.mjs", "scripts/lib/argv.mjs", "test/setup/read-map.ts"]) put(path, readFileSync(join(ROOT, path), "utf8"));
  put("package.json", '{"type":"module"}'); put("package-lock.json", "{}");
  put("test/setup/tmp-hygiene.ts", 'import {installReadMapFromEnv} from "./read-map.ts"; await installReadMapFromEnv();\n');
  put("deploy/unit.json", '{"positive":true}\n');
  put("test/a-reader.test.ts", 'import {test} from "node:test"; import {readFileSync} from "node:fs"; test("actual reader",()=>readFileSync("deploy/unit.json"));\n');
  put("test/b-other.test.ts", 'import {test} from "node:test"; test("actual non-reader",()=>{});\n');
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }, stdio: "pipe" });
  git("init"); git("add", "."); git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "source-bound corpus fixture");
  return { home, root, directory, git };
}
test("real Node per-file summaries and real fs reads produce a committed two-suite observation", () => {
  const fx = fixture();
  try {
    const prepared = prepareReadMapCorpus(fx.root, fx.directory);
    assert.equal(prepared.manifest.suites.length, 2);
    const clean = { ...process.env, ...prepared.env, NODE_V8_COVERAGE: "", RMD_TEST_SLOT_MANAGED: process.env.RMD_TEST_SLOT_MANAGED };
    delete clean.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ["--import", TSX, "--import", join(fx.root, "test/setup/tmp-hygiene.ts"), "--test", "--test-reporter=tap", "--test-reporter-destination=stdout",
      "--test-reporter=" + prepared.reporter, "--test-reporter-destination=" + prepared.reporterDestination, "test/a-reader.test.ts", "test/b-other.test.ts"], { cwd: fx.root, env: clean, encoding: "utf8", timeout: 30000 });
    assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /# tests 2/); assert.match(run.stdout, /# fail 0/);
    const report = collectReadMapCorpus(fx.directory);
    assert.equal(report.state, "OBSERVED_NOT_QUALIFIED", report.problems.join("\n"));
    assert(report.observations.find(x => x.suite === "test/a-reader.test.ts")!.record.reads.includes("deploy/unit.json"));
    assert(!report.observations.find(x => x.suite === "test/b-other.test.ts")!.record.reads.includes("deploy/unit.json"));
    assert.equal(report.liveNarrowingAllowed, false);
    writeFileSync(join(fx.root, "deploy/unit.json"), "changed");
    assert.equal(collectReadMapCorpus(fx.directory).state, "INCOMPLETE");
  } finally { rmSync(fx.home, { recursive: true, force: true }); }
});
test("prepare refuses reuse dirty trees and output inside the source checkout", () => {
  const fx = fixture();
  try {
    assert.throws(() => prepareReadMapCorpus(fx.root, join(fx.root, "records")), /outside/);
    prepareReadMapCorpus(fx.root, fx.directory); assert.throws(() => prepareReadMapCorpus(fx.root, fx.directory), /never reused/);
    writeFileSync(join(fx.root, "untracked"), "not committed"); assert.throws(() => prepareReadMapCorpus(fx.root, join(fx.home, "second")), /clean committed/);
  } finally { rmSync(fx.home, { recursive: true, force: true }); }
});
test("unbounded symlink and unclosed artifacts are not empty successful observations", () => {
  const fx = fixture();
  try {
    prepareReadMapCorpus(fx.root, fx.directory);
    const alias = join(fx.home, "alias"); symlinkSync(join(fx.directory, "manifest.json"), alias);
    assert.throws(() => readCorpusBytes(alias), /bounded regular/);
    assert.throws(() => readCorpusBytes(join(fx.directory, "manifest.json"), 1), /bounded regular/);
    writeFileSync(join(fx.directory, "summaries.ndjson"), "{}"); assert.throws(() => collectReadMapCorpus(fx.directory), /unclosed/);
    assert.equal(existsSync(join(fx.root, "dist")), false);
  } finally { rmSync(fx.home, { recursive: true, force: true }); }
});
test("producer CLI refuses an implicit run and exposes explicit prepare and collect commands", () => {
  assert.equal(main([]), 2); assert.equal(main(["run", "--directory", "/nonexistent"]), 2);
  assert.equal(main(["--help"]), 0);
});
