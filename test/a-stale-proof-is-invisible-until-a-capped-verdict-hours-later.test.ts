import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "proof-discrimination-gate.mjs");
const gate = (await import(pathToFileURL(SCRIPT).href)) as {
  resolveMergeBase: (baseSha: string, headSha: string, options?: { root?: string; git?: (args: string[], root: string) => { status: number | null; stdout?: string; stderr?: string } }) => { ok: boolean; mergeBase?: string; message?: string };
  criteriaForReview: (body: string, headSha: string, options?: { root?: string }) => { criteria: Array<{ proof?: string }>; source: string };
  runCheckProof: (proof: string, mergeBase: string, options?: { root?: string }) => { status: number | null; stdout: string; stderr: string; error?: string };
  evaluateProofDiscrimination: (criteria: Array<{ proof?: string }>, mergeBase: string, runProof: (proof: string, base: string) => { status: number | null; stdout: string; stderr?: string; error?: string }) => { stale: Array<{ proof: string; head: string; base: string }>; unreadable: unknown[]; executed: number };
  main: (argv: string[], deps?: Record<string, unknown>) => number;
};

const STALE = "grep: persistent marker in src/example.ts";

test("a proof that passes at the PR head and its merge base fails, naming the proof and both hit counts", () => {
  const result = gate.evaluateProofDiscrimination([{ proof: STALE }], "merge-base", (proof, base) => {
    assert.equal(proof, STALE);
    assert.equal(base, "merge-base");
    return { status: 5, stdout: "hits:       2\nbase hits:  2\ndiscrimination: executed_stale\n" };
  });
  assert.equal(result.executed, 1);
  assert.deepEqual(result.unreadable, []);
  // FALSIFIER: changing the production comparison away from CHECK_PROOF_EXIT.executedStale
  // makes this assertion fail while the fixture remains the same head/base parity report.
  assert.deepEqual(result.stale.map(({ proof, head, base }) => ({ proof, head, base })), [{ proof: STALE, head: "2", base: "2" }]);
});

test("a proof that passes at head and misses at merge base is not refused", () => {
  const result = gate.evaluateProofDiscrimination([{ proof: STALE }], "merge-base", () => ({
    status: 0,
    stdout: "hits:       1\nbase hits:  0\ndiscrimination: discriminates\n",
  }));
  assert.equal(result.executed, 1);
  assert.deepEqual(result.stale, []);
  assert.deepEqual(result.unreadable, []);
});

test("the base passed to check-proof is the PR fork point, not the event's current base tip", () => {
  const result = gate.resolveMergeBase("base-tip", "head", {
    git(args) {
      assert.deepEqual(args, ["merge-base", "base-tip", "head"]);
      return { status: 0, stdout: "fork-point\n" };
    },
  });
  assert.deepEqual(result, { ok: true, mergeBase: "fork-point" });
});

test("the merge-base resolver's default git path returns the real fork point", () => {
  const result = gate.resolveMergeBase("HEAD", "HEAD", { root: ROOT });
  assert.equal(result.ok, true, result.message);
  assert.match(result.mergeBase!, /^[0-9a-f]{40}$/);
});

test("the merge-base resolver reports git failures with their stderr detail", () => {
  const result = gate.resolveMergeBase("base-tip", "head", {
    git(args) {
      assert.deepEqual(args, ["merge-base", "base-tip", "head"]);
      return { status: 1, stdout: "", stderr: "fatal: no merge base\n" };
    },
  });
  assert.deepEqual(result, { ok: false, message: "could not resolve the PR merge base: fatal: no merge base" });
});

test("the gate uses the reviewer's body fallback when a PR has no task trailer", () => {
  const body = `## Acceptance\n\n- claim: behavior exists\n  proof: ${STALE}\n`;
  const resolved = gate.criteriaForReview(body, "HEAD", { root: ROOT });
  assert.equal(resolved.source, "PR body Acceptance block");
  assert.deepEqual(resolved.criteria.map((criterion) => criterion.proof), [STALE]);
});

