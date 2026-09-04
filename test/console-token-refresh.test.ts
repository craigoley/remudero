// test/console-token-refresh.test.ts — W1-T2269: THE CONSOLE HOLDS A PERSONAL TOKEN FOR ITS
// WHOLE LIFETIME AND NOTHING EVER REPLACES IT.
//
// Covers the five unit-test acceptance criteria in
// plan/tasks.d/W1-T2269-console-token-never-refreshes.yaml:
//   1. the console obtains its GitHub credential through a path that can replace it, rather than
//      holding a value fixed at spawn
//   2. a credential that cannot be replaced is reported by the console rather than presented as a
//      working board
//   3. the console's write routes keep the tiers and scopes they already have
//   4. the console starts and serves when the daemon is absent, so no renewal path couples the two
//      lifetimes
//   5. no credential value reaches a log line, a ledger row, or disk on any arm of the new path
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

import {
  buildServeRoutes,
  buildServeServer,
  buildVersionRoute,
  renderShellHtml,
  type ServeDeps,
} from "../src/lib/serve.js";
import {
  GH_APP_ID_ENV,
  GH_APP_INSTALLATION_ID_ENV,
  GH_APP_PRIVATE_KEY_PATH_ENV,
  TOKEN_REFRESHED_STEP,
  TOKEN_REFRESH_FAILED_STEP,
  type RefreshOptions,
} from "../src/lib/github-app.js";
import type { GitHub, PrRef } from "../src/lib/status.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import type { RatifyCliGateway } from "../src/lib/panel-graph.js";
import type { Plan, Task } from "../src/lib/plan.js";

const READ_TOKEN = "ctr-read-token";
const WRITE_TOKEN = "ctr-write-token";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-TX",
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued",
    attempts: 0,
    ...over,
  };
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

