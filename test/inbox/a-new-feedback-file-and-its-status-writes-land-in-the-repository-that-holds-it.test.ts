// W1-T12203: a new feedback file lands in the plan destination while `feedback` is in the kinds of the host
// file, and a status write lands in the repository that holds the file. Every test reads the switch the way
// production does: HOME points at a fixture config. Git is real, with bare origins; only `gh` is a fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { captureFeedback, readFeedbackEntry, setFeedbackStatus } from "#src/lib/feedback.js";
import {
  LANDING_BRANCH, feedbackLandingSweepRungs, landFeedback, landFeedbackStatusContent, queueFeedbackRecord, queuedFeedbackLandings,
  sweepFeedbackLandingAsync,
} from "#src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { planDestinationPath } from "#src/lib/plan-destination.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const PRIVATE_OWNER = "zz-private-owner";
const PRIVATE_NAME = "zz-private-plan";
const ON = { repository: `${PRIVATE_OWNER}/${PRIVATE_NAME}`, kinds: ["feedback"] };

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
  GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
};

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const rel = (id: string): string => `plan/feedback/${id}.yaml`;

function entry(id: string, status: string, raw = `text of ${id}`): string {
  return `id: ${id}\nts: 2026-11-01T00:00:00.000Z\nraw: ${raw}\nattachments: []\norigin: cli\nstatus: ${status}\n`;
}

function writeEntry(dir: string, id: string, text: string): void {
  mkdirSync(join(dir, "plan", "feedback"), { recursive: true });
  writeFileSync(join(dir, rel(id)), text);
}

function landEntry(dir: string, id: string, text: string): void {
  writeEntry(dir, id, text);
  gitIn(dir, "add", rel(id));
  gitIn(dir, "commit", "-q", "-m", `feedback ${id}`);
  gitIn(dir, "push", "-q", "origin", "HEAD:main");
}

/** A fake `gh`: no open landing PR, and `pr create` answers a URL in the repository it was asked for. */
function fakeGh() {
  const calls: string[][] = [];
  const gh = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") return "[]";
    if (args[0] === "pr" && args[1] === "create") {
      const repo = args.includes("--repo") ? args[args.indexOf("--repo") + 1] : "o/public";
      return `https://github.com/${repo}/pull/77\n`;
    }
    throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
  };
  return { gh, calls };
}

interface Host {
  home: string;
  configRoot: string;
  stateDir: string;
  pub: GitRepo;
  publicOrigin: GitRepo;
  destinationOrigin: GitRepo;
  checkout: string;
  setSwitch: (value: unknown) => void;
  restore: () => void;
}

const PUBLIC_ID = "fb-0000000000001-pub000";
const DEST_ID = "fb-0000000000002-dest00";

