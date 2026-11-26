/**
 * W1-T14987: on 2026-11-26 core #21008 (src/lib/github-delivery-log.ts, src/lib/serve.ts, src/lib/ledger-steps.ts) merged
 * 14:28Z and serve's handoff then waited about 2.7 h behind the spacing. Craig ruled 14:43Z that a merge changing only
 * serve's own code hands serve over without the spacing, and the daemon keeps its spacing; 14:54Z he approved counting
 * src/lib/ledger-steps.ts daemon-inert under a census guard (the last tests here).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { daemonProcessClosure, type ClosureGit } from "#src/lib/daemon-closure.js";
import type { GenerationMessage } from "#src/lib/serve-generation.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import {
  classifyServeOnlyAdvance, SERVE_OWN_CODE_DAEMON_INERT_PATHS, serveOnlyAdvanceIn, serveOnlyVerdict, type ServeOnlyAdvanceReader,
} from "#src/lib/serve-own-code.js";
import { gateStaleCodeExit, type GatewayCheckoutAssessment } from "#src/lib/serve.js";
import {
  createServeSupervisor, readServeOnlyVerdict, SERVE_HANDOFF_SPACING_BASE_MS, type GenerationProcess, type PreparedSlot, type ServeSupervisorOptions,
} from "#src/lib/serve-supervisor.js";
import { meaningOfStep } from "#src/lib/ledger-steps.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const MIN = 60_000;
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
};

/**
 * A repository shaped like core: src/run-task.ts loads the daemon's module and serve.ts; serve.ts alone loads
 * serve-only.ts; report-commands.ts (daemon side) alone loads ledger-steps.ts. Each change lands as a --no-ff merge.
 */
function fixture() {
  const repo = gitRepo({ kind: "serve-own-code", seedCommit: false });
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  };
  write("package.json", "{\"type\":\"module\"}\n");
  write("src/run-task.ts", "import \"./lib/serve.js\";\nimport \"./lib/daemon-loop.js\";\nimport \"./lib/report-commands.js\";\n");
  write("src/lib/serve.ts", "import \"./serve-only.js\";\nimport \"./daemon-loop.js\";\nexport const serve = 1;\n");
  write("src/lib/serve-only.ts", "export const own = 1;\n");
  write("src/lib/daemon-loop.ts", "export const loop = 1;\n");
  write("src/lib/report-commands.ts", "import { meaningOfStep } from \"./ledger-steps.js\";\nexport const grep = meaningOfStep;\n");
  write("src/lib/ledger-steps.ts", "export const meaningOfStep = (s: string) => s;\n");
  write("docs/notes.md", "notes\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "base");
  const sha = (): string => repo.git("rev-parse", "HEAD").trim();
  const merge = (name: string, files: Record<string, string>, remove: string[] = []): string => {
    repo.git("checkout", "-q", "-b", name);
    for (const [path, text] of Object.entries(files)) write(path, text);
    for (const path of remove) repo.git("rm", "-q", path);
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", name);
    repo.git("checkout", "-q", "main");
    repo.git("merge", "-q", "--no-ff", "-m", `Merge ${name}`, name);
    return sha();
  };
  const base = sha();
  const serveOnly = merge("serve-only", { "src/lib/serve-only.ts": "export const own = 2;\n", "docs/notes.md": "more\n" });
  const daemonToo = merge("daemon-too", { "src/lib/serve.ts": "import \"./serve-only.js\";\nimport \"./daemon-loop.js\";\nexport const serve = 2;\n", "src/lib/daemon-loop.ts": "export const loop = 2;\n" });
  const docsOnly = merge("docs-only", { "docs/notes.md": "docs\n" });
  const ledgerToo = merge("ledger-too", { "src/lib/serve.ts": "import \"./serve-only.js\";\nimport \"./daemon-loop.js\";\nexport const serve = 3;\n", "src/lib/ledger-steps.ts": "export const meaningOfStep = (s: string) => s + s;\n" });
  const noEntry = merge("no-entry", {}, ["src/run-task.ts"]);
  return { repo, base, serveOnly, daemonToo, docsOnly, ledgerToo, noEntry };
}

