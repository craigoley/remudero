import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildServeServer,
  consoleBuildBannerLine,
  consoleBuildRealpath,
  consoleBuildStatus,
  type ServeDeps,
} from "../src/lib/serve.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import type { RatifyCliGateway } from "../src/lib/panel-graph.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { GitHub, PrRef } from "../src/lib/status.js";
import type { TraceGithub, TracePrView } from "../src/lib/trace.js";

// W1-T3176 — A CONSOLE BUILD IS THE FIRST BUILD ARTIFACT THIS SYSTEM HAS EVER HAD.
//
// FOUR READS THAT AGREE, 2026-09-08: `bin/rmd` ends `exec tsx src/run-task.ts` (production runs
// TypeScript directly); `ls dist build` finds neither; CI runs `tsc --noEmit` and never emits; and
// `deploy/entrypoint.sh` updates the running checkout with `npm ci` and builds nothing.
//
// THE NEW FAILURE MODE DOES NOT EXIST YET, WHICH IS WHY IT IS WORTH BUILDING NOW. Today the console
// is a string inside the source that runs, so it CANNOT be older than the code around it. Once it
// is a build output, a checkout that updates without rebuilding serves a stale console — or an
// absent one, which renders as a blank tab indistinguishable from a hung daemon.
//
// ABSENCE ONLY. Staleness needs a provenance stamp and a comparison; folding it in would put two
// mechanisms behind one falsifier (design iv).

const READ_TOKEN = "console-build-read";
const WRITE_TOKEN = "console-build-write";
const io = {
  realpath: (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  },
};

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-T3176-FIXTURE",
    title: "fixture",
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