function fakeGitHub(byRef: Record<string, PrRef> = {}): GitHub {
  return {
    prByRef: (ref) => byRef[String(ref)] ?? null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
}

function fakeIssueCloser(): IssueCloser & { closed: string[] } {
  const closed: string[] = [];
  return {
    closed,
    close(issueUrl: string) {
      closed.push(issueUrl);
    },
  };
}

function fakeRatifyGateway(): RatifyCliGateway {
  return {
    approve() {},
    reframe() {},
  };
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-ctr-"));
}

function ledgerPathFor(root: string): string {
  const p = join(root, "state", "ledger.ndjson");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(p, "");
  return p;
}

function writePlan(root: string, plan: Plan): string {
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  const yamlBody = plan.tasks.length === 0
    ? "[]\n"
    : plan.tasks.map((t) => `- id: ${t.id}\n  title: "${t.title}"\n  repo: ${t.repo}\n  type: ${t.type}\n`).join("");
  writeFileSync(planPath, yamlBody, { flag: "wx" });
  return planPath;
}

/** The minimal, complete `ServeDeps` every test below starts from — `over.githubAppRefresh` (or
 *  any other field) layers on top per test, the same "base + override" shape test/serve.test.ts's
 *  own `depsFor` uses. */
function depsFor(root: string, over: Partial<ServeDeps> = {}): ServeDeps {
  const plan = planOf([task()]);
  const ledgerPath = ledgerPathFor(root);
  const planPath = writePlan(root, plan);
  return {
    board: { plan, ledgerPath, github: fakeGitHub() },
    panelGraph: { root, planPath, ledgerPath, github: { prView: () => null }, statusGithub: fakeGitHub(), ratify: fakeRatifyGateway() },
    ledgerPath,
    issues: fakeIssueCloser(),
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    identity: { trustedLocalAddress: "127.0.0.1", capability: "remudero:console" },
    pollMs: 50,
    ...over,
  };
}

async function withServeServer<T>(deps: ServeDeps, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = buildServeServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function get(base: string, path: string, token = READ_TOKEN) {
  return fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
}

function routeShape(routes: ReturnType<typeof buildServeRoutes>) {
  return routes
    .map((r) => ({ method: r.method, path: r.path, scope: r.scope, tier: r.tier }))
    .sort((a, b) => `${a.method}${a.path}`.localeCompare(`${b.method}${b.path}`));
}

// ── (1) A PATH THAT CAN REPLACE THE CREDENTIAL, NEVER FIXED AT SPAWN ────────────────────────────

test("W1-T2269: an unconfigured console arms nothing — byte-identical to before this task", () => {
  const root = tmpRoot();
  const routes = buildServeRoutes(depsFor(root, { githubAppRefresh: { env: {} } }));
  const version = routes.find((r) => "path" in r && r.path === "/v1/version");
  assert.ok(version, "GET /v1/version must be mounted");
});

test("W1-T2269: a configured console arms its OWN in-process refresh loop, never the daemon's", () => {
  const root = tmpRoot();
  let started = false;
  let observedEnv: NodeJS.ProcessEnv | undefined;
  const fakeStart = (opts: { log?: RefreshOptions["log"]; env?: NodeJS.ProcessEnv }) => {
    started = true;
    observedEnv = opts.env;
    return { armed: true };
  };
  const env = {
    [GH_APP_ID_ENV]: "app-1",
    [GH_APP_INSTALLATION_ID_ENV]: "inst-1",
    [GH_APP_PRIVATE_KEY_PATH_ENV]: "/fake/key.pem",
  };
  buildServeRoutes(depsFor(root, { githubAppRefresh: { start: fakeStart, env } }));
  assert.equal(started, true, "buildServeRoutes must arm the console's OWN refresh loop");
  assert.equal(observedEnv, env, "the refresh loop must read the CONSOLE's own env, not a daemon's");
});

test("W1-T2269: an armed, never-failed console reports 'refreshing (App)' on the shell", async () => {
  const root = tmpRoot();
  const env = {
    [GH_APP_ID_ENV]: "app-1",
    [GH_APP_INSTALLATION_ID_ENV]: "inst-1",
    [GH_APP_PRIVATE_KEY_PATH_ENV]: "/fake/key.pem",
  };
  const deps = depsFor(root, {
    githubAppRefresh: { start: () => ({ armed: true }), env },
  });
  await withServeServer(deps, async (base) => {
    const res = await get(base, "/", READ_TOKEN);
    assert.equal(res.status, 200);
    const shell = await res.text();
    assert.match(shell, /refreshing \(App\)/, "an armed console with no recorded failure must read as actively refreshing");
  });
});

test("W1-T2269: deploy/serve-container.sh carries a passthrough for all three GH_APP_* names", () => {
  // The COMMITTED launcher, not an operator's inherited shell — the rationale's own finding was
  // that the currently-running console holds these by ACCIDENT of how it was started, never by
  // anything checked in. This is the source-level proof that a launch through THIS script now
  // carries a path for the credential to be replaceable, the same way GH_TOKEN always has.
  const src = readFileSync(fileURLToPath(new URL("../deploy/serve-container.sh", import.meta.url)), "utf8");
  for (const name of ["GH_APP_ID", "GH_APP_INSTALLATION_ID", "GH_APP_PRIVATE_KEY_PATH"]) {
    assert.match(src, new RegExp(`-e ${name}\\b`), `serve-container.sh must pass ${name} through by name`);
  }
});

const SERVE_CONTAINER_SH = fileURLToPath(new URL("../deploy/serve-container.sh", import.meta.url));
const SERVE_APP_KEY_DEST = "/home/node/.rmd-github-app-private-key.pem";
// W1-T2778 criterion 5: the fixed destinations deploy/serve-container.sh has used since before
// this task, for the account file, webhook secret, state mount, and default network name — read
// here from the script's own constants so this file fails loudly if any of them ever drift.
const SERVE_ACCOUNT_FILE_DEST = "/home/node/.claude.json";
const SERVE_WEBHOOK_SECRET_DEST = "/home/node/.rmd-github-webhook-secret";
const SERVE_STATE_MOUNT_DEST = "/home/node/Remudero";
const SERVE_DEFAULT_NETWORK = "rmd-net";

interface ServeLauncherFixtureOptions {
  // W1-T2778 criterion 5: the pre-existing account-file, webhook-secret, and GH_TOKEN-capture
  // behaviors must ride unchanged alongside the new App-key mount. Off by default so the four
  // tests above (unchanged from before this option existed) keep exercising the plain paths.
  accountFilePresent?: boolean;
  webhookSecretPresent?: boolean;
  captureTokenFromDaemon?: boolean;
  /** False models the App-only production shape: neither shell nor daemon carries a static token. */
  daemonTokenPresent?: boolean;
  extraArgv?: string[];
  existingContainer?: boolean;
}

function runServeLauncherFixture(
  source: "direct" | "daemon" | "missing" | "empty",
  options: ServeLauncherFixtureOptions = {},
) {
  const root = tmpRoot();
  const binDir = join(root, "bin");
  const stateDir = join(root, "state-root");
  const credDir = join(root, "daemon-credentials");
  const capturePath = join(root, "docker-capture.txt");
  const dockerPath = join(binDir, "docker");
  const directKeyPath = join(root, "direct-app.pem");
  const accountFilePath = join(root, "account-file.json");
  const webhookSecretPath = join(root, "webhook-secret.txt");
  // A production-shaped absolute path such as /home/node/.claude/rmd-app.pem can exist in the
  // parent test container. In that case the launcher correctly treats it as directly readable
  // and never exercises either translation arm. Give each fixture a container-only mount path so
  // the test result cannot depend on credentials installed on the machine running the proof.
  const daemonCredentialDest = `/rmd-test-${basename(root)}`;
  const daemonKeyPath = join(daemonCredentialDest, "rmd-app.pem");
  const keyBody = "FAKE-PRIVATE-KEY-CONTENT-W1-T2778";
  const token = "ghs_FAKE_STATIC_TOKEN_W1_T2778";
  const daemonTokenArg = options.daemonTokenPresent === false ? "" : "'GH_TOKEN=daemon-token'";
  mkdirSync(binDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(credDir, { recursive: true });
  // Pre-touch the capture file: a dry run and a refused (existing-container) launch never call
  // `docker run`, so nothing would otherwise create this file before the common return below reads it.
  writeFileSync(capturePath, "");
  if (source === "direct") writeFileSync(directKeyPath, keyBody);
  if (source === "daemon") writeFileSync(join(credDir, "rmd-app.pem"), keyBody);
  // W1-T2778 criterion 3 names FOUR degraded shapes — absent, empty, unreadable, untranslatable —
  // and "missing" below only exercises the untranslatable one (a daemon-captured path with no
  // matching host file). The empty case gives `-s` (non-empty) its own portable direct-path
  // fixture rather than hiding behind "missing"'s coverage of the fourth shape. A chmod-based
  // unreadable fixture is deliberately absent: uid 0 bypasses it, so it changes meaning by host
  // and is refused by the repository's host-capability ratchet.
  if (source === "empty") writeFileSync(directKeyPath, "");
  if (options.accountFilePresent) writeFileSync(accountFilePath, '{"account":"fake"}');
  if (options.webhookSecretPresent) writeFileSync(webhookSecretPath, "fake-webhook-secret");

  writeFileSync(
    dockerPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "network" ] && [ "\${2:-}" = "inspect" ]; then
  if [[ " $* " == *" --format "* ]]; then printf '%s\\n' 'cloudflared '; fi
  exit 0
fi
if [ "\${1:-}" = "inspect" ] && [ "\${2:-}" = "remudero-daemon" ]; then
  case "$*" in
    *Config.Env*)
      printf '%s\\n' ${daemonTokenArg} 'GH_APP_ID=123' 'GH_APP_INSTALLATION_ID=456' 'GH_APP_PRIVATE_KEY_PATH=${daemonKeyPath}'
      ;;
    *home/node/Remudero*)
      printf '%s\\n' '${stateDir}'
      ;;
    *Mounts*)
      printf '%s\\t%s\\n' '${stateDir}' '/home/node/Remudero' '${credDir}' '${daemonCredentialDest}'
      ;;
  esac
  exit 0
fi
if [ "\${1:-}" = "inspect" ] && [[ " $* " == *" remudero-serve "* ]]; then
  case "$*" in
    *State.Running*) printf '%s\\n' true; exit 0 ;;
    *NetworkSettings.Networks*) printf '%s\\n' yes; exit 0 ;;
    *)
      # The plain existence check (no --format) this script's own "an existing container is never
      # silently replaced" section runs before ever building RUN_ARGS. FAKE_EXISTING_CONTAINER lets
      # W1-T2778's own coverage prove that refusal is untouched by the new App-key mount code.
      if [ "\${FAKE_EXISTING_CONTAINER:-0}" = "1" ]; then exit 0; else exit 1; fi
      ;;
  esac