test("the public check-proof command reports a real head/base parity through the gate's process boundary", () => {
  const result = gate.runCheckProof("grep: parseAcceptanceBlock in src/lib/review.ts", "HEAD", { root: ROOT });
  assert.equal(result.status, 5, result.stdout + result.stderr);
  assert.match(result.stdout, /discrimination: executed_stale/);
});

function logs() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: { log: (line: string) => out.push(line), error: (line: string) => err.push(line) } };
}

test("the process-level gate fails closed on a stale proof and reports its repairable evidence", () => {
  const sink = logs();
  const code = gate.main(["--event-path", "event.json"], {
    readPayload: () => ({ readable: true, body: "body", baseSha: "base-tip", headSha: "head" }),
    mergeBase: () => ({ ok: true, mergeBase: "fork" }),
    resolveCriteria: () => ({ criteria: [{ proof: STALE }], source: "task acceptance" }),
    runProof: () => ({ status: 5, stdout: "hits: 2\nbase hits: 2\n" }),
    log: sink.log,
  });
  assert.equal(code, 1);
  assert.match(sink.err.join("\n"), /proof: grep: persistent marker/);
  assert.match(sink.err.join("\n"), /head hits: 2; base hits: 2/);
  assert.match(sink.err.join("\n"), /Remedy:/);
});

test("the process-level gate passes a discriminating proof and refuses an unreadable executor", () => {
  const passing = logs();
  const common = {
    readPayload: () => ({ readable: true, body: "body", baseSha: "base-tip", headSha: "head" }),
    mergeBase: () => ({ ok: true, mergeBase: "fork" }),
    resolveCriteria: () => ({ criteria: [{ proof: STALE }], source: "task acceptance" }),
  };
  assert.equal(gate.main(["--event-path", "event.json"], { ...common, runProof: () => ({ status: 0, stdout: "hits: 1\nbase hits: 0\n" }), log: passing.log }), 0);
  assert.match(passing.out.join("\n"), /did not pass at both head and merge base/);

  const unreadable = logs();
  assert.equal(gate.main(["--event-path", "event.json"], { ...common, runProof: () => ({ status: null, stdout: "", error: "spawn failed" }), log: unreadable.log }), 1);
  assert.match(unreadable.err.join("\n"), /could not run/);
});

test("the process-level gate refuses missing and unreadable event payloads before proof execution", () => {
  const previous = process.env.GITHUB_EVENT_PATH;
  delete process.env.GITHUB_EVENT_PATH;
  try {
    const missing = logs();
    assert.equal(gate.main([], { log: missing.log }), 1);
    assert.match(missing.err.join("\n"), /no event payload path/);
  } finally {
    if (previous === undefined) delete process.env.GITHUB_EVENT_PATH;
    else process.env.GITHUB_EVENT_PATH = previous;
  }

  const unreadable = logs();
  assert.equal(
    gate.main(["--event-path", "event.json"], {
      readPayload: () => ({ readable: false, reason: "ENOENT" }),
      log: unreadable.log,
    }),
    1,
  );
  assert.match(unreadable.err.join("\n"), /unreadable event payload: ENOENT/);
});

test("the process-level gate refuses when the PR merge base cannot be resolved", () => {
  const sink = logs();
  const code = gate.main(["--event-path", "event.json"], {
    readPayload: () => ({ readable: true, body: "body", baseSha: "base-tip", headSha: "head" }),
    mergeBase: () => ({ ok: false, message: "could not resolve the PR merge base: fatal" }),
    log: sink.log,
  });
  assert.equal(code, 1);
  assert.match(sink.err.join("\n"), /could not resolve the PR merge base: fatal/);
});

test("the workflow evaluates the PR head on body edits and ci-gate aggregates the named check", async () => {
  const workflow = await import("node:fs/promises").then(({ readFile }) => readFile(join(ROOT, ".github/workflows/proof-discrimination-gate.yml"), "utf8"));
  const ciGate = await import("node:fs/promises").then(({ readFile }) => readFile(join(ROOT, ".github/workflows/ci-gate.yml"), "utf8"));
  assert.match(workflow, /types: \[opened, synchronize, reopened, edited\]/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /proof-discrimination-gate\.mjs/);
  assert.match(ciGate, /types: \[opened, synchronize, reopened, edited\]/);
  assert.match(ciGate, /"proof-discrimination"/);
});
