// W1-T13210: a red or conflicting landing pull request rebuilds itself from the pending edits.
// On 2026-11-16 landing pull request #18789 was red for 13 hours and #18902 conflicted with main
// for hours more: an open pull request sealed the task-files lane whatever its checks said, and the
// lane waited without a row. The landing is driven through its injected git and gh against a local
// bare origin; GitHub's listing reports only the fields the landing asks for.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { landTaskFilesAsync, stagedTaskFiles, type TaskFilesLandingResult } from "#src/lib/feedback-landing.js";
import { fixedClock } from "#src/lib/clock.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import type { PlanPrPreflightResult } from "#src/lib/plan-pr-emitter.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

const A = "W1-T92001";
const B = "W1-T92002";
const C = "W1-T92003";
const pathOf = (id: string): string => `plan/tasks.d/${id}-fixture.yaml`;
const shard = (id: string): string => [`- id: ${id}`, "  repo: remudero", "  status: queued", "  attempts: 0", ""].join("\n");
const edited = (id: string): string => `${shard(id)}  note: machine-filed edit of ${id}\n`;
const inputOf = (id: string) => ({ relPath: pathOf(id), content: edited(id), claim: `${id} carries its edit`, proof: `grep: machine-filed edit of ${id} in ${pathOf(id)}` });
const GREEN: PlanPrPreflightResult = { ok: true, failures: [], unreadable: [] };
const RED_CHECK = "acceptance-author-gate";
const OPENED_AT = "2026-11-16T17:40:00.000Z";
const NOW_MS = Date.parse("2026-11-16T20:40:00.000Z");

type Pr = { url: string; state: "OPEN" | "CLOSED" | "MERGED"; body: string; mergeable: string; createdAt: string };
type Row = Record<string, unknown>;
type Check = { name: string; status: string; conclusion: string; startedAt: string };

let fixtures = 0;