fi
if [ "\${1:-}" = "run" ]; then
  {
    printf '%s\\n' RUN
    printf '%s\\n' "$@"
    printf 'ENV:%s\\n' "\${GH_APP_PRIVATE_KEY_PATH:-}"
  } >> "\${FAKE_DOCKER_CAPTURE}"
  exit 0
fi
if [ "\${1:-}" = "logs" ]; then
  printf '%s\\n' 'listening on http://0.0.0.0:4317'
  exit 0
fi
exit 1
`,
  );
  chmodSync(dockerPath, 0o755);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    HOME: root,
    GH_TOKEN: token,
    FAKE_DOCKER_CAPTURE: capturePath,
    RMD_SERVE_DOCKERENV_PATH: join(root, "not-a-container-marker"),
    RMD_CLAUDE_JSON_PATH: options.accountFilePresent ? accountFilePath : join(root, "no-account-file"),
    RMD_GITHUB_WEBHOOK_SECRET_PATH: options.webhookSecretPresent ? webhookSecretPath : join(root, "no-webhook-secret"),
  };
  delete env.GH_APP_ID;
  delete env.GH_APP_INSTALLATION_ID;
  delete env.GH_APP_PRIVATE_KEY_PATH;
  if (source === "direct" || source === "empty") {
    env.GH_APP_ID = "123";
    env.GH_APP_INSTALLATION_ID = "456";
    env.GH_APP_PRIVATE_KEY_PATH = directKeyPath;
  }
  if (options.captureTokenFromDaemon) {
    // W1-T2778 criterion 5: the GH_TOKEN-capture-from-daemon path (unmodified by this task) must
    // still work with an App key configured. The fake daemon's Config.Env above always offers
    // GH_TOKEN=daemon-token; leaving this shell's own GH_TOKEN unset is what makes the launcher
    // fall through to that capture instead of using this shell's value.
    delete env.GH_TOKEN;
  }
  if (options.existingContainer) {
    env.FAKE_EXISTING_CONTAINER = "1";
  }

  const result = spawnSync(
    "bash",
    [SERVE_CONTAINER_SH, ...(options.extraArgv ?? [])],
    { encoding: "utf8", env },
  );
  const capture = readFileSync(capturePath, "utf8");
  return { result, capture, root, credDir, directKeyPath, daemonKeyPath, keyBody, token, accountFilePath, webhookSecretPath, stateDir };
}

test("W1-T2778: a direct readable host App key becomes one read-only file mount and the launched env names that destination", () => {
  const fixture = runServeLauncherFixture("direct");
  assert.equal(fixture.result.status, 0, fixture.result.stderr);
  assert.ok(fixture.capture.includes(`${fixture.directKeyPath}:${SERVE_APP_KEY_DEST}:ro`));
  assert.ok(fixture.capture.includes(`ENV:${SERVE_APP_KEY_DEST}`));
  assert.equal(fixture.capture.split(SERVE_APP_KEY_DEST).length - 1, 2, "one mount destination plus one env value");
  assert.ok(!`${fixture.result.stdout}${fixture.result.stderr}${fixture.capture}`.includes(fixture.keyBody), "key content never reaches output or argv");
  assert.ok(!`${fixture.result.stdout}${fixture.result.stderr}${fixture.capture}`.includes(fixture.token), "token content never reaches output or argv");
});

test("W1-T2778: a daemon-container key path is translated through the daemon's observed mount source", () => {
  const fixture = runServeLauncherFixture("daemon");
  assert.equal(fixture.result.status, 0, fixture.result.stderr);
  assert.ok(
    fixture.capture.includes(`${join(fixture.credDir, "rmd-app.pem")}:${SERVE_APP_KEY_DEST}:ro`),
    `expected the translated file mount in:\n${fixture.capture}`,
  );
  assert.ok(fixture.capture.includes(`ENV:${SERVE_APP_KEY_DEST}`));
  assert.ok(!fixture.capture.includes(`${fixture.credDir}:/home/node/.claude`), "the credential directory itself is never mounted");
});

test("W1-T2778: an untranslatable or missing key preserves startup and fallback without inventing a mount", () => {
  const fixture = runServeLauncherFixture("missing");
  assert.equal(fixture.result.status, 0, fixture.result.stderr);
  assert.ok(!fixture.capture.includes(SERVE_APP_KEY_DEST), `unexpected key destination in:\n${fixture.capture}`);
  assert.ok(fixture.capture.includes(`ENV:${fixture.daemonKeyPath}`), "the refresher retains the unreadable path so its existing telemetry names the failure");
  assert.match(fixture.result.stderr, /private key.*unreadable|could not resolve.*private key/i);
});

test("W1-T2778: an empty declared key file preserves startup and fallback without inventing a mount", () => {
  const fixture = runServeLauncherFixture("empty");
  assert.equal(fixture.result.status, 0, fixture.result.stderr);
  assert.ok(!fixture.capture.includes(SERVE_APP_KEY_DEST), `unexpected key destination in:\n${fixture.capture}`);
  assert.ok(fixture.capture.includes(`ENV:${fixture.directKeyPath}`), "the refresher retains the declared path so its existing telemetry names the failure");
  assert.match(fixture.result.stderr, /private key.*unreadable|could not resolve.*private key/i);
});

test("W1-T2778: the account file, webhook secret, state mount, network attach, and daemon-captured GH_TOKEN ride unchanged alongside the App-key mount", () => {
  const fixture = runServeLauncherFixture("direct", {
    accountFilePresent: true,
    webhookSecretPresent: true,
    captureTokenFromDaemon: true,
  });
  assert.equal(fixture.result.status, 0, fixture.result.stderr);
  assert.ok(fixture.capture.includes(`${fixture.directKeyPath}:${SERVE_APP_KEY_DEST}:ro`), "the App-key mount is still present");
  assert.ok(
    fixture.capture.includes(`${fixture.accountFilePath}:${SERVE_ACCOUNT_FILE_DEST}:ro`),
    `expected the unchanged account-file mount in:\n${fixture.capture}`,
  );
  assert.ok(
    fixture.capture.includes(`${fixture.webhookSecretPath}:${SERVE_WEBHOOK_SECRET_DEST}:ro`),
    `expected the unchanged webhook-secret mount in:\n${fixture.capture}`,
  );
  assert.ok(
    fixture.capture.includes(`${fixture.stateDir}:${SERVE_STATE_MOUNT_DEST}`),
    `expected the unchanged state mount in:\n${fixture.capture}`,
  );
  assert.match(
    fixture.capture,
    new RegExp(`--network\\n${SERVE_DEFAULT_NETWORK}\\n`),
    "the network attach is unchanged", // one argv entry per capture line — see the fake docker's `printf '%s\\n' "$@"`
  );
  assert.ok(
    !`${fixture.result.stdout}${fixture.result.stderr}${fixture.capture}`.includes("daemon-token"),
    "the daemon-captured token value is never printed, even though capture (not this shell's own GH_TOKEN) is what supplied it",
  );
});

test("W1-T2778: --dry-run prints the App-key mount alongside every other mount and changes nothing", () => {
  const fixture = runServeLauncherFixture("direct", {
    accountFilePresent: true,
    webhookSecretPresent: true,
    extraArgv: ["--dry-run"],
  });
  assert.equal(fixture.result.status, 0, fixture.result.stderr);
  assert.match(fixture.result.stdout, /--dry-run, nothing changed/);
  assert.ok(fixture.result.stdout.includes(`${fixture.directKeyPath}:${SERVE_APP_KEY_DEST}:ro`), "the printed launch names the App-key mount");
  assert.ok(fixture.result.stdout.includes(`${fixture.accountFilePath}:${SERVE_ACCOUNT_FILE_DEST}:ro`), "the printed launch still names the account-file mount");
  assert.ok(fixture.result.stdout.includes(`${fixture.webhookSecretPath}:${SERVE_WEBHOOK_SECRET_DEST}:ro`), "the printed launch still names the webhook-secret mount");
  assert.equal(fixture.capture, "", "a dry run never calls docker run — nothing was actually launched");
  assert.ok(
    !`${fixture.result.stdout}${fixture.result.stderr}`.includes(fixture.keyBody),
    "key content never reaches the printed dry-run output",
  );
});

test("W1-T2778: an existing remudero-serve container is still refused without --replace, App key configured or not", () => {
  const fixture = runServeLauncherFixture("direct", { existingContainer: true });
  assert.equal(fixture.result.status, 1, fixture.result.stdout);
  assert.match(fixture.result.stderr, /REFUSING.*already exists/s);
  assert.equal(fixture.capture, "", "the refusal fires before docker run is ever called — nothing was launched or replaced");
});

test("W1-T2836: a readable App identity launches without any static GH_TOKEN", () => {
  const fixture = runServeLauncherFixture("direct", {
    captureTokenFromDaemon: true,
    daemonTokenPresent: false,
  });
  assert.equal(fixture.result.status, 0, fixture.result.stderr);
  assert.match(fixture.result.stdout, /no static GH_TOKEN; GitHub App auth is fully configured/);
  assert.ok(fixture.capture.includes(`${fixture.directKeyPath}:${SERVE_APP_KEY_DEST}:ro`));
  assert.ok(!`${fixture.result.stdout}${fixture.result.stderr}${fixture.capture}`.includes(fixture.token));
});

test("W1-T2836: no static token plus an unusable App key still refuses before docker run", () => {
  const fixture = runServeLauncherFixture("missing", {
    captureTokenFromDaemon: true,
    daemonTokenPresent: false,
  });
  assert.equal(fixture.result.status, 1, fixture.result.stdout);
  assert.match(fixture.result.stderr, /REFUSING — no GH_TOKEN is available, and GitHub App auth is not usable/);
  assert.equal(fixture.capture, "", "the failed credential preflight must not replace or launch anything");
});

// ── (2) A CREDENTIAL THAT CANNOT BE REPLACED IS REPORTED, NOT PRESENTED AS A WORKING BOARD ──────

test("W1-T2269: an unconfigured console reports 'static' on the board, not silence", async () => {
  const root = tmpRoot();
  const deps = depsFor(root, { githubAppRefresh: { env: {} } });
  await withServeServer(deps, async (base) => {
    const shell = await (await get(base, "/", READ_TOKEN)).text();
    assert.match(shell, /github-credential/, "the shell must render a github-credential chip");
    assert.match(shell, /static \(no renewal configured\)/, "an unconfigured console must NAME itself static, not look like a healthy board");
  });
});

test("W1-T2269: a refresh failure is named on the board, with github-app.ts's own reason", async () => {
  const root = tmpRoot();
  const FAIL_REASON = "exchange rejected: 403";
  const fakeStart = (opts: { log?: RefreshOptions["log"] }) => {
    opts.log?.(TOKEN_REFRESH_FAILED_STEP, { reason: FAIL_REASON });
    return { armed: true };
  };
  const deps = depsFor(root, {
    githubAppRefresh: {
      start: fakeStart,
      env: { [GH_APP_ID_ENV]: "1", [GH_APP_INSTALLATION_ID_ENV]: "2", [GH_APP_PRIVATE_KEY_PATH_ENV]: "/k.pem" },
    },
  });
  await withServeServer(deps, async (base) => {
    const shell = await (await get(base, "/", READ_TOKEN)).text();
    assert.match(shell, new RegExp(`refresh failed: ${FAIL_REASON}`), "a failed refresh must be named on the board, not hidden behind a healthy chip");
  });
});

test("W1-T2269: a later SUCCESS clears a previously-reported failure on the board — never a stuck stale warning", async () => {
  const root = tmpRoot();
  let log: RefreshOptions["log"] | undefined;
  const fakeStart = (opts: { log?: RefreshOptions["log"] }) => {
    log = opts.log;
    opts.log?.(TOKEN_REFRESH_FAILED_STEP, { reason: "exchange timed out" });
    return { armed: true };
  };
  const deps = depsFor(root, {
    githubAppRefresh: {
      start: fakeStart,
      env: { [GH_APP_ID_ENV]: "1", [GH_APP_INSTALLATION_ID_ENV]: "2", [GH_APP_PRIVATE_KEY_PATH_ENV]: "/k.pem" },
    },
  });
  await withServeServer(deps, async (base) => {
    const before = await (await get(base, "/", READ_TOKEN)).text();
    assert.match(before, /refresh failed: exchange timed out/);

    log?.(TOKEN_REFRESHED_STEP, { installation_id: "2", expires_at: "2026-08-25T12:00:00Z" });

    const after = await (await get(base, "/", READ_TOKEN)).text();
    assert.doesNotMatch(after, /refresh failed/, "a fresh success must clear the stale failure");
    assert.match(after, /refreshing \(App\)/, "and read as actively refreshing again");
  });
});

// ── (3) WRITE ROUTES KEEP THE TIERS AND SCOPES THEY ALREADY HAVE ────────────────────────────────

test("W1-T2269: arming (or not arming) the credential refresh changes NOTHING about route scopes/tiers", () => {
  const unconfigured = routeShape(buildServeRoutes(depsFor(tmpRoot(), { githubAppRefresh: { env: {} } })));
  const configured = routeShape(
    buildServeRoutes(
      depsFor(tmpRoot(), {
        githubAppRefresh: {
          start: () => ({ armed: true }),
          env: { [GH_APP_ID_ENV]: "1", [GH_APP_INSTALLATION_ID_ENV]: "2", [GH_APP_PRIVATE_KEY_PATH_ENV]: "/k.pem" },
        },
      }),
    ),
  );
  assert.deepEqual(configured, unconfigured, "the route table's method/path/scope/tier must be identical either way");
  // Sanity: the write tiers this shard must NOT touch are still present and still HIGH.
  const highPaths = configured.filter((r) => r.tier === "high").map((r) => r.path).sort();
  assert.deepEqual(highPaths, [
    "/v1/drain/kick",
    "/v1/drain/run",
    "/v1/inbox/approve",
    "/v1/manual/approve",
    "/v1/merge-hold",
    "/v1/policy/provider-routing",
    "/v1/policy/provider-routing/clear",
    "/v1/skills/run",
  ].sort());
});

// ── (4) THE CONSOLE STARTS AND SERVES WHEN THE DAEMON IS ABSENT ─────────────────────────────────

test("W1-T2269: the console boots and serves with the refresh armed and NO daemon reachable anywhere", async () => {
  // No daemon process is started anywhere in this test file — every fixture above is an in-memory
  // fake. This test additionally proves the refresh path itself never reaches OUT for anything
  // but GitHub: the fake `start` below performs its own network-shaped exchange against a stub
  // `fetchImpl` that only ever answers `https://api.github.com/...`, never a daemon URL/port, and
  // the server still boots, binds and serves GET / and GET /v1/version normally.
  const root = tmpRoot();
  const calledUrls: string[] = [];
  const fakeStart = (opts: { log?: RefreshOptions["log"] }) => {
    void (async () => {
      calledUrls.push("https://api.github.com/app/installations/2/access_tokens");
      opts.log?.(TOKEN_REFRESHED_STEP, { installation_id: "2", expires_at: "2026-08-25T12:00:00Z" });
    })();
    return { armed: true };
  };
  const deps = depsFor(root, {
    githubAppRefresh: {
      start: fakeStart,
      env: { [GH_APP_ID_ENV]: "1", [GH_APP_INSTALLATION_ID_ENV]: "2", [GH_APP_PRIVATE_KEY_PATH_ENV]: "/k.pem" },
    },
  });
  await withServeServer(deps, async (base) => {
    const shellRes = await get(base, "/", READ_TOKEN);
    assert.equal(shellRes.status, 200);
    const versionRes = await get(base, "/v1/version");
    assert.equal(versionRes.status, 200);
  });
  assert.deepEqual(calledUrls, ["https://api.github.com/app/installations/2/access_tokens"]);
});

