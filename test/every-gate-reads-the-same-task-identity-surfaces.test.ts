import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const AUTHOR_GATE = pathToFileURL(join(REPO_ROOT, "scripts", "acceptance-author-gate.mjs")).href;
const PROOF_GATE = pathToFileURL(join(REPO_ROOT, "scripts", "proof-discrimination-gate.mjs")).href;

type Verdict = { ok: boolean; defect?: string; message: string };
const { evaluateGate } = (await import(AUTHOR_GATE)) as { evaluateGate: (input: Record<string, unknown>) => Verdict };
const { main } = (await import(PROOF_GATE)) as { main: (argv: string[], deps: Record<string, unknown>) => number };

// W1-T4206: the reviewer recovers a task identity from the body trailer and then from a run-shaped head ref
// (`resolveReviewTaskId`, run-task.ts). Both gates below read the body alone, so a trailerless run-branch PR was
// judged one way by the reviewer and refused another here.
const TASK = "W1-T4206";
const RUN_REF = `run-${TASK}-1790872155388`;
const TRAILERLESS_BODY = "## Summary\n\nbuilt it\n";

function runProofGate(over: Record<string, unknown>) {
  const logs: string[] = [];
  const errors: string[] = [];
  const resolved: string[] = [];
  const code = main(["--event-path", "/dev/null"], {
    root: REPO_ROOT,
    readPayload: () => ({ readable: true, baseSha: "b", headSha: "h", body: TRAILERLESS_BODY, headRefName: RUN_REF }),
    mergeBase: () => ({ ok: true, mergeBase: "deadbeef" }),
    resolveCriteria: (body: string) => {
      resolved.push(body);
      return { criteria: [{ claim: "c", proof: "unit test: test/plan.test.ts" }], source: "task acceptance" };
    },
    runProof: () => ({ status: 5, stdout: "hits: 100\nbase hits: 100\n" }),
    baseline: () => ({ [TASK]: 1 }),
    log: { log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) },
    ...over,
  });
  return { code, logs, errors, resolved };
}

test("W1-T4206: both gates accept a trailerless PR on a run-shaped head ref", () => {
  const verdict = evaluateGate({ body: TRAILERLESS_BODY, authorLogin: "a-human", headRefName: RUN_REF, trailerResolves: (id: string) => id === TASK });
  assert.equal(verdict.ok, true, verdict.message);
  assert.match(verdict.message, new RegExp(`Remudero-Task: ${TASK}`));

  const { code, logs, errors, resolved } = runProofGate({});
  assert.equal(code, 0, `a recovered identity must reach its allowance; errors: ${errors.join(" | ")}`);
  assert.match(logs.join("\n"), new RegExp(`stale proof\\(s\\) for ${TASK}`));
  assert.match(resolved[0] ?? "", new RegExp(`^Remudero-Task: ${TASK}$`, "m"));
});

test("W1-T4206: a refusal names the identity surfaces it read", () => {
  const noRef = evaluateGate({ body: TRAILERLESS_BODY, authorLogin: "a-human", headRefName: "feature/not-a-run-branch" });
  assert.equal(noRef.ok, false);
  assert.equal(noRef.defect, "no-header");
  assert.match(noRef.message, /Task identity was read from the PR body/);
  assert.match(noRef.message, /"feature\/not-a-run-branch" is not a run-<taskId>-<epochMs> branch/);
  assert.match(noRef.message, /the trailer must be in the PR body/);

  // The recovered identity names a task the plan does not declare: the refusal says which surface supplied it.
  const unresolved = evaluateGate({ body: TRAILERLESS_BODY, authorLogin: "a-human", headRefName: RUN_REF, trailerResolves: () => false });
  assert.equal(unresolved.ok, false);
  assert.match(unresolved.message, new RegExp(`run-shaped head ref "${RUN_REF}" \\(${TASK}\\)`));

  const proof = runProofGate({
    readPayload: () => ({ readable: true, baseSha: "b", headSha: "h", body: TRAILERLESS_BODY, headRefName: "feature/not-a-run-branch" }),
  });
  assert.equal(proof.code, 1);
  assert.match(proof.errors.join("\n"), /task identity read from the PR body \(no Remudero-Task trailer\) and the head ref/);
  assert.match(proof.errors.join("\n"), /the trailer must be in the PR body/);

  const overAllowance = runProofGate({ baseline: () => ({ [TASK]: 0 }) });
  assert.equal(overAllowance.code, 1);
  assert.match(overAllowance.errors.join("\n"), new RegExp(`Task identity was read from the run-shaped head ref "${RUN_REF}"`));
});

test("W1-T4206: a body trailer wins over the head ref, and a plan-only diff does not recover an identity", () => {
  const trailer = evaluateGate({
    body: "Remudero-Task: W1-T1\n",
    authorLogin: "a-human",
    headRefName: RUN_REF,
    trailerResolves: (id: string) => id === "W1-T1",
  });
  assert.equal(trailer.ok, true, trailer.message);
  assert.match(trailer.message, /Remudero-Task: W1-T1 trailer present/);

  const planOnly = evaluateGate({
    body: TRAILERLESS_BODY,
    authorLogin: "a-human",
    headRefName: RUN_REF,
    changedPaths: ["plan/tasks.d/W1-T9999-x.yaml"],
  });
  assert.equal(planOnly.ok, false);
  assert.match(planOnly.message, /a plan-only diff recovers no identity from the head ref/);
});
