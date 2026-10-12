import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { loadPlanFromYaml } from "../src/lib/plan.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

const script = fileURLToPath(new URL("../scripts/proof-resolve-precheck.mjs", import.meta.url));
const precheck = await import(new URL("../scripts/proof-resolve-precheck.mjs", import.meta.url).href);
const oldPath = "test/old-census.test.ts";
const newPath = "test/new-census.test.ts";
const proof = `grep: ^needle[0-9][0-9]$ in ${oldPath}`;
const claim = "the census names the admitted population";
const guidance = "a builder may not edit a merged criterion (Standing rule 15): name this in your PR body so the operator files the amendment";

function task(id = "W1-T1", status = "merged", acceptance = [{ claim, proof }]) {
  return { id, status, title: "census proof", repo: "remudero", type: "implement", verify: "auto", depends_on: [], attempts: 0, acceptance };
}

function plan(tasks = [task()]) {
  return loadPlanFromYaml(stringify(tasks), "fixture");
}

function put(repo: GitRepo, path: string, text: string) {
  mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
  writeFileSync(join(repo.dir, path), text);
}

function fixture(options: { planOnly?: boolean; rename?: boolean; unit?: boolean; blocking?: boolean; addedPath?: string; proofPath?: string } = {}) {
  const repo = gitRepo({ kind: "merged-proof-orphan" });
  repo.addRemote("origin", "https://github.com/craigoley/remudero.git");
  const removed = options.planOnly ? "plan/old-evidence.yaml" : oldPath;
  const added = options.addedPath ?? (options.planOnly ? "plan/new-evidence.yaml" : newPath);
  const criteria = [{ claim, proof: options.unit ? `unit test: ${removed}` : `grep: ^needle[0-9][0-9]$ in ${options.proofPath ?? removed}` }];
  const tasks = [task("W1-T1", "queued", criteria)];
  if (options.blocking) tasks.push(task("W1-T2", "queued", [{ claim: "a new test", proof: "unit test: test/missing.test.ts" }]));
  put(repo, "plan/tasks.yaml", stringify(tasks));
  const source = options.unit ? 'test("owner [literal] records its cause", () => {});\n' : "needle42\n";
  put(repo, removed, options.unit ? `// test("comment-only ownership", () => {});\n${source}` : source);
  repo.git("add", ".");
  repo.git("commit", "-qm", "base (#1)\n\nRemudero-Task: W1-T1");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  if (options.rename) renameSync(join(repo.dir, removed), join(repo.dir, added));
  else {
    rmSync(join(repo.dir, removed));
    put(repo, added, options.unit ? source : "replacement census\nneedle42\n");
  }
  put(repo, options.planOnly ? "plan/decoy.yaml" : "test/decoy.test.ts", options.unit
    ? `// ${source}\n/* ${source} */\ntest("owner l records its cause", () => {});\ntest("comment-only ownership", () => {});\n`
    : "^needle[0-9][0-9]$\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "head");
  return { repo, removed, added };
}

function run(repo: GitRepo, headRef = "feature", base = "origin/main") {
  const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), script, "--base", base, "--head-ref", headRef], {
    cwd: repo.dir, encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  return { status: result.status, output: result.stdout + result.stderr };
}

test("W1-T8001: a deleted file a merged proof names is reported", () => {
  assert.equal(typeof precheck.mergedProofOrphans, "function");
  const criteria = [
    { claim, proof },
    { claim: "the whole suite passes", proof: `unit test: ${oldPath}` },
    { claim: "a bare title names no file", proof: "unit test: census reports its population" },
    { claim: "unsafe targets are refused by the reviewer", proof: "grep: needle in ../old.ts" },
    { claim: "private criterion", proof, holdout: true },
  ];
  const rows = precheck.mergedProofOrphans({ plan: plan([task("W1-T1", "merged", criteria)]), removedPaths: [oldPath], addedFiles: [] });
  assert.deepEqual(rows, [
    { taskId: "W1-T1", claim, proof, removedPath: oldPath, candidates: [] },
    { taskId: "W1-T1", claim: criteria[1].claim, proof: criteria[1].proof, removedPath: oldPath, candidates: [] },
  ]);
  for (const path of [`./${oldPath}`, "test//old-census.test.ts"]) {
    const aliasedProof = `grep: ^needle[0-9][0-9]$ in ${path}`;
    assert.deepEqual(precheck.mergedProofOrphans({
      plan: plan([task("W1-T1", "merged", [{ claim, proof: aliasedProof }])]),
      removedPaths: [oldPath], addedFiles: [],
    }), [{ taskId: "W1-T1", claim, proof: aliasedProof, removedPath: oldPath, candidates: [] }]);
  }
  const { repo, removed, added } = fixture({ rename: true });
  try {
    assert.match(repo.git("diff", "--name-status", "-M", "origin/main...HEAD"), /R100/);
    const result = run(repo);
    assert.equal(result.status, 0, result.output);
    assert.ok(result.output.includes(removed) && result.output.includes(added), result.output);
    assert.ok(result.output.includes(claim) && result.output.includes("W1-T1"), result.output);
  } finally { repo.cleanup(); }
  const aliased = fixture({ proofPath: `./${oldPath}` });
  try {
    const result = run(aliased.repo);
    assert.equal(result.status, 0, result.output);
    assert.ok(result.output.includes(`removed: ${oldPath}`), result.output);
    assert.ok(result.output.includes(`candidates: ${newPath}`), result.output);
  } finally { aliased.repo.cleanup(); }
});