function fakeTraceGithub(byRef: Record<string, TracePrView> = {}): TraceGithub {
  return { prView: (ref) => byRef[String(ref)] ?? null };
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

function fakeRatifyGateway(): RatifyCliGateway & {
  approved: string[];
  reframed: Array<{ proposalId: string; feedback: string }>;
} {
  const approved: string[] = [];
  const reframed: Array<{ proposalId: string; feedback: string }> = [];
  return {
    approved,
    reframed,
    approve(proposalId: string) {
      approved.push(proposalId);
    },
    reframe(proposalId: string, feedback: string) {
      reframed.push({ proposalId, feedback });
    },
  };
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-console-build-serve-"));
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
  const body =
    plan.tasks.length === 0
      ? "[]\n"
      : plan.tasks.map((t) => `- id: ${t.id}\n  title: "${t.title}"\n  repo: ${t.repo}\n  type: ${t.type}\n`).join("");
  writeFileSync(planPath, body, { flag: "wx" });
  return planPath;
}

function serveDepsFor(root: string, over: Partial<ServeDeps> = {}): ServeDeps {
  const ledgerPath = ledgerPathFor(root);
  const plan = planOf([task()]);
  const planPath = writePlan(root, plan);
  return {
    board: { plan, ledgerPath, github: fakeGitHub() },
    panelGraph: { root, planPath, ledgerPath, github: fakeTraceGithub(), statusGithub: fakeGitHub(), ratify: fakeRatifyGateway() },
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

async function withConsoleRoot<T>(fn: (root: string) => Promise<T>, built: boolean): Promise<T> {
  const base = mkdtempSync(join(tmpdir(), "rmd-console-build-"));
  const root = join(base, "dist");
  mkdirSync(root, { recursive: true });
  if (built) {
    writeFileSync(join(root, "index.html"), "<!doctype html><title>console</title>");
    writeFileSync(join(root, "app.js"), "export const x = 1;");
  }
  try {
    return await fn(realpathSync(root));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

async function withServeServer<T>(deps: ServeDeps, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = buildServeServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function withRoot(fn: (root: string, built: boolean) => void, built: boolean) {
  const base = mkdtempSync(join(tmpdir(), "rmd-console-build-"));
  const root = join(base, "dist");
  mkdirSync(root, { recursive: true });
  if (built) {
    writeFileSync(join(root, "index.html"), "<!doctype html><title>console</title>");
    writeFileSync(join(root, "app.js"), "export const x = 1;");
  }
  try {
    fn(realpathSync(root), built);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test("W1-T3176: an absent console build is reported, NAMING the path that was searched", () => {
  withRoot((root) => {
    const status = consoleBuildStatus(root, io);
    assert.equal(status?.kind, "absent");
    // "console build missing" with no path sends an operator looking in the wrong tree — the
    // motivating failure is someone staring at a blank tab, so the directory is in the line.
    assert.match(status!.reason, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const line = consoleBuildBannerLine(status);
    assert.match(line!, /ABSENT/);
    assert.match(line!, /the \/v1 API is unaffected/, "and the banner says what still works");

    // AN EMPTY dist/ IS WHAT A FAILED BUILD LEAVES BEHIND. A directory-existence check would call
    // that present and then serve nothing, so the ENTRY DOCUMENT is the test.
    assert.equal(consoleBuildStatus(join(root, "nope"), io)?.kind, "absent");
  }, false);
});

test("W1-T3176: a PRESENT build produces no complaint — the check discriminates", () => {
  withRoot((root) => {
    const status = consoleBuildStatus(root, io);
    assert.equal(status?.kind, "present");
    assert.equal(consoleBuildBannerLine(status), `    console build: ${root}`, "it states the root, without alarm");
    assert.doesNotMatch(consoleBuildBannerLine(status)!, /ABSENT|UNREADABLE/);
  }, true);
});

test("W1-T3176: NOT CONFIGURED is silent — a daemon serving only the string shell reports nothing", () => {
  // Crying wolf on every boot is how a startup banner stops being read. Until a console build is
  // configured there is nothing to be missing.
  assert.equal(consoleBuildStatus(undefined, io), null);
  assert.equal(consoleBuildBannerLine(null), null);
});

test("W1-T3176: the DEFAULT resolver tells absence from failure — the unreadable arm is reachable in production", () => {
  // ⚠ THE DEFECT THIS PINS. The first implementation's default `realpath` swallowed EVERY error and
  // returned null, so a real EACCES reported as `absent` and the `unreadable` arm was UNREACHABLE
  // outside a test. Every case below it injects a throwing fake, so the suite could not see it —
  // CLAUDE.md: "when every test injects a fake, the seam's DEFAULT implementation is unreachable".
  // Caught by the bare-catch ratchet, not by any assertion here.
  assert.equal(consoleBuildRealpath(join(tmpdir(), "rmd-definitely-not-here-3176")), null, "ENOENT is absence");

  // A directory as a path component makes the OS return ENOTDIR, not ENOENT: a real failure, and it
  // must THROW so consoleBuildStatus can report `unreadable` rather than quietly saying `absent`.
  const base = mkdtempSync(join(tmpdir(), "rmd-notdir-"));
  const file = join(base, "afile");
  writeFileSync(file, "x");
  try {
    assert.throws(() => consoleBuildRealpath(join(file, "under-a-file")), /ENOTDIR/, "a non-ENOENT error must not read as absence");
    const status = consoleBuildStatus(join(file, "under-a-file"), { realpath: consoleBuildRealpath });
    assert.equal(status?.kind, "unreadable", "and it must surface as UNREADABLE through the default io");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("W1-T3176: UNREADABLE is not ABSENT — the remedies differ and one of them is not 'rebuild'", () => {
  const throwing = {
    realpath: () => {
      throw new Error("EACCES: permission denied");
    },
  };
  const status = consoleBuildStatus("/some/root", throwing);
  assert.equal(status?.kind, "unreadable");
  assert.match(status!.reason, /EACCES/);
  assert.match(consoleBuildBannerLine(status)!, /UNREADABLE/);
});

test("W1-T3176: with the build absent the console route 404s while /v1 still serves — one surface, never both", async () => {
  await withConsoleRoot(async (consoleRoot) => {
    const root = tmpRoot();
    const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    try {
      await withServeServer(
        serveDepsFor(root, {
          consoleBuildRoot: consoleRoot,
          consoleBuildIo: io,
          log: (step, extra) => logs.push({ step, extra }),
        }),
        async (base) => {
          const h = { authorization: `Bearer ${READ_TOKEN}` };
          const api = await fetch(`${base}/v1/version`, { headers: h });
          assert.equal(api.status, 200, "the API must keep serving with no console build");

          const console404 = await fetch(`${base}/console/app.js`, { headers: h });
          assert.equal(console404.status, 404, "and the console surface refuses rather than half-rendering");
          assert.match(await console404.text(), /not_found/);
        },
      );

      assert.deepEqual(
        logs.filter((line) => line.step === "serve.console_build_missing"),
        [
          {
            step: "serve.console_build_missing",
            extra: { kind: "absent", root: consoleRoot, reason: `no index.html under ${consoleRoot}` },
          },
        ],
        "buildServeServer must report the absent build through the daemon log",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, false);
});

test("W1-T3176: a PRESENT build is mounted by the real serve assembler", async () => {
  await withConsoleRoot(async (consoleRoot) => {
    const root = tmpRoot();
    try {
      await withServeServer(
        serveDepsFor(root, {
          consoleBuildRoot: consoleRoot,
          consoleBuildIo: io,
        }),
        async (base) => {
          const js = await fetch(`${base}/console/app.js`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
          assert.equal(js.status, 200, "a present build must install the /console/ static mount");
          assert.equal(await js.text(), "export const x = 1;");
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, true);
});

test("W1-T3176: BOTH deploy paths that run `npm ci` also build the console", () => {
  // DESIGN (i). Two paths update the running code: the image build (deploy/Dockerfile, fired
  // automatically on a push touching a baked path since #3967) and the in-place checkout update
  // (deploy/entrypoint.sh, taken on every restart). They are reached INDEPENDENTLY, so a build
  // wired into only one of them is a stale console waiting for the other path to be taken.
  //
  // MEASURED: removing the entrypoint call killed no test until this case existed — the shard's
  // own criterion greps entrypoint.sh only, and nothing covered the Dockerfile at all.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  for (const path of ["deploy/entrypoint.sh", "deploy/Dockerfile"]) {
    const text = readFileSync(join(root, path), "utf8");
    // THE INVOCATION, NOT THE WORD. MEASURED: matching /build:console/ anywhere in the file is
    // satisfied by the COMMENT explaining it, so a mutant that deleted the actual call survived.
    // The assertion has to name the command that runs.
    assert.match(text, /npm run --silent build:console/, `${path} must INVOKE the console build, not merely mention it`);
  }

  // AND NEITHER MAY BE FATAL. A failed console build must not stop the daemon coming up: the /v1
  // API is what the fleet runs on, and `rmd serve` reports the missing build legibly instead.
  const entry = readFileSync(join(root, "deploy/entrypoint.sh"), "utf8");
  const call = entry.slice(entry.indexOf("build:console"));
  assert.doesNotMatch(call.slice(0, 200), /\bdie\b/, "the entrypoint must not die on a console build failure");

  // The script it invokes has to exist, or both call sites are wired to nothing.
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts["build:console"], "package.json must declare build:console");
});
