import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse, stringify } from "yaml";
import { ciDependencyClosure, produceCiDependencyEvidence, readCiDependencyEvidence, type CiDependencyProducerContext } from "#scripts/lib/ci-dependency-evidence.mjs";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { parseTasksFromYaml } from "#src/lib/plan.js";
import { recordFilingRiskRuling } from "#src/lib/risk-judge.js";
import { taskRulingPin } from "#src/lib/task-linter.js";
import { lintPlanCommand } from "#src/run-task.js";

function fixture(t: TestContext) {
  const repo = gitRepo({ scope: t, kind: "hosted-dependency-producer" });
  const root = ownedFixtureDir(t, "hosted-dependency-artifact").dir;
  const put = (path: string, text: string) => writeFileSync(join(repo.dir, path), text);
  mkdirSync(join(repo.dir, "plan/tasks.d"), { recursive: true });
  mkdirSync(join(repo.dir, "src/lib"), { recursive: true }); mkdirSync(join(repo.dir, "test"));
  put("src/lib/subject.ts", "export const answer = 1;\n");
  put("test/proof.test.ts", 'import { test } from "node:test";test("hosted dependency fixture behavior",()=>{});\n');
  const record = (id: string, dependencies: string[]) => parseTasksFromYaml(`- id: ${id}\n  title: Hosted dependency fixture ${id}\n  repo: remudero\n  depends_on: [${dependencies.join(", ")}]\n  type: implement\n  verify: auto\n  risk: low\n  status: queued\n  attempts: 0\n  origin: fixture\n  files: [src/lib/subject.ts, test/proof.test.ts]\n  acceptance:\n    - claim: The dependency fixture behaves\n      proof: 'unit test: hosted dependency fixture behavior'\n`, "hosted-producer-fixture")[0]!;
  put("plan/tasks.yaml", stringify([record("ZZ-T1", [])]));
  repo.git("add", "."); repo.git("commit", "-qm", "test: committed dependency implementation");
  const base = repo.git("rev-parse", "HEAD");
  const filing = recordFilingRiskRuling({ ...record("ZZ-T2", ["ZZ-T1"]), author_class: "machine" as const },
    { verdict: "operator", action: "proceed", confidence: 1, reasons: ["isolated fixture ruling"], judgedAt: new Date(0).toISOString() }, taskRulingPin);
  put("plan/tasks.d/ZZ-T2-filing.yaml", stringify([filing]));
  repo.git("add", "."); repo.git("commit", "-qm", "test: machine filing with merged dependency");
  const context: CiDependencyProducerContext = { actions: true, repository: "fixture-owner/remudero",
    head: repo.git("rev-parse", "HEAD"), base, producerSha: base, producerJob: "commitlint",
    runId: "123", attempt: "2", nowMs: Date.now(), checkout: repo.dir };
  const pr = { number: 17, merged: true, state: "closed", merged_at: new Date(context.nowMs - 1000).toISOString(),
    html_url: "https://github.com/fixture-owner/remudero/pull/17", merge_commit_sha: base,
    base: { ref: "main", repo: { full_name: context.repository } }, body: "Remudero-Task: ZZ-T1",
    head: { ref: "run-ZZ-T1-1234" }, changed_files: 1 };
  const calls: string[] = [];
  const request = (path: string): unknown => {
    calls.push(path);
    if (path.startsWith("search/issues?")) return { incomplete_results: false, total_count: 1, items: [{ number: 17, pull_request: {} }] };
    if (path.endsWith("/pulls/17")) return pr;
    assert.match(path, /\/pulls\/17\/files\?per_page=100&page=1$/);
    return [{ filename: "src/lib/subject.ts" }];
  };
  let copies = 0;
  const consume = (produced: Awaited<ReturnType<typeof produceCiDependencyEvidence>>, expected = {}) => {
    const path = join(root, `evidence-${copies++}-${produced.digest}.json`);
    writeFileSync(path, produced.bytes, { mode: 0o400 });
    return readCiDependencyEvidence(path, { ...context, digest: produced.digest, maxAgeMs: 60000,
      runnerTemp: root, ...expected });
  };
  const lint = async (evidence: ReturnType<typeof readCiDependencyEvidence>["dependencyEvidence"], offline = true) => {
    const lines: string[] = [], original = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = (...parts: unknown[]) => void lines.push(parts.join(" "));
    try {
      const code = await lintPlanCommand(["--base", base], { repoRoot: repo.dir, dependencyEvidence: evidence,
        ...(offline ? { offline: true } : {
          loadConfig: () => { throw new Error("isolated fixture has no instance configuration"); },
          resolveOwnerRepo: () => ({ owner: "fixture-owner", repo: "remudero" }),
          openPlanShardSlugs: () => [],
        }) });
      return { code, text: lines.join("\n") };
    } finally { Object.assign(console, original); }
  };
  return { repo, root, put, context, pr, calls, request, consume, lint };
}

