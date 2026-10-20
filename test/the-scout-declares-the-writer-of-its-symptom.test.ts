import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import type { GardenCheckout, GardenerDeps } from "#src/lib/gardener.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";
import { scoutGardenSpec, scoutShard } from "#src/lib/scout-gardener.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ghShim } from "#test/helpers/gh-shim.js";

const symptom = { step: "inbox.draft_escalated", older: 2, newer: 3, total: 5, files: [] };

test("W1-T10261: a recon scout draft declares the file that writes its step", (t) => {
  const repo = gitRepo({ scope: t, kind: "scout-writer" });
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  };
  put("src/lib/inbox.ts", 'log("inbox.draft_escalated"); log(\'inbox.draft_escalated\');');
  put("scripts/inbox.ts", 'log(`inbox.draft_escalated`);');
  put("src/comment.ts", '// "inbox.draft_escalated"\nlog("prefix inbox.draft_escalated");');
  put("test/example.ts", 'log("inbox.draft_escalated");');
  repo.git("add", ".");
  put("src/untracked.ts", 'log("inbox.draft_escalated");');
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
  writeFileSync(join(repo.dir, "src/lib/inbox.ts"), 'log("inbox.draft_escalated");');
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
    if (n === 6) task.origin = "other:inbox.draft_escalated";
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
