import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test, type TestContext } from "node:test";

import { COMMENT_ONLY_DISCRIMINATION_LINE } from "#src/lib/check-proof.js";
import {
  planPrPreflightAsync,
  planPrPreflightAtCommitAsync,
  type PlanPrPreflightAsyncChecks,
  type PlanPrPreflightResult,
  type ProofCheckStatus,
} from "#src/lib/plan-pr-emitter.js";
import {
  insertRefusalAmendment,
  refusalAmendmentComment,
  refusalAmendmentProof,
  type WorkerRefusal,
} from "#src/lib/refusal-amendment.js";
import {
  commentOnlyGrepProofRefusal,
  isRefusalAmendmentMarkerProof,
  judgeReview,
  parseWhitelistedProof,
  setProofSandboxForTests,
} from "#src/lib/review.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

before(() => setProofSandboxForTests({ mode: "unsandboxed", reason: "pinned: this suite grades proofs, not sandboxes" }));
after(() => setProofSandboxForTests());

const ID = "W1-T90609";
const REL = `plan/tasks.d/${ID}-a-fixture-task.yaml`;
const RUN = "work-fix-dispatch-W1-T90609-1700000000001-abcd@1234abcd";
const EARLIER_RUN = "work-fix-dispatch-W1-T90609-1700000000000-dcba@4321dcba";
const ONE: readonly WorkerRefusal[] = [{ criterion: 1, refusalClass: "premise-rotted", detail: "no line meets the condition" }];
const TWO: readonly WorkerRefusal[] = [...ONE, { criterion: 2, refusalClass: "premise-rotted", detail: "the named file is gone" }];
const GREEN = async () => ({ status: 0, output: "fixture check passed" });
const OTHER_CHECKS: PlanPrPreflightAsyncChecks = { lintPlan: GREEN, taskIdExistence: GREEN, shardCensus: GREEN };
const TITLE = `chore(plan): propose an amendment for ${ID} from its worker's refusal`;

/** Task records with and without a block scalar and a quoted scalar before `status:`. */
const LAYOUTS: Record<string, string> = {
  plain: [`- id: ${ID}`, "  repo: remudero", "  status: queued", "  attempts: 0", ""].join("\n"),
  block: [`- id: ${ID}`, "  repo: remudero", "  rationale: |", "    The first line of a block scalar.", "    Its second line.", "  status: queued", "  attempts: 0", ""].join("\n"),
  quoted: [`- id: ${ID}`, '  title: "A fixture task: it holds a colon, and a comma"', "  repo: remudero", '  note: "held: see the rationale"', "  status: queued", "  attempts: 0", ""].join("\n"),
  both: [
    `- id: ${ID}`,
    '  title: "A fixture task: it holds a colon, and a comma"',
    "  repo: remudero",
    "  files:",
    "    - src/lib/fixture.ts",
    "  acceptance:",
    '    - claim: "the fixture holds"',
    '      proof: "grep: fixture in src/lib/fixture.ts"',
    "  rationale: |",
    "    The first line of a block scalar.",
    "    Its second line.",
    '  note: "held: see the rationale"',
    "  status: queued",
    "  attempts: 0",
    "",
  ].join("\n"),
};

function stampAtMarkerLine(record: string): string {
  const line = record.split("\n").findIndex((l) => /^\s*status:/.test(l)) + 1;
  return `2026-11-24T03:${String(line).padStart(2, "0")}:01.000Z`;
}

function amended(record: string, runId: string, refusals: readonly WorkerRefusal[]): string {
  const text = insertRefusalAmendment(record, ID, refusalAmendmentComment(ID, runId, refusals, stampAtMarkerLine(record)));
  assert.ok(text !== undefined, "the record has a status line");
  return text;
}

function put(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
}

