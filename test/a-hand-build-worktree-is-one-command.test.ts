// W1-T5533: `rmd hand-worktree <taskId>` makes a hand build's worktree in one command. Every fixture
// is a throwaway bare origin + clone (test/helpers/git-repo.ts); git, npm and cp really run, so the
// default seams are the ones exercised.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import {
  HAND_WORKTREE_TASK_ID_RE,
  createHandWorktree,
  donorRejection,
  findDonor,
  formatGiB,
  hardLinkNodeModules,
  renderHandWorktree,
} from "../src/lib/hand-worktree.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { handWorktreeCommand } from "../src/run-task.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

const NOW = 1_791_000_000_000;
const PKG = '{"name":"fixture","version":"1.0.0","private":true}\n';
const LOCK = '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"fixture","version":"1.0.0"}}}\n';

interface Fleet {
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
  return { seed, core, parent: mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}hw-parent-`)) };
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
  assert.match(r.out, new RegExp(`hard-linked from ${lender}`));
  const upstream = spawnSync("git", ["-C", path, "rev-parse", "--abbrev-ref", "@{u}"], { encoding: "utf8" });
  assert.notEqual(upstream.status, 0, "the branch must carry no upstream");
  assert.equal(f.core.git("rev-parse", `run-W1-T9-${NOW}`), f.core.git("rev-parse", "origin/main"));
  const modules = lstatSync(join(path, "node_modules"));
  assert.equal(modules.isSymbolicLink(), false, "node_modules must never be a symlink");
  assert.equal(modules.isDirectory(), true);
  assert.equal(statSync(join(path, "node_modules", ".bin", "tool")).ino, statSync(join(lender, "node_modules", ".bin", "tool")).ino);
});

test("hand-worktree refuses a relative parent and writes nothing", () => {
  const f = fleet();
  const before = f.core.git("worktree", "list");
  const r = command(["W1-T9", "--parent", "rmd-work"], { repoDir: f.core.dir, clock: fixedClock(NOW) });
  assert.equal(r.code, 1);
  assert.match(r.err, /--parent 'rmd-work' is relative/);
  assert.equal(f.core.git("worktree", "list"), before);
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

test("hand-worktree usage errors exit 2 and the default parent is the checkout's own directory", () => {
  const f = fleet();
  assert.equal(command([], { repoDir: f.core.dir }).code, 2);
  assert.equal(command(["W1-T9", "--parent"], { repoDir: f.core.dir }).code, 2);
  assert.match(command(["W1-T9", "--bogus"], { repoDir: f.core.dir }).err, /unexpected argument '--bogus'/);
  const r = command(["W1-T9"], { repoDir: f.core.dir, minFreeBytes: Number.MAX_SAFE_INTEGER });
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`free under ${dirname(f.core.dir)},`));
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
