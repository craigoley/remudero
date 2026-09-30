/**
 * resolveOwnerRepo outside a resolvable checkout names its failure and its remedy.
 *
 * Before this, the console image's /app (no .git, deploy/Dockerfile REQ 13) made every one of
 * resolveOwnerRepo's ~45 bare callers die with `Command failed: git -C <dir> config --get
 * remote.origin.url` -- which names neither the cause nor the remedy. The throw is now ONE typed
 * error, so a caller that already catches keeps working and a caller that does not says what to do.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OWNER_REPO_REMEDY, OwnerRepoUnresolvableError, asOwnerRepoUnresolvable, resolveOwnerRepoAt } from "../src/lib/owner-repo.js";
import { repoRoot, resolveOwnerRepo } from "../src/lib/repo-location.js";
import { reviewCommand } from "../src/run-task.js";

const REPO = join(import.meta.dirname, "..");

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "rmd-owner-repo-"));
}

function git(dir: string, ...args: string[]): void {
  execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

function initRepo(origin?: string): string {
  const dir = scratch();
  git(dir, "init", "--quiet", "-b", "main");
  if (origin !== undefined) git(dir, "remote", "add", "origin", origin);
  return dir;
}

test("resolveOwnerRepo in a directory that is not a git checkout throws the typed error naming root, cause and remedy", () => {
  const dir = scratch();
  try {
    const e = thrown(() => resolveOwnerRepoAt(dir));
    assert.ok(e instanceof OwnerRepoUnresolvableError, `expected OwnerRepoUnresolvableError, got ${String(e)}`);
    assert.equal(e.checkoutRoot, dir);
    assert.match(e.message, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(e.reason, "not inside a git work tree");
    assert.ok(e.message.includes(OWNER_REPO_REMEDY));
    assert.match(e.message, /run inside a git checkout, or pass --repo <owner>\/<repo>/);
    assert.doesNotMatch(e.message, /Command failed/);
    assert.equal(e.message.split("\n").length, 1, "the message is one line");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveOwnerRepo in a git repo with no origin remote names the unset remote, not a bare exit", () => {
  const dir = initRepo();
  try {
    const e = thrown(() => resolveOwnerRepoAt(dir));
    assert.ok(e instanceof OwnerRepoUnresolvableError);
    assert.equal(e.reason, "remote.origin.url is not set");
    assert.match(e.message, /remote\.origin\.url is not set/);
    assert.ok(e.message.includes(OWNER_REPO_REMEDY));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveOwnerRepo on an origin url that does not parse names the unparseable url and redacts credentials", () => {
  const dir = initRepo("https://user:secret-token@example.invalid/");
  try {
    const e = thrown(() => resolveOwnerRepoAt(dir));
    assert.ok(e instanceof OwnerRepoUnresolvableError);
    assert.match(e.message, /cannot parse owner\/repo from origin url "https:\/\/example\.invalid\/"/);
    assert.doesNotMatch(e.message, /secret-token/);
    assert.ok(e.message.includes(OWNER_REPO_REMEDY));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveOwnerRepo on an origin whose value is empty is unparseable, not a crash", () => {
  const dir = initRepo("");
  try {
    const e = thrown(() => resolveOwnerRepoAt(dir));
    assert.ok(e instanceof OwnerRepoUnresolvableError);
    assert.match(e.message, /cannot parse owner\/repo from origin url ""/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveOwnerRepo when git itself cannot start names the spawn failure", () => {
  const dir = scratch();
  const savedPath = process.env.PATH;
  process.env.PATH = join(dir, "no-such-bin");
  try {
    const e = thrown(() => resolveOwnerRepoAt(dir));
    assert.ok(e instanceof OwnerRepoUnresolvableError);
    assert.match(e.reason, /ENOENT/);
  } finally {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveOwnerRepo on a normal origin is unchanged for the https and ssh forms", () => {
  const cases: Array<[string, { owner: string; repo: string }]> = [
    ["https://github.com/acme/portal.git", { owner: "acme", repo: "portal" }],
    ["https://github.com/acme/portal", { owner: "acme", repo: "portal" }],
    ["git@github.com:acme/portal.git", { owner: "acme", repo: "portal" }],
    ["ssh://git@github.com/acme/portal.git", { owner: "acme", repo: "portal" }],
  ];
  for (const [origin, want] of cases) {
    const dir = initRepo(origin);
    try {
      assert.deepEqual(resolveOwnerRepoAt(dir), want, origin);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("resolveOwnerRepo with no argument answers exactly what resolveOwnerRepoAt(repoRoot) answers", () => {
  const settle = (fn: () => unknown): unknown => {
    try {
      return fn();
    } catch (e) {
      assert.ok(e instanceof OwnerRepoUnresolvableError, "a checkout without an origin fails typed, never raw");
      return e.message;
    }
  };
  assert.deepEqual(settle(() => resolveOwnerRepo()), settle(() => resolveOwnerRepoAt(repoRoot)));
});

test("a bare caller run outside a checkout dies with the typed message, not the raw git command", () => {
  const dir = scratch();
  try {
    for (const verb of [["receipt", "W1-T1"], ["next-task-id"], ["reap-branches"]]) {
      const r = spawnSync(process.execPath, ["--import", "tsx", join(REPO, "src", "run-task.ts"), ...verb, "--repo-root", dir], {
        cwd: REPO,
        encoding: "utf8",
        timeout: 120_000,
        env: { PATH: process.env.PATH, HOME: dir },
      });
      assert.doesNotMatch(r.stderr, /Command failed/, verb.join(" "));
      assert.match(r.stderr, /no origin remote resolvable at .* — run inside a git checkout, or pass --repo/, verb.join(" "));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveOwnerRepo on a subdirectory of a checkout reads the enclosing checkout's origin", () => {
  const dir = initRepo("https://github.com/acme/portal.git");
  try {
    mkdirSync(join(dir, "sub"));
    assert.deepEqual(resolveOwnerRepoAt(join(dir, "sub")), { owner: "acme", repo: "portal" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("asOwnerRepoUnresolvable passes a typed error through and wraps any other failure at the given root", () => {
  const typed = new OwnerRepoUnresolvableError("/a", "why");
  assert.equal(asOwnerRepoUnresolvable(typed, "/b"), typed);
  const wrapped = asOwnerRepoUnresolvable(new Error("fatal: nope\nsecond line"), "/b");
  assert.ok(wrapped instanceof OwnerRepoUnresolvableError);
  assert.equal(wrapped.checkoutRoot, "/b");
  assert.equal(wrapped.reason, "fatal: nope");
  assert.equal(asOwnerRepoUnresolvable("plain string", "/b").reason, "plain string");
});

test("rmd review's refusal is the typed error's own message, so the wording has one source", async () => {
  const failure = new OwnerRepoUnresolvableError("/app", "not inside a git work tree");
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => {
    errors.push(a.join(" "));
  };
  try {
    const code = await reviewCommand("8", [], {
      resolveOwnerRepo: () => {
        throw failure;
      },
    });
    assert.equal(code, 1);
    assert.deepEqual(errors, [`rmd review: ${failure.message}`]);
  } finally {
    console.error = realError;
  }
});
