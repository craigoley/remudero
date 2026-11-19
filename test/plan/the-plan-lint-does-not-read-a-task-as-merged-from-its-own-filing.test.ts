import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { loadPlan } from "#src/lib/plan.js";
import { buildCommitTrailerIndex, ghGateway, persistVerifiedCredit, projectPlan } from "#src/lib/status.js";
import { lintTask } from "#src/lib/task-linter.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const OWNER = "fixture";
const REPO = "remudero";
const TASKS = [
  { id: "W1-T101", slug: "file-a-task", path: "src/heartbeat.ts" },
  { id: "W1-T102", slug: "build-a-task", path: "src/worker.ts" },
  { id: "W1-T103", slug: "deliver-plan-text", path: "plan/claims.yaml" },
];

function history(t: TestContext) {
  const repo = gitRepo({ scope: t });
  repo.addRemote("origin", `https://github.com/${OWNER}/${REPO}.git`);
  const write = (path: string, body: string) => {
    const file = join(repo.dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  };
  const commit = (number: number, title: string, id?: string) => {
    repo.git("add", ".");
    repo.git("commit", "-qm", `${title} (#${number})`, ...(id ? ["-m", `Remudero-Task: ${id}`] : []));
    return repo.git("diff-tree", "--root", "-r", "--no-commit-id", "--name-only", "HEAD").split("\n");
  };
  const record = (task: (typeof TASKS)[number], amended = false) => {
    write(`plan/tasks.d/${task.id}-${task.slug}.yaml`, [
      `- id: ${task.id}`,
      `  title: ${task.slug.replaceAll("-", " ")}`,
      "  repo: remudero",
      "  type: implement",
      "  verify: auto",
      `  files: [${task.path}]`,
      "  status: queued",
      "  acceptance:",
      '    - claim: "the deliverable contains its marker"',
      `      proof: "grep: marker in ${task.path}"`,
      ...(amended ? [
        '    - claim: "the deliverable contains its second marker"',
        `      proof: "grep: second marker in ${task.path}"`,
      ] : []),
      "",
    ].join("\n"));
  };
  const [filing, built, planText] = TASKS;
  write("plan/tasks.yaml", "[]\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "start the plan");
  record(filing);
  const paths = new Map([[1, commit(1, "file the heartbeat task", filing.id)]]);
  record(built);
  record(planText);
  commit(2, "file the other tasks");
  write(built.path, "marker\n");
  paths.set(3, commit(3, "build the worker", built.id));
  write(planText.path, "marker\n");
  paths.set(4, commit(4, "deliver the declared plan text", planText.id));
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const planPath = join(repo.dir, "plan", "tasks.yaml");
  const base = loadPlan(planPath);
  for (const task of TASKS) record(task, true);
  const plan = loadPlan(planPath);

  const filesReads: number[] = [];
  const slug = `${OWNER}/${REPO}`;
  const gateway = (cwd: string | null = repo.dir) => {
    const options = {
      cwd: cwd ?? undefined,
      commitTrailerIndex: buildCommitTrailerIndex({ slug, cwd: repo.dir }),
      exec(args: string[]) {
        const endpoint = args.find((arg) => arg.startsWith(`repos/${slug}/pulls/`));
        const match = endpoint?.match(/\/pulls\/(\d+)(\/files)?$/);
        if (!match) return args[1]?.startsWith("search/") ? '{"items":[]}' : "[]";
        const number = Number(match[1]);
        if (match[2]) {
          filesReads.push(number);
          return paths.get(number)?.join("\n") ?? "";
        }
        const head = number === 1 ? `run-${filing.id}-1` : "operator-delivery";
        return JSON.stringify({ number, body: "", state: "closed", merged_at: "2026-11-16T12:00:00Z", head: { ref: head } });
      },
    };
    return ghGateway(OWNER, REPO, options);
  };
  const ledgerPath = join(repo.dir, "state", "ledger.ndjson");
  const projection = () => projectPlan(plan, {
    github: gateway(),
    ledgerPath,
    mergedPathsByPr: paths,
    writeCreditStore: () => {},
  });
  const lint = (cwd?: string | null) => {
    const statuses = projectPlan(plan, { github: gateway(cwd), ledgerPath, writeCreditStore: () => {} });
    const refused = new Set<string>();
    for (const task of plan.tasks) {
      const status = statuses.get(task.id);
      assert.ok(status && !status.indeterminate, `expected resolved credit for ${task.id}`);
      const baseTask = base.byId.get(task.id);
      assert.ok(baseTask, `expected a base record for ${task.id}`);
      const { violations } = lintTask(task, {
        postMergeAmendment: {
          statusResolvable: true,
          merged: status.merged,
          baseTask,
          baseAcceptance: baseTask.acceptance,
          followUpFiled: false,
        },
      });
      if (violations.some((violation) => violation.check === "post-merge-amendment" && violation.severity === "block")) {
        refused.add(task.id);
      }
    }
    return refused;
  };
  return { lint, projection, filesReads, ledgerPath };
}

test("W1-T13192 criterion 1 allows an amendment after the task's own filing commit", (t) => {
  const { lint } = history(t);
  assert.equal(lint().has(TASKS[0].id), false);
});

test("W1-T13192 criterion 2 agrees with the daemon projection over the same history", (t) => {
  const { lint, projection } = history(t);
  const projectedMerged = new Set([...projection()].filter(([, row]) => row.merged).map(([id]) => id));
  assert.deepEqual(projectedMerged, new Set(TASKS.slice(1).map((task) => task.id)));
  assert.deepEqual(lint(), projectedMerged);
});

test("W1-T13192 criterion 3 keeps code and declared plan text terminal using local paths", (t) => {
  const { lint, filesReads } = history(t);
  const refused = lint();
  assert.ok(refused.has(TASKS[1].id), "an amendment to built code is refused");
  assert.ok(refused.has(TASKS[2].id), "an amendment to delivered plan text is refused");
  assert.deepEqual(filesReads, [], "locally available paths need no GitHub files request");
});

test("a cached trailer credit from the filing is revalidated against the local commit", (t) => {
  const { lint, ledgerPath } = history(t);
  const pr = { number: 1, url: `https://github.com/${OWNER}/${REPO}/pull/1` };
  assert.equal(persistVerifiedCredit(ledgerPath, TASKS[0].id, pr, [TASKS[0].path]), "recorded");
  assert.equal(lint().has(TASKS[0].id), false);
});

test("an unreadable local merge history leaves the gateway's files fallback available", (t) => {
  const { lint, filesReads } = history(t);
  const otherRepo = gitRepo({ scope: t });
  otherRepo.addRemote("origin", `https://github.com/${OWNER}/${REPO}.git`);
  const refused = lint(otherRepo.dir);
  assert.ok(refused.has(TASKS[1].id));
  assert.ok(refused.has(TASKS[2].id));
  assert.deepEqual(filesReads, [3, 4]);
});

test("an injected GitHub transport needs an explicit checkout to use local merge paths", (t) => {
  const { lint, filesReads, ledgerPath } = history(t);
  const previous = process.cwd();
  process.chdir(dirname(dirname(ledgerPath)));
  try {
    const paths = ghGateway(OWNER, REPO).localMergedPaths?.(1);
    assert.deepEqual(paths, [`plan/tasks.d/${TASKS[0].id}-${TASKS[0].slug}.yaml`]);
    assert.ok(lint(null).has(TASKS[0].id));
    assert.deepEqual(filesReads, [3, 4]);
  } finally {
    process.chdir(previous);
  }
});
