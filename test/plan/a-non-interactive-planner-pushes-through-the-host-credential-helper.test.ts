import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { hostWorktreeGitResult, planCommand } from "#src/run-task.js";
import {
  hostAppIdentityEnv, plannerHostGitCredential, realScopedMint, startRunChildGitCredentialSocket,
  type HostAppIdentity, type PlannerHostGitCredential,
} from "#src/lib/secret-boundary.js";
import { hostWorktreeGitAsync } from "#src/lib/worktree-git.js";
import { wireCredentialHelperSocket, type WorkerResult } from "#src/lib/worker.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type PlanCredential = NonNullable<NonNullable<Parameters<typeof planCommand>[1]>["credential"]>;

// W1-T11851: `rmd plan` launched from a non-interactive shell had no credential for its own pushes — the only
// token was a ~/.bashrc export, which bash reads only for an interactive shell. Its pushes now present a
// repo-scoped token minted from the host registry's App identity at the git credential-helper boundary.

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const FAKE_TOKEN = "ghs_W1T11851fakescopedtoken";
const DECOY_TOKEN = "ghp_W1T11851bashrcdecoy";
const REQUEST = "protocol=https\nhost=github.com\npath=acme/widgets.git\n\n";

function scratch(tag: string): string {
  return mkdtempSync(join(tmpdir(), `rmd-t11851-${tag}-`));
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}