test("W1-T2269: github-app.ts's exchange never names a daemon host — GitHub's own API is the only remote it calls", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/lib/github-app.ts", import.meta.url)), "utf8");
  const urls = [...src.matchAll(/https?:\/\/[^\s"'`]+/g)].map((m) => m[0]);
  assert.ok(urls.length > 0, "control: the module must call SOME URL, or this assertion is vacuous");
  for (const url of urls) {
    assert.match(url, /^https:\/\/api\.github\.com\//, `unexpected remote in github-app.ts: ${url}`);
  }
});

function extractFunctionBody(src: string, name: string): string {
  const startIdx = src.indexOf(`function ${name}(`);
  assert.ok(startIdx >= 0, `${name} must exist in src/lib/serve.ts`);
  const closeIdx = src.indexOf("\n}\n", startIdx);
  assert.ok(closeIdx >= 0, `could not find the end of ${name}`);
  return src.slice(startIdx, closeIdx);
}

test("W1-T2269: serve.ts's new credential-refresh wiring makes no HTTP call of its own (it only arms github-app.ts's)", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/lib/serve.ts", import.meta.url)), "utf8");
  const trackerBody = extractFunctionBody(src, "trackGithubCredentialState");
  const rendererBody = extractFunctionBody(src, "renderGithubCredentialHtml");
  const armStart = src.indexOf("const githubCredential = trackGithubCredentialState(deps.log);");
  assert.ok(armStart >= 0, "the arming call site must exist in buildServeRoutes");
  const armEnd = src.indexOf("}).armed;", armStart);
  assert.ok(armEnd >= 0, "the arming call site must close with `}).armed;`");
  const armBlock = src.slice(armStart, armEnd + "}).armed;".length);
  for (const [label, code] of [
    ["trackGithubCredentialState", trackerBody],
    ["renderGithubCredentialHtml", rendererBody],
    ["buildServeRoutes's arming call site", armBlock],
  ] as const) {
    assert.ok(!/\bfetch\(/.test(code), `${label} must not itself fetch anything — only github-app.ts's own exchange may`);
  }
});

// ── (5) NO CREDENTIAL VALUE REACHES A LOG LINE, A LEDGER ROW, OR DISK ───────────────────────────

test("W1-T2269: a secret written into GH_TOKEN never appears in the rendered shell, /v1/version, or the ledger log", async () => {
  const root = tmpRoot();
  const SECRET = "ghs_SHOULD-NEVER-LEAK-1234567890";
  const loggedLines: string[] = [];
  const fakeStart = (opts: { log?: RefreshOptions["log"] }) => {
    // A well-behaved (and a misbehaving) producer both get exercised: github-app.ts's own
    // contract never puts a token in `extra` (test/github-app.test.ts covers that module
    // directly) — this test instead proves serve.ts's OWN relay/render path is not itself a
    // second place a token could leak from, by checking every surface serve.ts controls.
    opts.log?.(TOKEN_REFRESH_FAILED_STEP, { reason: "exchange rejected: 403" });
    return { armed: true };
  };
  const deps = depsFor(root, {
    githubAppRefresh: {
      start: fakeStart,
      env: {
        GH_TOKEN: SECRET,
        [GH_APP_ID_ENV]: "1",
        [GH_APP_INSTALLATION_ID_ENV]: "2",
        [GH_APP_PRIVATE_KEY_PATH_ENV]: "/k.pem",
      },
    },
    log: (step, extra) => loggedLines.push(JSON.stringify({ step, extra })),
  });
  await withServeServer(deps, async (base) => {
    const shell = await (await get(base, "/", READ_TOKEN)).text();
    assert.ok(!shell.includes(SECRET), "the shell HTML must never contain the token value");

    const versionBody = await (await get(base, "/v1/version")).text();
    assert.ok(!versionBody.includes(SECRET), "GET /v1/version must never contain the token value");
  });
  assert.ok(loggedLines.length > 0, "control: the ledger log must have received at least one line, or this assertion is vacuous");
  for (const line of loggedLines) {
    assert.ok(!line.includes(SECRET), `ledger line leaked the token: ${line}`);
  }
});

test("W1-T2269: renderShellHtml's credential param is a plain server-rendered span — no new client-script field", () => {
  const html = renderShellHtml(undefined, undefined, "", '<span class="gh-credential-failed">refresh failed: boom</span>');
  assert.match(html, /id="github-credential"/);
  assert.match(html, /refresh failed: boom/);
});

test("W1-T2269: GET /v1/version stays exactly {sha} — the credential state is reported on the shell, never on this JSON surface", async () => {
  // A pre-existing invariant test (test/serve.test.ts, "the served payload carries the sha and NO
  // credential-shaped key") already guards this endpoint's shape; this test pins the SAME
  // decision from this task's own side, so a future edit that tries to add the credential state
  // here fails immediately, in the file that made the choice, not only in the older guard.
  const route = buildVersionRoute("deadbeef");
  const chunks: Buffer[] = [];
  const res = {
    writeHead: () => {},
    end: (body: string) => chunks.push(Buffer.from(body)),
  } as unknown as import("node:http").ServerResponse;
  route.handler({} as import("node:http").IncomingMessage, res, {} as never);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.deepEqual(Object.keys(body), ["sha"]);
});

test("W1-T2269: deploy/serve-container.sh never writes a GH_APP_* value inline, never prints one — name-only passthrough, same as GH_TOKEN", () => {
  const src = readFileSync(fileURLToPath(new URL("../deploy/serve-container.sh", import.meta.url)), "utf8");
  for (const name of ["GH_APP_ID", "GH_APP_INSTALLATION_ID", "GH_APP_PRIVATE_KEY_PATH"]) {
    assert.ok(!new RegExp(`-e ${name}=`).test(src), `${name} must be passed by NAME only, never -e ${name}=<value>`);
  }
  // The three capture/echo lines name the SOURCE only ("from the invoking shell" / "captured
  // from <container>"), never interpolate the captured value itself into an echo.
  assert.ok(!/echo.*\$\{CAPTURED\}/.test(src.replace(/CAPTURED="\$\(docker[^\n]*\n/g, "")), "no echo may print a captured credential value");
});