/** One origin, one author pushing main, one checkout the landing runs in, and GitHub as the landing reads and writes it. */
function landingFixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t13210-"));
  const origin = gitRepo({ bare: true, kind: "w1-t13210-origin" });
  const author = gitRepo({ cloneFrom: origin.dir, kind: "w1-t13210-author" });
  mkdirSync(join(author.dir, "plan", "tasks.d"), { recursive: true });
  for (const id of [A, B, C]) writeFileSync(join(author.dir, pathOf(id)), shard(id));
  // The landing caches preflight verdicts by tree, process-wide: a fixture of its own bytes keeps each tree new.
  const nonce = `${process.pid}-${Date.now()}-${++fixtures}`;
  writeFileSync(join(author.dir, "README.md"), `fixture ${nonce}\n`);
  author.git("add", "-A");
  author.git("commit", "--quiet", "-m", "seed the plan");
  author.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
  const checkout: GitRepo = gitRepo({ cloneFrom: origin.dir, kind: "w1-t13210-checkout" });

  const prs: Pr[] = [];
  const patches: Array<{ url: string; body: string }> = [];
  const closes: string[] = [];
  const rows: Row[] = [];
  /** The check runs GitHub reports for each head commit. */
  const checks = new Map<string, Check[]>();
  const github = { maxOpen: 0 };
  const openPrs = (): Pr[] => prs.filter((p) => p.state === "OPEN");
  const branchRef = (): string | undefined =>
    origin.git("for-each-ref", "--format=%(refname)", "refs/heads").split("\n").find((r) => r.startsWith("refs/heads/task-files-landing"));
  const branchSha = (): string | undefined => {
    const ref = branchRef();
    return ref ? origin.git("rev-parse", ref) : undefined;
  };
  const mainSha = (): string => origin.git("rev-parse", "refs/heads/main");
  const listed = (pr: Pr): Record<string, unknown> => {
    const head = branchSha();
    return { url: pr.url, headRefOid: head, mergeable: pr.mergeable, createdAt: pr.createdAt, statusCheckRollup: head ? checks.get(head) ?? [] : [] };
  };
  const gh = (args: string[]): string => {
    if (args[0] === "pr" && args[1] === "list") {
      // As gh does: only the fields `--json` names come back.
      const fields = (args[args.indexOf("--json") + 1] ?? "url").split(",");
      return JSON.stringify(openPrs().map((p) => Object.fromEntries(Object.entries(listed(p)).filter(([k]) => fields.includes(k)))));
    }
    if (args[0] === "pr" && args[1] === "create") {
      const url = `https://github.com/acme/remudero/pull/${9200 + prs.length + 1}`;
      prs.push({ url, state: "OPEN", body: args[args.indexOf("--body") + 1]!, mergeable: "MERGEABLE", createdAt: OPENED_AT });
      github.maxOpen = Math.max(github.maxOpen, openPrs().length);
      return url;
    }
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ state: prs.find((p) => p.url === args[2])?.state ?? "OPEN" });
    if (args[0] === "pr" && args[1] === "close") {
      prs.find((p) => p.url === args[2])!.state = "CLOSED";
      closes.push(args[2]!);
      return "";
    }
    if (args[0] === "api" && args.includes("PATCH")) {
      const number = /pulls\/(\d+)$/.exec(args.find((a) => a.startsWith("repos/"))!)![1];
      const pr = prs.find((p) => p.url.endsWith(`/pull/${number}`))!;
      pr.body = args[args.indexOf("-f") + 1]!.replace(/^body=/, "");
      patches.push({ url: pr.url, body: pr.body });
      return "{}";
    }
    return "[]";
  };
  let pushes = 0;
  const git = (args: string[], o?: { env?: NodeJS.ProcessEnv }): string => {
    const out = execFileSync("git", ["-C", checkout.dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: o?.env ?? process.env });
    if (args[0] === "push") {
      pushes++;
      for (const p of openPrs()) p.mergeable = "MERGEABLE"; // GitHub re-reads mergeability for the new head
    }
    return out;
  };
  const control = { preflight: async (): Promise<PlanPrPreflightResult> => GREEN, preflights: 0 };
  const opts = (): Parameters<typeof landTaskFilesAsync>[2] => ({
    stateRoot: root,
    targetRepository: { owner: "acme", repo: "remudero" },
    log: (step: string, extra?: Row) => void rows.push({ step, ...extra }),
    gh,
    git,
    clock: fixedClock(NOW_MS),
    planPrPreflight: async () => {
      control.preflights++;
      return control.preflight();
    },
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
    root, origin, prs, patches, closes, rows, github, checks, control, openPrs, branchRef, branchSha, mainSha, snapshot,
    pushes: () => pushes,
    land: (ids: string[], extra: { stageOnly?: boolean } = {}): Promise<TaskFilesLandingResult> =>
      withLiveWritesAllowed(() => landTaskFilesAsync(checkout.dir, ids.map(inputOf), { ...opts(), ...extra })),
    /** Main moves on: an unrelated commit, or one that changes a task file the landing edits. */
    moveMain: (taskFile?: string): string => {
      author.git("fetch", "--quiet", "origin");
      author.git("reset", "--quiet", "--hard", "origin/main");
      if (taskFile) writeFileSync(join(author.dir, pathOf(taskFile)), `${shard(taskFile)}  note: main's own edit of ${taskFile}\n`);
      else writeFileSync(join(author.dir, "README.md"), `fixture ${nonce} main edit ${++mainEdits}\n`);
      author.git("commit", "--quiet", "-am", "main moves");
      author.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
      return mainSha();
    },
    red: (sha: string): void => void checks.set(sha, [{ name: RED_CHECK, status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-11-16T02:51:00Z" }]),
    green: (sha: string): void => void checks.set(sha, [{ name: RED_CHECK, status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-11-16T02:51:00Z" }]),
    /** The task files the landing branch's head changes against main: what its commit holds. */
    headFiles: (): string[] => {
      const head = branchSha()!;
      return origin.git("diff", "--name-only", `refs/heads/main...${head}`, "--", "plan/tasks.d").split("\n").filter(Boolean).sort();
    },
    staged: () => stagedTaskFiles(root).sort((x, y) => x.relPath.localeCompare(y.relPath)),
    waitingRows: (): Row[] => rows.filter((r) => r.step === "task_files_landing.waiting_on_pr"),
    setAsideRows: (): Row[] => rows.filter((r) => r.step === "task_files_landing.set_aside"),
  };
}

type Fixture = ReturnType<typeof landingFixture>;
const criteria = (body: string): string[] => body.slice(body.indexOf("## Acceptance")).split("\n").filter((l) => l.startsWith("- "));

/** The head is one commit on top of current main, and the body lists exactly the files that commit holds. */
function assertRebuiltOnMain(f: Fixture, files: string[]): void {
  const head = f.branchSha()!;
  assert.equal(f.origin.git("rev-parse", `${head}^`), f.mainSha(), "the rebuilt head sits on current main");
  assert.equal(f.origin.git("rev-list", "--count", `refs/heads/main..${head}`), "1", "one new commit");
  assert.deepEqual(f.headFiles(), files.map(pathOf).sort());
  const lines = criteria(f.prs.at(-1)!.body);
  assert.equal(lines.length, files.length, `one acceptance line per file the head holds:\n${f.prs.at(-1)!.body}`);
  for (const id of files) assert.equal(lines.filter((l) => l.includes(` in ${pathOf(id)}`)).length, 1, `${id} has its acceptance line`);
}

test("W1-T13210 criterion 1: a landing pull request red at its head, or conflicting with main, is rebuilt from the pending edits on current main", async (t) => {
  await t.test("red on its own check, main not red the same way: one new commit on current main and a body written from it", async () => {
    const f = landingFixture();
    await f.land([A, B]);
    const url = f.prs[0]!.url;
    const redHead = f.branchSha()!;
    f.red(redHead);
    f.moveMain();
    const rebuilt = await f.land([]);
    assert.equal(rebuilt.pushed, true, "the red head is replaced");
    assert.notEqual(f.branchSha(), redHead);
    assert.equal(rebuilt.prUrl, url, "the same pull request carries the rebuild");
    assert.deepEqual(rebuilt.landed.sort(), [pathOf(A), pathOf(B)]);
    assertRebuiltOnMain(f, [A, B]);
    assert.deepEqual(f.patches.map((p) => p.url), [url], "the body was rewritten from the rebuilt commit");
    assert.equal(f.prs.length, 1);
  });

  await t.test("conflicting with main, with no checks: rebuilt on current main, and an edit whose base moved on main is set aside", async () => {
    const f = landingFixture();
    await f.land([A, B, C]);
    const url = f.prs[0]!.url;
    f.moveMain(C); // as #18901 withdrew W1-T9274 next to the landing branch's edit of that record
    f.prs[0]!.mergeable = "CONFLICTING";
    const rebuilt = await f.land([]);
    assert.equal(rebuilt.pushed, true, "a conflicting head registers no checks and is rebuilt anyway");
    assert.equal(rebuilt.prUrl, url);
    assertRebuiltOnMain(f, [A, B]);
    assert.deepEqual(f.setAsideRows().map((r) => r.path), [pathOf(C)]);
    assert.match(String(f.setAsideRows()[0]!.reason), /the copy on main stands/);
    assert.deepEqual(f.staged().map((s) => s.relPath), [pathOf(A), pathOf(B)]);
    assert.equal(f.openPrs()[0]!.mergeable, "MERGEABLE");
  });

  await t.test("red, and main alone is red the same way: no push and no file set aside until main moves", async () => {
    const f = landingFixture();
    await f.land([A]);
    const redHead = f.branchSha()!;
    f.red(redHead);
    f.moveMain();
    f.control.preflight = async () => ({ ok: false, failures: [{ check: "lint-plan", firstLine: "main's own lint-plan red" }], unreadable: [] });
    const held = await f.land([]);
    assert.equal(held.pushed, false);
    assert.equal(f.branchSha(), redHead);
    assert.deepEqual(f.setAsideRows(), []);
    assert.match(String(f.waitingRows().at(-1)?.reason), /origin\/main is red/);
  });

  await t.test("a green or pending landing pull request is left alone", async () => {
    const f = landingFixture();
    await f.land([A]);
    const head = f.branchSha()!;
    f.moveMain();
    for (const judge of [() => undefined, () => f.green(head)]) {
      judge();
      const sealed = await f.land([]);
      assert.equal(sealed.pushed, false);
      assert.equal(f.branchSha(), head);
    }
    assert.deepEqual(f.patches, []);
  });
});

test("W1-T13210 criterion 2: the lane writes one waiting row for each change of the pull request, its checks and the edits waiting, not one a pass", async () => {
  const f = landingFixture();
  await f.land([A]);
  const url = f.prs[0]!.url;
  const head = f.branchSha()!;
  await f.land([]);
  await f.land([]);
  await f.land([]);
  assert.equal(f.waitingRows().length, 1, "three passes in one state write one row");
  const first = f.waitingRows()[0]!;
  assert.equal(first.pr_url, url);
  assert.equal(first.checks, "none");
  assert.equal(first.waiting, 0);
  assert.equal(first.head_sha, head);
  assert.deepEqual([first.opened_at, first.age_ms], [OPENED_AT, 3 * 60 * 60 * 1000], "the row carries the pull request's age");

  await f.land([B], { stageOnly: true });
  await f.land([]);
  await f.land([]);
  assert.equal(f.waitingRows().length, 2, "one more edit waiting is a new state");
  assert.equal(f.waitingRows()[1]!.waiting, 1);

  f.green(head);
  await f.land([]);
  await f.land([]);
  assert.equal(f.waitingRows().length, 3, "its checks going green is a new state");
  assert.deepEqual([f.waitingRows()[2]!.checks, f.waitingRows()[2]!.waiting], ["green", 1]);
});

test("W1-T13210 criterion 3: a rebuild that would produce the red head's tree is not pushed, and its row says red and unchanged with the failing check", async () => {
  const f = landingFixture();
  await f.land([A]);
  const url = f.prs[0]!.url;
  const redHead = f.branchSha()!;
  f.red(redHead);
  const pushesBefore = f.pushes();
  for (let pass = 0; pass < 3; pass++) {
    const held = await f.land([]);
    assert.equal(held.pushed, false, "neither main nor the pending set changed");
    assert.equal(held.prUrl, url);
  }
  assert.equal(f.pushes(), pushesBefore);
  assert.equal(f.branchSha(), redHead);
  assert.deepEqual(f.patches, [], "an unchanged pull request is not touched");
  assert.equal(f.waitingRows().length, 1, "one row for the red, unchanged state");
  const row = f.waitingRows()[0]!;
  assert.deepEqual([row.pr_url, row.checks, row.unchanged, row.failing_checks], [url, "red", true, [RED_CHECK]]);

  // The pending set changes: the rebuild carries the new edit, on the same main.
  await f.land([B], { stageOnly: true });
  const rebuilt = await f.land([]);
  assert.equal(rebuilt.pushed, true);
  assertRebuiltOnMain(f, [A, B]);
  assert.equal(f.prs.length, 1);
});

test("W1-T13210 criterion 4: a rebuild loses no edit, a person's close sets its files aside as before, and one landing pull request is open at most", async (t) => {
  await t.test("the edits a rebuild replaces stay pending, through later passes", async () => {
    const f = landingFixture();
    await f.land([A, B]);
    const url = f.prs[0]!.url;
    f.red(f.branchSha()!);
    f.moveMain();
    await f.land([]);
    await f.land([]);
    await f.land([]);
    assert.deepEqual(f.setAsideRows(), [], "the lane's own rebuild sets nothing aside");
    assert.deepEqual(f.staged(), [{ relPath: pathOf(A), prUrl: url }, { relPath: pathOf(B), prUrl: url }]);
    assert.deepEqual(f.closes, []);
    assert.equal(f.prs.length, 1);
    assert.equal(f.github.maxOpen, 1, "never two landing pull requests open");
  });

  await t.test("a conflicting pull request with nothing left to land is closed by the lane, and the next edit opens the next one", async () => {
    const f = landingFixture();
    await f.land([A]);
    const url = f.prs[0]!.url;
    f.moveMain(A);
    f.prs[0]!.mergeable = "CONFLICTING";
    const closed = await f.land([]);
    assert.deepEqual(f.closes, [url], "the lane closes the pull request whose every edit main superseded");
    assert.equal(closed.prUrl, undefined);
    assert.deepEqual(f.staged(), []);
    const next = await f.land([B]);
    assert.equal(f.prs.length, 2);
    assert.equal(next.prUrl, f.prs[1]!.url);
    assert.deepEqual(next.landed, [pathOf(B)]);
    assert.deepEqual(f.setAsideRows().map((r) => r.path), [pathOf(A)], "only main's own edit set A aside");
    assert.equal(f.github.maxOpen, 1, "never two landing pull requests open");
  });

  await t.test("a pull request a person closes sets its files aside, as before", async () => {
    const f = landingFixture();
    await f.land([A]);
    const url = f.prs[0]!.url;
    f.prs[0]!.state = "CLOSED";
    await f.land([]);
    assert.deepEqual(f.setAsideRows().map((r) => [r.path, r.reason]), [[pathOf(A), `its landing pull request ${url} was closed without a merge`]]);
  });
});
