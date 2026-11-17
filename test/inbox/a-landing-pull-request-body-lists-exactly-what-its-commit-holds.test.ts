// W1-T13209: a landing pull request's body lists exactly what its commit holds.
// On #18789 (2026-11-16) a second writer pushed to task-files-landing after the first writer had
// opened its pull request: the head held three files and the body still named four, and the
// acceptance gate refused the missing file's grep proof for 13 hours.
// Two interleaved calls are driven through the landing's injected git and gh, never a real origin:
// the later writer's plan preflight is where the earlier writer runs to completion, which is the
// window the seal read before the batch leaves open.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { landTaskFilesAsync, stagedTaskFiles, type TaskFilesLandingResult } from "#src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import type { PlanPrPreflightResult } from "#src/lib/plan-pr-emitter.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

const A = "W1-T91001";
const B = "W1-T91002";
const C = "W1-T91003";
const pathOf = (id: string): string => `plan/tasks.d/${id}-fixture.yaml`;
const shard = (id: string): string => [`- id: ${id}`, "  repo: remudero", "  status: queued", "  attempts: 0", ""].join("\n");
const edited = (id: string): string => `${shard(id)}  note: machine-filed edit of ${id}\n`;
const inputOf = (id: string) => ({ relPath: pathOf(id), content: edited(id), claim: `${id} carries its edit`, proof: `grep: machine-filed edit of ${id} in ${pathOf(id)}` });
const GREEN: PlanPrPreflightResult = { ok: true, failures: [], unreadable: [] };

type Pr = { url: string; state: "OPEN" | "CLOSED" | "MERGED"; body: string };
type Row = Record<string, unknown>;

let fixtures = 0;

/** One origin, one checkout, one state directory, and GitHub as the landing reads and writes it. */
function landingFixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t13209-"));
  const origin = gitRepo({ bare: true, kind: "w1-t13209-origin" });
  const author = gitRepo({ cloneFrom: origin.dir, kind: "w1-t13209-author" });
  mkdirSync(join(author.dir, "plan", "tasks.d"), { recursive: true });
  for (const id of [A, B, C]) writeFileSync(join(author.dir, pathOf(id)), shard(id));
  // The landing caches preflight verdicts by tree, process-wide: a fixture of its own bytes keeps each tree new.
  writeFileSync(join(author.dir, "README.md"), `fixture ${process.pid}-${Date.now()}-${++fixtures}\n`);
  author.git("add", "-A");
  author.git("commit", "--quiet", "-m", "seed the plan");
  author.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
  const checkout: GitRepo = gitRepo({ cloneFrom: origin.dir, kind: "w1-t13209-checkout" });

  const prs: Pr[] = [];
  const patches: Array<{ url: string; body: string }> = [];
  const rows: Row[] = [];
  const github = {
    /** A listing that lags: an open pull request is left out of every listing until the next push. */
    lagging: false,
    maxOpen: 0,
  };
  const openPrs = (): Pr[] => prs.filter((p) => p.state === "OPEN");
  const gh = (args: string[]): string => {
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify(github.lagging ? [] : openPrs().map(({ url }) => ({ url })));
    if (args[0] === "pr" && args[1] === "create") {
      const url = `https://github.com/acme/remudero/pull/${9100 + prs.length + 1}`;
      prs.push({ url, state: "OPEN", body: args[args.indexOf("--body") + 1]! });
      github.maxOpen = Math.max(github.maxOpen, openPrs().length);
      return url;
    }
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ state: prs.find((p) => p.url === args[2])?.state ?? "OPEN" });
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
  /** A git verb that fails, as an unreachable origin would. */
  const faults = { verb: undefined as string | undefined };
  const git = (args: string[], o?: { env?: NodeJS.ProcessEnv }): string => {
    if (args[0] === faults.verb) throw new Error(`fatal: ${args[0]} could not reach the object store`);
    if (args[0] === "push") {
      pushes++;
      github.lagging = false;
    }
    return execFileSync("git", ["-C", checkout.dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: o?.env ?? process.env });
  };
  /** Run once, inside the next plan preflight of the batch; the call that owns that preflight waits for it. */
  let during: (() => Promise<void>) | undefined;
  const planPrPreflight = async (): Promise<PlanPrPreflightResult> => {
    const step = during;
    during = undefined;
    if (step) await step();
    return GREEN;
  };
  const opts = (): Parameters<typeof landTaskFilesAsync>[2] => ({
    stateRoot: root,
    targetRepository: { owner: "acme", repo: "remudero" },
    log: (step: string, extra?: Row) => void rows.push({ step, ...extra }),
    gh,
    git,
    planPrPreflight,
  });
  const branchRef = (): string | undefined =>
    origin.git("for-each-ref", "--format=%(refname)", "refs/heads").split("\n").find((r) => r.startsWith("refs/heads/task-files-landing"));
  const branchSha = (): string | undefined => {
    const ref = branchRef();
    return ref ? origin.git("rev-parse", ref) : undefined;
  };
  const pending = join(root, "state", "task-files-landing-pending");
  const snapshot = (): string => {
    if (!existsSync(pending)) return "";
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [`${join(dir, e.name).slice(pending.length)}\n${readFileSync(join(dir, e.name), "utf8")}`]);
    return walk(pending).sort().join("\n--\n");
  };
  return {
    root, origin, prs, patches, rows, github, openPrs, branchRef, branchSha, snapshot,
    pushes: () => pushes,
    faults,
    set during(step: (() => Promise<void>) | undefined) { during = step; },
    land: (ids: string[], extra: { stageOnly?: boolean } = {}): Promise<TaskFilesLandingResult> =>
      withLiveWritesAllowed(() => landTaskFilesAsync(checkout.dir, ids.map(inputOf), { ...opts(), ...extra })),
    /** The task files the landing branch's head changes against main: what its commit holds. */
    headFiles: (): string[] => {
      const head = branchSha()!;
      return origin.git("diff", "--name-only", `refs/heads/main...${head}`, "--", "plan/tasks.d").split("\n").filter(Boolean).sort();
    },
    staged: (): string[] => stagedTaskFiles(root).map((f) => f.relPath).sort(),
    closePr: (url: string) => void (prs.find((p) => p.url === url)!.state = "CLOSED"),
  };
}

