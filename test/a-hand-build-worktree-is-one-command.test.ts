// W1-T5533: `rmd hand-worktree <taskId>` makes a hand build's worktree in one command. Every fixture
// is a throwaway bare origin + clone (test/helpers/git-repo.ts); git, npm and cp really run, so the
// default seams are the ones exercised.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { dispatchClaimRef, parseClaimAnchorMessage, type DispatchClaimReserver } from "#src/lib/dispatch-claim.js";
import {
  HAND_WORKTREE_TASK_ID_RE,
  createHandWorktree,
  donorRejection,
  findDonor,
  formatGiB,
  hardLinkNodeModules,
  renderHandWorktree,
} from "#src/lib/hand-worktree.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { dispatchClaimReserverFor, handWorktreeCommand } from "#src/run-task.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

// W1-T14307: the dispatch-claim reserver mints its anchor with `commit-tree` through the inherited environment, so
// the fixture's identity must be in process.env for a stripped CI runner (no git identity) to mint it.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
  GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
  GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
  GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
});

const NOW = 1_791_000_000_000;
const PKG = '{"name":"fixture","version":"1.0.0","private":true}\n';
const LOCK = '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"fixture","version":"1.0.0"}}}\n';

interface Fleet {
  origin: GitRepo;
  seed: GitRepo;
  core: GitRepo;
  parent: string;
}

