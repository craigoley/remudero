// W1-T14748: a red task-files landing rebuild sets aside each file the destination gate's findings name and lands the rest.
// The landing is driven through its injected git and gh against a local bare origin. The landing target is the plan
// destination, every file passes the core preflight, and the failing check is the destination gate, as in ops #672.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AsyncIssueGateway, OpenIssue } from "#src/lib/escalate.js";
import { landTaskFilesAsync, rememberedRecordRefusal, stagedTaskFiles, type TaskFilesLandingResult } from "#src/lib/feedback-landing.js";
import { fixedClock } from "#src/lib/clock.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { planDestinationPath } from "#src/lib/plan-destination.js";
import type { PlanPrPreflightResult } from "#src/lib/plan-pr-emitter.js";
import { gateFindingsUnreadEscalation } from "#src/lib/sweep.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

const A = "W1-T93001";
const B = "W1-T93002";
const C = "W1-T93003";
const pathOf = (id: string): string => `plan/tasks.d/${id}-fixture.yaml`;
const shard = (id: string): string => [`- id: ${id}`, "  repo: remudero", "  status: queued", "  attempts: 0", ""].join("\n");
const edited = (id: string): string => `${shard(id)}  note: machine-filed edit of ${id}\n`;
const inputOf = (id: string) => ({ relPath: pathOf(id), content: edited(id), claim: `${id} carries its edit`, proof: `grep: machine-filed edit of ${id} in ${pathOf(id)}` });
const blobOf = (text: string): string => execFileSync("git", ["hash-object", "--stdin"], { input: text, encoding: "utf8" }).trim();
const GREEN: PlanPrPreflightResult = { ok: true, failures: [], unreadable: [] };
const GATE = "ops-gate";
const OTHER_CHECK = "acceptance-author-gate";
const OPS = { owner: "acme", repo: "remudero-ops" };
const RUN = "45476180866";
const JOB = "128000000001";
const JOB_LOG = `repos/${OPS.owner}/${OPS.repo}/actions/jobs/${JOB}/logs`;
const finding = (id: string): string =>
  `public commit f0901b68dd82 holds no record for id ${id}; point 'moved_from' at the public commit the record was copied from`;
/** A failed ops-gate job log as GitHub serves it: each line has a timestamp prefix. */
const gateLog = (relPath: string, id: string): string => [
  "2026-11-24T20:00:00.1000000Z ##[group]Run ruby scripts/ops-gate.rb",
  `2026-11-24T20:00:01.2000000Z ${relPath}: ${finding(id)}`,
  "2026-11-24T20:00:01.3000000Z ops-gate: FAIL",
].join("\n");

type Pr = { url: string; state: "OPEN" | "CLOSED" | "MERGED"; body: string; mergeable: string; createdAt: string };
type Row = Record<string, unknown>;
type Check = { name: string; status: string; conclusion: string; startedAt: string; detailsUrl: string };

let fixtures = 0;