test("W1-T10258: hosted plan lint credits a merged dependency from same-run producer evidence", async t => {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  assert.ok(workflow.jobs.commitlint.steps.some((step: { id?: string }) => step.id === "dependency-evidence"),
    "dependency credit unavailable (UNKNOWN): the same-run producer step is absent");
  const f = fixture(t), before = f.repo.git("status", "--porcelain");
  const produced = await produceCiDependencyEvidence(f.context, { request: f.request });
  const receipt = f.consume(produced);
  assert.equal(receipt.state, "ready");
  assert.deepEqual(receipt.dependencyEvidence({ id: "ZZ-T1" }), { state: "merged" });
  const verdict = await f.lint(receipt.dependencyEvidence);
  assert.equal(verdict.code, 0, verdict.text);
  const online = await f.lint(receipt.dependencyEvidence, false);
  assert.equal(online.code, 0, online.text);
  assert.equal(f.calls.filter(path => path.startsWith("search/issues?")).length, 2, "trailer and branch corpora are both observed");
  assert.ok(f.calls.some(path => path.includes("/files?")), "merge status alone never grants implementation credit");
  assert.equal(f.repo.git("status", "--porcelain"), before, "producer cannot persist native credit or change the candidate");
});

test("W1-T10258: hosted plan lint keeps a dependency UNKNOWN without valid producer evidence", async t => {
  const f = fixture(t), produced = await produceCiDependencyEvidence(f.context, { request: f.request });
  for (const context of [{ digest: "0".repeat(64) }, { head: "a".repeat(40) }, { runId: "124" }, { attempt: "3" }]) {
    const receipt = f.consume(produced, context), verdict = await f.lint(receipt.dependencyEvidence);
    assert.equal(receipt.state, "unknown");
    assert.equal(verdict.code, 1, verdict.text);
    assert.match(verdict.text, /dependency credit unavailable \(UNKNOWN\)/);
  }
  const absent = readCiDependencyEvidence(join(f.root, "absent"), { ...f.context, digest: produced.digest,
    maxAgeMs: 60000, runnerTemp: f.root });
  const verdict = await f.lint(absent.dependencyEvidence);
  assert.equal(verdict.code, 1); assert.match(verdict.text, /dependency credit unavailable \(UNKNOWN\)/);
});

test("producer accepts the trailer and run-branch union but refuses non-merged, foreign, plan-only and unproven ancestry", async t => {
  const f = fixture(t);
  for (const patch of [{ body: "no trailer" }, { body: null }, { head: { ref: "other" } }]) {
    const produced = await produceCiDependencyEvidence(f.context, { request: path => path.endsWith("/pulls/17") ? { ...f.pr, ...patch } : f.request(path) });
    assert.equal(f.consume(produced).dependencyEvidence({ id: "ZZ-T1" }).state, "merged");
  }
  const invalid = [{ merged: false }, { state: "open" }, { body: {} }, { body: "Remudero-Task: ZZ-T10", head: { ref: "run-ZZ-T10-123" } },
    { html_url: "https://github.com/foreign/repo/pull/17" }, { base: { ref: "main", repo: { full_name: "foreign/repo" } } },
    { merge_commit_sha: "a".repeat(40) }, { changed_files: 0 }, { changed_files: 3001 },
    { merged_at: new Date(f.context.nowMs + 1000).toISOString() }];
  for (const patch of invalid) {
    const produced = await produceCiDependencyEvidence(f.context, { request: path => path.endsWith("/pulls/17") ? { ...f.pr, ...patch } : f.request(path) });
    assert.equal(f.consume(produced).dependencyEvidence({ id: "ZZ-T1" }).state, "unknown", JSON.stringify(patch));
  }
  const planOnly = await produceCiDependencyEvidence(f.context, { request: path => path.includes("/files?") ? [{ filename: "plan/tasks.d/ZZ-T1.yaml" }] : f.request(path) });
  assert.equal(f.consume(planOnly).dependencyEvidence({ id: "ZZ-T1" }).state, "unknown");
});