function fleet(): Fleet {
  const origin = gitRepo({ bare: true, kind: "hw-origin" });
  const seed = gitRepo({ kind: "hw-seed" });
  writeFileSync(join(seed.dir, "package.json"), PKG);
  writeFileSync(join(seed.dir, "package-lock.json"), LOCK);
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  seed.addRemote("origin", origin.dir);
  seed.git("push", "-q", "origin", "main");
  const core = gitRepo({ cloneFrom: origin.dir, kind: "hw-core" });
  return { origin, seed, core, parent: mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}hw-parent-`)) };
}

/** The sha `ref` names on the fixture's bare origin, or "" when origin holds no such ref. */
function originRef(f: Fleet, ref: string): string {
  const r = spawnSync("git", ["-C", f.origin.dir, "for-each-ref", "--format=%(objectname)", ref], { encoding: "utf8" });
  return (r.stdout ?? "").trim();
}

/** A server-side hook in the fixture's bare origin; the hardened leaf disables only the CLIENT's hooks. */
function originHook(f: Fleet, name: "pre-receive" | "post-receive", body: string): void {
  writeFileSync(join(f.origin.dir, "hooks", name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

/** A refused claim leaves no new worktree, no local branch, and (when origin is readable) no branch on origin. */
function nothingLeft(f: Fleet, branch: string, { originReadable = true } = {}): void {
  const path = join(f.parent, branch);
  assert.equal(existsSync(path), false, `${path} must be removed`);
  assert.doesNotMatch(f.core.git("worktree", "list"), new RegExp(branch), "git must not list the removed worktree");
  assert.equal(f.core.git("branch", "--list", branch), "", `the local branch ${branch} must be deleted`);
  if (originReadable) assert.equal(originRef(f, `refs/heads/${branch}`), "", `origin must not keep ${branch}`);
}

/** A reserver standing in for one whose push the host refuses (a proxy that refuses `refs/rmd-*`) or that loses a race. */
function scriptedReserver(over: Partial<DispatchClaimReserver>): DispatchClaimReserver {
  return {
    mintAnchor: () => "a".repeat(40),
    attempt: () => "unreachable",
    holder: () => undefined,
    drop: () => true,
    lastAttemptStderr: () => "fatal: unable to access 'https://github.com/x/y.git/': The requested URL returned error: 403",
    ...over,
  };
}

function donor(f: Fleet, name: string, opts: { lock?: string; pkg?: string; bin?: boolean } = {}): string {
  const dir = f.core.addWorktree(join(f.parent, name), name).dir;
  if (opts.lock !== undefined) writeFileSync(join(dir, "package-lock.json"), opts.lock);
  if (opts.pkg !== undefined) writeFileSync(join(dir, "package.json"), opts.pkg);
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  if (opts.bin !== false) writeFileSync(join(dir, "node_modules", ".bin", "tool"), "#!/bin/sh\n");
  return dir;
}

function pushCommit(f: Fleet, message: string, branch = "main"): void {
  f.seed.git("commit", "-q", "--allow-empty", "-m", message);
  f.seed.git("push", "-q", "origin", `HEAD:refs/heads/${branch}`);
}

function command(rest: string[], opts: Parameters<typeof handWorktreeCommand>[1]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const [log, error] = [console.log, console.error];
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    return { code: handWorktreeCommand(rest, opts), out: out.join("\n"), err: err.join("\n") };
  } finally {
    [console.log, console.error] = [log, error];
  }
}

function created(r: ReturnType<typeof createHandWorktree>): Extract<typeof r, { status: "created" }> {
  assert.equal(r.status, "created", JSON.stringify(r));
  return r as Extract<typeof r, { status: "created" }>;
}

test("hand-worktree creates run-<taskId>-<epochMs> at an absolute path with no upstream and a hard-linked node_modules", () => {
  const f = fleet();
  pushCommit(f, "near miss\n\nRemudero-Task: W1-T99");
  pushCommit(f, "near miss branch", "run-W1-T90-1");
  const lender = donor(f, "lender");
  const r = command(["W1-T9", "--parent", f.parent], { repoDir: f.core.dir, clock: fixedClock(NOW) });
  assert.equal(r.code, 0, r.err);
  const path = join(f.parent, `run-W1-T9-${NOW}`);
  assert.ok(isAbsolute(path) && existsSync(join(path, "package.json")));
  assert.match(r.out, new RegExp(`path:   ${path}`));
  assert.match(r.out, new RegExp(`branch: run-W1-T9-${NOW}`));
  assert.match(r.out, new RegExp(`hard-linked from ${realpathSync(lender)}`));
  const upstream = spawnSync("git", ["-C", path, "rev-parse", "--abbrev-ref", "@{u}"], { encoding: "utf8" });
  assert.notEqual(upstream.status, 0, "the branch must carry no upstream");
  assert.equal(f.core.git("rev-parse", `run-W1-T9-${NOW}`), f.core.git("rev-parse", "origin/main"));
  const modules = lstatSync(join(path, "node_modules"));
  assert.equal(modules.isSymbolicLink(), false, "node_modules must never be a symlink");
  assert.equal(modules.isDirectory(), true);
  assert.equal(statSync(join(path, "node_modules", ".bin", "tool")).ino, statSync(join(lender, "node_modules", ".bin", "tool")).ino);
});

test("hand-worktree uses enabled dependency seeds and preserves an occupied destination", () => {
  const f = fleet(), lender = donor(f, "seed-lender"), target = f.core.addWorktree(join(f.parent, "seed-consumer"), "seed-consumer").dir;
  const store = join(realpathSync(f.parent), "seeds"), previous = process.env.RMD_DEPENDENCY_SEED_ROOT;
  const writable = (path: string): void => { const s = lstatSync(path); if (s.isSymbolicLink()) return; chmodSync(path, s.mode | 0o700); if (s.isDirectory()) for (const name of readdirSync(path)) writable(join(path, name)); };
  try {
    process.env.RMD_DEPENDENCY_SEED_ROOT = store;
    const outcome = hardLinkNodeModules(lender, target);
    assert.equal(outcome.kind, "seeded");
    assert.ok(lstatSync(join(target, "node_modules")).isDirectory());
    const result = { status: "created" as const, path: target, branch: "seed-consumer", freeBytes: 2 * 1024 ** 3, nodeModules: outcome, claim: { kind: "not-applicable" as const } };
    assert.match(renderHandWorktree(result), /validated dependency seed/);
    assert.deepEqual(hardLinkNodeModules(lender, target), { kind: "npm-ci-needed", reasons: ["dependency destination is already occupied"] });
    const invalid = join(f.parent, "invalid"); mkdirSync(invalid);
    const refused = hardLinkNodeModules(lender, invalid);
    assert.equal(refused.kind, "npm-ci-needed");
    if (refused.kind === "npm-ci-needed") assert.match(refused.reasons[0], /dependency seed refused/);
  } finally {
    if (previous === undefined) delete process.env.RMD_DEPENDENCY_SEED_ROOT; else process.env.RMD_DEPENDENCY_SEED_ROOT = previous;
    if (existsSync(store)) { writable(store); rmSync(store, { recursive: true }); }
  }
});

test("hand-worktree refuses a relative parent and writes nothing", () => {
  const f = fleet();
  const before = f.core.git("worktree", "list");
  const r = command(["W1-T9", "--parent", "rmd-work"], { repoDir: f.core.dir, clock: fixedClock(NOW) });
  assert.equal(r.code, 1);
  assert.match(r.err, /--parent 'rmd-work' is relative/);
  assert.equal(f.core.git("worktree", "list"), before);
});

test("an enabled hand worktree primes a reusable seed without any installed donor", () => {
  const f = fleet(), previous = process.env.RMD_DEPENDENCY_SEED_ROOT;
  const store = join(realpathSync(f.parent), "seeds");
  try {
    process.env.RMD_DEPENDENCY_SEED_ROOT = store;
    const result = created(createHandWorktree({ repoDir: f.core.dir, taskId: "unfiled", parent: f.parent, clock: fixedClock(NOW) }));
    assert.equal(result.nodeModules.kind, "seeded");
    assert.ok(existsSync(join(result.path, "node_modules", ".rmd-dependency-seed.json")));
  } finally {
    if (previous === undefined) delete process.env.RMD_DEPENDENCY_SEED_ROOT; else process.env.RMD_DEPENDENCY_SEED_ROOT = previous;
    const writable = (path: string): void => { const s = lstatSync(path); if (s.isSymbolicLink()) return; chmodSync(path, s.mode | 0o700); if (s.isDirectory()) for (const name of readdirSync(path)) writable(join(path, name)); };
    if (existsSync(store)) { writable(store); rmSync(store, { recursive: true }); }
  }
});

test("with no identical lockfile it reports npm ci and the free space instead of running it", () => {
  const f = fleet();
  donor(f, "stale", { lock: LOCK.replace("1.0.0", "2.0.0") });
  const r = created(createHandWorktree({ repoDir: f.core.dir, taskId: "W1-T9", parent: f.parent, clock: fixedClock(NOW) }));
  assert.equal(r.nodeModules.kind, "npm-ci-needed");
  assert.equal(existsSync(join(r.path, "node_modules")), false);
  const text = renderHandWorktree(r);
  assert.match(text, /next step: `npm ci` in .* \(~850 MB; \d+\.\d GiB free\)/);
  assert.match(text, /no donor: .*stale: package-lock\.json differs/);
});

test("a donor with an empty .bin, a symlinked node_modules or a failing npm ls lends nothing", () => {
  const f = fleet();
  const empty = donor(f, "empty", { bin: false });
  const broken = donor(f, "broken", { pkg: '{"name":"fixture","version":"1.0.0","dependencies":{"left-pad":"1.0.0"}}\n' });
  const linked = f.core.addWorktree(join(f.parent, "linked"), "linked").dir;
  symlinkSync(join(empty, "node_modules"), join(linked, "node_modules"));
  const r = created(createHandWorktree({ repoDir: f.core.dir, taskId: "unfiled", parent: f.parent, clock: fixedClock(NOW) }));
  assert.equal(r.branch, `run-unfiled-${NOW}`);
  assert.ok(r.nodeModules.kind === "npm-ci-needed");
  const reasons = r.nodeModules.reasons.join("\n");
  assert.match(reasons, new RegExp(`${empty}: node_modules/\\.bin is empty`));
  assert.match(reasons, new RegExp(`${broken}: npm ls failed`));
  assert.match(reasons, new RegExp(`${linked}: node_modules is not a real directory`));
  assert.match(reasons, new RegExp(`${f.core.dir}: node_modules is not a real directory`));
});

test("hand-worktree refuses a task a run-<taskId>-* branch on origin is already building", () => {
  const f = fleet();
  pushCommit(f, "fleet work", "run-W1-T9-5");
  const r = command(["W1-T9", "--parent", f.parent], { repoDir: f.core.dir, clock: fixedClock(NOW) });
  assert.equal(r.code, 1);
  assert.match(r.err, /origin already has refs\/heads\/run-W1-T9-5 — someone is building W1-T9/);
  assert.equal(existsSync(join(f.parent, `run-W1-T9-${NOW}`)), false);
});

test("hand-worktree refuses a task whose Remudero-Task trailer is already merged", () => {
  const f = fleet();
  pushCommit(f, "feat: done (W1-T9)\n\nRemudero-Task: W1-T9");
  const r = createHandWorktree({ repoDir: f.core.dir, taskId: "W1-T9", parent: f.parent, clock: fixedClock(NOW) });
  assert.equal(r.status, "refused");
  assert.match(r.status === "refused" ? r.reason : "", /W1-T9 is already merged on origin\/main: [0-9a-f]+ feat: done/);
});

test("unfiled skips the duplicate checks and names its branch from the real clock", () => {
  const f = fleet();
  pushCommit(f, "fleet work", "run-unfiled-5");
  const r = created(createHandWorktree({ repoDir: f.core.dir, taskId: "unfiled", parent: f.parent }));
  assert.match(r.branch, /^run-unfiled-\d{13}$/);
});

test("every refusal before git worktree add names its cause", () => {
  const f = fleet();
  const refuse = (over: Partial<Parameters<typeof createHandWorktree>[0]>): string => {
    const r = createHandWorktree({ repoDir: f.core.dir, taskId: "W1-T9", parent: f.parent, clock: fixedClock(NOW), ...over });
    assert.equal(r.status, "refused", JSON.stringify(r));
    return r.status === "refused" ? r.reason : "";
  };
  assert.equal(HAND_WORKTREE_TASK_ID_RE.test("W1-T9"), true);
  assert.equal(HAND_WORKTREE_TASK_ID_RE.test("../W1-T9"), false);
  assert.match(refuse({ taskId: "../W1-T9" }), /is not a task id/);
  assert.match(refuse({ parent: join(f.parent, "absent") }), /is not a directory/);
  assert.match(refuse({ minFreeBytes: Number.MAX_SAFE_INTEGER }), /GiB free under .*, below the .* GiB floor/);
  assert.match(refuse({ repoDir: gitRepo({ kind: "hw-orphan" }).dir }), /git fetch origin main failed/);
  mkdirSync(join(f.parent, `run-W1-T9-${NOW}`));
  assert.match(refuse({}), /already exists/);
  f.core.git("branch", `run-W1-T9-${NOW + 1}`);
  assert.match(refuse({ clock: fixedClock(NOW + 1) }), /git worktree add failed: .*already exists/);
});

test("an unreadable branch list or trailer history refuses rather than reading as no duplicate", () => {
  const f = fleet();
  const script = join(f.parent, "upload-pack-once.sh");
  writeFileSync(script, `#!/bin/sh\n[ -e "${f.parent}/used" ] && exit 1\ntouch "${f.parent}/used"\nexec git-upload-pack "$@"\n`, { mode: 0o755 });
  f.core.git("config", "remote.origin.uploadpack", script);
  const heads = createHandWorktree({ repoDir: f.core.dir, taskId: "W1-T9", parent: f.parent, clock: fixedClock(NOW) });
  assert.match(heads.status === "refused" ? heads.reason : "", /cannot read origin's run-W1-T9-\* branches/);
  const g = fleet();
  g.core.git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/mirror/*");
  g.core.git("update-ref", "-d", "refs/remotes/origin/main");
  const trailers = createHandWorktree({ repoDir: g.core.dir, taskId: "W1-T9", parent: g.parent, clock: fixedClock(NOW) });
  assert.match(trailers.status === "refused" ? trailers.reason : "", /cannot read origin\/main's Remudero-Task trailers/);
});

test("hand-worktree usage errors exit 2 and an absent fixture scratch root selects the checkout parent", () => {
  const f = fleet();
  assert.equal(command([], { repoDir: f.core.dir }).code, 2);
  assert.equal(command(["W1-T9", "--parent"], { repoDir: f.core.dir }).code, 2);
  assert.match(command(["W1-T9", "--bogus"], { repoDir: f.core.dir }).err, /unexpected argument '--bogus'/);
  const missingScratch = join(f.parent, "absent-scratch");
  assert.equal(existsSync(missingScratch), false);
  const r = command(["W1-T9"], { repoDir: f.core.dir, scratchRoot: missingScratch, minFreeBytes: Number.MAX_SAFE_INTEGER });
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`free under ${dirname(f.core.dir)},`));
  assert.equal(existsSync(missingScratch), false, "the fallback must not create the absent fixture scratch root");
});

test("each donor and link failure is named, never read as a clean miss", () => {
  const f = fleet();
  const lender = donor(f, "lender");
  assert.equal(donorRejection(lender, Buffer.from(LOCK)), null);
  assert.match(donorRejection(lender, Buffer.from(LOCK), join(f.parent, "no-npm")) ?? "", /^npm ls failed: .*ENOENT/);
  assert.equal(donorRejection(lender, Buffer.from(LOCK), "npm", statSync(lender).dev), null);
  assert.match(donorRejection(lender, Buffer.from(LOCK), "npm", statSync(lender).dev + 1) ?? "", /on another filesystem/);
  assert.equal(donorRejection(f.parent, Buffer.from(LOCK)), "no package-lock.json");
  assert.deepEqual(findDonor(f.core.dir, f.parent), { reasons: [`${f.parent} has no package-lock.json`] });
  assert.match(JSON.stringify(findDonor(f.parent, lender)), /git worktree list failed/);
  const lone = gitRepo({ kind: "hw-lone" });
  writeFileSync(join(lone.dir, "package-lock.json"), LOCK);
  assert.deepEqual(findDonor(lone.dir, lone.dir), { reasons: ["no other worktree exists"] });
  const miss = hardLinkNodeModules(join(f.parent, "absent"), f.parent);
  assert.equal(miss.kind, "npm-ci-needed");
  assert.match(miss.kind === "npm-ci-needed" ? miss.reasons[0] : "", /cp -al from .*absent failed/);
  assert.equal(formatGiB(1.5 * 1024 ** 3), "1.5 GiB");
});

// ── W1-T14307: a filed hand worktree is published before it is built ───────────────────────────────────────────
//
// The drain dispatches a task unless an open PR or a pushed run branch exists, and before W1-T14307 a hand worktree
// published nothing until its builder's first push: on 2026-11-22 the fleet built W1-T14147 again (#20129) beside an
// unpushed hand worktree. Every case below drives the REAL reserver `rmd claim` uses, the real hardened-leaf push and
// listing, and a real bare origin; the origin's own server hooks stage a race, a refused push and a lost origin.
//
// INVARIANT a-hand-build-is-published-before-it-is-built: a filed hand worktree exists only with its run branch on
// origin, or with the operator's explicit --no-claim.

test("W1-T14307 criterion 1: for a filed id, rmd hand-worktree leaves run-<id>-<epochMs> at the worktree's base sha and refs/rmd-dispatch/<id> on a bare origin", () => {
  const f = fleet();
  const r = command(["W1-T9", "--parent", f.parent], { repoDir: f.core.dir, clock: fixedClock(NOW) });
  assert.equal(r.code, 0, r.err);
  const branch = `run-W1-T9-${NOW}`;
  const base = spawnSync("git", ["-C", join(f.parent, branch), "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  assert.equal(base, f.core.git("rev-parse", "origin/main"), "the worktree is cut at origin/main");
  assert.equal(originRef(f, `refs/heads/${branch}`), base, "the run branch is on origin at the worktree's base sha");
  const claim = originRef(f, dispatchClaimRef("W1-T9"));
  assert.match(claim, /^[0-9a-f]{40}$/, "the fleet's own dispatch claim is on origin");
  const anchor = parseClaimAnchorMessage(spawnSync("git", ["-C", f.origin.dir, "log", "-1", "--format=%B", claim], { encoding: "utf8" }).stdout.trim());
  assert.equal(anchor?.pid, process.pid, "the claim is the reserver's own anchor, naming this process");
  assert.match(r.out, new RegExp(`claim:  ${branch} pushed to origin at ${base}; refs/rmd-dispatch/W1-T9 taken`));
  // POSITIVE CONTROL: a second hand worktree for the same id now sees the first one's claim and refuses.
  const again = command(["W1-T9", "--parent", f.parent], { repoDir: f.core.dir, clock: fixedClock(NOW + 1) });
  assert.equal(again.code, 1);
  assert.match(again.err, new RegExp(`origin holds refs/rmd-dispatch/W1-T9 at ${claim} \\(rmd-dispatch claim ${process.pid}@`));
});

test("W1-T14307 criterion 2: a dispatch claim on origin for the id, a second run branch for the id appearing during the push, or a failed push refuses and leaves no new worktree or branch behind", () => {
  const branch = `run-W1-T9-${NOW}`;
  // A dispatch claim already on origin is read with the branches, before anything is cut.
  const held = fleet();
  held.seed.git("push", "-q", "origin", "HEAD:refs/rmd-dispatch/W1-T9");
  const heldSha = held.seed.git("rev-parse", "HEAD");
  const a = command(["W1-T9", "--parent", held.parent], { repoDir: held.core.dir, clock: fixedClock(NOW) });
  assert.equal(a.code, 1, a.out);
  assert.match(a.err, new RegExp(`origin holds refs/rmd-dispatch/W1-T9 at ${heldSha} \\(seed\\) — the fleet or another hand build has claimed W1-T9`));
  nothingLeft(held, branch);

  // A second run branch for the id reaches origin during the push: both builders must not proceed.
  const raced = fleet();
  // Only on the create: the cleanup's own delete of our branch reaches this hook too, with an all-zero sha.
  originHook(raced, "post-receive", `while read old new ref; do [ "$ref" = "refs/heads/${branch}" ] && [ "$old" = "${"0".repeat(40)}" ] && git update-ref refs/heads/run-W1-T9-5 "$new"; done; exit 0`);
  const b = command(["W1-T9", "--parent", raced.parent], { repoDir: raced.core.dir, clock: fixedClock(NOW) });
  assert.equal(b.code, 1, b.out);
  assert.match(b.err, /another branch for W1-T9 reached origin during the push: refs\/heads\/run-W1-T9-5 — two builders must never both proceed; removed the new worktree and branch/);
  nothingLeft(raced, branch);
  assert.notEqual(originRef(raced, "refs/heads/run-W1-T9-5"), "", "the other builder's branch is not ours to remove");
  assert.equal(originRef(raced, dispatchClaimRef("W1-T9")), "", "the dispatch claim it took is dropped");

  // A failed push refuses, and drops the dispatch claim it had taken.
  const closed = fleet();
  originHook(closed, "pre-receive", `while read old new ref; do case "$ref" in refs/heads/run-*) echo "run branches are closed" >&2; exit 1;; esac; done; exit 0`);
  const c = command(["W1-T9", "--parent", closed.parent], { repoDir: closed.core.dir, clock: fixedClock(NOW) });
  assert.equal(c.code, 1, c.out);
  assert.match(c.err, new RegExp(`could not push ${branch} to origin: .*; removed the new worktree and branch`));
  nothingLeft(closed, branch);
  assert.equal(originRef(closed, dispatchClaimRef("W1-T9")), "", "the dispatch claim it took is dropped");

  // A failed listing after the push refuses too; what it cannot remove on the lost origin is NAMED, never silent.
  const lost = fleet();
  originHook(lost, "post-receive", `while read old new ref; do [ "$ref" = "refs/heads/${branch}" ] && git config core.repositoryformatversion 99; done; exit 0`);
  const d = createHandWorktree({ repoDir: lost.core.dir, taskId: "W1-T9", parent: lost.parent, clock: fixedClock(NOW), claimReserver: dispatchClaimReserverFor(lost.core.dir) });
  assert.equal(d.status, "refused", JSON.stringify(d));
  const reason = d.status === "refused" ? d.reason : "";
  assert.match(reason, new RegExp(`pushed ${branch}, then could not list origin's run-W1-T9-\\* branches: `));
  assert.match(reason, new RegExp(`could not remove origin's ${branch} \\(.*\\), origin's refs/rmd-dispatch/W1-T9 — remove them by hand`));
  nothingLeft(lost, branch, { originReadable: false });

  // A claim another lane takes between the read and the attempt refuses, naming its holder, before anything is pushed.
  const late = fleet();
  const e = createHandWorktree({ repoDir: late.core.dir, taskId: "W1-T9", parent: late.parent, clock: fixedClock(NOW),
    claimReserver: scriptedReserver({ attempt: () => "taken", holder: () => "b".repeat(40) }) });
  assert.match(e.status === "refused" ? e.reason : "", new RegExp(`refs/rmd-dispatch/W1-T9 was taken while the worktree was cut: .*held by ${"b".repeat(40)}.*; removed the new worktree and branch`));
  nothingLeft(late, branch);
});

test("W1-T14307 criterion 3: --no-claim and unfiled cut the worktree with no push, a refused dispatch-claim push keeps the run branch as the claim, and the output says which claim it holds", () => {
  const f = fleet();
  const skipped = command(["W1-T9", "--parent", f.parent, "--no-claim"], { repoDir: f.core.dir, clock: fixedClock(NOW) });
  assert.equal(skipped.code, 0, skipped.err);
  assert.ok(existsSync(join(f.parent, `run-W1-T9-${NOW}`)), "--no-claim still cuts the worktree");
  assert.match(skipped.out, /claim:  skipped \(--no-claim\) — nothing on origin says this task is held, so the fleet may dispatch it/);
  assert.equal(originRef(f, `refs/heads/run-W1-T9-${NOW}`), "", "--no-claim pushes no run branch");
  assert.equal(originRef(f, dispatchClaimRef("W1-T9")), "", "--no-claim takes no dispatch claim");

  const unfiled = command(["unfiled", "--parent", f.parent], { repoDir: f.core.dir, clock: fixedClock(NOW + 1) });
  assert.equal(unfiled.code, 0, unfiled.err);
  assert.match(unfiled.out, /claim:  not applicable \(unfiled\)/);
  assert.equal(originRef(f, `refs/heads/run-unfiled-${NOW + 1}`), "", "unfiled pushes nothing");

  // The host refuses the dispatch-claim push: the run branch alone is the claim, and the line says why.
  const kept = created(createHandWorktree({ repoDir: f.core.dir, taskId: "W1-T8", parent: f.parent, clock: fixedClock(NOW + 2), claimReserver: scriptedReserver({}) }));
  assert.equal(kept.claim.kind, "pushed");
  const keptSha = originRef(f, `refs/heads/run-W1-T8-${NOW + 2}`);
  assert.match(keptSha, /^[0-9a-f]{40}$/, "the run branch is pushed");
  assert.match(renderHandWorktree(kept), new RegExp(`claim:  run-W1-T8-${NOW + 2} pushed to origin at ${keptSha}; dispatch claim not taken \\(cannot reach origin to claim refs/rmd-dispatch/W1-T8 .*error: 403\\); the run branch alone is the claim`));

  // An anchor that cannot be minted is not an attempt; a library caller with no reserver still pushes the branch.
  const unminted = created(createHandWorktree({ repoDir: f.core.dir, taskId: "W1-T7", parent: f.parent, clock: fixedClock(NOW + 3), claimReserver: scriptedReserver({ mintAnchor: () => "" }) }));
  assert.match(renderHandWorktree(unminted), /dispatch claim not taken \(could not mint an anchor for refs\/rmd-dispatch\/W1-T7\); the run branch alone is the claim/);
  const bare = created(createHandWorktree({ repoDir: f.core.dir, taskId: "W1-T6", parent: f.parent, clock: fixedClock(NOW + 4) }));
  assert.match(renderHandWorktree(bare), /dispatch claim not taken \(no dispatch-claim reserver was given\); the run branch alone is the claim/);
  assert.match(originRef(f, `refs/heads/run-W1-T6-${NOW + 4}`), /^[0-9a-f]{40}$/);
});