/** One origin, one author pushing main, one checkout the landing runs in, GitHub as the landing reads it, and the operator's issues. */
function landingFixture(opt: { destination?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t14748-"));
  if (opt.destination !== false) {
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(planDestinationPath(join(root, "state")), JSON.stringify({ repository: `${OPS.owner}/${OPS.repo}`, kinds: ["task"] }));
  }
  const origin = gitRepo({ bare: true, kind: "w1-t14748-origin" });
  const author = gitRepo({ cloneFrom: origin.dir, kind: "w1-t14748-author" });
  mkdirSync(join(author.dir, "plan", "tasks.d"), { recursive: true });
  for (const id of [A, B, C]) writeFileSync(join(author.dir, pathOf(id)), shard(id));
  // The landing caches preflight verdicts by tree, process-wide: a fixture of its own bytes keeps each tree new.
  const nonce = `${process.pid}-${Date.now()}-${++fixtures}`;
  writeFileSync(join(author.dir, "README.md"), `fixture ${nonce}\n`);
  author.git("add", "-A");
  author.git("commit", "--quiet", "-m", "seed the plan");
  author.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
  const checkout: GitRepo = gitRepo({ cloneFrom: origin.dir, kind: "w1-t14748-checkout" });

  const prs: Pr[] = [];
  const control = {
    preflight: async (_body: string): Promise<PlanPrPreflightResult> => GREEN, preflights: 0,
    jobLog: (): string => gateLog(pathOf(C), C),
  };
  const rows: Row[] = [];
  const logReads: string[] = [];
  const checks = new Map<string, Check[]>();
  const openPrs = (): Pr[] => prs.filter((p) => p.state === "OPEN");
  const branchSha = (): string | undefined => {
    const ref = origin.git("for-each-ref", "--format=%(refname)", "refs/heads").split("\n").find((r) => r.startsWith("refs/heads/task-files-landing"));
    return ref ? origin.git("rev-parse", ref) : undefined;
  };
  const mainSha = (): string => origin.git("rev-parse", "refs/heads/main");
  const gh = (args: string[]): string => {
    if (args[0] === "pr" && args[1] === "list") {
      const fields = (args[args.indexOf("--json") + 1] ?? "url").split(",");
      const head = branchSha();
      return JSON.stringify(openPrs().map((p) => Object.fromEntries(Object.entries({
        url: p.url, headRefOid: head, mergeable: p.mergeable, createdAt: p.createdAt, statusCheckRollup: head ? checks.get(head) ?? [] : [],
      }).filter(([k]) => fields.includes(k)))));
    }
    if (args[0] === "pr" && args[1] === "create") {
      const url = `https://github.com/${OPS.owner}/${OPS.repo}/pull/${672 + prs.length}`;
      prs.push({ url, state: "OPEN", body: args[args.indexOf("--body") + 1]!, mergeable: "MERGEABLE", createdAt: "2026-11-24T19:00:00.000Z" });
      return url;
    }
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ state: prs.find((p) => p.url === args[2])?.state ?? "OPEN" });
    if (args[0] === "api" && args[1]?.endsWith("/logs")) {
      logReads.push(args[1]);
      return control.jobLog();
    }
    if (args[0] === "api" && args.includes("PATCH")) {
      const number = /pulls\/(\d+)$/.exec(args.find((a) => a.startsWith("repos/"))!)![1];
      prs.find((p) => p.url.endsWith(`/pull/${number}`))!.body = args[args.indexOf("-f") + 1]!.replace(/^body=/, "");
      return "{}";
    }
    return "[]";
  };
  let pushes = 0;
  const git = (args: string[], o?: { env?: NodeJS.ProcessEnv }): string => {
    const out = execFileSync("git", ["-C", checkout.dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: o?.env ?? process.env });
    if (args[0] === "push") {
      pushes++;
      for (const p of openPrs()) p.mergeable = "MERGEABLE";
    }
    return out;
  };
  const issues: AsyncIssueGateway & { creates: string[]; open: OpenIssue[] } = {
    creates: [], open: [],
    async listOpen() {
      return [...issues.open];
    },
    async create(title, body) {
      issues.creates.push(title);
      const url = `https://github.com/acme/remudero/issues/${issues.creates.length}`;
      issues.open.push({ number: issues.creates.length, url, title, body });
      return url;
    },
    async comment() {},
  };
  const opts = (): Parameters<typeof landTaskFilesAsync>[2] => ({
    stateRoot: root,
    targetRepository: OPS,
    log: (step: string, extra?: Row) => void rows.push({ step, ...extra }),
    gh,
    git,
    clock: fixedClock(Date.parse("2026-11-24T21:00:00.000Z")),
    planPrPreflight: async (_sha, pr) => {
      control.preflights++;
      return control.preflight(pr.body ?? "");
    },
    // The production port the sweep binds, over a recording issue gateway.
    escalateGateFindingsUnread: gateFindingsUnreadEscalation({ issues, ledgerPath: join(root, "ledger.jsonl"), runId: "RUN-T14748" }),
  });
  const pending = join(root, "state", "task-files-landing-pending");
  const snapshot = (): string => {
    if (!existsSync(pending)) return "";
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [`${join(dir, e.name).slice(pending.length)}\n${readFileSync(join(dir, e.name), "utf8")}`]);
    return walk(pending).sort().join("\n--\n");
  };
  let mainEdits = 0;
  return {
    root, origin, prs, rows, logReads, checks, control, issues, branchSha, mainSha, snapshot, openPrs,
    pushes: () => pushes,
    land: (ids: string[], extra: Partial<Parameters<typeof landTaskFilesAsync>[2]> = {}): Promise<TaskFilesLandingResult> =>
      withLiveWritesAllowed(() => landTaskFilesAsync(checkout.dir, ids.map(inputOf), { ...opts(), ...extra })),
    moveMain: (): void => {
      author.git("fetch", "--quiet", "origin");
      author.git("reset", "--quiet", "--hard", "origin/main");
      writeFileSync(join(author.dir, "README.md"), `fixture ${nonce} main edit ${++mainEdits}\n`);
      author.git("commit", "--quiet", "-am", "main moves");
      author.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
    },
    red: (sha: string, name: string): void => void checks.set(sha, [{
      name, status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-11-24T20:00:00Z",
      detailsUrl: `https://github.com/${OPS.owner}/${OPS.repo}/actions/runs/${RUN}/job/${JOB}`,
    }]),
    headFiles: (): string[] => {
      const head = branchSha()!;
      return origin.git("diff", "--name-only", `refs/heads/main...${head}`, "--", "plan/tasks.d").split("\n").filter(Boolean).sort();
    },
    staged: (): string[] => stagedTaskFiles(root).map((s) => s.relPath).sort(),
    stepRows: (step: string): Row[] => rows.filter((r) => r.step === step),
  };
}