/** A host with a config, a public checkout and a cloned destination checkout, each holding one landed entry. */
function host(opts: { config?: boolean } = {}): Host {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w12203-`));
  const configRoot = join(home, "Remudero");
  const stateDir = join(configRoot, "state");
  mkdirSync(stateDir, { recursive: true });
  if (opts.config !== false) {
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root: configRoot }));
  }
  const publicOrigin = gitRepo({ bare: true, branch: "main" });
  const pub = gitRepo({ cloneFrom: publicOrigin.dir });
  landEntry(pub.dir, PUBLIC_ID, entry(PUBLIC_ID, "proposed"));
  const destinationOrigin = gitRepo({ bare: true, branch: "main" });
  const seed = gitRepo({ cloneFrom: destinationOrigin.dir });
  landEntry(seed.dir, DEST_ID, entry(DEST_ID, "proposed"));
  const checkout = join(configRoot, "repos", PRIVATE_NAME);
  mkdirSync(join(configRoot, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", destinationOrigin.dir, checkout], { env: GIT_ENV, stdio: "ignore" });
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  return {
    home, configRoot, stateDir, pub, publicOrigin, destinationOrigin, checkout,
    setSwitch: (value) => writeFileSync(planDestinationPath(stateDir), JSON.stringify(value)),
    restore: () => {
      process.env.HOME = oldHome;
      for (const repo of [pub, publicOrigin, seed, destinationOrigin]) repo.cleanup();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** The files the landing branch of `origin` changes from its main, or [] when there is no landing branch. */
function landed(origin: GitRepo): string[] {
  const heads = gitIn(origin.dir, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n");
  if (!heads.includes(LANDING_BRANCH)) return [];
  return gitIn(origin.dir, "diff", "--name-only", "main", LANDING_BRANCH).split("\n").filter(Boolean).sort();
}

const onBranch = (origin: GitRepo, path: string): string => gitIn(origin.dir, "show", `${LANDING_BRANCH}:${path}`);

const passingPreflight = () => ({ ok: true, failures: [], unreadable: [] });

test("W1-T12203 criterion 1: with feedback in the kinds, captureFeedback lands a new feedback file in the destination repository", () => {
  const h = host();
  try {
    h.setSwitch(ON);
    const { gh, calls } = fakeGh();
    // The production entry: nothing in place of the resolver, the landing or its preflight. Only GitHub is a fake.
    const captured = withLiveWritesAllowed(() => captureFeedback(h.pub.dir, { raw: "a new note", origin: "cli", land: { gh } }));
    assert.ok(existsSync(join(h.checkout, rel(captured.id))), "the file is written in the destination checkout");
    assert.equal(existsSync(join(h.pub.dir, rel(captured.id))), false, "and not in the public checkout");
    assert.deepEqual(landed(h.destinationOrigin), [rel(captured.id)], "the landing branch of the destination carries the file");
    assert.deepEqual(landed(h.publicOrigin), [], "the public repository gets no landing branch");
    const create = calls.find((c) => c[0] === "pr" && c[1] === "create");
    assert.ok(create, "a landing pull request is opened");
    assert.equal(create[create.indexOf("--repo") + 1], `${PRIVATE_OWNER}/${PRIVATE_NAME}`, "in the destination repository");
    assert.equal(create[create.indexOf("--head") + 1], LANDING_BRANCH, "on the plain landing branch, whose name does not name the destination");
    assert.equal(readFeedbackEntry(h.pub.dir, captured.id).raw, "a new note", "the readers find the new file");
  } finally {
    h.restore();
  }
});

test("W1-T12203 criterion 2: the daemon's landing pass lands waiting feedback files in the destination repository", async () => {
  const h = host();
  try {
    h.setSwitch(ON);
    // Waiting: a new console capture in the queue, a status write of a public entry in the queue, and a file in the
    // destination checkout whose own landing failed.
    const queuedNew = "fb-0000000000005-queued";
    writeEntry(h.pub.dir, queuedNew, entry(queuedNew, "new"));
    assert.deepEqual(queueFeedbackRecord(h.pub.dir, rel(queuedNew), h.configRoot).queued, [rel(queuedNew)]);
    setFeedbackStatus(h.pub.dir, PUBLIC_ID, "accepted", { land: { stateRoot: h.configRoot } });
    const waiting = "fb-0000000000006-waits0";
    writeEntry(h.checkout, waiting, entry(waiting, "new"));
    const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const { gh } = fakeGh();
    // The options the daemon command passes, with the fake GitHub and a passing preflight.
    const rungs = feedbackLandingSweepRungs(h.pub.dir, {
      log: (step, extra) => rows.push({ step, extra }), stateRoot: h.configRoot, planDestinationStateDir: h.stateDir,
      gh, planPrPreflight: passingPreflight,
    } as Parameters<typeof feedbackLandingSweepRungs>[1]);
    const result = await withLiveWritesAllowed(() => rungs.atBoot());
    assert.deepEqual(result.files, [rel(PUBLIC_ID)], "the public pass lands the status write of the public entry");
    assert.deepEqual(landed(h.publicOrigin), [rel(PUBLIC_ID)]);
    assert.deepEqual(landed(h.destinationOrigin), [rel(queuedNew), rel(waiting)].sort(), "the new capture and the waiting file land in the destination");
    assert.match(onBranch(h.publicOrigin, rel(PUBLIC_ID)), /^status: accepted$/m);
    const sweeps = rows.filter((r) => r.step === "feedback.landing_sweep");
    assert.deepEqual(sweeps.map((r) => r.extra?.plan_destination), [undefined, "destination"], "one row per repository");
    const text = JSON.stringify(rows);
    assert.equal(text.includes(PRIVATE_NAME), false, "no row names the destination repository");
    assert.equal(text.includes(h.checkout), false, "no row names the destination checkout");
    assert.match(String(sweeps[1].extra?.pr_url), /^https:\/\/github\.com\/the plan destination\/pull\/77$/);
    // The per-poll pass is the same pass: nothing new waits, so neither repository gets a new push.
    const again = await withLiveWritesAllowed(() => rungs.perPoll());
    assert.equal(again.pushed ?? false, false);
  } finally {
    h.restore();
  }
});

test("W1-T12203 criterion 3: a status write lands in the repository that holds the file, also for a public file while the kind is on", () => {
  const h = host();
  try {
    h.setSwitch(ON);
    const { gh, calls } = fakeGh();
    withLiveWritesAllowed(() => setFeedbackStatus(h.pub.dir, DEST_ID, "accepted", { land: { gh, planPrPreflight: passingPreflight } }));
    assert.deepEqual(landed(h.destinationOrigin), [rel(DEST_ID)], "the destination file is edited in the destination");
    assert.match(onBranch(h.destinationOrigin, rel(DEST_ID)), /^status: accepted$/m);
    assert.deepEqual(landed(h.publicOrigin), []);
    withLiveWritesAllowed(() => setFeedbackStatus(h.pub.dir, PUBLIC_ID, "rejected", { land: { gh, planPrPreflight: passingPreflight } }));
    assert.deepEqual(landed(h.publicOrigin), [rel(PUBLIC_ID)], "the public file is edited in the public repository");
    assert.match(onBranch(h.publicOrigin, rel(PUBLIC_ID)), /^status: rejected$/m);
    assert.deepEqual(landed(h.destinationOrigin), [rel(DEST_ID)], "and nothing of it goes to the destination");
    const repos = calls.filter((c) => c[1] === "create").map((c) => (c.includes("--repo") ? c[c.indexOf("--repo") + 1] : "origin"));
    assert.deepEqual(repos, [`${PRIVATE_OWNER}/${PRIVATE_NAME}`, "origin"]);
    // A local write (no landing) is written in the checkout that holds the file.
    setFeedbackStatus(h.pub.dir, DEST_ID, "rejected");
    assert.match(readFileSync(join(h.checkout, rel(DEST_ID)), "utf8"), /^status: rejected$/m);
    assert.equal(existsSync(join(h.pub.dir, rel(DEST_ID))), false);
  } finally {
    h.restore();
  }
});

test("W1-T12203 criterion 4: a file the destination gate refuses is left out and reported, and the other files land", async () => {
  const h = host();
  try {
    h.setSwitch(ON);
    const clean = "fb-0000000000007-clean0", leaky = "fb-0000000000008-leaky0";
    writeEntry(h.checkout, clean, entry(clean, "new"));
    // Built at run time, so this test file holds no token-shaped string.
    writeEntry(h.checkout, leaky, entry(leaky, "new", `the key is ${"AKIA"}${"Q".repeat(16)}`));
    const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const { gh } = fakeGh();
    const rungs = feedbackLandingSweepRungs(h.pub.dir, {
      log: (step, extra) => rows.push({ step, extra }), stateRoot: h.configRoot, planDestinationStateDir: h.stateDir,
      gh, planPrPreflight: passingPreflight,
    } as Parameters<typeof feedbackLandingSweepRungs>[1]);
    await withLiveWritesAllowed(() => rungs.perPoll());
    assert.deepEqual(landed(h.destinationOrigin), [rel(clean)], "the clean file lands; the refused file does not");
    const row = rows.find((r) => r.step === "feedback.landing_sweep" && r.extra?.plan_destination === "destination");
    assert.deepEqual(row?.extra?.refused, [{ path: rel(leaky), reason: "the plan destination gate refuses this feedback file (AWS access key id-shaped string)" }]);
    assert.ok(existsSync(join(h.checkout, rel(leaky))), "the refused file stays in the checkout for a person to fix");
    // A status write of a refused file is reported the same way and lands nothing.
    const status = withLiveWritesAllowed(() => landFeedbackStatusContent(h.checkout, rel(leaky), entry(leaky, "rejected", `${"AKIA"}${"Q".repeat(16)}`),
      { gh, planPrPreflight: passingPreflight, screenForDestinationGate: true }));
    assert.deepEqual(status.refused?.map((r) => r.path), [rel(leaky)]);
  } finally {
    h.restore();
  }
});

/** Git calls with each sha, fixture path and capture id made the same, so two fixtures compare. */
function recordingGit(dir: string) {
  const calls: string[] = [];
  const norm = (s: string): string => s.replaceAll(dir, "<root>").replace(/[0-9a-f]{40}/g, "<sha>")
    .replace(/fb-\d{13}-[0-9a-f]{6}/g, "<id>").replace(/rmd-feedback-landing-[A-Za-z0-9]+/g, "<scratch>");
  const git = (args: string[], o?: { env?: NodeJS.ProcessEnv }): string => {
    calls.push(norm(JSON.stringify(args)));
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...GIT_ENV, ...o?.env } });
  };
  return { git, calls };
}

test("W1-T12203 criterion 5: with no host file, capture, the landing pass and a status write make the same calls on the same repository as today", async () => {
  for (const config of [true, false]) {
    // `now` runs the changed writer; `today` runs the landing primitive the writer called before this task.
    const now = host({ config }), today = host({ config });
    try {
      const a = recordingGit(now.pub.dir), b = recordingGit(today.pub.dir);
      const ghA = fakeGh(), ghB = fakeGh();
      // Each fixture reads its own config: HOME names the fixture that runs next.
      const asNow = <T>(run: () => T): T => { process.env.HOME = now.home; return withLiveWritesAllowed(run); };
      const asToday = <T>(run: () => T): T => { process.env.HOME = today.home; return withLiveWritesAllowed(run); };
      const land = (git: typeof a.git, gh: typeof ghA.gh) => ({ git, gh: gh, planPrPreflight: passingPreflight });
      const captured = asNow(() => captureFeedback(now.pub.dir, { raw: "a note", origin: "cli", land: land(a.git, ghA.gh) }));
      assert.ok(existsSync(join(now.pub.dir, rel(captured.id))));
      writeFileSync(join(today.pub.dir, rel(captured.id)), stringifyYaml(captured));
      asToday(() => landFeedback(today.pub.dir, land(b.git, ghB.gh)));
      assert.ok(a.calls.length > 0);
      assert.deepEqual(a.calls, b.calls, "capture: the same git calls");

      a.calls.length = 0; b.calls.length = 0;
      const status = asNow(() => setFeedbackStatus(now.pub.dir, PUBLIC_ID, "accepted", { land: land(a.git, ghA.gh) }));
      asToday(() => landFeedbackStatusContent(today.pub.dir, rel(PUBLIC_ID), stringifyYaml(status), land(b.git, ghB.gh)));
      assert.deepEqual(a.calls, b.calls, "status write: the same git calls");

      a.calls.length = 0; b.calls.length = 0;
      const waiting = "fb-0000000000009-wait00";
      writeEntry(now.pub.dir, waiting, entry(waiting, "new"));
      writeEntry(today.pub.dir, waiting, entry(waiting, "new"));
      await asNow(() => feedbackLandingSweepRungs(now.pub.dir, {
        ...land(a.git, ghA.gh), stateRoot: now.configRoot, planDestinationStateDir: now.stateDir,
      } as Parameters<typeof feedbackLandingSweepRungs>[1]).perPoll());
      await asToday(() => sweepFeedbackLandingAsync(today.pub.dir, { ...land(b.git, ghB.gh), stateRoot: today.configRoot }));
      assert.deepEqual(a.calls, b.calls, "landing pass: the same git calls");
      assert.deepEqual(ghA.calls.map((c) => c.slice(0, 2)), ghB.calls.map((c) => c.slice(0, 2)), "the same GitHub calls");
      assert.equal(ghA.calls.some((c) => c.includes("--repo")), false, "no call names another repository");
      assert.deepEqual(landed(now.destinationOrigin), [], "the cloned checkout under repos/ gets nothing");
      assert.equal(queuedFeedbackLandings(now.configRoot).length, 0);
    } finally {
      today.restore();
      now.restore();
    }
  }
});
