// W1-T12212: a gardener files a new task in the plan destination. Each test drives the production checkout,
// `gardenCheckoutAsync` or `daemonGardenWorkspace`, over real git against two bare origins: the public repository and
// the destination at `<root>/repos/<name>`. GitHub and the plan preflight verdict are fakes that record each call.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { clockFromMillisFn } from "#src/lib/clock.js";
import { landTaskFilesAsync, stagedTaskFiles, taskFilesLandingBranchAsync } from "#src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { planDestinationPath, resolvePlanDestination } from "#src/lib/plan-destination.js";
import type { PlanPrPreflightResult } from "#src/lib/plan-pr-emitter.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { GIT_REPO_FIXTURE_IDENTITY, originWithClone } from "#test/helpers/git-repo.js";
import { daemonGardenWorkspace, gardenCheckoutAsync, type GardenCheckoutOpts, type GardenName } from "#test/helpers/run-task-test.js";

const T0 = Date.parse("2026-11-14T12:00:00.000Z");
const PUBLIC = "acme/remudero";
const OPS = "acme/remudero-ops";
const pathOf = (id: string): string => `plan/tasks.d/${id}-fixture.yaml`;
const shard = (id: string, note = ""): string => [`- id: ${id}`, "  repo: remudero", "  status: queued", "  attempts: 0", `  origin: "fixture:${id}"`, ...(note ? [`  note: ${note}`] : []), ""].join("\n");
const fileBody = (id: string): string => `File one task.\n\n## Acceptance\n- claim: the task ${id} is filed\n  proof: grep: id: ${id} in ${pathOf(id)}`;
const editBody = (id: string): string => `Tend one task.\n\n## Acceptance\n- claim: the task ${id} is tended\n  proof: grep: note: tended in ${pathOf(id)}`;
const GREEN: PlanPrPreflightResult = { ok: true, failures: [], unreadable: [] };
type Row = Record<string, unknown> & { step: string };
type HostFile = { kinds: string[] } | "absent" | "garbage";