/** A supervisor on the production spacing base, booted spaced; prepare hands out `shas` in turn. */
function supervisorAt(extra: Partial<ServeSupervisorOptions>, coldSha: string, shas: string[]) {
  const slots = new Map<string, PreparedSlot>();
  let forks = 0;
  /** The listeners of the generation last promoted: the one whose asks the supervisor acts on. */
  let current: Array<(m: GenerationMessage) => void> = [];
  const spawn: ServeSupervisorOptions["spawn"] = (command, env) => {
    slots.set(env.RMD_SERVE_READY_SOCKET, JSON.parse(command.args[0]) as PreparedSlot);
    forks += 1;
    const onMessage: Array<(m: GenerationMessage) => void> = [];
    const onExit: Array<(c: number | null, s: string | null) => void> = [];
    const generation: GenerationProcess = {
      pid: forks,
      send(message) {
        if (message.type === "rmd.promote") {
          current = onMessage;
          queueMicrotask(() => onMessage.forEach((l) => l({ type: "rmd.promoted" })));
        }
        if (message.type === "rmd.drain") queueMicrotask(() => onExit.forEach((l) => l(0, null)));
      },
      onMessage: (l) => void onMessage.push(l),
      onExit: (l) => void onExit.push(l),
      kill: () => onExit.forEach((l) => l(null, "SIGKILL")),
    };
    return generation;
  };
  const state = { now: Date.parse("2026-11-26T14:00:00.000Z") };
  const waits: Array<{ ms: number; wake: () => void }> = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const supervisor = createServeSupervisor({
    coldSlot: { dir: "/cold", sha: coldSha },
    prepare: async (activeDir) => ({ dir: activeDir === "/slot-a" ? "/slot-b" : "/slot-a", sha: shas.shift() ?? "exhausted" }),
    spawn,
    get: async (socketPath, path) => path === "/v1/version"
      ? { status: 200, body: JSON.stringify({ sha: slots.get(socketPath)?.sha }) }
      : { status: 200, body: JSON.stringify({ ready: true, criteria: [] }) },
    command: (slot) => ({ exec: "gen", execArgv: [], args: [JSON.stringify(slot)], cwd: slot.dir }),
    log: (step, fields) => void logs.push({ step, extra: fields }),
    exit: () => {},
    clock: { now: () => state.now, iso: () => "" } as never,
    sleep: (ms) => new Promise<void>((resolve) => void waits.push({ ms, wake: () => ((state.now += ms), resolve()) })),
    freeMemory: () => undefined, rss: () => undefined, peakRss: () => 1_000,
    hostPressure: async () => ({ atMs: state.now, memAvailableBytes: 2 ** 40, swapInPagesPerSec: 0, psiSomeAvg10: 0, psiFullAvg10: 0, unread: [] }),
    upgradeThresholds: () => ({ hostReserveBytes: 0, swapInPagesPerSecMax: 256, psiSomeAvg10Max: 10, psiFullAvg10Max: 2, staleMs: 600_000 }),
    socketPathFor: (n) => `/sock/${n}`,
    spacingBaseMs: SERVE_HANDOFF_SPACING_BASE_MS,
    spacingHalfLifeMs: 60 * MIN,
    spaceFromBoot: true,
    ...extra,
  });
  const rows = (step: string) => logs.filter((l) => l.step === step).map((l) => l.extra!);
  const spaced = () => rows("serve.handoff_deferred").filter((r) => r.reason === "spacing");
  /** The active generation's ask over IPC, as serve.ts sends it: `targetSha` and its own verdict beside it. */
  const ask = async (fields: Record<string, unknown>): Promise<void> => {
    current.forEach((l) => l({ type: "rmd.handoff_request", ...fields }));
    await settle();
  };
  /** The generation-side classifier, really reading git: what the active generation would send for `targetSha`. */
  const askFor = async (reader: ServeOnlyAdvanceReader, targetSha: string | undefined, fromSha = supervisor.activeSha()!): Promise<void> =>
    ask({ ...(targetSha === undefined ? {} : { targetSha }), serveOnly: await serveOnlyVerdict(reader, fromSha, targetSha) });
  return { supervisor, state, waits, logs, rows, spaced, ask, askFor };
}

