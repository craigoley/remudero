import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import type { GardenCheckout, GardenerDeps } from "#src/lib/gardener.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";
import { scoutGardenSpec, scoutShard } from "#src/lib/scout-gardener.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const symptom = { step: "inbox.draft_error", older: 2, newer: 3, total: 5, files: [] };

test("scout writer discovery finishes after nested templates and ignores later comment literals", (t) => {
  const repo = gitRepo({ scope: t, kind: "scout-template-writer" });
  mkdirSync(join(repo.dir, "src"), { recursive: true });
  mkdirSync(join(repo.dir, "scripts"), { recursive: true });
  writeFileSync(join(repo.dir, "scripts/hash.sh"), '# "inbox.draft_error" is comment data');
  const template = 'const value = `outer ${flag ? { nested: `inner ${name}` } : {}} tail`;\n';
  writeFileSync(join(repo.dir, "src/comment.ts"), template + '/** `## Acceptance` "inbox.draft_error" */\n');
  writeFileSync(join(repo.dir, "src/regex.ts"), 'const pattern = /"inbox.draft_error"/;\n');
  writeFileSync(join(repo.dir, "src/writer.ts"), template + '/** `## Acceptance` "inbox.draft_error" */\nconst after = `before ${name} after`;\n// "inbox.draft_error" is comment data\nlog("inbox.draft_error");\n');
  repo.git("add", "src", "scripts");
  const moduleUrl = new URL("../src/lib/scout-gardener.ts", import.meta.url).href;
  const shellText = '# "inbox.draft_error" is comment data\nprintf "inbox.draft_error"\n';
  const program = `import { scoutShard, countScoutStepLiterals } from ${JSON.stringify(moduleUrl)};
    import { createScanner, SyntaxKind } from "typescript/unstable/ast";
    const result = scoutShard(${JSON.stringify(symptom)}, "W1-T99000", [5], ${JSON.stringify(repo.dir)});
    const shellCount = countScoutStepLiterals("scripts/writer.sh", ${JSON.stringify(shellText)}, "inbox.draft_error");
    const scanner = createScanner(true, undefined, "");
    Object.assign(scanner, { scan: () => SyntaxKind.Unknown, getTokenEnd: () => 0, getTokenStart: () => 0 });
    let refusal;
    try { countScoutStepLiterals("src/nonprogress.ts", "", "inbox.draft_error", scanner); }
    catch (error) { refusal = String(error); }
    process.stdout.write(JSON.stringify({ ...result, refusal, shellCount }));`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], {
    cwd: REPO_ROOT, encoding: "utf8", timeout: 10_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout) as { text: string; refused?: string; refusal?: string; shellCount: number };
  assert.equal(result.refused, undefined);
  assert.equal(result.shellCount, 1, "shell comments are ignored while quoted command arguments remain writers");
  assert.match(result.refusal ?? "", /source scanner did not advance in src\/nonprogress\.ts at 0/);
  const task = loadPlanFromYaml(result.text, "template-draft.yaml").tasks[0]!;
  assert.deepEqual(task.files?.slice(0, -1), ["src/writer.ts"], "the real writer survives; comment and regex data are not writers");
});