/** The public repository and the destination, each a bare origin and a clone; the host file as `host` says. */
function world(t: TestContext, host: HostFile) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t12212-`));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  // The landing caches a green tree by its hash for the process, so each world's tree is its own.
  const pub = originWithClone(join(root, "public"), { seed: {
    "plan/tasks.yaml": "[]\n", [pathOf("W1-T90001")]: shard("W1-T90001"), "docs/notes.txt": "# notes\n", "world.txt": `${root}\n`,
  } });
  const ops = originWithClone(join(root, "repos", "remudero-ops"), { seed: {
    "plan/tasks.yaml": "[]\n", [pathOf("W1-T90002")]: shard("W1-T90002"), "world.txt": `${root} ops\n`,
  } });
  for (const clone of [pub.clone, ops.clone]) {
    clone.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
    clone.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  }
  if (host === "garbage") writeFileSync(planDestinationPath(stateDir), "{ not json");
  else if (host !== "absent") writeFileSync(planDestinationPath(stateDir), JSON.stringify({ repository: OPS, kinds: host.kinds }));
  t.after(() => {
    for (const r of [pub.origin, ops.origin]) r.cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  const rows: Row[] = [];
  const log = (step: string, extra: Record<string, unknown> = {}): void => void rows.push({ ...extra, step });
  const gh = { open: new Map<string, Array<{ url: string }>>(), creates: [] as string[], rest: [] as string[] };
  const repoOf = (args: string[]): string => args[args.indexOf("--repo") + 1] ?? "none";
  /** The `gh` the shared landing calls: an open-PR list, a create and a view for each repository. */
  const landingGh = (args: string[]): string => {
    const repo = args.includes("--repo") ? repoOf(args) : "none";
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify(gh.open.get(repo) ?? []);
    if (args[0] === "pr" && args[1] === "create") {
      const url = `https://github.com/${repo}/pull/${9000 + gh.creates.length + 1}`;
      gh.creates.push(url);
      gh.open.set(repo, [{ url }]);
      return url;
    }
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ state: "OPEN" });
    return "[]";
  };
  const preflights: Array<{ cwd: string; codeRoot?: string }> = [];
  const landingPreflights: Array<{ headRef?: string }> = [];
  const taskFilesLanding = {
    stateRoot: root, gh: landingGh,
    planPrPreflight: async (_sha: string, pr: { headRef?: string }): Promise<PlanPrPreflightResult> => {
      landingPreflights.push({ headRef: pr.headRef });
      return GREEN;
    },
  };
  let tick = T0;
  const clock = clockFromMillisFn(() => (tick += 1000));
  /** The options `daemonGardenWorkspace` passes, with the GitHub and preflight fakes, and the switch as the host reads it. */
  const checkoutOpts = (name: GardenName, only: boolean): GardenCheckoutOpts => {
    const at = resolvePlanDestination("task", stateDir, { owner: "acme", repo: "remudero", checkoutDir: pub.clone.dir });
    return {
      name, repoDir: pub.clone.dir, worktreesRoot: join(root, "worktrees"), owner: "acme", repo: "remudero", log, clock,
      preflight: (input) => {
        preflights.push({ cwd: input.cwd, ...(input.codeRoot === undefined ? {} : { codeRoot: input.codeRoot }) });
        return GREEN;
      },
      // The REST create of a garden's own PR.
      fetcher: async (args) => {
        gh.rest.push(args.join(" "));
        const repo = /repos\/([^/]+\/[^/]+)\/pulls/.exec(args.join(" "))?.[1] ?? "none";
        return { html_url: `https://github.com/${repo}/pull/${700 + gh.rest.length}`, number: 700 + gh.rest.length };
      },
      taskFilesLanding,
      ...(only ? { taskFilesOnly: true as const } : {}),
      ...(at.outcome === "destination" || at.outcome === "unreadable" ? { taskDestination: at } : {}),
    };
  };
  const ctx = {
    config: { root } as Parameters<typeof daemonGardenWorkspace>[0]["config"], repoRoot: pub.clone.dir, owner: "acme", repo: "remudero", log,
  };
  const heads = (origin: typeof pub.origin): string[] => origin.git("for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean);
  const worktrees = (clone: typeof pub.clone): number => clone.git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length;
  return { root, stateDir, pub, ops, rows, gh, preflights, landingPreflights, taskFilesLanding, checkoutOpts, ctx, heads, worktrees, log,
    steps: (step: string) => rows.filter((r) => r.step === step) };
}

const land = (ws: Awaited<ReturnType<typeof gardenCheckoutAsync>>, paths: string[], body: string, extra: { sealedLanding?: false } = {}) =>
  withLiveWritesAllowed(() => ws.land({ paths, title: "chore(plan): tend the plan", body, ...extra }));