type Fixture = ReturnType<typeof landingFixture>;
const criteria = (body: string): string[] => body.slice(body.indexOf("## Acceptance")).split("\n").filter((l) => l.startsWith("- "));

/** A landing of A, B and C whose pull request head is red on `check`. */
async function redLanding(f: Fixture, check: string): Promise<string> {
  await f.land([A, B, C]);
  assert.equal(f.prs.length, 1);
  assert.deepEqual(f.headFiles(), [A, B, C].map(pathOf).sort());
  const head = f.branchSha()!;
  f.red(head, check);
  return head;
}

test("W1-T14748 criterion 1: a landing red on the destination gate is rebuilt without the file the gate's log names, which is set aside and remembered", async () => {
  const f = landingFixture();
  const redHead = await redLanding(f, GATE);
  const preflightsBefore = f.control.preflights;
  const rebuilt = await f.land([]);

  assert.deepEqual(f.logReads, [JOB_LOG], "the failed gate job's log is read once");
  assert.ok(f.control.preflights > preflightsBefore, "the rest passes the core preflight, as every file did");
  assert.equal(rebuilt.pushed, true, "the red head is replaced");
  assert.notEqual(f.branchSha(), redHead);
  assert.equal(f.origin.git("rev-parse", `${f.branchSha()!}^`), f.mainSha(), "the new head sits on current main");
  assert.deepEqual(f.headFiles(), [A, B].map(pathOf).sort(), "the new head holds the other staged files only");
  assert.deepEqual(rebuilt.landed.sort(), [A, B].map(pathOf).sort());
  const lines = criteria(f.prs[0]!.body);
  assert.equal(lines.length, 2, `the body lists only the files the head holds:\n${f.prs[0]!.body}`);
  assert.equal(lines.filter((l) => l.includes(pathOf(C))).length, 0);

  const setAside = f.stepRows("task_files_landing.set_aside");
  assert.deepEqual(setAside.map((r) => r.path), [pathOf(C)], "one set-aside row, for the file the gate named");
  assert.ok(String(setAside[0]!.reason).includes(finding(C)), "the row names the finding text");
  assert.ok(String(setAside[0]!.reason).includes(`(run ${RUN})`), "the row names the run id");
  assert.deepEqual(rebuilt.setAside.map((r) => r.path), [pathOf(C)]);
  assert.deepEqual(f.staged(), [A, B].map(pathOf).sort());
  assert.equal(f.stepRows("task_files_landing.gate_findings_unread").length, 0);
  assert.equal(f.issues.creates.length, 0, "a read log asks the operator nothing");

  // Every staged edit ends landed or set aside with a row: none is dropped silently.
  assert.deepEqual([...rebuilt.landed, ...setAside.map((r) => String(r.path))].sort(), [A, B, C].map(pathOf).sort());

  const remembered = rememberedRecordRefusal(f.root, pathOf(C), blobOf(edited(C)));
  assert.deepEqual(remembered?.rules, ["destination-gate"], "the blob enters the refusal memory");
  const again = await f.land([C], { stageOnly: true });
  assert.deepEqual(again.refused.map((r) => r.path), [pathOf(C)], "the same bytes are refused at staging");
  assert.match(again.refused[0]!.reason, /the plan destination gate refused it/);

  // With the set-aside copy gone, the memory alone refuses the same bytes, and names no core finding.
  rmSync(join(f.root, "state", "task-files-landing-refused", pathOf(C)), { force: true });
  const fromMemory = await f.land([C], { stageOnly: true });
  assert.deepEqual(fromMemory.refused.map((r) => [r.path, r.rules, r.failures]), [[pathOf(C), ["destination-gate"], undefined]]);
  assert.ok(fromMemory.refused[0]!.reason.includes(finding(C)));
  assert.deepEqual(f.staged(), [A, B].map(pathOf).sort());
});

