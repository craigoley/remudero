import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  approveRunBranch,
  fileRatificationBatch,
  inboxDraftExampleFragmentYaml,
  joinedRatificationPrBody,
  RatificationDraftRefusedError,
  ratificationPrBody,
  type RatificationPayload,
} from "../src/lib/inbox.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { changedFilesBlockDrift } from "../src/lib/plan-pr-emitter.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { approveCommand } from "../src/run-task.js";
import { ghShim, type GhShimRoute } from "./helpers/gh-shim.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY, type GitRepo } from "./helpers/git-repo.js";

// W1-T4706. W1-T4700 routed the SINGLE approve through `fileRatificationDraft` (the stamp and repo
// re-check, and a PR body naming only the paths written). The BATCH lane still wrote through the
// bare shard writer and listed MASTER-PLAN.md unconditionally, and a ratify PR joined by a later
// approve kept the first approve's body — #7608 was two proposals joined, five shards under a
// two-shard body. The drives below run the REAL un-injected gateways offline: a bare throwaway
// origin, a `gh` shim on PATH, and `approveCommand` itself.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const KNOWN = new Set(["none", "remudero"]);
const OWN_PR_URL = "https://github.com/craigoley/remudero/pull/4706";
const PRIOR_PR_URL = "https://github.com/craigoley/remudero/pull/4437";

// ── #7608's own fragment: five malformed tasks under a two-id stamp ─────────────────────────
const PROPOSAL_7608 = "verify-human-automate:W1-T4471";
const malformed = (id: string, n: number): string =>
  [
    `- id: ${id}`,
    `  title: Placeholder task ${n} for P25`,
    "  repo: master-plan",
    "  depends_on: []",
    "  type: implement",
    "  verify:",
    '    proof: "grep: MASTER-PLAN.md contains an open ratification candidate for §7/P25; skeleton task created"',
    "  risk: low",
    "  status: queued",
    "  attempts: 0",
    "  origin: plan/tasks.yaml",
    "  files:",
    "    - plan/tasks.yaml",
    "    - MASTER-PLAN.md",
  ].join("\n");
const FIVE_IDS = ["W1-T4695", "W1-T4696", "W1-T4697", "W1-T4698", "W1-T4699"];
const PAYLOAD_7608: RatificationPayload = {
  proposalId: PROPOSAL_7608,
  fragmentYaml: FIVE_IDS.map((id, i) => malformed(id, i + 1)).join("\n"),
  stampLine: `- ${PROPOSAL_7608} (Ratification skeleton for MASTER-PLAN §7/P25 open plan) — RATIFIED 2026-09-28 -> W1-T4695/W1-T4696`,
};

/** A well-formed one-task draft: the canonical example with its own title, claim, file and repo. */
function draftFor(proposalId: string, title: string, file: string, repo = "remudero"): { fragmentYaml: string; stampLine: string } {
  const fragmentYaml = inboxDraftExampleFragmentYaml()
    .replace("Tighten the empty-input guard in parseWidget", title)
    .replaceAll("parseWidget rejects an empty input instead of throwing a raw TypeError", `${title} holds under the fixture`)
    .replace("src/lib/widget.ts", file)
    .replace("repo: remudero", `repo: ${repo}`);
  return { fragmentYaml, stampLine: `- ${proposalId} (${title}) — RATIFIED 2026-09-28 -> NEW-1.` };
}

test("#7608's shape in a batch is refused before anything is minted or written — even behind a valid member", () => {
  const wt = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t4706-unit-`));
  const masterPlan = `# plan\n- ${PROPOSAL_7608} (open)\n- P-VALID (open)\n`;
  writeFileSync(join(wt, "MASTER-PLAN.md"), masterPlan, "utf8");
  const valid = { proposalId: "P-VALID", ...draftFor("P-VALID", "Rotate the quux ledger for the batch fixture", "src/lib/quux.ts") };
  const materialized: string[] = [];
  assert.throws(
    () =>
      fileRatificationBatch(wt, [valid, PAYLOAD_7608], (p) => (materialized.push(p.proposalId), p), { mkdirSync, writeFileSync, readFileSync }, join, KNOWN),
    (e: unknown) => e instanceof RatificationDraftRefusedError && e.message.includes(PROPOSAL_7608) && /repo "master-plan"/.test(e.message),
  );
  assert.deepEqual(materialized, [], "no member is minted once any member's draft is refused");
  assert.equal(existsSync(join(wt, "plan")), false, "no shard may be written, the valid member's included");
  assert.equal(readFileSync(join(wt, "MASTER-PLAN.md"), "utf8"), masterPlan, "no stamp may be folded");
});