/** A checkout whose origin/main holds `base` and whose HEAD holds `head` on top of it. */
function baseAndHead(t: TestContext, base: Record<string, string>, head: Record<string, string>): { repo: GitRepo; head: string } {
  const repo = gitRepo({ scope: t, kind: "w1-t14609" });
  put(repo.dir, base);
  repo.git("add", "-A");
  repo.git("commit", "-q", "--allow-empty", "-m", "base");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  put(repo.dir, head);
  repo.git("add", "-A");
  repo.git("commit", "-q", "--allow-empty", "-m", "head");
  return { repo, head: repo.git("rev-parse", "HEAD") };
}

/** The real `rmd check-proof <proof> --base origin/main` child, run in `cwd`. */
function checkProofChild(cwd: string, proof: string): { code: number; out: string } {
  const run = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(REPO_ROOT, "src", "check-proof-main.ts"), proof, "--base", "origin/main"], {
    cwd, encoding: "utf8", timeout: 120_000,
  });
  assert.ifError(run.error);
  assert.notEqual(run.status, null, run.stderr);
  return { code: run.status!, out: run.stdout };
}

function grade(proof: string, head: Record<string, string>, base: Record<string, string>, t: TestContext) {
  const headDir = ownedFixtureDir(t, "w1-t14609-head").dir;
  const baseDir = ownedFixtureDir(t, "w1-t14609-base").dir;
  put(headDir, head);
  put(baseDir, base);
  const verdict = judgeReview([{ claim: "the record holds the amendment", proof }], {
    diff: "", report: "REPORT: unrelated words only.", headCheckoutDir: headDir, baseCheckoutDir: baseDir, baseIsCheckout: true,
  });
  return verdict.criteria[0]!;
}

const findingLines = (findings: PlanPrPreflightResult["failures"]): string[] =>
  [...new Set(findings.flatMap((f) => [f.firstLine, ...(f.lines ?? [])]))];
const patternOf = (proof: string): string => parseWhitelistedProof(proof)!.args[2]!;