test("W1-T8001: the added file carrying the pattern is named as the re-point candidate", () => {
  const rows = precheck.mergedProofOrphans({
    plan: plan(), removedPaths: [oldPath],
    addedFiles: [{ path: newPath, matchingProofs: [proof] }, { path: "test/unrelated.test.ts", matchingProofs: [] }],
  });
  assert.deepEqual(rows[0].candidates, [newPath]);
  const { repo, added } = fixture();
  try {
    const result = run(repo);
    assert.equal(result.status, 0, result.output);
    const line = result.output.split("\n").find((line) => line.includes("merged proof orphan"));
    assert.ok(line, result.output);
    assert.ok(line.includes(`candidates: ${added}`), result.output);
    assert.ok(line.endsWith(guidance), line);
    assert.ok(!line.includes("decoy"), "a BRE match, not the literal regex text or an unrelated added file");
  } finally { repo.cleanup(); }
});

test("W1-T8001: the orphan report runs on every push and never blocks", () => {
  for (const options of [{}, { planOnly: true }]) {
    const { repo, removed } = fixture(options);
    try {
      for (const headRef of ["feature", "run-W1-T999-1"]) {
        const result = run(repo, headRef);
        assert.equal(result.status, 0, result.output);
        assert.ok(result.output.includes(`removed: ${removed}`), result.output);
        assert.ok(result.output.includes(guidance), result.output);
      }
    } finally { repo.cleanup(); }
  }
});

test("W1-T8001: only merged tasks are reported", () => {
  const tasks = [task("W1-T1"), ...["queued", "running", "blocked", "done"].map((status, i) => task(`W1-T${i + 2}`, status))];
  const rows = precheck.mergedProofOrphans({ plan: plan(tasks), removedPaths: [oldPath], addedFiles: [] });
  assert.deepEqual(rows.map((row: { taskId: string }) => row.taskId), ["W1-T1"]);
  assert.deepEqual(precheck.mergedProofOrphans({ plan: plan(), removedPaths: ["test/unrelated.test.ts"], addedFiles: [] }), []);
  const queried: string[] = [];
  const projected = precheck.mergedProofPlan({ plan: plan([
    task("W1-T1", "queued"), task("W1-T2", "merged"),
    task("W1-T3", "merged", [{ claim, proof: "grep: needle in test/untouched.test.ts" }]),
  ]), removedPaths: [oldPath] }, (id: string) => { queried.push(id); return id === "W1-T1"; });
  assert.deepEqual(queried, ["W1-T1", "W1-T2"]);
  assert.deepEqual(precheck.mergedProofOrphans({ plan: projected, removedPaths: [oldPath], addedFiles: [] })
    .map((row: { taskId: string }) => row.taskId), ["W1-T1"]);
});

test("merge evidence unions anchored PR trailers and owned merged branches", () => {
  const pr = { url: "https://github.com/craigoley/remudero/pull/1", state: "MERGED", headRefName: "feature" };
  const queries: string[] = [];
  const github = {
    findMergedByTrailerAll: (id: string) => { queries.push(`trailer:${id}`); return [pr]; },
    headRefName: () => "feature",
    prBody: () => "Remudero-Task: W1-T1\n",
    findMergedByHeadBranch: (id: string) => {
      queries.push(`branch:${id}`);
      return [
        { ...pr, headRefName: "run-W1-T2-123" },
        { ...pr, headRefName: "run-W1-T3-123", state: "OPEN" },
        { ...pr, headRefName: "run-W1-T30-123" },
      ];
    },
    readFailed: () => false,
  };
  const merged = precheck.mergedTaskResolver("unused", "unused", { commitCredits: new Map([["W1-T4", [pr]]]), github });
  assert.equal(merged("W1-T4"), true);
  assert.deepEqual([...queries], [], "the committed trailer index needs no GitHub reads");
  assert.equal(merged("W1-T1"), true);
  assert.deepEqual([...queries], ["trailer:W1-T1"], "an anchored trailer needs no branch fallback");
  assert.equal(merged("W1-T2"), true, "a merged branch credits a task without its trailer");
  assert.equal(merged("W1-T3"), false, "an open or prefix-colliding branch cannot credit a task");
  assert.ok(queries.includes("branch:W1-T2") && queries.includes("branch:W1-T3"));
  assert.equal(precheck.mergedTaskResolver("unused", "unused", {
    commitCredits: new Map(), github: { ...github, prBody: () => "mentions Remudero-Task: W1-T1 in prose\n" },
  })("W1-T1"), false, "a fuzzy body-search hit must carry the exact anchored trailer");
});