test("a joined body keeps every stamp the current body names, adds the joining one once, and ignores other lines", () => {
  const first = "- P-FIRST (first) — RATIFIED 2026-09-28 -> W1-T50.";
  const second = "- P-JOIN (second) — RATIFIED 2026-09-28 -> W1-T51.";
  const paths = ["plan/tasks.d/W1-T50-a.yaml", "plan/tasks.d/W1-T51-b.yaml"];
  const opts = { baseRef: "fixture-base", proofCheck: () => 0 };
  const current = ratificationPrBody(first, ["W1-T50"], [paths[0]], opts);
  const body = joinedRatificationPrBody(current, second, ["W1-T50", "W1-T51"], paths, opts);
  assert.ok(body.startsWith(`${first}\n${second}\n\n`), body);
  assert.deepEqual(changedFilesBlockDrift(body, paths), { missing: [], extra: [] });
  assert.equal(joinedRatificationPrBody(body, second, ["W1-T50", "W1-T51"], paths, opts), body, "a repeated join names each stamp once");
  assert.ok(joinedRatificationPrBody("", "", ["W1-T50"], [paths[0]], opts).startsWith("The operator's"), "no stamp in, no stamp out");
});

// ── The real gateways, offline ──────────────────────────────────────────────────────────────

interface Drive {
  origin: GitRepo;
  root: string;
  error: unknown;
  ledger: Array<Record<string, unknown>>;
  /** The shim's raw call log: one `$*` per call, a multi-line body spilling across lines. */
  rawCalls: string;
}

