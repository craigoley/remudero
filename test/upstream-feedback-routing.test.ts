import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import {
  FeedbackError,
  captureFeedback,
  feedbackDir,
  feedbackEntryPath,
  homeRepoPath,
  loadHomeRepoPointer,
} from "../src/lib/feedback.js";

// W1-T397 — "`rmd feedback` always writes the LOCAL checkout's plan/feedback/, so an instance
// working on another codebase files rmd's own bugs where no rmd maintainer will read them:
// give it a home-repo pointer and a transport home." This suite drives `captureFeedback`'s new
// routing decision end to end with injected `git`/`gh` doubles (the same seam
// feedback-landing.test.ts uses for its own `gh` half) — no real subprocess, no live GitHub
// call, no second machine, exactly what the task's `verify: auto` / `note:` promise.

function root(): string {
  return mkdtempSync(join(tmpdir(), "rmd-upstream-feedback-"));
}

function seedHomePointer(r: string, repoSlug: string): void {
  mkdirSync(join(r, ".remudero"), { recursive: true });
  writeFileSync(homeRepoPath(r), JSON.stringify({ repo: repoSlug }));
}

/** A `git` double whose ONLY supported call is the `remote.origin.url` read the self-check
 *  makes — anything else throws, so a test fails loud if the routing logic ever calls git for
 *  something else. */
function fakeGit(remoteUrl: string | null) {
  const calls: string[][] = [];
  const git = (args: string[]): string => {
    calls.push(args);
    if (remoteUrl === null) throw new Error("no such remote 'origin'");
    if (args[0] === "config" && args[1] === "--get" && args[2] === "remote.origin.url") return `${remoteUrl}\n`;
    throw new Error(`unexpected git call in fixture: ${JSON.stringify(args)}`);
  };
  return { git, calls };
}

/** A `gh` double that never expects to be called — asserts the routing logic short-circuits
 *  before ever reaching the transport (the self/no-pointer cases). */
function unreachableGh() {
  return (args: string[]): string => {
    throw new Error(`gh should never have been called in this scenario: ${JSON.stringify(args)}`);
  };
}

/** A `gh` double that drives the full repo-lookup -> branch -> content -> PR sequence to a
 *  successful PR open. */
function fakeGhSuccess(slug: string, prUrl: string) {
  const calls: string[][] = [];
  const gh = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "api" && args[1] === `repos/${slug}`) return JSON.stringify({ default_branch: "main" });
    if (args[0] === "api" && args[1] === `repos/${slug}/git/ref/heads/main`) return JSON.stringify({ object: { sha: "deadbeef" } });
    if (args[0] === "api" && args[1] === `repos/${slug}/git/refs`) return JSON.stringify({});
    if (args[0] === "api" && args[1].startsWith(`repos/${slug}/contents/`)) return JSON.stringify({});
    if (args[0] === "api" && args[1] === `repos/${slug}/pulls`) return JSON.stringify({ html_url: prUrl });
    throw new Error(`unexpected gh call in fixture: ${JSON.stringify(args)}`);
  };
  return { gh, calls };
}

/** A `gh` double that fails on the very first call — simulates an unreachable home (offline,
 *  no network, no `gh` auth) with no further calls attempted. */
function fakeGhUnreachable() {
  const calls: string[][] = [];
  const gh = (args: string[]): string => {
    calls.push(args);
    throw new Error("could not resolve host: api.github.com");
  };
  return { gh, calls };
}

/** Every path under `r`, relative to `r`, recursively — used to prove NOTHING outside
 *  `plan/feedback/` (and the pre-seeded pointer file) is ever touched by routing. */
function listAllFiles(r: string): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const name of readdirSync(abs)) {
      const childAbs = join(abs, name);
      if (statSync(childAbs).isDirectory()) walk(childAbs);
      else out.push(relative(r, childAbs).split("\\").join("/"));
    }
  };
  walk(r);
  return out;
}

// ── Claim 1: a configured pointer routes the entry at the home repo ─────────────────────────

test("W1-T397 claim 1: with a home-repo pointer configured (and this checkout is NOT home), the entry is directed at the home repo", () => {
  const r = root();
  seedHomePointer(r, "acme/upstream");
  const { git } = fakeGit("https://github.com/someone-else/otherrepo.git");
  const { gh, calls } = fakeGhSuccess("acme/upstream", "https://github.com/acme/upstream/pull/42");

  const entry = captureFeedback(r, { raw: "rmd itself has a bug", upstream: { git, gh } });

  // Still captured LOCALLY, in THIS checkout's own plan/feedback/ — upstreaming augments the
  // local artifact, it never replaces it.
  const onDisk = parseYaml(readFileSync(feedbackEntryPath(r, entry.id), "utf8"));
  assert.equal(onDisk.raw, "rmd itself has a bug");

  // ...AND directed at the home repo via a PR, not left stranded in the local checkout only.
  assert.deepEqual(entry.upstream, {
    home: "acme/upstream",
    status: "landed",
    pr_url: "https://github.com/acme/upstream/pull/42",
  });
  // The transport actually named the home repo's slug, not this checkout's own.
  assert.ok(calls.some((c) => c[1] === "repos/acme/upstream/pulls"));
});