test("producer refuses partial API observations, changed checkout identity and invalid context", async t => {
  const f = fixture(t);
  for (const result of [null, { incomplete_results: true, total_count: 0, items: [] },
    { incomplete_results: false, total_count: 2, items: [{ number: 17, pull_request: {} }] },
    { incomplete_results: false, total_count: 1, items: [{ number: "17", pull_request: {} }] }]) {
    await assert.rejects(produceCiDependencyEvidence(f.context, { request: () => result }), /search incomplete or malformed/);
  }
  for (const files of [[], [{}], [{ filename: "" }]]) {
    await assert.rejects(produceCiDependencyEvidence(f.context, { request: path => path.includes("/files?") ? files : f.request(path) }), /changed-file evidence incomplete/);
  }
  for (const patch of [{ actions: false }, { repository: "../repo" }, { producerSha: "a".repeat(40) },
    { runId: "0" }, { attempt: "0" }, { nowMs: -1 }, { producerJob: "other" }]) {
    await assert.rejects(produceCiDependencyEvidence({ ...f.context, ...patch }), /context unavailable or malformed/);
  }
  await assert.rejects(produceCiDependencyEvidence({ ...f.context, head: f.context.base }), /checkout identity changed/);
});

test("producer reads the full changed-file population before granting credit", async t => {
  const f = fixture(t), pages: string[] = [];
  const produced = await produceCiDependencyEvidence(f.context, { request: path => {
    if (path.endsWith("/pulls/17")) return { ...f.pr, changed_files: 101 };
    if (path.includes("/files?")) {
      pages.push(path);
      return Array.from({ length: path.endsWith("page=1") ? 100 : 1 }, (_, index) => ({ filename: `src/population-${pages.length}-${index}.ts` }));
    }
    return f.request(path);
  } });
  assert.equal(pages.length, 2); assert.equal(f.consume(produced).dependencyEvidence({ id: "ZZ-T1" }).state, "merged");
});

test("producer carries subtract-only rulings and refuses malformed committed rulings", async t => {
  const f = fixture(t);
  f.put("plan/credit-overrides.yaml", '- task: ZZ-T1\n  pr: 17\n  action: remove-credit\n  reason: isolated fixture ruling\n  author_class: operator\n');
  f.repo.git("add", "."); f.repo.git("commit", "-qm", "test: subtractive ruling");
  f.context.head = f.repo.git("rev-parse", "HEAD");
  const produced = await produceCiDependencyEvidence(f.context, { request: f.request });
  assert.equal(f.consume(produced).dependencyEvidence({ id: "ZZ-T1" }).state, "unknown");
  for (const text of ["[broken", '- task: ZZ-T1\n  pr: 17\n  action: grant-credit\n']) {
    f.put("plan/credit-overrides.yaml", text); f.repo.git("add", "."); f.repo.git("commit", "-qm", "test: invalid ruling");
    assert.throws(() => ciDependencyClosure(f.repo.dir, f.repo.git("rev-parse", "HEAD"), f.context.base), /override ruling unreadable or malformed/);
  }
});