type Fixture = ReturnType<typeof landingFixture>;
const criteria = (body: string): string[] => body.slice(body.indexOf("## Acceptance")).split("\n").filter((l) => l.startsWith("- "));
const countOf = (body: string): number => Number(/^Lands (\d+) machine-filed edit/.exec(body)?.[1]);

/**
 * The #18789 interleaving: B and C wait; the later writer reads an empty seal and builds the batch
 * [B, C]; while its plan preflight runs, the earlier writer stages A and lands [A, B, C] through a
 * new pull request. `lag` leaves that pull request out of the later writer's listings until it pushes.
 */
async function interleave(f: Fixture, lag: boolean): Promise<{ later: TaskFilesLandingResult; earlier: TaskFilesLandingResult; afterEarlier: string; earlierSha: string }> {
  await f.land([B, C], { stageOnly: true });
  let earlier: TaskFilesLandingResult | undefined;
  let afterEarlier = "";
  let earlierSha = "";
  f.during = async () => {
    earlier = await f.land([A]);
    earlierSha = f.branchSha()!;
    afterEarlier = f.snapshot();
    f.github.lagging = lag;
  };
  const later = await f.land([]);
  assert.ok(earlier, "the earlier writer ran inside the later writer's plan preflight");
  assert.equal(f.prs.length, 1, "the earlier writer opened the landing pull request");
  assert.deepEqual(earlier.landed.sort(), [pathOf(A), pathOf(B), pathOf(C)]);
  return { later, earlier, afterEarlier, earlierSha };
}

test("W1-T13209 criterion 1: a push over an open landing pull request rewrites its body from the pushed commit's files", async () => {
  const f = landingFixture();
  const { later } = await interleave(f, true);
  assert.equal(later.pushed, true, "the listing missed the open pull request, so the lease held and the later writer pushed");
  assert.equal(f.prs.length, 1, "the push reuses the open pull request");
  const pr = f.prs[0]!;
  const head = f.headFiles();
  assert.deepEqual(head, [pathOf(B), pathOf(C)], "the head now holds the later writer's batch");
  assert.equal(countOf(pr.body), head.length, `the body's count is the head's file count:\n${pr.body}`);
  const lines = criteria(pr.body);
  assert.equal(lines.length, head.length, "one acceptance line per file the head holds");
  for (const path of head) assert.equal(lines.filter((l) => l.includes(` in ${path}`)).length, 1, `${path} has its acceptance line`);
  assert.doesNotMatch(pr.body, new RegExp(A), "the body names no file the head does not hold");
  assert.deepEqual(f.patches.map((p) => p.url), [pr.url], "the body was rewritten once, on the open pull request");
});

test("W1-T13209 criterion 2: a caller that read no open pull request reads the seal again before it pushes, and pushes nothing when one opened", async () => {
  const f = landingFixture();
  const { later, earlierSha } = await interleave(f, false);
  assert.equal(later.pushed, false, "the later writer lost the race and pushed nothing");
  assert.equal(f.branchSha(), earlierSha, "the branch still holds the earlier writer's commit");
  assert.equal(f.pushes(), 1, "only the earlier writer pushed");
  assert.equal(f.prs.length, 1);
  assert.deepEqual(f.patches, [], "the open pull request's body is left as its own push wrote it");
  assert.equal(later.prUrl, f.prs[0]!.url, "the later writer names the pull request that seals the branch");
  const head = f.headFiles();
  assert.deepEqual(head, [pathOf(A), pathOf(B), pathOf(C)]);
  assert.equal(countOf(f.prs[0]!.body), head.length, "the body still matches the head");
});