test("W1-T14748 criterion 2: an unread gate log, or one that names no staged file, holds the landing with one row and one escalation for its head", async (t) => {
  const cases: Array<[string, () => string, RegExp]> = [
    ["a gh error (403)", () => { throw new Error("gh: Resource not accessible by integration (HTTP 403)"); }, /HTTP 403/],
    ["a gh error (404)", () => { throw new Error("gh: Not Found (HTTP 404)"); }, /HTTP 404/],
    ["a log that names no staged file", () => gateLog("plan/tasks.d/W1-T93999-fixture.yaml", "W1-T93999"), /names no staged file/],
  ];
  for (const [name, jobLog, why] of cases) {
    await t.test(name, async () => {
      const f = landingFixture();
      const redHead = await redLanding(f, GATE);
      const pushes = f.pushes();
      f.control.jobLog = jobLog;
      const held = await f.land([]);
      assert.equal(held.pushed, false, "nothing is pushed");
      assert.equal(f.pushes(), pushes);
      assert.equal(f.branchSha(), redHead);
      assert.equal(f.stepRows("task_files_landing.set_aside").length, 0, "no file is set aside");
      assert.deepEqual(f.staged(), [A, B, C].map(pathOf).sort(), "every edit still waits");
      const unread = f.stepRows("task_files_landing.gate_findings_unread");
      assert.equal(unread.length, 1, "one row for this head");
      assert.equal(unread[0]!.head_sha, redHead);
      assert.equal(unread[0]!.pr_url, f.prs[0]!.url);
      assert.match(String(unread[0]!.reason), why);
      assert.equal(f.issues.creates.length, 1, "one operator escalation for this head");
      assert.equal(unread[0]!.escalation, "https://github.com/acme/remudero/issues/1");
      assert.ok(f.issues.creates[0]!.includes(f.prs[0]!.url), "the escalation names the pull request");

      await f.land([]);
      await f.land([]);
      assert.equal(f.stepRows("task_files_landing.gate_findings_unread").length, 1, "a later pass on the same head writes no row");
      assert.equal(f.issues.creates.length, 1, "and no escalation");
      assert.equal(f.pushes(), pushes);
      assert.deepEqual(f.staged(), [A, B, C].map(pathOf).sort(), "no edit is dropped");
    });
  }
});