test("producer dependency closure is transitive, bounded and unavailable tasks never become empty evidence", async t => {
  const f = fixture(t);
  assert.deepEqual(ciDependencyClosure(f.repo.dir, f.context.head, f.context.base).taskIds, ["ZZ-T1"]);
  const unchanged = await produceCiDependencyEvidence({ ...f.context, base: f.context.head, producerSha: f.context.head },
    { request: () => assert.fail("no changed machine filing has no API population to inspect") });
  assert.deepEqual(JSON.parse(unchanged.bytes).taskIds, []);
  const original = readFileSync(join(f.repo.dir, "plan/tasks.d/ZZ-T2-filing.yaml"), "utf8");
  const [task] = parse(original);
  f.put("plan/tasks.d/ZZ-T2-filing.yaml", stringify([{ ...task, depends_on: ["ZZ-T404"] }]));
  f.repo.git("add", "."); f.repo.git("commit", "-qm", "test: missing dependency");
  assert.throws(() => ciDependencyClosure(f.repo.dir, f.repo.git("rev-parse", "HEAD"), f.context.base), /dependency task absent|depends_on unknown task/);
  const tasks = Array.from({ length: 33 }, (_, index) => ({ ...task, id: `ZZ-T${100 + index}`, depends_on: [] }));
  f.put("plan/tasks.yaml", stringify(tasks));
  f.put("plan/tasks.d/ZZ-T2-filing.yaml", stringify([{ ...task, depends_on: tasks.map(row => row.id) }]));
  f.repo.git("add", "."); f.repo.git("commit", "-qm", "test: dependency population exceeds consumer bound");
  assert.throws(() => ciDependencyClosure(f.repo.dir, f.repo.git("rev-parse", "HEAD"), f.context.base), /exceeds the consumer bound/);
});

test("producer default transport executes real GET-only gh children and never silently recovers an API failure", async t => {
  const f = fixture(t), shim = ghShim([
    { when: "/pulls/17/files", stdout: JSON.stringify([{ filename: "src/lib/subject.ts" }]) },
    { when: "/pulls/17", stdout: JSON.stringify(f.pr) },
    { when: "search/issues?", stdout: JSON.stringify({ incomplete_results: false, total_count: 1, items: [{ number: 17, pull_request: {} }] }) },
  ]);
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  try {
    const produced = await produceCiDependencyEvidence(f.context);
    assert.equal(f.consume(produced).dependencyEvidence({ id: "ZZ-T1" }).state, "merged");
    assert.equal(shim.calls().length, 4);
    assert.ok(shim.calls().every(call => call.startsWith("api --method GET ")));
    shim.addRoute({ when: "search/issues?", exit: 1, stderr: "fixture: API unavailable" });
    await assert.rejects(produceCiDependencyEvidence(f.context), /fixture: API unavailable/);
  } finally { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; }
});