test("W1-T13209 criterion 3: a staged file the open pull request's head does not hold is waiting, whatever pull request its record names", async () => {
  const f = landingFixture();
  await interleave(f, true);
  const url = f.prs[0]!.url;
  // After the race the head holds [B, C]; A was staged by the earlier writer, whose record named this pull request.
  const sealed = await f.land([]);
  assert.equal(sealed.pushed, false, "the branch is sealed");
  assert.equal(sealed.prUrl, url);
  assert.deepEqual(sealed.landed.sort(), [pathOf(B), pathOf(C)], "landed is what the head holds");
  assert.deepEqual(sealed.waiting, [pathOf(A)], "A is not in the head, so it waits");
  assert.deepEqual(stagedTaskFiles(f.root).find((s) => s.relPath === pathOf(A)), { relPath: pathOf(A) }, "A's record no longer names a pull request that does not carry it");

  // A record that names the open pull request outright, with no push behind it, is still read from the head.
  const g = landingFixture();
  await g.land([B]);
  const pr = g.prs[0]!.url;
  await g.land([A], { stageOnly: true });
  const meta = join(g.root, "state", "task-files-landing-pending", `${pathOf(A)}.meta.json`);
  writeFileSync(meta, `${JSON.stringify({ ...JSON.parse(readFileSync(meta, "utf8")), prUrl: pr })}\n`);
  const forged = await g.land([]);
  assert.deepEqual([forged.landed, forged.waiting], [[pathOf(B)], [pathOf(A)]]);
});

test("W1-T13209 criterion 4: an edit the open pull request's head does not hold stays pending, is never set aside, and lands later; one landing pull request at a time", async (t) => {
  await t.test("the caller that loses the race changes nothing on disk", async () => {
    const f = landingFixture();
    const { afterEarlier } = await interleave(f, false);
    assert.equal(f.snapshot(), afterEarlier, "the pending directory is byte-identical to what the earlier writer left");
    assert.deepEqual(f.rows.filter((r) => r.step === "task_files_landing.set_aside"), []);
    assert.equal(f.github.maxOpen, 1, "never two landing pull requests open");
  });

  await t.test("a file dropped from the head survives its pull request's close and lands in the next one", async () => {
    const f = landingFixture();
    await interleave(f, true);
    const first = f.prs[0]!.url;
    assert.ok(f.staged().includes(pathOf(A)), "A waits in the pending directory");
    f.closePr(first);
    const next = await f.land([]);
    const asideA = f.rows.filter((r) => r.step === "task_files_landing.set_aside" && r.path === pathOf(A));
    assert.deepEqual(asideA, [], "A was never in the closed pull request's head, so its close does not set A aside");
    assert.equal(f.prs.length, 2, "a later landing pull request opens");
    assert.equal(next.prUrl, f.prs[1]!.url);
    assert.ok(next.landed.includes(pathOf(A)), "A lands in the later pull request");
    assert.ok(f.headFiles().includes(pathOf(A)));
    assert.match(criteria(f.prs[1]!.body).join("\n"), new RegExp(A));
    assert.equal(f.github.maxOpen, 1, "never two landing pull requests open");
  });

  await t.test("a file dropped from the head lands in the next pull request after the first merges", async () => {
    const f = landingFixture();
    await interleave(f, true);
    const head = f.branchSha()!;
    f.origin.git("update-ref", "refs/heads/main", head);
    f.origin.git("update-ref", "-d", f.branchRef()!);
    f.prs[0]!.state = "MERGED";
    const next = await f.land([]);
    assert.deepEqual(f.staged(), [pathOf(A)], "the merged files leave the queue; A stays until it lands");
    assert.equal(next.prUrl, f.prs[1]!.url);
    assert.deepEqual(next.landed, [pathOf(A)]);
    assert.deepEqual(f.rows.filter((r) => r.step === "task_files_landing.set_aside"), []);
    assert.equal(f.github.maxOpen, 1, "never two landing pull requests open");
  });
});

test("W1-T13209: an open pull request whose head cannot be read counts nothing as carried, and one with no branch carries nothing", async () => {
  const f = landingFixture();
  await f.land([B]);
  const url = f.prs[0]!.url;
  f.faults.verb = "merge-base";
  const unread = await f.land([]);
  assert.deepEqual([unread.prUrl, unread.landed, unread.waiting, unread.pushed], [url, [], [pathOf(B)], false]);
  assert.match(String(unread.error), /the head of task-files-landing\S* cannot be read, so no staged file counts as carried by .*: fatal: merge-base could not reach/);
  assert.deepEqual(stagedTaskFiles(f.root), [{ relPath: pathOf(B), prUrl: url }], "an unread head clears no record");

  f.faults.verb = undefined;
  f.origin.git("update-ref", "-d", f.branchRef()!);
  const gone = await f.land([]);
  assert.deepEqual([gone.landed, gone.waiting, gone.error], [[], [pathOf(B)], undefined], "no branch: its pull request holds no file");
  assert.deepEqual(stagedTaskFiles(f.root), [{ relPath: pathOf(B) }]);
  assert.equal(f.prs.length, 1, "the seal still holds: nothing is pushed or opened");
});