test("W1-T10261: a recon scout draft declares the file that writes its step", (t) => {
  const repo = gitRepo({ scope: t, kind: "scout-writer" });
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  };
  put("src/lib/inbox.ts", 'log("inbox.draft_error"); log(\'inbox.draft_error\');');
  put("scripts/inbox.ts", 'log(`inbox.draft_error`);');
  put("src/comment.ts", '// "inbox.draft_error"\nlog("prefix inbox.draft_error");');
  put("test/example.ts", 'log("inbox.draft_error");');
  repo.git("add", ".");
  put("src/untracked.ts", 'log("inbox.draft_error");');
  const draft = scoutShard(symptom, "W1-T99001", [5], repo.dir);
  assert.equal(draft.refused, undefined);
  const task = loadPlanFromYaml(draft.text, "draft.yaml").tasks[0]!;
  assert.deepEqual(task.files?.slice(0, -1), ["src/lib/inbox.ts", "scripts/inbox.ts"]);
  assert.match(task.files!.at(-1)!, /\/scout-.*\.test\.ts$/);
  assert.equal(task.author_class, "machine");
  assert.equal(task.verify, "human");
  const named = scoutShard({ ...symptom, files: ["src/named.ts"] }, "W1-T99002", [5], repo.dir);
  assert.deepEqual(loadPlanFromYaml(named.text, "named.yaml").tasks[0]!.files?.slice(0, -1), ["src/named.ts"]);
  const now = Date.now();
  const spec = scoutGardenSpec({ repoRoot: repo.dir, stateDir: repo.dir, clock: fixedClock(now), log: () => {},
    openWorkspace: () => { throw new Error("unused"); } }, {
    mintTaskId: () => "W1-T99004", plan: () => ({ open: [], all: [], shards: new Map() }),
    mergedTasks: () => new Map(), mergedLastDay: () => 1,
    ledger: () => [1, 5].map((days) => ({ step: symptom.step, ts: new Date(now - days * 86_400_000).toISOString() })),
  });
  const inv = spec.inventory();
  const landed = spec.apply({ root: repo.dir, branch: "scout-filing" } as GardenCheckout,
    { actions: spec.candidates(inv, () => 0), acting: ["file-uncovered-symptom"] }, {});
  const filed = loadPlanFromYaml(readFileSync(join(repo.dir, landed!.paths[0]!), "utf8"), "filed.yaml").tasks[0]!;
  assert.deepEqual(filed.files, task.files);
  assert.equal(filed.verify, "human");
});

test("W1-T10261: a scout draft with no locatable writer keeps its test-only shape", (t) => {
  const repo = gitRepo({ scope: t, kind: "scout-no-writer" });
  assert.deepEqual(scoutShard(symptom, "W1-T99003", [5], repo.dir), scoutShard(symptom, "W1-T99003", [5]));
  assert.equal(loadPlanFromYaml(scoutShard(symptom, "W1-T99003", [5], repo.dir).text, "draft.yaml").tasks[0]!.files!.length, 1);
});