function writeKey(path: string): void {
  writeFileSync(path, generateKeyPairSync("rsa", {
    modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey);
}

function registry(dir: string, instances: string): string {
  const path = join(dir, "daemon-instances.yaml");
  writeFileSync(path, `instances:\n${instances}`);
  return path;
}

const instance = (name: string, fields: Record<string, string>): string =>
  `  ${name}:\n${Object.entries(fields).map(([k, v]) => `    ${k}: ${v}\n`).join("")}`;

/** A checkout and a linked worktree carrying split worktree config, as a lane worktree has. */
function laneFixture(dir: string): { main: string; worktree: string; cleanup: () => void } {
  const main = gitRepo({ kind: "t11851-main" });
  main.git("config", "extensions.worktreeConfig", "true");
  const worktree = join(dir, "lane");
  main.addWorktree(worktree, "lane");
  return { main: main.dir, worktree, cleanup: () => main.cleanup() };
}

/** A HOME whose only token is an interactive-only .bashrc export, and whose global helper answers from $GH_TOKEN. */
function decoyHome(dir: string): string {
  const home = join(dir, "home");
  mkdirSync(home);
  writeFileSync(join(home, ".bashrc"), `export GH_TOKEN=${DECOY_TOKEN}\n`);
  writeFileSync(join(home, ".gitconfig"),
    "[credential]\n\thelper = \"!f() { test -n \\\"$GH_TOKEN\\\" && printf 'username=x-access-token\\\\npassword=%s\\\\n' \\\"$GH_TOKEN\\\"; }; f\"\n");
  return home;
}

/** `git credential fill` in a bash child whose env is built from scratch: no GH_TOKEN, no GH_APP_* variable. */
function bashCredentialFill(flags: "-c" | "-ic", cwd: string, home: string): Promise<{ code: number; stdout: string }> {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
  // stdin is /dev/null, never a pipe: bash sources ~/.bashrc for `-c` too when stdin is a socket (its
  // remote-shell heuristic), and node's pipes are socketpairs. MEASURED here: a piped `bash -c` read the decoy.
  return new Promise((resolve) => {
    const child = spawn("bash", [flags, `printf '%s' "$REQ" | git -C "${cwd}" credential fill`],
      { env: { ...env, REQ: REQUEST }, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
  });
}

function password(reply: string): string | undefined {
  return /^password=(.*)$/m.exec(reply)?.[1];
}

/** A `mintScopedToken` stand-in recording the private env it was handed, answering with the fake token. */
function recordingMint(seen: NodeJS.ProcessEnv[]): Parameters<typeof realScopedMint>[1] {
  return async (_repo, _ttl, opts) => {
    seen.push({ ...(opts?.env ?? {}) });
    return { ok: true, token: FAKE_TOKEN };
  };
}

test("the planner credential resolver reads the host registry: app, ambient, and a named refusal for each unusable source", async () => {
  const dir = scratch("resolver");
  try {
    const key = join(dir, "app.pem");
    writeKey(key);
    const claudeDir = join(dir, "claude");
    mkdirSync(claudeDir);
    writeKey(join(claudeDir, "rmd-app.pem"));
    const app = { github_repo: "acme/widgets", gh_app_id: "11", gh_app_installation_id: "22" };

    const explicit = await plannerHostGitCredential("acme/widgets", {
      registryPath: registry(dir, instance("core", { ...app, gh_app_private_key_path: "/home/node/.claude/rmd-app.pem", gh_app_private_key_host_path: key })),
    });
    assert.deepEqual(explicit, { kind: "app", registryPath: join(dir, "daemon-instances.yaml"), appId: "11", installationId: "22", keyPath: key });

    const mapped = await plannerHostGitCredential("ACME/widgets", {
      registryPath: registry(dir, instance("core", { ...app, gh_app_private_key_path: "/home/node/.claude/rmd-app.pem", claude_dir: `${claudeDir}/` })),
    });
    assert.equal(mapped.kind === "app" && mapped.keyPath, join(claudeDir, "rmd-app.pem"), "the container key path maps under claude_dir");

    assert.deepEqual(await plannerHostGitCredential("acme/widgets", { registryPath: join(dir, "absent.yaml") }),
      { kind: "ambient", registryPath: join(dir, "absent.yaml") }, "only a missing registry keeps today's helpers");

    const refused = async (text: string, opts: { access?: (p: string) => Promise<void> } = {}): Promise<string> => {
      const got: PlannerHostGitCredential = await plannerHostGitCredential("acme/widgets", { registryPath: registry(dir, text), ...opts });
      assert.equal(got.kind, "refused", `refused: ${JSON.stringify(got)}`);
      return got.kind === "refused" ? got.reason : "";
    };
    const keyed = { ...app, gh_app_private_key_host_path: key };
    assert.match(await refused("  core:\n   bad-indent: x\n"), /malformed/);
    assert.match(await refused(instance("core", { github_repo: "acme/widgets", gh_app_installation_id: "22", gh_app_private_key_host_path: key })), /no gh_app_id/);
    assert.match(await refused(instance("core", { ...app, gh_app_private_key_host_path: join(dir, "missing.pem") })), /not readable: ENOENT/);
    assert.match(await refused(instance("core", keyed), { access: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } }), /not readable: EACCES/);
    assert.match(await refused(instance("core", { ...app, gh_app_private_key_path: "/srv/key.pem" })), /does not map onto this host/);
    assert.match(await refused(instance("other", { ...keyed, github_repo: "acme/gadgets" })), /no host instance names acme\/widgets/);
    assert.match(
      await refused(instance("core", keyed) + instance("old", { ...keyed, gh_app_id: "99", retired: "true" })),
      /2 host instances name acme\/widgets with different App identities/,
    );
    const unreadable = await plannerHostGitCredential("acme/widgets", { registryPath: dir });
    assert.ok(unreadable.kind === "refused" && /unreadable: EISDIR/.test(unreadable.reason), "a registry that cannot be read is not absence");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T11851 criterion 3: a non-interactive child whose only token is a .bashrc export gets the scoped token from the wired helper", async () => {
  const dir = scratch("helper");
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const seen: NodeJS.ProcessEnv[] = [];
  const cleanups: Array<() => void> = [];
  try {
    const key = join(dir, "app.pem");
    writeKey(key);
    const resolved = await plannerHostGitCredential("acme/widgets", {
      registryPath: registry(dir, instance("core", { github_repo: "acme/widgets", gh_app_id: "11", gh_app_installation_id: "22", gh_app_private_key_host_path: key })),
    });
    assert.equal(resolved.kind, "app");
    const identity = resolved as HostAppIdentity;
    const { main, worktree, cleanup } = laneFixture(dir);
    cleanups.push(cleanup);
    const home = decoyHome(dir);
    const runDir = join(dir, "run");
    mkdirSync(runDir);
    const log = (step: string, fields: Record<string, unknown>) => rows.push({ step, fields });
    const socket = await startRunChildGitCredentialSocket({ runDir, log, mint: realScopedMint(log, recordingMint(seen), identity) });
    try {
      wireCredentialHelperSocket(worktree, socket.socketPath);
      const wired = await bashCredentialFill("-c", worktree, home);
      assert.equal(password(wired.stdout), FAKE_TOKEN, `the wired helper answers a non-interactive child: ${JSON.stringify(wired)}`);
      assert.deepEqual(seen, [hostAppIdentityEnv(identity)], "the mint read exactly the registry identity, from a private env");
      assert.deepEqual(seen[0], { GH_APP_ID: "11", GH_APP_INSTALLATION_ID: "22", GH_APP_PRIVATE_KEY_PATH: key });
      // The harness git leaf every reservation and run-branch push takes carries the same helper.
      assert.equal(password(await hostWorktreeGitAsync(worktree, ["credential", "fill"], { input: REQUEST })), FAKE_TOKEN);

      // RED CONTROL: the decoy is observable, so the fixture can see the original failure.
      const bare = await bashCredentialFill("-c", main, home);
      assert.equal(password(bare.stdout), undefined, "an unwired checkout in a non-interactive child has no credential");
      assert.notEqual(bare.code, 0);
      const interactive = await bashCredentialFill("-ic", main, home);
      assert.equal(password(interactive.stdout), DECOY_TOKEN, "bash -ic does read the .bashrc decoy");
      assert.notEqual(password(interactive.stdout), FAKE_TOKEN, "an unwired worktree never gets the scoped token");
    } finally {
      await socket.close();
    }
    assert.ok(rows.some((r) => r.step === "boundary.request" && r.fields.status === "minted"), "the mint is ledgered value-free");
    assert.ok(!JSON.stringify(rows).includes(FAKE_TOKEN), "no ledger row carries the token");
  } finally {
    for (const cleanup of cleanups) cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the identity reaches the real mint and the real socket thread, and a pathless request mints nothing", async () => {
  const dir = scratch("thread");
  try {
    const key = join(dir, "app.pem");
    writeKey(key);
    const identity: HostAppIdentity = { appId: "11", installationId: "22", keyPath: key };
    // The real mintScopedToken: with the identity it reaches the owner/repo check; without it, it has no App at all.
    assert.deepEqual(await realScopedMint(() => {}, undefined, identity)("github.com"), { ok: false, reason: "request names no owner/repo to scope to" });
    assert.deepEqual(await realScopedMint(() => {})("github.com"), { ok: false, reason: "app not configured" });

    const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
    const socket = await startRunChildGitCredentialSocket({ runDir: dir, log: (step, fields) => rows.push({ step, fields }), identity });
    try {
      const lane = laneFixture(dir);
      try {
        wireCredentialHelperSocket(lane.worktree, socket.socketPath);
        await assert.rejects(hostWorktreeGitAsync(lane.worktree, ["credential", "fill"], { input: "protocol=https\nhost=github.com\n\n",
          env: { GIT_TERMINAL_PROMPT: "0" } }), "a pathless request is answered with nothing");
      } finally {
        lane.cleanup();
      }
    } finally {
      await socket.close();
    }
    assert.ok(rows.some((r) => r.fields.decision === "refuse" && /owner\/repo/.test(String(r.fields.reason))),
      `the thread minted as the identity and refused the pathless request: ${JSON.stringify(rows)}`);
    assert.ok(!rows.some((r) => r.fields.status === "minted"), "nothing was minted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── planCommand itself, on the offline fixture shape test/plan-lane-mint.test.ts uses ─────────────────────────

function fakeWorker(text: string): WorkerResult {
  return { sessionId: "T11851", costUsd: 0, numTurns: 1, text, blocks: [text], stderr: "", subtype: "success", isError: false,
    apiError: false, model: "claude-opus-5", effort: "high", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    totalCostUsd: 0, billingMode: "subscription", verdict: "success", qualitySuspect: false, compactionEvents: [], childEnvKeys: [] } as unknown as WorkerResult;
}

async function withPlanHarness(body: (configRoot: string) => Promise<void>): Promise<Array<Record<string, unknown>>> {
  const dir = scratch("plan");
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  const bare = gitRepo({ bare: true, kind: "t11851-origin" });
  const seed = gitRepo({ seedCommit: false, kind: "t11851-seed" });
  const shim = ghShim([{ when: "pr list", stdout: "[]" }], { kind: "t11851-gh" });
  try {
    mkdirSync(join(seed.dir, "plan", "tasks.d"), { recursive: true });
    writeFileSync(join(seed.dir, "plan", "tasks.yaml"), "- id: W1-T4\n  title: \"seed\"\n  repo: remudero\n  origin: architect\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n  attempts: 0\n");
    writeFileSync(join(seed.dir, "MASTER-PLAN.md"), "# MASTER PLAN\n");
    seed.git("add", "-A");
    seed.git("commit", "-q", "-m", "chore: seed");
    seed.git("push", "-q", bare.dir, "main");
    const home = join(dir, "home");
    const configRoot = join(dir, "root");
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/usr/bin/true", root: configRoot, installRoot: REPO_ROOT }));
    const originUrl = git(REPO_ROOT, "config", "--get", "remote.origin.url").trim();
    const repoDir = join(configRoot, "repos", /[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(originUrl)![2]!);
    mkdirSync(dirname(repoDir), { recursive: true });
    execFileSync("git", ["clone", "-q", bare.dir, repoDir], { env: GIT_ENV });
    git(repoDir, "config", "user.name", "remudero-test");
    git(repoDir, "config", "user.email", "test@remudero.invalid");
    process.env.HOME = home;
    process.env.PATH = `${shim.dir}:${saved.PATH}`;
    await body(configRoot);
    const ledger = join(configRoot, "state", "ledger.ndjson");
    return existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
  } finally {
    process.env.HOME = saved.HOME;
    process.env.PATH = saved.PATH;
    bare.cleanup();
    seed.cleanup();
    rmSync(shim.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

const BRIEF = ["--mode=create", "a", "fixture", "brief"];

test("an unusable host credential refuses rmd plan before any reservation push or worker spawn", async () => {
  for (const credential of [
    { resolve: async () => ({ kind: "refused", reason: "the acme/widgets App key is not readable: EACCES", registryPath: "/etc/remudero/daemon-instances.yaml" }) },
    { resolve: async () => ({ kind: "app", appId: "11", installationId: "22", keyPath: "/k.pem", registryPath: "/r.yaml" }),
      startSocket: async () => { throw new Error("bind refused"); } },
    { resolve: async () => ({ kind: "app", appId: "11", installationId: "22", keyPath: "/k.pem", registryPath: "/r.yaml" }),
      startSocket: async () => ({ socketPath: "/nonexistent/git.sock", close: async () => { throw new Error("close refused"); } }),
      wire: () => { throw new Error("config write refused"); } },
  ] satisfies PlanCredential[]) {
    let spawns = 0;
    const gitCalls: string[][] = [];
    let reads = 0;
    const ledger = await withPlanHarness(async () => {
      const code = await planCommand(BRIEF, {
        spawn: async () => { spawns++; return fakeWorker("CLEAR: unused"); },
        credential: { ...credential, git: (_cwd, args) => { gitCalls.push(args); return { status: 0, stdout: "", stderr: "" }; },
          openPrFetch: () => { reads++; return []; } },
      });
      assert.equal(code, 1, "a refused credential exits non-zero");
    });
    assert.equal(spawns, 0, "no paid worker starts");
    assert.deepEqual(gitCalls, [], "the remote reserver never runs");
    assert.equal(reads, 0, "nothing is minted, so nothing is read");
    const refusal = ledger.find((r) => r.step === "plan.credential_refused");
    assert.ok(refusal && typeof refusal.reason === "string" && typeof refusal.registry_path === "string", `ledgered: ${JSON.stringify(ledger)}`);
    assert.ok(!ledger.some((r) => r.step === "plan.id_minted"), "no id is claimed");
    if (credential.wire) {
      assert.match(String(refusal.reason), /helper not wired: config write refused/);
      assert.ok(ledger.some((r) => r.step === "plan.credential_close_failed" && /close refused/.test(String(r.error))),
        "a socket that will not close is ledgered, never masks the refusal");
    }
  }
});

test("rmd plan with the host App identity pushes through its own wired worktree and holds no token in its environment", async () => {
  const seen: NodeJS.ProcessEnv[] = [];
  const gitCwds: string[] = [];
  const reads: unknown[] = [];
  const unwired: string[] = [];
  const envBefore = JSON.stringify(process.env);
  let atSpawn: { harness?: string; child?: string; cwd: string } | undefined;
  let socketDir = "";
  const ledger = await withPlanHarness(async (configRoot) => {
    const credDir = join(configRoot, "tmp");
    const code = await planCommand(BRIEF, {
      credential: {
        resolve: async () => ({ kind: "app", appId: "11", installationId: "22", keyPath: "/host/app.pem", registryPath: "/r.yaml" }),
        startSocket: (opts) => {
          socketDir = opts.runDir;
          assert.ok(opts.runDir.startsWith(credDir), "the socket lives in this run's own directory");
          return startRunChildGitCredentialSocket({ ...opts, mint: realScopedMint(opts.log, recordingMint(seen), opts.identity) });
        },
        unwire: (cwd) => { unwired.push(cwd); return []; },
        git: (cwd, args) => {
          gitCwds.push(cwd);
          return hostWorktreeGitResult(cwd, args);
        },
        openPrFetch: (args) => { reads.push(args); return []; },
      },
      spawn: async (args: { cwd: string }) => {
        const home = decoyHome(mkdtempSync(join(tmpdir(), "rmd-t11851-home-")));
        try {
          atSpawn = {
            cwd: args.cwd,
            harness: password(await hostWorktreeGitAsync(args.cwd, ["credential", "fill"], { input: REQUEST })),
            child: password((await bashCredentialFill("-c", args.cwd, home)).stdout),
          };
        } finally {
          rmSync(dirname(home), { recursive: true, force: true });
        }
        return fakeWorker("CLEAR: nothing to file for this fixture brief");
      },
    });
    assert.equal(code, 0);
  });
  assert.ok(atSpawn, "the worker ran");
  assert.equal(atSpawn.harness, FAKE_TOKEN, "the reservation/push git leaf presents the scoped token");
  assert.equal(atSpawn.child, FAKE_TOKEN, "a non-interactive child in the plan worktree gets the scoped token");
  assert.deepEqual(seen.at(-1), { GH_APP_ID: "11", GH_APP_INSTALLATION_ID: "22", GH_APP_PRIVATE_KEY_PATH: "/host/app.pem" });
  assert.ok(gitCwds.length > 0 && gitCwds.every((cwd) => cwd === atSpawn!.cwd),
    `the reservation pushes and their release ran from the wired worktree: ${JSON.stringify(gitCwds)}`);
  assert.ok(ledger.some((r) => r.step === "plan.id_minted"), "ids were reserved");
  assert.ok(ledger.some((r) => r.step === "task_id.reservation_released"), `the release ran: ${JSON.stringify(ledger.map((r) => r.step))}`);
  assert.deepEqual(unwired, [atSpawn.cwd], "the worktree is unwired after the release");
  assert.equal(existsSync(socketDir), false, "the socket directory is removed");
  assert.equal(reads.length, 1, "the open-PR read is made once, through openPrMintTexts's own transport seam");
  assert.equal(JSON.stringify(process.env), envBefore, "the planner's process.env is untouched");
  assert.ok(!Object.values(process.env).some((v) => v === FAKE_TOKEN), "no token value enters process.env");
});