test("W1-T14609 criterion 1: check-proof passes the marker proof when the base lacks the marker and refuses it with the base-stale line when the base holds it", (t) => {
  const proof = refusalAmendmentProof(ID, RUN, REL);
  for (const [layout, record] of Object.entries(LAYOUTS)) {
    for (const [count, refusals] of [["one", ONE], ["two", TWO]] as const) {
      const head = amended(record, RUN, refusals);
      if (count === "one") assert.equal(head.split("\n").filter((l) => /^\s*# /.test(l)).length, 3, "one refusal writes three comment lines");
      const { repo } = baseAndHead(t, { [REL]: record }, { [REL]: head });
      const run = checkProofChild(repo.dir, proof);
      assert.equal(run.code, 0, `${layout}/${count}: ${run.out}`);
      assert.match(run.out, /^discrimination: discriminates/m, `${layout}/${count}`);
      assert.ok(!run.out.includes(COMMENT_ONLY_DISCRIMINATION_LINE), `${layout}/${count}`);
    }
  }
  const earlier = amended(LAYOUTS.both!, EARLIER_RUN, ONE);
  const again = baseAndHead(t, { [REL]: earlier }, { [REL]: amended(earlier, RUN, ONE) });
  assert.equal(checkProofChild(again.repo.dir, proof).code, 0, "an earlier run's marker at the base does not hold this run's");
  for (const layout of ["plain", "both"]) {
    const done = amended(LAYOUTS[layout]!, RUN, ONE);
    const { repo } = baseAndHead(t, { [REL]: done }, { [REL]: done, "README.md": "moved\n" });
    const run = checkProofChild(repo.dir, proof);
    assert.equal(run.code, 5, `${layout}: ${run.out}`);
    assert.match(run.out, /^discrimination: executed_stale — this proof matches BOTH head and base/m, layout);
    assert.ok(!run.out.includes(COMMENT_ONLY_DISCRIMINATION_LINE), layout);
  }
});

test("W1-T14609 criterion 2: the plan-PR preflight passes a refusal amendment for an ops task and a public task, and review grades it by its base", async (t) => {
  const proof = refusalAmendmentProof(ID, RUN, REL);
  const body = `## Acceptance\n- the shard records the worker's refusal of ${ID} and the amendment it implies | ${proof}\n`;
  const record = LAYOUTS.both!;
  const head = amended(record, RUN, ONE);

  const ops = baseAndHead(t, { [REL]: record }, { [REL]: head });
  const opsResult = await planPrPreflightAtCommitAsync(ops.repo.dir, ops.head, { title: TITLE, body, codeRoot: REPO_ROOT, bodyProofRoot: "plan" }, OTHER_CHECKS);
  assert.equal(opsResult.ok, true, JSON.stringify(opsResult));
  assert.deepEqual(opsResult.unreadable, []);
  assert.equal(opsResult.failures.some((f) => f.check === "proof-discrimination"), false);

  const pub = baseAndHead(t, { [REL]: record }, { [REL]: head });
  const seen: string[] = [];
  const pubResult = await planPrPreflightAtCommitAsync(pub.repo.dir, pub.head, { title: TITLE, body }, {
    ...OTHER_CHECKS,
    checkProof: async (cwd, p) => { seen.push(p); return checkProofChild(cwd, p).code; },
  });
  assert.equal(pubResult.ok, true, JSON.stringify(pubResult));
  assert.deepEqual(seen, [proof]);

  const fresh = grade(proof, { [REL]: head }, { [REL]: record }, t);
  assert.equal(fresh.proof_exec, "executed_pass", fresh.reason);
  assert.equal(fresh.met, true);
  const stale = grade(proof, { [REL]: head }, { [REL]: head }, t);
  assert.equal(stale.proof_exec, "executed_stale");
  assert.doesNotMatch(stale.reason, /every executor-returned matching line is a comment/);
});

test("W1-T14609 criterion 3: invariant:other-comment-proofs-are-unchanged every other comment-only grep proof is refused as before", (t) => {
  const record = amended(LAYOUTS.both!.replace("  status: queued", "  # held by the operator until review\n  status: queued"), RUN, ONE);
  const outside = "plan/W1-T90609-notes.yaml";
  const files: Record<string, string> = {
    "src/lib/fixture.ts": "// fixture note as a comment\nexport const fixture = 1;\n",
    "learnings/ci.yaml": "- id: keeper\n  # gardener note: keep this one\n  lifecycle: active\n",
    [REL]: record,
    [outside]: record,
  };
  const proofs = [
    "grep: fixture note as a comment in src/lib/fixture.ts",
    "grep: gardener note: keep this one in learnings/ci.yaml",
    `grep: held by the operator until review in ${REL}`,
    refusalAmendmentProof(ID, RUN, outside),
    `grep: refusal-amendment (${ID}, in ${REL}`,
  ];
  const { repo } = baseAndHead(t, { "README.md": "base\n" }, files);
  for (const proof of proofs) {
    const parsed = parseWhitelistedProof(proof)!;
    const pattern = parsed.args[2]!;
    const path = parsed.args[3]!;
    assert.equal(isRefusalAmendmentMarkerProof(pattern, path), false, proof);
    assert.equal(
      commentOnlyGrepProofRefusal(proof, (rel) => files[rel]),
      `\`grep:\` pattern "${pattern.slice(0, 70)}" can only match comment text in ${path}, which review grades ` +
        "executed_stale (every matching line is a comment), so the criterion can never pass. Use a `unit test:` proof " +
        "or a grep on a code line the build adds.",
      proof,
    );
    const run = checkProofChild(repo.dir, proof);
    assert.equal(run.code, 5, `${proof}: ${run.out}`);
    assert.match(run.out, /^discrimination: executed_stale — every matching line is a comment$/m, proof);
    const graded = grade(proof, files, { "README.md": "base\n" }, t);
    assert.equal(graded.proof_exec, "executed_stale", proof);
    assert.match(graded.reason, /every executor-returned matching line is a comment/, proof);
  }
  const marker = patternOf(refusalAmendmentProof(ID, "run.1*[x]^$\\z?", REL));
  assert.equal(isRefusalAmendmentMarkerProof(marker, REL), true);
  assert.equal(isRefusalAmendmentMarkerProof(marker, "plan/tasks.d/nested/record.yml"), true);
  assert.equal(isRefusalAmendmentMarkerProof(marker, "plan/tasks.d/record.md"), false);
  assert.equal(isRefusalAmendmentMarkerProof(marker, `x${REL}`), false);
  assert.equal(isRefusalAmendmentMarkerProof(`refusal-amendment (${ID}, run ,`, REL), false, "an empty run");
  assert.equal(isRefusalAmendmentMarkerProof(`refusal-amendment (${ID}, run run.1,`, REL), false, "an unescaped run");
  assert.equal(isRefusalAmendmentMarkerProof(`refusal-amendment (${ID}, run ${RUN}, 2026`, REL), false, "a longer pattern");
});

test("W1-T14609 criterion 4: a comment-only PR-body proof names its cause, a base pass still reads passes at origin/main too, and injected numbers and shard lines are unchanged", async (t) => {
  const record = LAYOUTS.both!.replace("  status: queued", "  # held by the operator until review\n  status: queued");
  const commentOnly = `grep: held by the operator until review in ${REL}`;
  const atBase = `grep: repo: remudero in ${REL}`;
  const body = `## Acceptance\n- the note is held | ${commentOnly}\n- the repo is named | ${atBase}\n`;
  const real = baseAndHead(t, { [REL]: LAYOUTS.both! }, { [REL]: record });
  const result = await planPrPreflightAtCommitAsync(real.repo.dir, real.head, { title: TITLE, body, codeRoot: REPO_ROOT, bodyProofRoot: "plan" }, OTHER_CHECKS);
  assert.equal(result.ok, false);
  const lines = findingLines(result.failures);
  assert.ok(lines.includes(`PR-body proof ${JSON.stringify(commentOnly)} matches only comment lines`), lines.join("\n"));
  assert.ok(lines.includes(`PR-body proof ${JSON.stringify(atBase)} passes at origin/main too`), lines.join("\n"));
  assert.equal(lines.some((l) => l.includes(commentOnly) && l.includes("passes at origin/main too")), false);

  const shardProof = "grep: not-built-yet in src/later.ts";
  const filing = `- id: W1-T90610\n  repo: remudero\n  acceptance:\n    - claim: "later"\n      proof: "${shardProof}"\n  status: queued\n`;
  const filed = baseAndHead(t, { [REL]: LAYOUTS.plain! }, { "plan/tasks.d/W1-T90610-later.yaml": filing });
  const run = (status: (proof: string) => ProofCheckStatus) =>
    planPrPreflightAsync({ cwd: filed.repo.dir, title: TITLE, body: `## Acceptance\n- c | ${atBase}\n` }, { ...OTHER_CHECKS, checkProof: async (_cwd, p) => status(p) });
  for (const [exit, text] of [[1, "fails on this tree"], [2, "does not parse as a proof"], [3, "matches no tests"], [5, "passes at origin/main too"]] as const) {
    const injected = await run((p) => (p === atBase ? exit : 0));
    assert.deepEqual(findingLines(injected.failures), [`PR-body proof ${JSON.stringify(atBase)} ${text}`], String(exit));
  }
  const unreadable = await run((p) => (p === atBase ? 4 : 0));
  assert.deepEqual(findingLines(unreadable.unreadable).filter((l) => l.startsWith("PR-body")),
    [`PR-body proof ${JSON.stringify(atBase)} could not be checked (check-proof exit 4)`]);
  for (const status of [5, { commentOnly: true } as const]) {
    const shard = await run((p) => (p === shardProof ? status : 0));
    assert.deepEqual(findingLines(shard.failures), [`shard proof ${JSON.stringify(shardProof)} passes at origin/main too`], JSON.stringify(status));
  }
});