test("W1-T14748 criterion 2: an escalation that throws is named in the row and the hold stands", async () => {
  const f = landingFixture();
  const redHead = await redLanding(f, GATE);
  const pushes = f.pushes();
  f.control.jobLog = () => { throw new Error("gh: Resource not accessible by integration (HTTP 403)"); };
  const escalateGateFindingsUnread = async (): Promise<string> => { throw new Error("the issue tracker is down"); };
  const held = await f.land([], { escalateGateFindingsUnread });
  assert.equal(held.pushed, false, "nothing is pushed");
  assert.equal(f.pushes(), pushes);
  assert.equal(f.branchSha(), redHead);
  assert.deepEqual(f.staged(), [A, B, C].map(pathOf).sort(), "no edit is dropped");
  const unread = f.stepRows("task_files_landing.gate_findings_unread");
  assert.equal(unread.length, 1);
  assert.equal(unread[0]!.escalation, "failed: the issue tracker is down");
  await f.land([], { escalateGateFindingsUnread });
  assert.equal(f.stepRows("task_files_landing.gate_findings_unread").length, 1, "the same head is not retried");
});

test("W1-T14748 criterion 3: a non-gate red, a landing outside the plan destination, a conflict and a core-preflight refusal are handled as before", async (t) => {
  await t.test("red on a check that is not the destination gate: rebuilt with every file, and no log is read", async () => {
    const f = landingFixture();
    await redLanding(f, OTHER_CHECK);
    f.moveMain();
    const rebuilt = await f.land([]);
    assert.equal(rebuilt.pushed, true);
    assert.deepEqual(f.headFiles(), [A, B, C].map(pathOf).sort());
    assert.deepEqual(f.logReads, []);
    assert.equal(f.stepRows("task_files_landing.set_aside").length, 0);
  });

  await t.test("red on a check named like the gate, in a landing outside the plan destination: no log is read", async () => {
    const f = landingFixture({ destination: false });
    await redLanding(f, GATE);
    f.moveMain();
    const rebuilt = await f.land([]);
    assert.equal(rebuilt.pushed, true);
    assert.deepEqual(f.headFiles(), [A, B, C].map(pathOf).sort());
    assert.deepEqual(f.logReads, []);
    assert.equal(f.stepRows("task_files_landing.set_aside").length, 0);
  });

  await t.test("conflicting with main: rebuilt with every file, and no log is read", async () => {
    const f = landingFixture();
    await f.land([A, B, C]);
    f.moveMain();
    f.prs[0]!.mergeable = "CONFLICTING";
    const rebuilt = await f.land([]);
    assert.equal(rebuilt.pushed, true);
    assert.deepEqual(f.headFiles(), [A, B, C].map(pathOf).sort());
    assert.deepEqual(f.logReads, []);
  });

  await t.test("a file the core preflight refuses is set aside with the preflight's reason, as before", async () => {
    const f = landingFixture();
    await redLanding(f, OTHER_CHECK);
    f.moveMain();
    f.control.preflight = async (body) => body.includes(pathOf(B))
      ? { ok: false, failures: [{ check: "lint-plan", firstLine: `${B}: a core finding` }], unreadable: [] } : GREEN;
    const rebuilt = await f.land([]);
    assert.equal(rebuilt.pushed, true);
    assert.deepEqual(f.headFiles(), [A, C].map(pathOf).sort());
    const setAside = f.stepRows("task_files_landing.set_aside");
    assert.deepEqual(setAside.map((r) => r.path), [pathOf(B)]);
    assert.match(String(setAside[0]!.reason), /the plan preflight refused it: \[lint-plan\]/);
    assert.deepEqual(f.logReads, []);
  });
});