// ── Claim 2: no pointer, or local checkout IS home -> files locally exactly as today ─────────

test("W1-T397 claim 2a: with NO pointer configured, the entry files locally exactly as today (no upstream field, gh never called)", () => {
  const r = root();
  // No .remudero/home-repo.json seeded at all.
  const entry = captureFeedback(r, { raw: "plain local capture", upstream: { gh: unreachableGh() } });

  assert.equal("upstream" in entry, false);
  const raw = readFileSync(feedbackEntryPath(r, entry.id), "utf8");
  assert.equal(raw.includes("upstream:"), false); // byte-identical to a pre-W1-T397 entry
});

test("W1-T397 claim 2b: when the local checkout IS the home repo, upstreaming is a no-op — files locally exactly as today", () => {
  const r = root();
  seedHomePointer(r, "acme/home");
  const { git } = fakeGit("https://github.com/acme/home.git"); // same slug as the pointer
  const gh = unreachableGh(); // proves gh is never reached for a self-target

  const entry = captureFeedback(r, { raw: "self-hosted capture", upstream: { git, gh } });

  assert.equal("upstream" in entry, false);
  const raw = readFileSync(feedbackEntryPath(r, entry.id), "utf8");
  assert.equal(raw.includes("upstream:"), false);
});

// ── Claim 3: an unreachable home never drops the entry and never fails the run ───────────────

test("W1-T397 claim 3: an unreachable home leaves the entry captured locally with a named, greppable failure record, and never throws", () => {
  const r = root();
  seedHomePointer(r, "acme/upstream");
  const { git } = fakeGit("https://github.com/someone-else/otherrepo.git");
  const { gh } = fakeGhUnreachable();

  const entry = captureFeedback(r, { raw: "a defect nobody upstream will ever see otherwise", upstream: { git, gh } });

  // Never dropped: the local artifact exists with the real content.
  const raw = readFileSync(feedbackEntryPath(r, entry.id), "utf8");
  assert.match(raw, /a defect nobody upstream will ever see otherwise/);

  // A NAMED, GREPPABLE record that it did not reach home — right in the entry file itself.
  assert.equal(entry.upstream?.status, "unreachable");
  assert.ok(entry.upstream?.error && entry.upstream.error.length > 0);
  assert.match(raw, /status: unreachable/);
  assert.match(raw, /home: acme\/upstream/);
});

test("W1-T397 claim 3 (config half): a malformed home-repo.json degrades to the SAME unreachable-class record — never throws, never drops the local capture", () => {
  const r = root();
  mkdirSync(join(r, ".remudero"), { recursive: true });
  writeFileSync(homeRepoPath(r), "{ not json");

  const entry = captureFeedback(r, { raw: "captured despite a broken pointer file" });

  const raw = readFileSync(feedbackEntryPath(r, entry.id), "utf8");
  assert.match(raw, /captured despite a broken pointer file/);
  assert.equal(entry.upstream?.status, "unreachable");
});

// ── Claim 4: the reporting path takes no lock and writes no ledger ───────────────────────────

test("W1-T397 claim 4: routing touches nothing outside plan/feedback/ — no lock, no ledger, no arbiter", () => {
  const r = root();
  seedHomePointer(r, "acme/upstream");
  const { git } = fakeGit("https://github.com/someone-else/otherrepo.git");
  const { gh } = fakeGhSuccess("acme/upstream", "https://github.com/acme/upstream/pull/7");

  const before = new Set(listAllFiles(r));
  const entry = captureFeedback(r, { raw: "no lock, no ledger", upstream: { git, gh } });
  const after = listAllFiles(r);

  const newFiles = after.filter((f) => !before.has(f));
  // The ONLY new file is this entry's own plan/feedback/<id>.yaml — nothing under plan/tasks.yaml,
  // no lock file, no ledger, no second artifact anywhere else in the checkout.
  assert.deepEqual(newFiles, [relative(r, feedbackEntryPath(r, entry.id)).split("\\").join("/")]);
  assert.ok(newFiles[0].startsWith(relative(r, feedbackDir(r)).split("\\").join("/") + "/"));
});

test("loadHomeRepoPointer FAILS LOUD on a malformed .remudero/home-repo.json — validated the same way loadManagedRepos is", () => {
  const r = root();
  mkdirSync(join(r, ".remudero"), { recursive: true });
  writeFileSync(homeRepoPath(r), JSON.stringify({ repo: "not-a-slash-pair" }));
  assert.throws(() => loadHomeRepoPointer(r), FeedbackError);
});

test("loadHomeRepoPointer on a missing file returns null — not an error (safe default, mirrors loadManagedRepos)", () => {
  const r = root();
  assert.equal(loadHomeRepoPointer(r), null);
});