test("W1-T10261: queued test-only scout drafts gain their writer and return to the judge", async (t) => {
  const repo = gitRepo({ scope: t, kind: "scout-rederive" });
  repo.addRemote("origin", "https://github.com/fixture/scout.git");
  mkdirSync(join(repo.dir, "src/lib"), { recursive: true });
  writeFileSync(join(repo.dir, "src/lib/inbox.ts"), 'log("inbox.draft_error");');
  repo.git("add", "src");
  mkdirSync(join(repo.dir, "plan/tasks.d"), { recursive: true });
  const texts = new Map<string, string>();
  const tasks = [1, 2, 3, 4, 5, 6].map((n) => {
    const id = `W1-T9901${n}`;
    let text = scoutShard(symptom, id, [5]).text.replace("  verify: human", "  verify: auto")
      .replace("  attempts: 0", `  attempts: ${n === 3 ? 1 : 0}`)
      .replace("  status: queued", `  status: ${n === 4 ? "done" : "queued"}`);
    if (n === 1) text += `  risk_ruling:\n    verdict: low\n    action: proceed\n    confidence: 0.9\n    reasons: ["fixture"]\n    judged_at: "2026-10-01T00:00:00Z"\n    pin: "${"a".repeat(64)}"\n`;
    const path = `plan/tasks.d/${id}.yaml`;
    texts.set(path, text);
    writeFileSync(join(repo.dir, path), text);
    const task = loadPlanFromYaml(text, path).tasks[0]!;
    if (n === 5) task.files!.unshift("src/already.ts");
    if (n === 6) task.origin = "other:inbox.draft_error";
    return task;
  });
  const deps: GardenerDeps = {
    repoRoot: repo.dir, stateDir: repo.dir, clock: fixedClock(Date.now()), log: () => {},
    openWorkspace: () => { throw new Error("unused"); },
  };
  let active = new Set([tasks[1]!.id]);
  const sources = {
    mintTaskId: () => { throw new Error("a re-derived draft keeps its id"); },
    plan: () => ({ all: tasks, open: tasks.filter((x) => x.status === "queued"), shards: new Map(tasks.map((x) => [x.id, `plan/tasks.d/${x.id}.yaml`])) }),
    ledger: () => [], mergedTasks: () => new Map(), mergedLastDay: () => 0,
    openRunTasks: () => active,
  };
  const spec = scoutGardenSpec(deps, sources);
  const inv = spec.inventory();
  assert.equal(spec.unfinished!(inv), true);
  const actions = spec.candidates(inv, () => 0);
  assert.equal(actions.length, 1);
  const ws = { root: repo.dir, branch: "scout-garden-test" } as GardenCheckout;
  // A run PR opened after inventory also prevents rewriting.
  active = new Set([tasks[0]!.id, tasks[1]!.id]);
  assert.equal(spec.apply(ws, { actions, acting: ["file-uncovered-symptom"] }, {}), undefined);
  active.delete(tasks[0]!.id);
  const path = `plan/tasks.d/${tasks[0]!.id}.yaml`;
  writeFileSync(join(repo.dir, path), texts.get(path)!.replace("  status: queued", "  status: done"));
  assert.equal(spec.apply(ws, { actions, acting: ["file-uncovered-symptom"] }, {}), undefined);
  writeFileSync(join(repo.dir, path), texts.get(path)!);
  const landed = spec.apply(ws, { actions, acting: ["file-uncovered-symptom"] }, {});
  assert.deepEqual(landed!.paths, [path]);
  const rewritten = loadPlanFromYaml(readFileSync(join(repo.dir, path), "utf8"), path).tasks[0]!;
  assert.deepEqual(rewritten.files, ["src/lib/inbox.ts", tasks[0]!.files![0]!]);
  assert.equal(rewritten.verify, "human");
  assert.equal(rewritten.author_class, "machine");
  assert.equal(rewritten.risk_ruling, undefined);
  assert.deepEqual(rewritten.acceptance, tasks[0]!.acceptance);
  for (const [other, text] of texts) if (other !== path) assert.equal(readFileSync(join(repo.dir, other), "utf8"), text);
  const shim = ghShim([{ when: "pulls?state=open&per_page=100", stdout: `run-${tasks[1]!.id}-123\nrun-${tasks[0]!.id}-456` }]);
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const oldPath = process.env.PATH;
  t.after(() => { process.env.PATH = oldPath; });
  process.env.PATH = `${shim.dir}:${oldPath}`;
  const defaultSpec = scoutGardenSpec(deps, { ...sources, openRunTasks: undefined });
  assert.throws(() => defaultSpec.inventory(), /requires an awaited open-run listing/);
  assert.deepEqual(defaultSpec.candidates(await defaultSpec.inventoryAsync!(), () => 0), []);
  assert.match(shim.calls()[0]!, /api --paginate .*pulls\?state=open&per_page=100 --jq/);
  assert.throws(() => defaultSpec.prepare!(ws, { actions, acting: ["file-uncovered-symptom"] }, false), /awaited open-run listing/);
  writeFileSync(join(repo.dir, path), texts.get(path)!);
  await defaultSpec.prepare!(ws, { actions, acting: ["file-uncovered-symptom"] }, true);
  assert.equal(defaultSpec.apply(ws, { actions, acting: ["file-uncovered-symptom"] }, {}), undefined);
  assert.equal(readFileSync(join(repo.dir, path), "utf8"), texts.get(path));
  shim.addRoute({ when: "pulls?state=open", stdout: `run-${tasks[1]!.id}-123` });
  await defaultSpec.prepare!(ws, { actions, acting: ["file-uncovered-symptom"] }, true);
  assert.deepEqual(defaultSpec.apply(ws, { actions, acting: ["file-uncovered-symptom"] }, {})!.paths, [path]);
  assert.equal(loadPlanFromYaml(readFileSync(join(repo.dir, path), "utf8"), path).tasks[0]!.verify, "human");
  repo.git("remote", "set-url", "origin", "not-a-repository");
  await assert.rejects(defaultSpec.inventoryAsync!(), /origin does not identify a GitHub repository/);
  repo.git("remote", "set-url", "origin", "https://github.com/fixture/scout.git");
  shim.addRoute({ when: "pulls?state=open", stderr: "cannot read open runs", exit: 7 });
  await assert.rejects(defaultSpec.inventoryAsync!(), /cannot read open runs/);
});


