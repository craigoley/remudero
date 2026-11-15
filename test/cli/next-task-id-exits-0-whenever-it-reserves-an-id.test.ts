/**
 * W1-T12453: `rmd next-task-id` exits 0 whenever it reserves an id.
 *
 * Before this task the reserve path ended with `return mint.degraded.length ? 1 : 0`, so a held id
 * from a checkout whose plan lags origin exited 1. A caller that reads the exit code (the gate
 * gardener's fallback minter runs the verb through execFileSync) then lost the held id.
 *
 * The degraded source here is real: the checkout's plan is behind origin/main, so the mint adds a
 * `local-plan` note. The command runs in process with an injected reserver.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import { gateGardenSpec, loadGateProbes } from "#src/lib/gate-gardener.js";
import type { GardenCheckout } from "#src/lib/gardener.js";
import type { RemoteRefReserver, RemoteReserveOutcome } from "#src/lib/task-id-reservation.js";
import { nextTaskIdCommand } from "#src/run-task.js";
import { gitRepo, originWithClone } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const BRANCH = "run-unfiled-1791072000000";

// The checkout's plan says W1-T5 while origin/main already says W1-T9.
const { origin: ORIGIN, clone: BEHIND } = originWithClone(join(gitRepo({ kind: "t12453-behind", seedCommit: false }).dir, "clone"), {
  seed: { "plan/tasks.yaml": "- id: W1-T5\n  title: seed\n" },
});
const AHEAD = gitRepo({ cloneFrom: ORIGIN.dir, kind: "t12453-ahead" });
writeFileSync(join(AHEAD.dir, "plan", "tasks.yaml"), "- id: W1-T9\n  title: newer\n");
AHEAD.git("add", "plan/tasks.yaml");
AHEAD.git("commit", "--quiet", "-m", "advance plan");
AHEAD.git("push", "--quiet", "origin", "main");
BEHIND.git("fetch", "--quiet", "origin", "main");
const CHECKOUT = BEHIND.dir;
/** No plan-destination switch here, so the mint never reads this host's own catalog. */
const STATE_DIR = gitRepo({ kind: "t12453-state", seedCommit: false }).dir;
/** The print-only path's namespace advisory reads origin; this fixture answers "unreadable". */
const NO_NAMESPACE = () => ({ status: 1, stdout: "", stderr: "fixture: no origin namespace" });

function stubReserver(refuse: (attempt: number) => boolean = () => false): RemoteRefReserver & { tried: string[] } {
  const tried: string[] = [];
  return {
    tried,
    mintAnchor: () => "ANCHOR-SHA",
    attempt(taskId: string): RemoteReserveOutcome {
      tried.push(taskId);
      return refuse(tried.length) ? "unreachable" : "created";
    },
  };
}

interface Run { code: number; out: string; err: string; tried: string[] }

async function run(rest: string[], opts: { reserver?: RemoteRefReserver & { tried: string[] }; openPrTexts?: () => string[] } = {}): Promise<Run> {
  const reserver = opts.reserver ?? stubReserver();
  const out: string[] = [];
  const err: string[] = [];
  const ol = console.log;
  const oe = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  let code: number;
  try {
    code = await nextTaskIdCommand(rest, {}, {
      repoRoot: CHECKOUT, destinationStateDir: () => STATE_DIR, runGit: NO_NAMESPACE, reserver, holderOf: () => "unknown",
      openPrTexts: opts.openPrTexts ?? (() => []),
    });
  } finally {
    console.log = ol;
    console.error = oe;
  }
  return { code, out: out.join("\n"), err: err.join("\n"), tried: reserver.tried };
}

test("W1-T12453 criterion 1: a reservation from a lagging checkout prints RESERVED and exits 0", async () => {
  const r = await run(["--reserve", "--branch", BRANCH]);
  assert.match(r.out, /^RESERVED W1-T10 on origin \(refs\/rmd-id\/W1-T10\) after 1 attempt\(s\)$/m, r.out + r.err);
  assert.match(r.err, /DEGRADED local-plan/, "control: the mint really is degraded");
  assert.equal(r.code, 0, r.err);
});

