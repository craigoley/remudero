import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  LANDING_BRANCH,
  LANDING_PR_TITLE,
  findPendingLandingPr,
  landingIdentity,
  landFeedback,
  type LandingRepository,
} from "../src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}

function makeBareOrigin(): string {
  const bare = mkdtempSync(join(tmpdir(), "rmd-landing-scope-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: GIT_ENV });
  const seed = mkdtempSync(join(tmpdir(), "rmd-landing-scope-seed-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { encoding: "utf8", env: GIT_ENV });
  writeFileSync(join(seed, "README.md"), "seed\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "chore: seed");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "--quiet", "origin", "main");
  rmSync(seed, { recursive: true, force: true });
  return bare;
}

function cloneRoot(bareOrigin: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-landing-scope-root-"));
  execFileSync("git", ["clone", "--quiet", bareOrigin, dir], { encoding: "utf8", env: GIT_ENV });
  return dir;
}

const coreRepo: LandingRepository = { owner: "craigoley", repo: "remudero" };

test("landingIdentity derives branch, PR head and owned directory from target repository plus landing owner", () => {
  const site = landingIdentity({
    targetRepository: { owner: "craigoley", repo: "remudero-site" },
    sourceRepository: coreRepo,
    landingOwner: "site-daemon",
  });
  const sandbox = landingIdentity({
    targetRepository: { owner: "craigoley", repo: "remudero-sandbox" },
    sourceRepository: coreRepo,
    landingOwner: "sandbox-daemon",
  });

  assert.notEqual(site.branch, LANDING_BRANCH);
  assert.equal(site.prHead, site.branch);
  assert.equal(site.ownedDir, "plan/feedback");
  assert.equal(site.prTitle, LANDING_PR_TITLE);
  assert.notEqual(site.branch, sandbox.branch);
});

test("the self target keeps the exact legacy branch and pull-request head", () => {
  const identity = landingIdentity({ targetRepository: coreRepo, sourceRepository: coreRepo });
  assert.equal(identity.branch, LANDING_BRANCH);
  assert.equal(identity.prHead, LANDING_BRANCH);
  assert.equal(identity.ownedDir, "plan/feedback");
});

test("findPendingLandingPr is scoped by repository and owner branch", () => {
  const other = landingIdentity({
    targetRepository: { owner: "craigoley", repo: "remudero-site" },
    sourceRepository: coreRepo,
    landingOwner: "site-daemon",
  });
  const mine = landingIdentity({
    targetRepository: { owner: "craigoley", repo: "remudero-sandbox" },
    sourceRepository: coreRepo,
    landingOwner: "sandbox-daemon",
  });
  const calls: string[][] = [];
  const gh = (args: string[]): string => {
    calls.push(args);
    const head = args[args.indexOf("--head") + 1];
    const repo = args[args.indexOf("--repo") + 1];
    return head === other.prHead && repo === "craigoley/remudero-site"
      ? JSON.stringify([{ url: "https://github.com/craigoley/remudero-site/pull/12" }])
      : "[]";
  };

  assert.equal(findPendingLandingPr({ gh, identity: mine }), undefined);
  assert.equal(
    findPendingLandingPr({ gh, identity: other }),
    "https://github.com/craigoley/remudero-site/pull/12",
  );
  assert.ok(calls.every((c) => c.includes("--repo")), "lookup must name the target repository");
});

test("landFeedback pushes and opens the PR on the derived owner branch", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  const targetRepository = { owner: "craigoley", repo: "remudero-site" };
  const identity = landingIdentity({ targetRepository, sourceRepository: coreRepo, landingOwner: "site-daemon" });
  mkdirSync(join(root, "plan", "feedback"), { recursive: true });
  writeFileSync(join(root, "plan", "feedback", "fb-site.yaml"), "id: fb-site\nraw: site feedback\n");

  const calls: string[][] = [];
  const gh = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") return "[]";
    if (args[0] === "pr" && args[1] === "create") {
      return "Creating pull request\nhttps://github.com/craigoley/remudero-site/pull/22\n";
    }
    if (args[0] === "pr" && args[1] === "merge") return "";
    throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
  };

  const result = withLiveWritesAllowed(() =>
    landFeedback(root, { gh, targetRepository, sourceRepository: coreRepo, landingOwner: "site-daemon" }),
  );
  assert.equal(result.landed, true);
  assert.equal(result.prUrl, "https://github.com/craigoley/remudero-site/pull/22");
  assert.match(
    execFileSync("git", ["--git-dir", bareOrigin, "show", `${identity.branch}:plan/feedback/fb-site.yaml`], {
      encoding: "utf8",
    }),
    /site feedback/,
  );

  const create = calls.find((c) => c[0] === "pr" && c[1] === "create");
  assert.ok(create?.includes("--repo"));
  assert.equal(create?.[create.indexOf("--repo") + 1], "craigoley/remudero-site");
  assert.equal(create?.[create.indexOf("--head") + 1], identity.prHead);
});