test("the scout preserves an operator-ratified test-only contract", t => {
  const repo = gitRepo({ scope: t, kind: "scout-ratified-contract" });
  mkdirSync(join(repo.dir, "src/lib"), { recursive: true });
  writeFileSync(join(repo.dir, "src/lib/inbox.ts"), 'log("inbox.draft_error");');
  repo.git("add", "src");
  const original = scoutShard(symptom, "W1-T99051", [5]).text +
    '  risk_ruling:\n    verdict: operator\n    action: proceed\n    confidence: 1\n    reasons: ["explicit existing operator decision"]\n';
  const path = "plan/tasks.d/W1-T99051.yaml";
  mkdirSync(join(repo.dir, "plan/tasks.d"), { recursive: true });
  writeFileSync(join(repo.dir, path), original);
  const task = loadPlanFromYaml(original, path).tasks[0]!;
  const spec = scoutGardenSpec({ repoRoot: repo.dir, stateDir: repo.dir, clock: fixedClock(Date.now()), log: () => {},
    openWorkspace: () => { throw new Error("unused"); } }, {
    mintTaskId: () => { throw new Error("no new task requested"); },
    plan: () => ({ all: [task], open: [task], shards: new Map([[task.id, path]]) }),
    ledger: () => [], mergedTasks: () => new Map(), mergedLastDay: () => 0, openRunTasks: () => new Set(),
  });
  assert.deepEqual(spec.candidates(spec.inventory(), () => 0), [], "operator scope is not an unratified draft to rederive");
  assert.equal(readFileSync(join(repo.dir, path), "utf8"), original);
});

test("an inadmissible scout rescope leaves its contract intact and does not poison an independent filing", t => {
  const repo = gitRepo({ scope: t, kind: "scout-independent-admission" });
  const step = "verify_human.release_escalated";
  mkdirSync(join(repo.dir, "src/lib"), { recursive: true });
  for (const file of ["verify-human-judge", "verify-human-release"]) {
    writeFileSync(join(repo.dir, `src/lib/${file}.ts`), `log(${JSON.stringify(step)});`);
  }
  writeFileSync(join(repo.dir, "src/lib/inbox.ts"), 'log("inbox.draft_error");');
  repo.git("add", "src");
  const original = scoutShard({ ...symptom, step }, "W1-T99052", [5]).text.replace("  risk: high", "  risk: low");
  const path = "plan/tasks.d/W1-T99052.yaml";
  mkdirSync(join(repo.dir, "plan/tasks.d"), { recursive: true });
  writeFileSync(join(repo.dir, path), original);
  const task = loadPlanFromYaml(original, path).tasks[0]!;
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const spec = scoutGardenSpec({ repoRoot: repo.dir, stateDir: repo.dir, clock: fixedClock(Date.now()),
    log: (step, fields = {}) => rows.push({ step, fields }), openWorkspace: () => { throw new Error("unused"); } }, {
    mintTaskId: () => { throw new Error("the filing uses its reserved id"); },
    plan: () => ({ all: [task], open: [task], shards: new Map([[task.id, path]]) }),
    ledger: () => [], mergedTasks: () => new Map(), mergedLastDay: () => 0, openRunTasks: () => new Set(),
  });
  const rederived = spec.candidates(spec.inventory(), () => 0);
  assert.equal(rederived.length, 1);
  const fresh = { class: "file-uncovered-symptom" as const, target: symptom.step, origin: "scout:inbox.draft_error",
    symptom: { ...symptom, files: ["src/lib/inbox.ts"] }, reason: "independent fixture symptom" };
  const landing = spec.apply({ root: repo.dir, branch: "scout-independent" } as GardenCheckout,
    { actions: [...rederived, fresh], acting: ["file-uncovered-symptom"] }, {}, ["W1-T99053"]);
  assert.ok(landing);
  assert.equal(readFileSync(join(repo.dir, path), "utf8"), original, "the refused rescope never overwrites its prior contract");
  assert.equal(landing.paths.length, 1, "only the independent admissible record may reach landing");
  assert.ok(!landing.paths.includes(path));
  assert.equal(spec.landingRefusal!(repo.dir, landing.paths), undefined, "the real unchanged final filing gate admits exactly the retained record");
  assert.ok(rows.some(r => r.step === "scout.record_refused" && r.fields.task_id === task.id && /sizing/.test(String(r.fields.reason))));
});