test("unavailable merge evidence is named rather than reported as an unmerged task", () => {
  const github = {
    findMergedByTrailerAll: () => [], headRefName: () => "feature", prBody: () => "",
    findMergedByHeadBranch: () => [], readFailed: () => false,
  };
  for (const broken of [
    { ...github, findMergedByTrailerAll: () => null },
    { ...github, readFailed: () => true },
    { ...github, findMergedByHeadBranch: () => null },
    { ...github, findMergedByTrailerAll: () => [{ state: "MERGED", url: "unreadable" }], headRefName: () => undefined },
    { ...github, findMergedByTrailerAll: () => [{ state: "MERGED", url: "unreadable" }], prBody: () => undefined },
  ]) {
    assert.throws(() => precheck.mergedTaskResolver("unused", "unused", {
      commitCredits: new Map(), github: broken,
    })("W1-T1"), /cannot (read|verify) merged PR/);
  }
  const repo = gitRepo({ kind: "unreadable-merge-credit" });
  try {
    repo.addRemote("origin", "https://github.com/craigoley/remudero.git");
    assert.throws(() => precheck.mergedTaskResolver(repo.dir, "refs/heads/absent")("W1-T1"), /cannot read merged commit trailers/);
  } finally { repo.cleanup(); }
});

test("a removed unit-test suite gets a candidate from literal test titles", () => {
  const { repo, added } = fixture({ unit: true });
  try {
    const result = run(repo);
    assert.equal(result.status, 0, result.output);
    const line = result.output.split("\n").find((line) => line.includes("merged proof orphan"));
    assert.ok(line, result.output);
    assert.ok(line.includes(`candidates: ${added}`), result.output);
    assert.ok(!line.includes("decoy"), "comments and regex interpretations of a literal title are not candidate tests");
  } finally { repo.cleanup(); }
});

test("unit-test replacement hints accept every file shape the reviewer recognizes", () => {
  for (const addedPath of ["test/replacement.spec.ts", "test/replacement.test.js", "test/replacement.spec.mjs"]) {
    const { repo, added } = fixture({ unit: true, addedPath });
    try {
      const result = run(repo);
      assert.equal(result.status, 0, result.output);
      const line = result.output.split("\n").find((line) => line.includes("merged proof orphan"));
      assert.ok(line?.includes(`candidates: ${added}`), result.output);
    } finally { repo.cleanup(); }
  }
});

test("an orphan without a replacement is still named and an existing title refusal still blocks", () => {
  const { repo } = fixture({ blocking: true });
  try {
    put(repo, newPath, "unrelated replacement\n");
    repo.git("commit", "-qam", "remove hint");
    const result = run(repo, "run-W1-T2-1");
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /merged proof orphan.*candidates: none/);
    assert.match(result.output, /WILL REFUSE 1/);
  } finally { repo.cleanup(); }
});

test("an unreadable diff or merged plan keeps the precheck's exit 2", () => {
  const { repo } = fixture();
  try {
    const missingBase = run(repo, "feature", "refs/heads/absent");
    assert.equal(missingBase.status, 2, missingBase.output);
    put(repo, "plan/tasks.yaml", "not a plan\n");
    repo.git("commit", "-qam", "unreadable plan");
    const brokenPlan = run(repo);
    assert.equal(brokenPlan.status, 2, brokenPlan.output);
    assert.match(brokenPlan.output, /could not read this head/);
  } finally { repo.cleanup(); }
});

test("replacement grep reads binary text and an unreadable replacement stays exit 2", () => {
  const { repo, added } = fixture();
  try {
    put(repo, added, "\0replacement census\nneedle42\n");
    repo.git("commit", "-qam", "binary replacement");
    const binary = run(repo);
    assert.equal(binary.status, 0, binary.output);
    assert.ok(binary.output.includes(`candidates: ${added}`), binary.output);
    rmSync(join(repo.dir, added));
    const unreadable = run(repo);
    assert.equal(unreadable.status, 2, unreadable.output);
    assert.match(unreadable.output, /cannot check replacement/);
  } finally { repo.cleanup(); }
});