test("W1-T12453 criterion 2: each degraded note goes to stderr and stdout holds no DEGRADED text", async () => {
  const r = await run(["--reserve", "--branch", BRANCH]);
  const notes = r.err.split("\n").filter((line) => line.startsWith("### rmd next-task-id: DEGRADED "));
  assert.equal(notes.length, 1, r.err);
  assert.match(notes[0]!, /^### rmd next-task-id: DEGRADED local-plan: this checkout's plan half is 4 id\(s\) behind origin's/);
  assert.match(r.out, /^RESERVED W1-T10 on origin/m);
  assert.match(r.out, /^W1-T10 \(max 9 across /m, "the mint line still prints on stdout");
  assert.doesNotMatch(r.out, /DEGRADED/);
});

test("W1-T12453 criterion 3: a reservation that holds no id still exits 2", async () => {
  const outage = await run(["--reserve", "--branch", BRANCH], { openPrTexts: () => { throw new Error("API rate limit exceeded"); } });
  assert.equal(outage.code, 2, "an unreadable open-PR surface refuses");
  assert.equal(outage.tried.length, 0);
  assert.doesNotMatch(outage.out, /^RESERVED /m);

  const refused = await run(["--reserve", "--branch", BRANCH], { reserver: stubReserver(() => true) });
  assert.equal(refused.code, 2, "a refused push exits 2");
  assert.match(refused.err, /REFUSED — origin is unreachable/);
  assert.doesNotMatch(refused.out, /^RESERVED /m);

  const partial = await run(["--reserve", "--branch", BRANCH, "--count", "3"], { reserver: stubReserver((n) => n === 3) });
  assert.equal(partial.code, 2, "a partial --count exits 2");
  assert.equal([...partial.out.matchAll(/^RESERVED /gm)].length, 2, partial.out);
  assert.match(partial.err, /PARTIAL — holds 2 of 3/);
});

test("W1-T12453 criterion 4: a print-only mint with a degraded source keeps exit 1 and its stdout note", async () => {
  for (const flag of ["--no-reserve", "--offline"]) {
    const r = await run([flag]);
    assert.equal(r.tried.length, 0, `${flag} claims nothing`);
    assert.equal(r.code, 1, `${flag}: ${r.out} ${r.err}`);
    assert.match(r.out, /^W1-T10 .* — DEGRADED: local-plan \(/m, `${flag} keeps the note in its mint line`);
  }
});

test("W1-T12453 criterion 5: the gate gardener's fallback minter gets the held id from a degraded reservation", async () => {
  const reserved = await run(["--reserve", "--branch", BRANCH]);
  const repo = gitRepo({ kind: "t12453-garden" });
  const put = (path: string, text: string) => {
    mkdirSync(join(repo.dir, path, ".."), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  };
  const now = Date.parse("2026-10-04T00:00:00Z");
  const stamp = new Date(now - 16 * 86_400_000).toISOString();
  put("test/fixture.test.ts", `const row = {\n  lastActivityAt: "${stamp}",\n};\n`);
  put("scripts/source-size-baseline.json", "{}\n");
  put("scripts/comment-load-baseline.json", "{}\n");
  put("scripts/learnings-budget-baseline.json", '{"measuredChars":0,"measuredActiveEntries":0}\n');
  put(".github/workflows/ci-gate.yml", 'jobs:\n  ci-gate:\n    env:\n      REQUIRED: >-\n        [\n        "ci"\n        ]\n      ADVISORY: >-\n        [\n        "dashboard"\n        ]\n');
  put("plan/tasks.yaml", "[]\n");
  put("test/expiring-fixture-census.test.ts", "export {};\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "seed census fixture");
  mkdirSync(join(repo.dir, "state"));
  for (const c of ["tighten", "refresh", "demote"]) put(`state/GATE_OFF-${c}`, "");
  const workspace: GardenCheckout = { root: repo.dir, branch: BRANCH, land: () => "https://github.com/acme/remudero/pull/1", dispose: () => {} };
  const deps = { repoRoot: repo.dir, stateDir: join(repo.dir, "state"), clock: fixedClock(now), seed: 1, log: () => {}, openWorkspace: () => workspace };
  let reservations = 0;
  const spec = gateGardenSpec(deps, await loadGateProbes(REPO_ROOT), {
    thresholdDays: 30,
    openOrigins: () => [],
    runSuite: (_file: string, shiftDays: number) => shiftDays < 1,
    admissionViolations: () => [],
    // The real execFileSync, replaying the in-process run's stdout, stderr and exit code.
    execFile: (command, args, options) => {
      if (command !== process.execPath || !args.includes("next-task-id")) return execFileSync(command, args, options);
      reservations++;
      const replay = `process.stdout.write(${JSON.stringify(reserved.out + "\n")}); process.stderr.write(${JSON.stringify(reserved.err + "\n")}); process.exitCode = ${reserved.code};`;
      return execFileSync(process.execPath, ["-e", replay], { ...options, stdio: "pipe" });
    },
  });
  const action = spec.inventory().candidates.find((a) => a.class === "defuse");
  assert.ok(action, "control: the fixture yields one defuse filing");
  const result = spec.apply(workspace, { acting: ["defuse"], actions: [action] }, {});
  assert.equal(reservations, 1);
  assert.deepEqual(result?.paths, ["plan/tasks.d/W1-T10-defuse-fixture.yaml"]);
});