test("W1-T12212 criterion 1: with task in the kinds, a new task file gets a checkout of the destination, is pushed there and opens its pull request there", async (t) => {
  const w = world(t, { kinds: ["task"] });
  const ws = await gardenCheckoutAsync(w.checkoutOpts("queue-judge", false));
  try {
    writeFileSync(join(ws.root, pathOf("W1-T95001")), shard("W1-T95001"));
    const out = await land(ws, [pathOf("W1-T95001")], fileBody("W1-T95001"));
    assert.match(String(out), /^https:\/\/github\.com\/acme\/remudero-ops\/pull\//, "the pull request opens in the destination");
    assert.equal(w.gh.rest.length, 1);
    assert.match(w.gh.rest[0]!, /repos\/acme\/remudero-ops\/pulls/);
    assert.ok(w.heads(w.ops.origin).includes(String(ws.branch)), "the garden branch is pushed to the destination");
    assert.ok(!w.heads(w.pub.origin).includes(String(ws.branch)), "the public repository gets no branch");
    assert.equal(w.ops.origin.git("show", `${ws.branch}:${pathOf("W1-T95001")}`), shard("W1-T95001").trimEnd());
    // The preflight runs in the destination checkout and reads the public code at the garden checkout.
    assert.equal(w.preflights.length, 1);
    assert.notEqual(w.preflights[0]!.cwd, ws.root);
    assert.equal(w.preflights[0]!.codeRoot, ws.root);
    assert.equal(w.worktrees(w.ops.clone), 1, "the worktree of the destination is removed after the land");
    assert.equal(w.steps("queue-judge.garden_plan_destination").at(-1)?.outcome, "destination");
  } finally {
    await ws.dispose();
  }
});

test("W1-T12212 criterion 2: a gardener that changes a task file edits it in the repository that holds it, also when the kind is on", async (t) => {
  const w = world(t, { kinds: ["task"] });
  const ws = await gardenCheckoutAsync(w.checkoutOpts("plan", false));
  try {
    writeFileSync(join(ws.root, pathOf("W1-T90001")), shard("W1-T90001", "tended"));
    const own = await land(ws, [pathOf("W1-T90001")], editBody("W1-T90001"), { sealedLanding: false });
    assert.match(String(own), /^https:\/\/github\.com\/acme\/remudero\/pull\//, "its own pull request opens in the public repository");
    assert.match(w.gh.rest[0]!, /repos\/acme\/remudero\/pulls/);
    assert.ok(w.heads(w.pub.origin).includes(String(ws.branch)));
    assert.deepEqual(w.heads(w.ops.origin), ["main"], "the destination gets no branch");
    assert.equal(w.preflights[0]!.cwd, ws.root);
    assert.equal(w.preflights[0]!.codeRoot, undefined);
  } finally {
    await ws.dispose();
  }
  // Through the shared landing, the edit waits for the public repository's landing pull request.
  const sealed = await gardenCheckoutAsync(w.checkoutOpts("plan", false));
  try {
    writeFileSync(join(sealed.root, pathOf("W1-T90001")), shard("W1-T90001", "tended twice"));
    const out = await land(sealed, [pathOf("W1-T90001")], editBody("W1-T90001"));
    assert.match(String(out), /^https:\/\/github\.com\/acme\/remudero\/pull\/9001$/);
    assert.deepEqual(w.gh.creates, ["https://github.com/acme/remudero/pull/9001"]);
    assert.deepEqual(w.heads(w.ops.origin), ["main"]);
  } finally {
    await sealed.dispose();
  }
});

test("W1-T12212: a land that adds one task file and edits another is refused with a message", async (t) => {
  const w = world(t, { kinds: ["task"] });
  const ws = await gardenCheckoutAsync(w.checkoutOpts("queue-judge", false));
  try {
    writeFileSync(join(ws.root, pathOf("W1-T95001")), shard("W1-T95001"));
    writeFileSync(join(ws.root, pathOf("W1-T90001")), shard("W1-T90001", "tended"));
    const out = await land(ws, [pathOf("W1-T95001"), pathOf("W1-T90001")], fileBody("W1-T95001"));
    assert.equal(out, undefined);
    const row = w.steps("queue-judge.garden_plan_destination").at(-1);
    assert.equal(row?.outcome, "refused");
    assert.match(String(row?.error), /adds a task file and edits another/);
    assert.equal(w.gh.rest.length + w.gh.creates.length, 0, "no pull request opens");
    assert.equal(w.preflights.length, 0);
  } finally {
    await ws.dispose();
  }
});

test("W1-T12212 criterion 3: a gardener whose change has a path outside plan/ uses the public repository, as it does today", async (t) => {
  const w = world(t, { kinds: ["task"] });
  const ws = await gardenCheckoutAsync(w.checkoutOpts("queue-judge", false));
  try {
    writeFileSync(join(ws.root, pathOf("W1-T95001")), shard("W1-T95001"));
    writeFileSync(join(ws.root, "docs/notes.txt"), "# notes\n\ntended\n");
    const out = await land(ws, [pathOf("W1-T95001"), "docs/notes.txt"], fileBody("W1-T95001"));
    assert.match(String(out), /^https:\/\/github\.com\/acme\/remudero\/pull\//);
    assert.match(w.gh.rest[0]!, /repos\/acme\/remudero\/pulls/);
    assert.ok(w.heads(w.pub.origin).includes(String(ws.branch)));
    assert.deepEqual(w.heads(w.ops.origin), ["main"]);
    assert.equal(w.steps("queue-judge.garden_plan_destination").length, 0);
  } finally {
    await ws.dispose();
  }
});

test("W1-T12212 criterion 4: the shared landing for task files lands a new task file in the destination repository", async (t) => {
  const w = world(t, { kinds: ["task"] });
  const ws = await gardenCheckoutAsync(w.checkoutOpts("ci-friction", true));
  try {
    const landingBranch = await taskFilesLandingBranchAsync({ owner: "acme", repo: "remudero-ops" });
    assert.equal(ws.branch, landingBranch, "a new id is reserved on the landing branch of the destination");
    writeFileSync(join(ws.root, pathOf("W1-T95001")), shard("W1-T95001"));
    const out = await land(ws, [pathOf("W1-T95001")], fileBody("W1-T95001"));
    assert.equal(out, "https://github.com/acme/remudero-ops/pull/9001");
    assert.deepEqual(w.gh.creates, ["https://github.com/acme/remudero-ops/pull/9001"]);
    assert.ok(w.landingPreflights.length > 0 && w.landingPreflights.every((p) => p.headRef === landingBranch), "the preflight asks about the destination's landing branch");
    assert.ok(w.heads(w.ops.origin).includes(landingBranch), "the landing branch is pushed to the destination");
    assert.equal(w.ops.origin.git("show", `${landingBranch}:${pathOf("W1-T95001")}`), shard("W1-T95001").trimEnd());
    assert.deepEqual(w.heads(w.pub.origin), ["main"], "the public repository gets no branch");
  } finally {
    await ws.dispose();
  }
});

test("W1-T12212 criterion 5: with no host file, each gardener gets the same checkout and makes the same calls as today", async (t) => {
  const w = world(t, "absent");
  const only = await daemonGardenWorkspace(w.ctx, "ci-friction")();
  try {
    assert.equal(only.branch, await taskFilesLandingBranchAsync({ owner: "acme", repo: "remudero" }));
  } finally {
    await only.dispose();
  }
  const ws = await gardenCheckoutAsync(w.checkoutOpts("queue-judge", false));
  try {
    assert.match(String(ws.branch), /^queue-judge-garden-\d+$/);
    writeFileSync(join(ws.root, pathOf("W1-T95001")), shard("W1-T95001"));
    const out = await land(ws, [pathOf("W1-T95001")], fileBody("W1-T95001"));
    assert.match(String(out), /^https:\/\/github\.com\/acme\/remudero\/pull\//);
    assert.equal(w.gh.rest.length, 1);
    assert.match(w.gh.rest[0]!, /^api --method POST repos\/acme\/remudero\/pulls /);
    assert.deepEqual(w.preflights, [{ cwd: ws.root }], "the preflight runs in the garden checkout with no code root");
    assert.ok(w.heads(w.pub.origin).includes(String(ws.branch)));
    assert.deepEqual(w.heads(w.ops.origin), ["main"]);
    assert.equal(w.rows.filter((r) => r.step.endsWith(".garden_plan_destination")).length, 0, "the switch is never consulted at land");
  } finally {
    await ws.dispose();
  }
});

test("W1-T12212 criterion 6: `daemonGardenWorkspace` reads the switch each time it builds the checkout of a registered gardener", async (t) => {
  const w = world(t, { kinds: ["task"] });
  const opsBranch = await taskFilesLandingBranchAsync({ owner: "acme", repo: "remudero-ops" });
  const pubBranch = await taskFilesLandingBranchAsync({ owner: "acme", repo: "remudero" });
  const on = await daemonGardenWorkspace(w.ctx, "ci-friction")();
  try {
    assert.equal(on.branch, opsBranch, "with the kind on, a gardener that files task files reserves on the destination's landing branch");
    writeFileSync(join(on.root, pathOf("W1-T95001")), shard("W1-T95001"));
    writeFileSync(join(on.root, pathOf("W1-T90001")), shard("W1-T90001", "tended"));
    assert.equal(await land(on, [pathOf("W1-T95001"), pathOf("W1-T90001")], fileBody("W1-T95001")), undefined);
    assert.equal(w.steps("ci-friction.garden_plan_destination").at(-1)?.outcome, "refused");
  } finally {
    await on.dispose();
  }
  // The operator removes `task` from the kinds: the next checkout files in the public repository.
  writeFileSync(planDestinationPath(w.stateDir), JSON.stringify({ repository: OPS, kinds: ["decision"] }));
  const off = await daemonGardenWorkspace(w.ctx, "ci-friction")();
  try {
    assert.equal(off.branch, pubBranch);
  } finally {
    await off.dispose();
  }
  // A host file that cannot be read files no new task anywhere.
  writeFileSync(planDestinationPath(w.stateDir), "{ not json");
  const unreadable = await daemonGardenWorkspace(w.ctx, "queue-judge")();
  try {
    writeFileSync(join(unreadable.root, pathOf("W1-T95002")), shard("W1-T95002"));
    assert.equal(await land(unreadable, [pathOf("W1-T95002")], fileBody("W1-T95002")), undefined);
    const row = w.steps("queue-judge.garden_plan_destination").at(-1);
    assert.equal(row?.outcome, "refused");
    assert.match(String(row?.error), /plan destination is unreadable/);
    assert.doesNotMatch(String(row?.error), /remudero-ops/, "the reason names no private repository");
  } finally {
    await unreadable.dispose();
  }
});

test("W1-T12212 criterion 7: a landing for one repository never carries or sets aside a file that waits for the other", async (t) => {
  const w = world(t, { kinds: ["task"] });
  const pubTarget = { ...w.taskFilesLanding, targetRepository: { owner: "acme", repo: "remudero" }, log: w.log };
  const opsTarget = { ...w.taskFilesLanding, targetRepository: { owner: "acme", repo: "remudero-ops" }, log: w.log };
  const edit = { relPath: pathOf("W1-T90001"), content: shard("W1-T90001", "tended"), claim: "tended", proof: `grep: note: tended in ${pathOf("W1-T90001")}` };
  const fresh = { relPath: pathOf("W1-T95003"), content: shard("W1-T95003"), claim: "filed", proof: `grep: id: W1-T95003 in ${pathOf("W1-T95003")}`, newFile: true as const };
  await withLiveWritesAllowed(async () => {
    assert.equal((await landTaskFilesAsync(w.pub.clone.dir, [edit], { ...pubTarget, stageOnly: true })).refused.length, 0);
    assert.equal((await landTaskFilesAsync(w.ops.clone.dir, [fresh], { ...opsTarget, stageOnly: true })).refused.length, 0);
    // A file staged before W1-T12212 names no repository; it is the public repository's.
    const legacy = { relPath: pathOf("W1-T95004"), content: shard("W1-T95004"), claim: "filed", proof: `grep: id: W1-T95004 in ${pathOf("W1-T95004")}`, newFile: true as const };
    await landTaskFilesAsync(w.pub.clone.dir, [legacy], { ...pubTarget, stageOnly: true });
    const legacyMeta = join(w.root, "state", "task-files-landing-pending", `${legacy.relPath}.meta.json`);
    const { repository, ...rest } = JSON.parse(readFileSync(legacyMeta, "utf8")) as Record<string, unknown>;
    assert.equal(repository, PUBLIC, "a file staged now names its repository");
    writeFileSync(legacyMeta, `${JSON.stringify(rest)}\n`);

    const toOps = await landTaskFilesAsync(w.ops.clone.dir, [], opsTarget);
    assert.equal(toOps.prUrl, "https://github.com/acme/remudero-ops/pull/9001");
    assert.deepEqual(toOps.landed, [fresh.relPath]);
    assert.deepEqual(toOps.waiting, [], "the files that wait for the public repository are not this landing's");
    assert.deepEqual(toOps.setAside, [], "nothing of the public repository is set aside");
    assert.equal(w.ops.origin.git("show", `${await taskFilesLandingBranchAsync(opsTarget.targetRepository)}:${fresh.relPath}`), shard("W1-T95003").trimEnd());

    const toPublic = await landTaskFilesAsync(w.pub.clone.dir, [], pubTarget);
    assert.equal(toPublic.prUrl, "https://github.com/acme/remudero/pull/9002");
    assert.deepEqual([...toPublic.landed].sort(), [edit.relPath, pathOf("W1-T95004")].sort());
    assert.deepEqual(toPublic.setAside, []);
    const pubBranch = await taskFilesLandingBranchAsync(pubTarget.targetRepository);
    assert.throws(() => w.pub.origin.git("show", `${pubBranch}:${fresh.relPath}`), "the new ops file never reaches the public repository");
  });
  assert.equal(stagedTaskFiles(w.root).length, 3, "each file waits for the merge of its own landing pull request");
  assert.ok(!existsSync(join(w.root, "state", "task-files-landing-refused")), "no file is set aside");
});
