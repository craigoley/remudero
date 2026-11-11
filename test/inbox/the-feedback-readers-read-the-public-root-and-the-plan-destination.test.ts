// W1-T12202: the feedback readers read the public root and, while the host file names a repository,
// the destination checkout `<config root>/repos/<name>`. Every test reads the switch the way production
// does: HOME points at a fixture config, and nothing stands in for the resolver or the loaders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { hostWorktreeGitAsync } from "#src/lib/worktree-git.js";
import { listFeedback, readFeedbackEntry, readLandedFeedbackEntry } from "#src/lib/feedback.js";
import { newFeedbackIdsOldestFirst, refreshFeedbackFromMain, triageCandidateReaders, type MainFeedbackGit } from "#src/lib/auto-triage.js";
import { planDestinationPath } from "#src/lib/plan-destination.js";

const PRIVATE_NAME = "zz-private-plan";
const SWITCH = { repository: `zz-private-owner/${PRIVATE_NAME}`, kinds: [] };

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
  GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
};

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function entry(id: string, ts: string, status: string, raw = `text of ${id}`): string {
  return `id: ${id}\nts: ${ts}\nraw: ${raw}\nattachments: []\norigin: cli\nstatus: ${status}\n`;
}

function writeEntry(dir: string, id: string, text: string): void {
  mkdirSync(join(dir, "plan", "feedback"), { recursive: true });
  writeFileSync(join(dir, "plan", "feedback", `${id}.yaml`), text);
}

/** Commit an entry in `dir` and push it to its origin's main. */
function landEntry(dir: string, id: string, text: string): void {
  writeEntry(dir, id, text);
  gitIn(dir, "add", `plan/feedback/${id}.yaml`);
  gitIn(dir, "commit", "-q", "-m", `feedback ${id}`);
  gitIn(dir, "push", "-q", "origin", "HEAD:main");
}

interface Host {
  home: string;
  stateDir: string;
  /** The public checkout the loaders are given. */
  pub: GitRepo;
  /** The destination checkout's own origin, and a second clone that lands entries there. */
  destinationOrigin: GitRepo;
  destinationSeed: GitRepo;
  /** `<config root>/repos/<name>`: where the resolver says the checkout is. */
  checkout: string;
  setSwitch: (value: unknown) => void;
  restore: () => void;
}

