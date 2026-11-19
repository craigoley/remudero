import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Config } from "#src/lib/config.js";
import { loadPlan } from "#src/lib/plan.js";
import { buildCommitTrailerIndex, ghGateway, persistVerifiedCredit, projectPlan } from "#src/lib/status.js";
import { lintPlanCommand, planLintOutcomeFromOutput } from "#src/run-task.js";
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
  for (const task of TASKS) record(task, true);

  const filesReads: number[] = [];
  const slug = `${OWNER}/${REPO}`;
  const gateway = (cwd = repo.dir) => {
    const options = {
      cwd,
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
  const projection = () => projectPlan(loadPlan(join(repo.dir, "plan", "tasks.yaml")), {
    github: gateway(),
    ledgerPath,
    mergedPathsByPr: paths,
    writeCreditStore: () => {},
  });
  const lint = async (cwd?: string) => {
    const lines: string[] = [];
    for (const method of ["log", "warn", "error"] as const) {
      t.mock.method(console, method, (line: string) => lines.push(line));
    }
    try {
      const code = await lintPlanCommand(["--base", "origin/main"], {
        repoRoot: repo.dir,
        loadConfig: () => ({ root: repo.dir }) as Config,
        resolveOwnerRepo: () => ({ owner: OWNER, repo: REPO }),
        ghGateway: () => gateway(cwd),
        openPlanShardSlugs: () => [],
      });
      const outcome = planLintOutcomeFromOutput(code, lines, repo.git("rev-parse", "origin/main"), true);
      assert.ok(outcome.ran, lines.join("\n"));
      assert.equal(outcome.checked, TASKS.length, lines.join("\n"));
      return new Set(outcome.violations.filter((line) => line.includes(" [post-merge-amendment] "))
        .map((line) => line.split(" ")[0]));
    } finally {
      t.mock.restoreAll();
    }
  };
  return { lint, projection, filesReads, ledgerPath };
}

test("W1-T13192 criterion 1 allows an amendment after the task's own filing commit", async (t) => {
  const { lint } = history(t);
  assert.equal((await lint()).has(TASKS[0].id), false);
});

test("W1-T13192 criterion 2 agrees with the daemon projection over the same history", async (t) => {
  const { lint, projection } = history(t);
  const projectedMerged = new Set([...projection()].filter(([, row]) => row.merged).map(([id]) => id));
  assert.deepEqual(projectedMerged, new Set(TASKS.slice(1).map((task) => task.id)));
  assert.deepEqual(await lint(), projectedMerged);
});

test("W1-T13192 criterion 3 keeps code and declared plan text terminal using local paths", async (t) => {
  const { lint, filesReads } = history(t);
  const refused = await lint();
  assert.ok(refused.has(TASKS[1].id), "an amendment to built code is refused");
  assert.ok(refused.has(TASKS[2].id), "an amendment to delivered plan text is refused");
  assert.deepEqual(filesReads, [], "locally available paths need no GitHub files request");
});

test("a cached trailer credit from the filing is revalidated against the local commit", async (t) => {
  const { lint, ledgerPath } = history(t);
  const pr = { number: 1, url: `https://github.com/${OWNER}/${REPO}/pull/1` };
  assert.equal(persistVerifiedCredit(ledgerPath, TASKS[0].id, pr, [TASKS[0].path]), "recorded");
  assert.equal((await lint()).has(TASKS[0].id), false);
});

test("an unreadable local merge history leaves the gateway's files fallback available", async (t) => {
  const { lint, filesReads } = history(t);
  const otherRepo = gitRepo({ scope: t });
  otherRepo.addRemote("origin", `https://github.com/${OWNER}/${REPO}.git`);
  const refused = await lint(otherRepo.dir);
  assert.ok(refused.has(TASKS[1].id));
  assert.ok(refused.has(TASKS[2].id));
  assert.deepEqual(filesReads, [3, 4]);
});