test("W1-T14987 criterion 1: a merge that changes only serve's own code hands serve over inside the spacing window", async () => {
  const f = fixture();
  try {
    const reader = serveOnlyAdvanceIn(f.repo.dir);
    const s = supervisorAt({}, f.base, [f.serveOnly, f.ledgerToo]);
    await s.supervisor.start();
    s.state.now += 20 * MIN;
    await s.askFor(reader, f.serveOnly);
    assert.equal(s.supervisor.activeSha(), f.serveOnly, "20 minutes after boot, a serve-only merge hands serve over at once");
    assert.equal(s.spaced().length, 0);
    assert.deepEqual(s.rows("serve.handoff_spacing_waived"), [{
      fromSha: f.base, toSha: f.serveOnly, merge: f.serveOnly, paths: ["docs/notes.md", "src/lib/serve-only.ts"], waitMs: SERVE_HANDOFF_SPACING_BASE_MS - 20 * MIN,
    }]);
    assert.equal(s.rows("serve.handoff_done")[0]!.pressure, 1, "the waived handoff still adds pressure");

    // The waived handoff set lastDoneAt: the next daemon-touching ask is spaced from it, at the pressured window.
    s.state.now += 5 * MIN;
    await s.askFor(reader, f.daemonToo);
    assert.equal(s.supervisor.activeSha(), f.serveOnly);
    assert.equal(s.spaced().length, 1);
    assert.equal(s.spaced()[0]!.sinceLastMs, 5 * MIN);
    assert.ok(Number(s.spaced()[0]!.spacingMs) > SERVE_HANDOFF_SPACING_BASE_MS, "the waived handoff added pressure to the window");

    // An ask the pending wait would absorb is waived too when its advance holds a serve-only merge (#21008's shape).
    await s.askFor(reader, f.ledgerToo);
    assert.equal(s.supervisor.activeSha(), f.ledgerToo);
    assert.equal(s.rows("serve.handoff_spacing_absorbed").length, 0);
    const waived = s.rows("serve.handoff_spacing_waived")[1]!;
    assert.equal(waived.merge, f.ledgerToo, "the oldest serve-only merge of serveOnly..ledgerToo: daemonToo and docsOnly are not");
    assert.deepEqual(waived.paths, ["src/lib/ledger-steps.ts", "src/lib/serve.ts"]);
    assert.match(meaningOfStep("serve.handoff_spacing_waived")?.meaning ?? "", /serve's own code/);
  } finally {
    f.repo.cleanup();
  }
});

test("W1-T14987 criterion 2: a merge that changes a module the daemon also loads still waits out the spacing", async () => {
  const f = fixture();
  try {
    const s = supervisorAt({}, f.serveOnly, [f.docsOnly]);
    await s.supervisor.start();
    s.state.now += 20 * MIN;
    // daemonToo changes serve.ts too: "touches a serve file" is not "touches only serve's own code". docsOnly counts for nothing.
    await s.askFor(serveOnlyAdvanceIn(f.repo.dir), f.docsOnly);
    assert.equal(s.supervisor.activeSha(), f.serveOnly);
    assert.equal(s.rows("serve.handoff_spacing_waived").length, 0);
    assert.deepEqual(s.spaced(), [{
      reason: "spacing", waitMs: SERVE_HANDOFF_SPACING_BASE_MS - 20 * MIN, spacingMs: SERVE_HANDOFF_SPACING_BASE_MS, pressure: 0, sinceLastMs: 20 * MIN, sha: f.serveOnly,
    }], "the same spacing row as before W1-T14987, with no field added");
    s.waits.find((w) => w.ms === SERVE_HANDOFF_SPACING_BASE_MS - 20 * MIN)!.wake();
    await settle();
    assert.equal(s.supervisor.activeSha(), f.docsOnly, "the wait re-asks and hands off as before");

    const git = (args: string[]) => Promise.resolve(f.repo.git(...args));
    assert.deepEqual(await classifyServeOnlyAdvance(git, f.daemonToo, f.docsOnly), { status: "spaced", reason: "none of 1 merge(s) changes only serve's own code" });
    assert.deepEqual(await classifyServeOnlyAdvance(git, f.docsOnly, f.docsOnly), { status: "spaced", reason: `no merge in ${f.docsOnly}..${f.docsOnly}` });
  } finally {
    f.repo.cleanup();
  }
});

test("W1-T14987 criterion 3: an unreadable diff or closure waits out the spacing and names why", async () => {
  const f = fixture();
  try {
    const reader = serveOnlyAdvanceIn(f.repo.dir);
    const s = supervisorAt({}, f.ledgerToo, []);
    await s.supervisor.start();
    s.state.now += 20 * MIN;
    await s.askFor(reader, undefined);
    assert.equal(s.spaced()[0]!.waiver, "the ask names no target sha");
    const ghost = "0123456789abcdef0123456789abcdef01234567";
    await s.askFor(reader, ghost);
    const absorbed = () => s.rows("serve.handoff_spacing_absorbed").map((r) => String(r.waiver));
    assert.match(absorbed()[0]!, new RegExp(`^unreadable: merges ${f.ledgerToo}\\.\\.${ghost}: `));
    await s.askFor(reader, f.noEntry);
    assert.match(absorbed()[1]!, new RegExp(`^unreadable: closure at ${f.noEntry}: the entry src/run-task.ts is not tracked`));
    // A generation reader that throws is unreadable too, and so is anything the supervisor cannot trust.
    await s.askFor(async () => { throw new Error("git is gone"); }, f.serveOnly);
    assert.equal(absorbed()[2], "unreadable: the reader threw: git is gone");
    const serveOnly = { status: "serve_only", merge: f.ledgerToo, paths: ["src/lib/serve.ts"] };
    await s.ask({ targetSha: f.noEntry, serveOnly: { ...serveOnly, fromSha: f.base, toSha: f.noEntry } });
    assert.equal(absorbed()[3], `a verdict from ${f.base}, not the active ${f.ledgerToo}`);
    await s.ask({ targetSha: f.noEntry, serveOnly: { ...serveOnly, fromSha: f.ledgerToo, toSha: f.serveOnly } });
    assert.equal(absorbed()[4], `a verdict for ${f.serveOnly}, not the asked ${f.noEntry}`);
    await s.ask({ targetSha: f.noEntry, serveOnly: { status: "serve_only", fromSha: f.ledgerToo } });
    assert.equal(absorbed()[5], "malformed verdict: the verdict's status \"serve_only\" does not carry its fields");
    await s.ask({ targetSha: f.noEntry, serveOnly: null });
    assert.equal(absorbed()[6], "malformed verdict: the verdict names no fromSha");
    assert.equal(s.supervisor.activeSha(), f.ledgerToo, "nothing unreadable or untrusted hands serve over");
    assert.equal(s.rows("serve.handoff_spacing_waived").length, 0);
    assert.deepEqual(readServeOnlyVerdict(undefined), {}, "an ask with no verdict is as before");

    // Each read the classifier makes fails closed: the closure at the old sha, and a merge's diff.
    const real = (args: string[]) => Promise.resolve(f.repo.git(...args));
    const failing = (verb: string, error: unknown): ClosureGit => (args) => (args[0] === verb ? Promise.reject(error) : real(args));
    const noTree = await classifyServeOnlyAdvance(async (args) => (args[0] === "ls-tree" && args[3] === f.daemonToo ? Promise.reject(new Error("bad object")) : real(args)), f.daemonToo, f.ledgerToo);
    assert.deepEqual(noTree, { status: "unreadable", reason: `closure at ${f.daemonToo}: bad object` });
    assert.deepEqual(await classifyServeOnlyAdvance(failing("diff-tree", "torn pack"), f.base, f.serveOnly), { status: "unreadable", reason: `diff of ${f.serveOnly}: torn pack` });
  } finally {
    f.repo.cleanup();
  }
});

test("W1-T14987: a daemon-touching merge landing after the ask does not ride the waiver", async () => {
  const f = fixture();
  try {
    // The ask names serveOnly; by the time prepare fetches, main holds daemonToo too.
    const s = supervisorAt({}, f.base, [f.daemonToo, f.daemonToo]);
    await s.supervisor.start();
    s.state.now += 20 * MIN;
    await s.askFor(serveOnlyAdvanceIn(f.repo.dir), f.serveOnly);
    assert.equal(s.supervisor.activeSha(), f.base, "the newer main is not handed over inside the spacing");
    assert.equal(s.rows("serve.handoff_spacing_waived").length, 0);
    assert.equal(s.rows("serve.handoff_done").length, 0);
    assert.equal(s.spaced().length, 1);
    assert.equal(s.spaced()[0]!.waiver, `prepared ${f.daemonToo}, not the waived target ${f.serveOnly}`);
    s.waits.find((w) => w.ms === s.spaced()[0]!.waitMs)!.wake();
    await settle();
    assert.equal(s.supervisor.activeSha(), f.daemonToo, "once the spacing has passed, the newer main hands off as before");
  } finally {
    f.repo.cleanup();
  }
});

test("W1-T14987: a stop node leaves the walk without serve's own code, and the closure without it is unchanged", async () => {
  const f = fixture();
  try {
    const git = (args: string[]) => Promise.resolve(f.repo.git(...args));
    const whole = await daemonProcessClosure(git, f.base, "src/run-task.ts");
    const daemon = await daemonProcessClosure(git, f.base, "src/run-task.ts", { stopAt: ["src/lib/serve.ts"] });
    const again = await daemonProcessClosure(git, f.base, "src/run-task.ts", { stopAt: [] });
    assert.equal(whole.status, "read");
    assert.equal(daemon.status, "read");
    const paths = (c: typeof whole) => [...(c as Extract<typeof c, { status: "read" }>).paths].sort();
    assert.deepEqual(paths(whole), ["package.json", "src/lib/daemon-loop.ts", "src/lib/ledger-steps.ts", "src/lib/report-commands.ts", "src/lib/serve-only.ts", "src/lib/serve.ts", "src/run-task.ts"]);
    assert.deepEqual(paths(daemon), ["package.json", "src/lib/daemon-loop.ts", "src/lib/ledger-steps.ts", "src/lib/report-commands.ts", "src/run-task.ts"]);
    assert.equal(again, whole, "an empty stopAt shares the plain memo entry");
  } finally {
    f.repo.cleanup();
  }
});

test("W1-T14987: the active generation sends its own verdict beside the target sha on its handoff ask", async () => {
  const f = fixture();
  try {
    const T0 = Date.parse("2026-11-26T14:00:00Z");
    const gate = (extra: Partial<Parameters<typeof gateStaleCodeExit>[0]>, targetSha: string | undefined) => {
      const asked: Array<Record<string, unknown>> = [];
      const assessment: GatewayCheckoutAssessment = {
        state: { head: f.base, behindBy: 1, dirty: false, checkedAt: "" }, restartDue: true, ...(targetSha === undefined ? {} : { targetSha }),
      };
      const g = gateStaleCodeExit({
        bootSha: f.base, resolveCurrentSha: () => f.base, resolveCommitsBehind: () => 0, exit: () => {},
        clock: clockFromMillisFn(() => T0 + 60 * MIN), bootedAt: T0, scheduleRecheck: () => () => {}, log: () => {},
        assessCheckout: async () => assessment, requestHandoff: (detail) => void asked.push(detail), ...extra,
      });
      /** The verdict reads git off the loop: wait (bounded) for the ask it sends. */
      const recheck = async (): Promise<void> => {
        await g.recheck();
        for (let i = 0; i < 500 && asked.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      };
      return { recheck, asked };
    };
    const real = gate({ serveOnlyAdvance: serveOnlyAdvanceIn(f.repo.dir) }, f.serveOnly);
    await real.recheck();
    assert.equal(real.asked.length, 1);
    assert.equal(real.asked[0]!.targetSha, f.serveOnly);
    assert.deepEqual(real.asked[0]!.serveOnly, {
      status: "serve_only", merge: f.serveOnly, paths: ["docs/notes.md", "src/lib/serve-only.ts"], fromSha: f.base, toSha: f.serveOnly,
    }, "classified by the generation, really reading git");
    assert.deepEqual(readServeOnlyVerdict(real.asked[0]!.serveOnly).serveOnly, real.asked[0]!.serveOnly, "the supervisor accepts its shape");

    const blind = gate({ serveOnlyAdvance: serveOnlyAdvanceIn(f.repo.dir) }, undefined);
    await blind.recheck();
    assert.deepEqual(blind.asked[0]!.serveOnly, { status: "unreadable", reason: "the ask names no target sha", fromSha: f.base });

    const bare = gate({}, f.serveOnly);
    await bare.recheck();
    assert.equal("serveOnly" in bare.asked[0]!, false, "without a reader the ask is as before");
  } finally {
    f.repo.cleanup();
  }
});

/**
 * THE CENSUS GUARD (Craig, 2026-11-26 14:54Z). Each daemon-inert path is pinned to the readers that justify it; a new
 * importer or a new call site makes this red, so the claim is re-read before it can widen.
 */
const INERT_CENSUS: Record<string, { importers: string[]; symbol: string; callers: Array<{ file: string; inside: string }> }> = {
  "src/lib/ledger-steps.ts": {
    importers: ["src/lib/report-commands.ts"],
    symbol: "meaningOfStep",
    callers: [{ file: "src/lib/report-commands.ts", inside: "ledgerGrepCommand" }],
  },
};

test("W1-T14987: every daemon-inert path of serve's own code is pinned by its census", () => {
  assert.deepEqual(SERVE_OWN_CODE_DAEMON_INERT_PATHS.map((row) => row.path).sort(), Object.keys(INERT_CENSUS).sort());
  for (const row of SERVE_OWN_CODE_DAEMON_INERT_PATHS) {
    const census = INERT_CENSUS[row.path]!;
    assert.match(row.reader, new RegExp(census.symbol), `${row.path} names its reader`);
    const stem = row.path.split("/").pop()!.replace(/\.ts$/, "");
    // A caller sweep, not a population walk: every importer names the stem, so `git grep -l` over
    // tracked src/scripts/bin is the complete candidate set the specifier test below narrows.
    const tracked = execFileSync("git", ["-C", REPO_ROOT, "grep", "-l", "-F", "-e", stem, "--", "src", "scripts", "bin"], { encoding: "utf8" }).split("\n").filter(Boolean);
    assert.ok(tracked.includes(census.importers[0]!), `positive control: the sweep for ${stem} sees ${census.importers[0]}`);
    const specifier = new RegExp(`(?:from|import)\\s*\\(?\\s*["'][^"']*/${stem}(?:\\.js|\\.ts)?["']`);
    const importers = tracked.filter((file) => file !== row.path && /\.(?:ts|mts|mjs|js)$/.test(file) && specifier.test(readFileSync(join(REPO_ROOT, file), "utf8")));
    assert.deepEqual(importers, census.importers, `the modules importing ${row.path}`);
    const calls: Array<{ file: string; inside: string }> = [];
    for (const file of importers) {
      let inside = "";
      for (const line of readFileSync(join(REPO_ROOT, file), "utf8").split("\n")) {
        inside = /^export (?:async )?function (\w+)/.exec(line)?.[1] ?? inside;
        if (new RegExp(`\\b${census.symbol}\\(`).test(line) && !/^\s*(?:\/\/|\*)/.test(line)) calls.push({ file, inside });
      }
    }
    assert.deepEqual(calls, census.callers, `${census.symbol}'s call sites`);
  }
});