test("loadHomeRepoPointer parses a valid {\"repo\": \"owner/repo\"} pointer", () => {
  const r = root();
  seedHomePointer(r, "acme/upstream");
  assert.deepEqual(loadHomeRepoPointer(r), { owner: "acme", repo: "upstream" });
});

// ── THE DEFAULT SEAMS AND THE CATCH ARMS (impl-EE) ──────────────────────────────────────
//
// Every test above injects both `git` and `gh`, so the seams' DEFAULT implementations and two
// error arms were unreachable and CI's diff-coverage blocked on six lines. This is the shape
// CLAUDE.md already records against a different seam: "when every test injects a fake, the
// seam's DEFAULT implementation and each catch arm are unreachable — write one test that really
// shells out, and one per catch arm." Each test below moves ONE variable off the fake.

test("loadHomeRepoPointer rejects a pointer that is valid JSON but the WRONG SHAPE, not merely an unparseable one", () => {
  // The two existing malformed cases reach different arms: "{ not json" fails JSON.parse, and
  // {repo:"not-a-slash-pair"} fails the owner/repo regex. A file that PARSES but carries no
  // string `repo` reaches neither — that is the arm this covers.
  for (const body of [JSON.stringify({ repo: 123 }), JSON.stringify({}), JSON.stringify([]), JSON.stringify("acme/x")]) {
    const r = root();
    mkdirSync(join(r, ".remudero"), { recursive: true });
    writeFileSync(homeRepoPath(r), body);
    assert.throws(() => loadHomeRepoPointer(r), FeedbackError, `shape ${body} must fail loud`);
  }
  // PAIRED POSITIVE, one variable moved: the correctly-shaped file still parses, so the block
  // above is the shape check rather than a predicate that rejects everything.
  const ok = root();
  mkdirSync(join(ok, ".remudero"), { recursive: true });
  writeFileSync(homeRepoPath(ok), JSON.stringify({ repo: "acme/home" }));
  assert.deepEqual(loadHomeRepoPointer(ok), { owner: "acme", repo: "home" });
});

test("an undeterminable current repo skips upstreaming, so a checkout whose git read THROWS is treated as self", () => {
  const r = root();
  seedHomePointer(r, "acme/home");
  // fakeGit(null) throws on the remote read — the arm that resolves the current repo to null.
  const { git } = fakeGit(null);
  const entry = captureFeedback(r, { raw: "no discoverable identity", upstream: { git, gh: unreachableGh() } });

  // Design point iv's safe side: an unknown identity must NOT open a PR (a home instance
  // spamming itself is the worse failure), and the entry is still captured locally.
  assert.equal("upstream" in entry, false, "no upstream attempt is recorded at all");
  assert.equal(entry.raw, "no discoverable identity", "and the local capture is untouched");
});

test("the DEFAULT git seam really shells out: an uninjected git reads this checkout's own origin remote", () => {
  const r = root();
  // A REAL git repo with a REAL origin remote, so the default seam has something true to read.
  const g = (args: string[]) => execFileSync("git", ["-C", r, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  g(["init", "--quiet"]);
  g(["remote", "add", "origin", "https://github.com/someone-else/otherrepo.git"]);
  seedHomePointer(r, "acme/home");

  // `git` is NOT injected — this exercises defaultUpstreamGit. `gh` still is, so exactly one
  // variable moves and a failure here cannot be blamed on the network.
  const { gh, calls } = fakeGhSuccess("acme/home", "https://github.com/acme/home/pull/7");
  const entry = captureFeedback(r, { raw: "default git seam", upstream: { gh } });

  // The real read resolved someone-else/otherrepo, which is NOT the home repo, so routing
  // proceeded. That is only possible if the default seam ran and returned the true remote.
  assert.equal(entry.upstream?.status, "landed");
  assert.ok(calls.length > 0, "and the gh double was reached, which requires the git read to have succeeded");
});

test("the DEFAULT gh seam really shells out: an uninjected gh is invoked and its failure is recorded, never thrown", () => {
  const r = root();
  // A home repo that cannot exist, so a real `gh` — authenticated or not, present or not —
  // can only fail. Nothing is created anywhere by this test.
  seedHomePointer(r, "acme/remudero-nonexistent-fixture-repo-xyzzy");
  const { git } = fakeGit("https://github.com/someone-else/otherrepo.git");

  // `gh` is NOT injected — this exercises defaultUpstreamGh.
  const entry = captureFeedback(r, { raw: "default gh seam", upstream: { git } });

  // The capture survives regardless, and the failure is recorded rather than thrown — the
  // property the whole routing step promises.
  assert.equal(entry.raw, "default gh seam", "the local capture is durable whatever gh did");
  assert.equal(entry.upstream?.status, "unreachable", "and the failed attempt is recorded honestly");
  assert.ok(String(entry.upstream?.error ?? "").length > 0, "with a stated reason rather than an empty field");
});