test("hosted wiring seals protected-base evidence before candidate code and retains online lint and unconditional required matrices", () => {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const job = workflow.jobs.commitlint, steps = job.steps as Array<{ name?: string; id?: string; run?: string; with?: Record<string, unknown> }>;
  const producer = steps.findIndex(step => step.id === "dependency-evidence"), install = steps.findIndex(step => step.id === "install");
  assert.ok(producer >= 0 && producer < install);
  assert.match(steps[producer]!.run!, /git archive "\$dependency_base"/);
  assert.match(steps[producer]!.run!, /npm ci --ignore-scripts/);
  assert.doesNotMatch(steps[producer]!.run!, /cp -al node_modules|import\(['"]\.\/scripts/);
  assert.match(steps[producer]!.run!, /protected base has no qualified dependency producer/);
  const lint = steps.find(step => step.id === "lint-plan")!.run!;
  assert.match(lint, /lintPlanCommand\(args,/);
  assert.match(lint, /ciDependencyEvidenceForInvocation\(args\)/);
  assert.doesNotMatch(lint, /offline:/);
  assert.deepEqual(workflow.jobs.ci.needs, ["commitlint"]);
  assert.equal(workflow.jobs.ci.if, "${{ always() && !cancelled() }}");
  assert.match(workflow.jobs.ci.env.RMD_CI_DEPENDENCY_DIGEST, /needs\.commitlint\.outputs\.dependency_digest/);
  assert.ok(workflow.jobs.ci.steps.some((step: { run?: string }) => step.run?.includes('gh run download "$GITHUB_RUN_ID"') &&
    step.run.includes('ci-dependency-evidence-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}')));
});

test("the protected-base producer loader ignores candidate configuration", t => {
  const root = ownedFixtureDir(t, "hosted-producer-loader").dir;
  const runtime = join(root, "trusted"), candidate = join(root, "candidate"), marker = join(root, "candidate-executed");
  mkdirSync(join(runtime, "node_modules/tsx/dist"), { recursive: true }); mkdirSync(candidate);
  writeFileSync(join(runtime, "package.json"), '{"type":"module"}');
  writeFileSync(join(candidate, "package.json"), '{"type":"module"}');
  writeFileSync(join(runtime, "node_modules/tsx/dist/loader.mjs"), `import ${JSON.stringify(import.meta.resolve("tsx"))};\n`);
  writeFileSync(join(runtime, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "fixture-binding": ["./binding.ts"] } } }));
  writeFileSync(join(runtime, "binding.ts"), 'export const value = "trusted";\n');
  writeFileSync(join(runtime, "producer.ts"), 'export { value } from "fixture-binding";\n');
  writeFileSync(join(candidate, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "fixture-binding": ["./binding.ts"] } } }));
  writeFileSync(join(candidate, "binding.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed"); export const value = "candidate";\n`);
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const run = workflow.jobs.commitlint.steps.find((step: { id?: string }) => step.id === "dependency-evidence").run as string;
  const command = run.split("\n").find(line => line.includes('node --import "$dependency_runtime/node_modules/tsx/dist/loader.mjs"'));
  assert.ok(command, "the actual protected-runtime loader invocation must exist");
  const invocation = command.trim().replace(/ <<'NODE'$/, "");
  const input = 'import { pathToFileURL } from "node:url"; const { value } = await import(pathToFileURL(process.argv[2] + "/producer.ts").href); console.log(value);';
  const observe = (line: string) => execFileSync("bash", ["-euo", "pipefail", "-c", `${line} <<'PROBE'\n${input}\nPROBE`], {
    cwd: candidate, encoding: "utf8", env: { ...process.env, TSX_TSCONFIG_PATH: undefined,
      dependency_runtime: runtime, dependency_base: "a".repeat(40), dependency_dir: root },
    // BACKSTOP: terminate a loader probe that never exits.
    timeout: 30_000,
  }).trim();
  const unpinned = invocation.replace(/^TSX_TSCONFIG_PATH="\$dependency_runtime\/tsconfig\.json"\s+/, "");
  assert.equal(observe(unpinned), "candidate", "positive control: the checkout configuration redirects the real loader");
  assert.equal(existsSync(marker), true); rmSync(marker);
  assert.equal(observe(invocation), "trusted");
  assert.equal(existsSync(marker), false, "candidate code must never run in the protected producer");
});


test("hosted dependency paths initialize at runner step scope before evidence consumption", t => {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const ci = workflow.jobs.ci;
  assert.doesNotMatch(JSON.stringify(ci.env), /\$\{\{\s*runner[.]/,
    "runner context is unavailable in a job-level environment");
  const steps = ci.steps as Array<{ id?: string; if?: string; run?: string }>;
  const index = steps.findIndex(step => step.id === "dependency-evidence-path");
  const download = steps.findIndex(step => step.run?.includes('gh run download "$GITHUB_RUN_ID"'));
  assert.ok(index >= 0 && index < download, "the runner path must exist before any evidence consumption");
  assert.equal(steps[index]!.if, undefined, "missing producer evidence must retain its fail-closed path");
  const root = ownedFixtureDir(t, "dependency path with spaces").dir;
  const envFile = join(root, "github-env");
  execFileSync("bash", ["-euo", "pipefail", "-c", steps[index]!.run!], {
    env: { ...process.env, RUNNER_TEMP: root, GITHUB_ENV: envFile },
  });
  assert.equal(readFileSync(envFile, "utf8"),
    `RMD_CI_DEPENDENCY_EVIDENCE=${root}/ci-dependency-evidence/evidence.json\n`);
});