/** A GET route's JSON, safe inside the shim's double-quoted `echo`: newline, backtick and `$` as JSON escapes. */
function shimJson(value: unknown): string {
  return JSON.stringify(value).replace(/\\n/g, "\\u000a").replace(/`/g, "\\u0060").replace(/\$/g, "\\u0024");
}

async function drive(opts: {
  ids: string[];
  drafts: Record<string, { fragmentYaml: string; stampLine: string }>;
  masterPlan?: string;
  prior?: (seed: GitRepo) => void;
  ledgerSeed?: Array<Record<string, unknown>>;
  routes: GhShimRoute[];
}): Promise<Drive> {
  const origin = gitRepo({ bare: true, kind: "t4706-origin" });
  const seed = gitRepo({ kind: "t4706-seed" });
  mkdirSync(join(seed.dir, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(seed.dir, ".remudero"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), "- id: W1-T4\n  title: a seed task the plan loader accepts\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: human\n  status: queued\n  attempts: 0\n");
  writeFileSync(join(seed.dir, "MASTER-PLAN.md"), opts.masterPlan ?? "# MASTER PLAN\n\nfixture\n");
  // The repo rule's names come from the checkout's own fleet registry, as they do in production.
  copyFileSync(join(REPO_ROOT, ".remudero", "daemon-instances.yaml"), join(seed.dir, ".remudero", "daemon-instances.yaml"));
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "chore: seed plan");
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "main");
  opts.prior?.(seed);

  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t4706-root-`));
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t4706-home-`));
  const remoteUrl = execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
  const checkoutDir = join(root, "repos", remoteUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2]);
  mkdirSync(dirname(checkoutDir), { recursive: true });
  execFileSync("git", ["clone", "--quiet", origin.dir, checkoutDir]);
  execFileSync("git", ["-C", checkoutDir, "config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name]);
  execFileSync("git", ["-C", checkoutDir, "config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email]);

  const config = { claudeBin: "/usr/bin/true", root, installRoot: REPO_ROOT };
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify(config));
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    join(root, "state", "inbox-proposals.json"),
    JSON.stringify({ proposals: opts.ids.map((id) => ({ id, summary: `${id} fixture`, evidenceAnchors: [] })) }),
  );
  const drafts = Object.fromEntries(Object.entries(opts.drafts).map(([id, d]) => [id, { proposalId: id, ...d, anchorFingerprint: "" }]));
  writeFileSync(join(root, "state", "inbox-drafts.json"), JSON.stringify(drafts));
  const ledgerFile = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerFile, (opts.ledgerSeed ?? []).map((r) => JSON.stringify(r) + "\n").join(""));

  const shim = ghShim(opts.routes, { kind: "t4706-gh" });
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  let error: unknown;
  try {
    process.env.HOME = home;
    process.env.PATH = `${shim.dir}:${savedPath}`;
    await withLiveWritesAllowed(() => approveCommand(opts.ids, { config: config as never }));
  } catch (e) {
    error = e;
  } finally {
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
  }
  const ledger = readFileSync(ledgerFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { origin, root, error, ledger, rawCalls: readFileSync(join(shim.dir, "calls.log"), "utf8") };
}

/** Every body a write call carried, in order. A body is one argv value that may span lines, so the
 *  log is sliced on the argv that follows it (POST) or on the next call's first word (PATCH). */
function writtenBodies(raw: string, marker: "--method POST" | "-X PATCH"): string[] {
  const bodies: string[] = [];
  for (let at = raw.indexOf(marker); at >= 0; at = raw.indexOf(marker, at + 1)) {
    const from = raw.indexOf(" -f body=", at) + " -f body=".length;
    const next = marker === "--method POST" ? raw.indexOf(" -f head=", from) : raw.slice(from).search(/\n(?:api|pr|repo) /) + from;
    bodies.push(raw.slice(from, next < from ? raw.length : next));
  }
  return bodies;
}

const runBranches = (origin: GitRepo): string[] =>
  origin.git("for-each-ref", "--format=%(refname:short)", "refs/heads/run-*").split("\n").filter(Boolean);

/** A batch run's own PR is refused by the ownership guard right after it opens: no CI wait, no review. */
const BATCH_ROUTES: GhShimRoute[] = [
  { when: "--method POST", stdout: JSON.stringify({ html_url: OWN_PR_URL, number: 4706 }) },
  { when: "headRefName", stdout: JSON.stringify({ headRefName: "someone-elses-branch" }) },
  { when: "pulls?state=open", stdout: "[]" },
  { when: "pulls?head=", stdout: "[]" },
  { when: "/pulls/", stdout: JSON.stringify({ number: 4706, html_url: OWN_PR_URL, state: "open", head: { ref: "someone-elses-branch", sha: "0" } }) },
];

test("a batch approve refuses a fragment the single lane refuses: nothing is minted, written, pushed or opened", async () => {
  const d = await drive({
    ids: ["P-GOOD", "P-BADREPO"],
    drafts: {
      "P-GOOD": draftFor("P-GOOD", "Rotate the quux ledger for the batch fixture", "src/lib/quux.ts"),
      // Well-formed in every way the readiness classification reads, so it reaches the gateway;
      // only the repo rule, which needs the checkout's registry, refuses it.
      "P-BADREPO": draftFor("P-BADREPO", "Index the zorble registry for the batch fixture", "src/lib/zorble.ts", "master-plan"),
    },
    routes: BATCH_ROUTES,
  });
  const steps = JSON.stringify(d.ledger.map((l) => l.step));
  assert.ok(d.error instanceof RatificationDraftRefusedError, `the batch must refuse by name; got ${String(d.error)}; steps=${steps}`);
  assert.match(String((d.error as Error).message), /P-BADREPO.*repo "master-plan"/s);
  assert.ok(!d.ledger.some((l) => l.step === "approve.id_materialized" || l.step === "approve.shards_written"), `nothing minted or written; steps=${steps}`);
  assert.deepEqual(runBranches(d.origin), [], "no branch reaches the origin");
  assert.equal(d.origin.git("for-each-ref", "refs/rmd-id"), "", "no task id is reserved remotely");
  assert.deepEqual(writtenBodies(d.rawCalls, "--method POST"), [], "no PR is opened");
  const worktrees = existsSync(join(d.root, "worktrees")) ? readdirSync(join(d.root, "worktrees")).filter((w) => w.startsWith("run-")) : [];
  assert.deepEqual(worktrees, [], "the refused run's worktree is removed");
});

test("a valid batch's PR lists only the files it wrote — MASTER-PLAN.md only when a stamp changed it", async () => {
  for (const withBullet of [false, true]) {
    const d = await drive({
      ids: ["P-ALPHA", "P-BETA"],
      drafts: {
        "P-ALPHA": draftFor("P-ALPHA", "Rotate the quux ledger for the batch fixture", "src/lib/quux.ts"),
        "P-BETA": draftFor("P-BETA", "Index the zorble registry for the batch fixture", "src/lib/zorble.ts"),
      },
      masterPlan: withBullet ? "# MASTER PLAN\n\n- P-ALPHA (open)\n" : "# MASTER PLAN\n\nfixture\n",
      routes: BATCH_ROUTES,
    });
    const steps = JSON.stringify(d.ledger.map((l) => l.step));
    assert.equal(d.error, undefined, `the batch must not throw; steps=${steps}`);
    const [branch] = runBranches(d.origin);
    assert.ok(branch, `one batch branch is pushed; steps=${steps}`);
    const diff = d.origin.git("diff", "--name-only", `main...${branch}`).split("\n").filter(Boolean);
    assert.equal(diff.filter((p) => p.startsWith("plan/tasks.d/")).length, 2, `one shard per member; diff=${JSON.stringify(diff)}`);
    assert.equal(diff.includes("MASTER-PLAN.md"), withBullet, "the stamp touches MASTER-PLAN.md only where it has a bullet");
    const bodies = writtenBodies(d.rawCalls, "--method POST");
    assert.equal(bodies.length, 1, "one PR for the whole batch");
    assert.deepEqual(changedFilesBlockDrift(bodies[0], diff), { missing: [], extra: [] }, `Changed files is the diff (withBullet=${withBullet})`);
    assert.equal(bodies[0].includes("MASTER-PLAN.md"), withBullet, "no filing criterion or listing names an unwritten MASTER-PLAN.md");
  }
});

// ── A later approve joining an open ratify PR ──────────────────────────────────────────────

const PRIOR_RUN_ID = "APPROVE-P-FIRST-1790000000000";
const PRIOR_SHARD = "plan/tasks.d/W1-T50-rotate-the-quux-ledger-for-the-join-fixture.yaml";
const PRIOR_STAMP = "- P-FIRST (Rotate the quux ledger) — RATIFIED 2026-09-28 -> W1-T50.";

async function driveJoin(patch: GhShimRoute): Promise<Drive & { priorBranch: string }> {
  const priorBranch = approveRunBranch(PRIOR_RUN_ID);
  let priorSha = "";
  const priorBody = ratificationPrBody(PRIOR_STAMP, ["W1-T50"], [PRIOR_SHARD], { baseRef: "fixture-base", proofCheck: () => 0 });
  const routes = (): GhShimRoute[] => [
    patch,
    { when: "--method POST", stdout: JSON.stringify({ html_url: OWN_PR_URL, number: 4706 }) },
    { when: "headRefName", stdout: JSON.stringify({ headRefName: priorBranch }) },
    { when: "/check-runs", stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }] }) },
    { when: "/status", stdout: JSON.stringify({ statuses: [] }) },
    { when: "pulls?state=open", stdout: "[]" },
    { when: "pulls?head=", stdout: JSON.stringify([{ html_url: PRIOR_PR_URL, number: 4437 }]) },
    {
      when: "/pulls/",
      stdout: shimJson({ number: 4437, html_url: PRIOR_PR_URL, state: "open", merged_at: null, body: priorBody, head: { ref: priorBranch, sha: priorSha } }),
    },
  ];
  const lazy: GhShimRoute[] = [];
  const d = await drive({
    ids: ["P-JOIN"],
    drafts: { "P-JOIN": draftFor("P-JOIN", "Index the zorble registry for the join fixture", "src/lib/zorble.ts") },
    prior: (seed) => {
      seed.git("checkout", "--quiet", "-b", priorBranch);
      const shard = draftFor("P-FIRST", "Rotate the quux ledger for the join fixture", "src/lib/quux.ts").fragmentYaml.replace("NEW-1", "W1-T50");
      writeFileSync(join(seed.dir, PRIOR_SHARD), shard);
      seed.git("add", "-A");
      seed.git("commit", "--quiet", "-m", "chore(plan): ratify P-FIRST via rmd approve");
      seed.git("push", "--quiet", "origin", priorBranch);
      priorSha = seed.git("rev-parse", "HEAD");
      lazy.push(...routes());
    },
    ledgerSeed: [{ run_id: PRIOR_RUN_ID, task_id: "P-FIRST", step: "ratify.approved", branch: priorBranch, pr_url: PRIOR_PR_URL, pr_number: 4437 }],
    routes: lazy,
  });
  return { ...d, priorBranch };
}

test("a joined ratify PR's body is rebuilt over both proposals' shards and stamps, and PATCHed onto that PR", async () => {
  const d = await driveJoin({ when: "-X PATCH", stdout: "{}" });
  const steps = JSON.stringify(d.ledger.map((l) => l.step));
  assert.ok(d.ledger.some((l) => l.step === "approve.joined" && l.branch === d.priorBranch), `the approval joined the open PR; steps=${steps}`);
  assert.equal(runBranches(d.origin).length, 1, "no second approve branch");
  const patches = writtenBodies(d.rawCalls, "-X PATCH");
  assert.equal(patches.length, 1, `exactly one body write; steps=${steps}`);
  assert.match(d.rawCalls, /-X PATCH repos\/craigoley\/remudero\/pulls\/4437 -f body=/, "the PATCH targets the joined PR itself");
  const diff = d.origin.git("diff", "--name-only", `main...${d.priorBranch}`).split("\n").filter(Boolean);
  assert.equal(diff.filter((p) => p.startsWith("plan/tasks.d/")).length, 2, `both proposals' shards are on the branch; diff=${JSON.stringify(diff)}`);
  assert.deepEqual(changedFilesBlockDrift(patches[0], diff), { missing: [], extra: [] }, "Changed files names both proposals' shards");
  assert.ok(patches[0].includes(PRIOR_STAMP), "the first approve's stamp is kept");
  assert.match(patches[0], /^- P-JOIN \(Index the zorble registry for the join fixture\) — RATIFIED 2026-09-28 -> W1-T\d+\.$/m, "the joining stamp is added, materialized");
  assert.match(patches[0], /W1-T50 is filed as a well-formed plan task shard/, "the first proposal's filing criterion survives the join");
  assert.ok(d.ledger.some((l) => l.step === "approve.join_body_refreshed" && l.pr_url === PRIOR_PR_URL), `the refresh is ledgered; steps=${steps}`);
});

test("a failed body write on a join is ledgered, and the approval it follows still lands", async () => {
  const d = await driveJoin({ when: "-X PATCH", stderr: "gh: HTTP 502 (fixture)", exit: 1 });
  const steps = JSON.stringify(d.ledger.map((l) => l.step));
  const stale = d.ledger.find((l) => l.step === "approve.join_body_stale");
  assert.ok(stale, `a stale body is ledgered, never silent; steps=${steps}`);
  assert.equal(stale.pr_url, PRIOR_PR_URL);
  const row = d.ledger.find((l) => l.step === "ratify.approved" && l.task_id === "P-JOIN");
  assert.equal(row?.joined, true, `the pushed commit is still recorded as this approval; steps=${steps}`);
});