/** A host with a config, a public checkout and a cloned destination checkout. No switch file yet. */
function host(opts: { cloneDestination?: boolean; config?: boolean } = {}): Host {
  const home = mkdtempSync(join(tmpdir(), "rmd-feedback-two-roots-"));
  const root = join(home, "Remudero");
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  if (opts.config !== false) {
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  }
  const publicOrigin = gitRepo({ bare: true, branch: "main" });
  const pub = gitRepo({ cloneFrom: publicOrigin.dir });
  const destinationOrigin = gitRepo({ bare: true, branch: "main" });
  const destinationSeed = gitRepo({ cloneFrom: destinationOrigin.dir });
  landEntry(destinationSeed.dir, "fb-0000000000002-dest00", entry("fb-0000000000002-dest00", "2026-11-02T00:00:00.000Z", "new"));
  const checkout = join(root, "repos", PRIVATE_NAME);
  if (opts.cloneDestination !== false) {
    mkdirSync(join(root, "repos"), { recursive: true });
    execFileSync("git", ["clone", "-q", destinationOrigin.dir, checkout], { env: GIT_ENV, stdio: "ignore" });
  }
  landEntry(pub.dir, "fb-0000000000001-pub000", entry("fb-0000000000001-pub000", "2026-11-01T00:00:00.000Z", "new"));
  landEntry(pub.dir, "fb-0000000000003-pub000", entry("fb-0000000000003-pub000", "2026-11-03T00:00:00.000Z", "new"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  return {
    home, stateDir, pub, destinationOrigin, destinationSeed, checkout,
    setSwitch: (value) => writeFileSync(planDestinationPath(stateDir), typeof value === "string" ? value : JSON.stringify(value)),
    restore: () => {
      process.env.HOME = oldHome;
      for (const repo of [pub, publicOrigin, destinationSeed, destinationOrigin]) repo.cleanup();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function countingGit(): { git: MainFeedbackGit; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, git: (cwd, args, o) => { calls.push([cwd, ...args]); return hostWorktreeGitAsync(cwd, args, o); } };
}

const ids = (entries: Array<{ id: string }>): string[] => entries.map((e) => e.id);

test("W1-T12202 criterion 1: with the host file, listFeedback, readFeedbackEntry and readLandedFeedbackEntry read both roots", () => {
  const h = host();
  try {
    h.setSwitch(SWITCH);
    assert.deepEqual(ids(listFeedback(h.pub.dir)), ["fb-0000000000001-pub000", "fb-0000000000002-dest00", "fb-0000000000003-pub000"],
      "one list in id order across both roots");
    assert.equal(listFeedback(h.pub.dir, { status: "new" }).length, 3);
    assert.equal(readFeedbackEntry(h.pub.dir, "fb-0000000000002-dest00").raw, "text of fb-0000000000002-dest00");
    assert.equal(readFeedbackEntry(h.pub.dir, "fb-0000000000001-pub000").raw, "text of fb-0000000000001-pub000");
    assert.equal(readLandedFeedbackEntry(h.pub.dir, "fb-0000000000002-dest00")?.status, "new", "landed on the destination's origin/main");
    assert.equal(readLandedFeedbackEntry(h.pub.dir, "fb-0000000000001-pub000")?.status, "new", "landed on the public origin/main");
    assert.equal(readLandedFeedbackEntry(h.pub.dir, "fb-0000000000009-absent"), null);
  } finally {
    h.restore();
  }
});

test("W1-T12202 criterion 2: one id in both roots with different bytes is refused, and the message names both paths", () => {
  const h = host();
  try {
    h.setSwitch(SWITCH);
    const id = "fb-0000000000001-pub000";
    // The same bytes in both roots: read once, not twice.
    landEntry(h.destinationSeed.dir, id, entry(id, "2026-11-01T00:00:00.000Z", "new"));
    gitIn(h.checkout, "pull", "-q", "--ff-only", "origin", "main");
    assert.deepEqual(ids(listFeedback(h.pub.dir)).filter((x) => x === id), [id]);
    assert.equal(readFeedbackEntry(h.pub.dir, id).id, id);
    assert.equal(readLandedFeedbackEntry(h.pub.dir, id)?.id, id);
    // Different bytes: refused by each loader, naming both copies.
    landEntry(h.destinationSeed.dir, id, entry(id, "2026-11-01T00:00:00.000Z", "accepted"));
    gitIn(h.checkout, "pull", "-q", "--ff-only", "origin", "main");
    const both = (e: unknown): boolean => {
      const message = (e as Error).message;
      return /different bytes/.test(message) && message.includes(h.pub.dir) && message.includes(h.checkout);
    };
    assert.throws(() => listFeedback(h.pub.dir), both);
    assert.throws(() => readFeedbackEntry(h.pub.dir, id), both);
    assert.throws(() => readLandedFeedbackEntry(h.pub.dir, id), both);
    assert.throws(() => newFeedbackIdsOldestFirst(h.pub.dir), both);
  } finally {
    h.restore();
  }
});

test("W1-T12202 criterion 3: refreshFeedbackFromMain refreshes both roots, and newFeedbackIdsOldestFirst orders both by age", async () => {
  const h = host();
  try {
    h.setSwitch(SWITCH);
    // Landed on the destination after its checkout was cloned: only its origin/main holds the entry.
    landEntry(h.destinationSeed.dir, "fb-0000000000000-late00", entry("fb-0000000000000-late00", "2026-11-02T12:00:00.000Z", "new"));
    gitIn(h.checkout, "fetch", "-q", "origin");
    const counted = countingGit();
    await refreshFeedbackFromMain(h.pub.dir, undefined, counted.git);
    assert.deepEqual([...new Set(counted.calls.map((c) => c[0]))], [h.pub.dir, h.checkout], "one refresh per root");
    const readers = await triageCandidateReaders(h.pub.dir);
    assert.deepEqual(readers.newFeedbackIdsOldestFirst(h.pub.dir),
      ["fb-0000000000001-pub000", "fb-0000000000002-dest00", "fb-0000000000000-late00", "fb-0000000000003-pub000"],
      "one order by ts across both roots, with the entry that only the destination's origin/main holds");
    assert.equal(readers.oldestFeedbackAgeMs(h.pub.dir, new Date("2026-11-02T00:00:00.000Z")), 86_400_000);
  } finally {
    h.restore();
  }
});

test("W1-T12202 criterion 4: an unreadable destination checkout or switch file is reported as unreadable, never as empty", async () => {
  const h = host({ cloneDestination: false });
  try {
    h.setSwitch(SWITCH);
    const unreadable = /plan destination checkout is unreadable/;
    assert.throws(() => listFeedback(h.pub.dir), unreadable);
    assert.throws(() => readFeedbackEntry(h.pub.dir, "fb-0000000000001-pub000"), unreadable);
    assert.throws(() => readLandedFeedbackEntry(h.pub.dir, "fb-0000000000001-pub000"), unreadable);
    await assert.rejects(refreshFeedbackFromMain(h.pub.dir), unreadable);
    assert.throws(() => newFeedbackIdsOldestFirst(h.pub.dir), unreadable);
    h.setSwitch("{not json");
    assert.throws(() => listFeedback(h.pub.dir), /plan destination is unreadable: .*not valid JSON/);
    assert.throws(() => newFeedbackIdsOldestFirst(h.pub.dir), /plan destination is unreadable/);
  } finally {
    h.restore();
  }
});

test("W1-T12202 criterion 5: with no host file, each reader returns the public entries with the same git calls as today", async () => {
  for (const config of [true, false]) {
    const h = host({ config });
    try {
      // A cloned checkout under repos/ is not a switch: the listing of repos/ is never read.
      const publicOnly = ["fb-0000000000001-pub000", "fb-0000000000003-pub000"];
      assert.deepEqual(ids(listFeedback(h.pub.dir)), publicOnly);
      assert.throws(() => readFeedbackEntry(h.pub.dir, "fb-0000000000002-dest00"),
        { message: `no feedback entry "fb-0000000000002-dest00" (looked in ${join(h.pub.dir, "plan", "feedback", "fb-0000000000002-dest00.yaml")})` });
      const landedCalls: string[][] = [];
      const git = (args: string[]): string => { landedCalls.push(args); return gitIn(h.pub.dir, ...args); };
      assert.equal(readLandedFeedbackEntry(h.pub.dir, "fb-0000000000001-pub000", git)?.id, "fb-0000000000001-pub000");
      assert.deepEqual(landedCalls, [["show", "origin/main:plan/feedback/fb-0000000000001-pub000.yaml"]]);
      const counted = countingGit();
      await refreshFeedbackFromMain(h.pub.dir, undefined, counted.git);
      assert.deepEqual(counted.calls.map((c) => c.slice(0, 2)), [[h.pub.dir, "ls-tree"], [h.pub.dir, "cat-file"], [h.pub.dir, "ls-tree"]],
        "the public root's main listing, blob read and HEAD listing, and nothing in the destination checkout");
      assert.deepEqual(newFeedbackIdsOldestFirst(h.pub.dir), publicOnly);
    } finally {
      h.restore();
    }
  }
});
