import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { daemonCommand } from "#test/helpers/run-task-daemon.js";
import type { DaemonSummary } from "#src/lib/daemon.js";
import {
  PLAN_DESTINATION_KINDS,
  planDestinationPath,
  planDestinationRepository,
  resolvePlanDestination,
  type PlanDestination,
  type PlanDestinationKind,
} from "#src/lib/plan-destination.js";
import { withGhShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T12200. The private repository in these fixtures has a name that appears nowhere else, so a search
// of a ledger or of a reason for that name is a real test.
const PRIVATE_OWNER = "zz-private-owner";
const PRIVATE_NAME = "zz-private-plan";
const PRIVATE = `${PRIVATE_OWNER}/${PRIVATE_NAME}`;
const PUBLIC = { owner: "public-owner", repo: "public-name", checkoutDir: join(REPO_ROOT, "fixture-public-checkout") };

function fixtureRoot(): { home: string; root: string; stateDir: string; planPath: string; resolve: (kind: PlanDestinationKind) => PlanDestination } {
  const home = mkdtempSync(join(tmpdir(), "rmd-plan-destination-"));
  const root = join(home, "Remudero");
  const stateDir = join(root, "state");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  return { home, root, stateDir, planPath, resolve: (kind) => resolvePlanDestination(kind, stateDir, { ...PUBLIC }) };
}

function writeSwitch(stateDir: string, value: unknown): void {
  writeFileSync(planDestinationPath(stateDir), typeof value === "string" ? value : JSON.stringify(value));
}

interface Row { step: string; [key: string]: unknown }

/** Boot the real daemon command against a fixture instance. The loop is the only stand-in. */
async function bootDaemon(f: { home: string; planPath: string; stateDir: string }): Promise<{ code: number; reachedLoop: boolean; rows: Row[]; ledger: string }> {
  const oldHome = process.env.HOME;
  const oldRunId = process.env.REMUDERO_RUN_ID;
  process.env.HOME = f.home;
  process.env.REMUDERO_RUN_ID = "DAEMON-fixture";
  let reachedLoop = false;
  let code: number;
  try {
    code = await daemonCommand(["--allow-self-target", "--plan", f.planPath, "--max", "0"], {
      runDaemon: async (): Promise<DaemonSummary> => {
        reachedLoop = true;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldRunId === undefined) delete process.env.REMUDERO_RUN_ID;
    else process.env.REMUDERO_RUN_ID = oldRunId;
  }
  const ledgerPath = join(f.stateDir, "ledger.ndjson");
  const ledger = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "";
  const rows = ledger.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Row);
  return { code, reachedLoop, rows, ledger };
}

const destinationRows = (rows: Row[]): Row[] => rows.filter((row) => row.step === "daemon.plan_destination");
const cloneCalls = (calls: string[]): string[] => calls.filter((call) => call.includes("repo clone"));

test("W1-T12200 criterion 1: with no host file the resolver returns the caller's public repository and checkout", () => {
  const f = fixtureRoot();
  try {
    for (const kind of PLAN_DESTINATION_KINDS) {
      assert.deepEqual(f.resolve(kind), { outcome: "off", ...PUBLIC });
    }
    assert.deepEqual(planDestinationRepository(f.stateDir), { outcome: "off" });
    // A host with no instance config has no state directory. That is also off, and nothing is created.
    assert.deepEqual(resolvePlanDestination("task", undefined, { ...PUBLIC }), { outcome: "off", ...PUBLIC });
    assert.deepEqual(planDestinationRepository(undefined), { outcome: "off" });
    assert.equal(existsSync(join(f.root, "repos")), false, "the resolver makes no directory");
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("W1-T12200 criterion 2: a host file that names a repository and lists the kind gives that repository and its checkout under repos/", () => {
  const f = fixtureRoot();
  try {
    writeSwitch(f.stateDir, { repository: PRIVATE, kinds: ["decision", "task"] });
    const expected = { outcome: "destination", owner: PRIVATE_OWNER, repo: PRIVATE_NAME, checkoutDir: join(f.root, "repos", PRIVATE_NAME) };
    assert.deepEqual(f.resolve("decision"), expected);
    assert.deepEqual(f.resolve("task"), expected);
    assert.deepEqual(planDestinationRepository(f.stateDir),
      { outcome: "named", owner: PRIVATE_OWNER, repo: PRIVATE_NAME, checkoutDir: join(f.root, "repos", PRIVATE_NAME), kinds: ["decision", "task"] });
    // A field this task does not know (a later task adds one) does not make the file unreadable.
    writeSwitch(f.stateDir, { repository: PRIVATE, kinds: ["feedback"], dispatch_ops_tasks: true });
    assert.equal(f.resolve("feedback").outcome, "destination");
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("W1-T12200 criterion 3: a kind the file does not list is public, and the file is read on each call", () => {
  const f = fixtureRoot();
  try {
    writeSwitch(f.stateDir, { repository: PRIVATE, kinds: ["decision"] });
    assert.deepEqual(f.resolve("feedback"), { outcome: "not_listed", ...PUBLIC });
    assert.equal(f.resolve("decision").outcome, "destination");
    // The operator removes the kind. The same process sees it on the next call.
    writeSwitch(f.stateDir, { repository: PRIVATE, kinds: [] });
    assert.deepEqual(f.resolve("decision"), { outcome: "not_listed", ...PUBLIC });
    // The readers of both roots still get the repository while the file names it.
    assert.equal(planDestinationRepository(f.stateDir).outcome, "named");
    // The operator adds it back, then removes the file.
    writeSwitch(f.stateDir, { repository: PRIVATE, kinds: ["decision"] });
    assert.equal(f.resolve("decision").outcome, "destination");
    rmSync(planDestinationPath(f.stateDir));
    assert.deepEqual(f.resolve("decision"), { outcome: "off", ...PUBLIC });
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("W1-T12200 criterion 4: a file that is malformed, unreadable, or holds an unknown kind or a bad repository is `unreadable` with a reason and no repository", () => {
  const f = fixtureRoot();
  try {
    const bad: Array<[string, unknown, RegExp]> = [
      ["cut-off JSON", `{"repository": "${PRIVATE}", "kinds": ["decision"`, /not valid JSON$/],
      ["a list", [PRIVATE], /not a \{repository, kinds\} record$/],
      ["null", "null", /not a \{repository, kinds\} record$/],
      ["an unknown kind", { repository: PRIVATE, kinds: ["decision", "amendment"] }, /kinds is not a list of decision, feedback, task$/],
      ["kinds that is not a list", { repository: PRIVATE, kinds: "decision" }, /kinds is not a list of/],
      ["no kinds", { repository: PRIVATE }, /kinds is not a list of/],
      ["no repository", { kinds: ["decision"] }, /repository is not <owner>\/<name>$/],
      ["a name with no owner", { repository: PRIVATE_NAME, kinds: ["decision"] }, /repository is not <owner>\/<name>$/],
      ["three parts", { repository: `${PRIVATE}/plan`, kinds: ["decision"] }, /repository is not <owner>\/<name>$/],
      ["a name that leaves repos/", { repository: `${PRIVATE_OWNER}/..`, kinds: ["decision"] }, /repository is not <owner>\/<name>$/],
      ["a URL", { repository: `https://github.com/${PRIVATE}`, kinds: ["decision"] }, /repository is not <owner>\/<name>$/],
    ];
    for (const [label, value, reason] of bad) {
      writeSwitch(f.stateDir, value);
      for (const kind of PLAN_DESTINATION_KINDS) {
        const got = f.resolve(kind);
        assert.equal(got.outcome, "unreadable", label);
        assert.deepEqual(Object.keys(got).sort(), ["outcome", "reason"], `${label}: no repository and no checkout`);
        assert.match(got.outcome === "unreadable" ? got.reason : "", reason, label);
        assert.ok(!JSON.stringify(got).includes(PRIVATE_NAME) && !JSON.stringify(got).includes(PRIVATE_OWNER),
          `${label}: the reason does not quote the file`);
      }
      assert.equal(planDestinationRepository(f.stateDir).outcome, "unreadable", label);
    }
    // A path that cannot be read as a file.
    rmSync(planDestinationPath(f.stateDir));
    mkdirSync(planDestinationPath(f.stateDir));
    const unreadable = f.resolve("decision");
    assert.equal(unreadable.outcome, "unreadable");
    assert.match(unreadable.outcome === "unreadable" ? unreadable.reason : "", /cannot read the file \(EISDIR\)$/);
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("W1-T12200 criterion 5: at boot the daemon command makes the missing clone and writes one row with the outcome and the kinds, without the repository name", async () => {
  const f = fixtureRoot();
  try {
    writeSwitch(f.stateDir, { repository: PRIVATE, kinds: ["feedback", "decision"] });
    const checkout = join(f.root, "repos", PRIVATE_NAME);
    await withGhShim([{ when: "repo clone", writes: { path: join(checkout, ".git", "HEAD"), content: "ref: refs/heads/main\n" } }], async (shim) => {
      const first = await bootDaemon(f);
      assert.equal(first.code, 0);
      assert.equal(first.reachedLoop, true);
      assert.deepEqual(cloneCalls(shim.calls()), [`repo clone ${PRIVATE} ${checkout}`], "one clone, of the repository the file names");
      assert.deepEqual(destinationRows(first.rows).map(({ outcome, kinds, checkout: state, reason }) => ({ outcome, kinds, state, reason })),
        [{ outcome: "named", kinds: ["decision", "feedback"], state: "cloned", reason: undefined }]);
      assert.ok(!first.ledger.includes(PRIVATE_NAME) && !first.ledger.includes(PRIVATE_OWNER), "no ledger row names the private repository");

      // The second boot finds the checkout. It makes no second clone.
      const second = await bootDaemon(f);
      assert.equal(second.code, 0);
      assert.equal(cloneCalls(shim.calls()).length, 1);
      assert.deepEqual(destinationRows(second.rows).map((row) => row.checkout), ["cloned", "present"]);
      assert.ok(!second.ledger.includes(PRIVATE_NAME) && !second.ledger.includes(PRIVATE_OWNER));
    });
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("W1-T12200 criterion 5: a clone that fails, and a file that is unreadable, each write a row and do not stop the boot", async () => {
  const f = fixtureRoot();
  try {
    writeSwitch(f.stateDir, { repository: PRIVATE, kinds: ["task"] });
    // The real failure text names the repository. The row must not.
    await withGhShim([{ when: "repo clone", stderr: `GraphQL: Could not resolve to a Repository with the name '${PRIVATE}'.`, exit: 1 }], async (shim) => {
      const failed = await bootDaemon(f);
      assert.equal(failed.code, 0, "the boot goes on");
      assert.equal(failed.reachedLoop, true, "the daemon reaches its loop");
      assert.equal(cloneCalls(shim.calls()).length, 1);
      assert.deepEqual(destinationRows(failed.rows).map(({ outcome, kinds, checkout, reason }) => ({ outcome, kinds, checkout, reason })),
        [{ outcome: "named", kinds: ["task"], checkout: "clone_failed", reason: "gh repo clone failed (exit 1)" }]);
      assert.ok(!failed.ledger.includes(PRIVATE_NAME) && !failed.ledger.includes(PRIVATE_OWNER), "no ledger row names the private repository");
      assert.equal(existsSync(join(f.root, "repos", PRIVATE_NAME)), false);

      writeSwitch(f.stateDir, `{"repository": "${PRIVATE}", "kinds": [`);
      const unreadable = await bootDaemon(f);
      assert.equal(unreadable.code, 0);
      assert.equal(unreadable.reachedLoop, true);
      assert.equal(cloneCalls(shim.calls()).length, 1, "an unreadable file makes no clone");
      const row = destinationRows(unreadable.rows).at(-1)!;
      assert.equal(row.outcome, "unreadable");
      assert.deepEqual(row.kinds, []);
      assert.match(String(row.reason), /plan-destination\.json: not valid JSON$/);
      assert.ok(!unreadable.ledger.includes(PRIVATE_NAME) && !unreadable.ledger.includes(PRIVATE_OWNER));
    });
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("W1-T12200 criterion 6: with no host file the daemon command makes no clone, makes no added call to GitHub and writes the same rows as today", async () => {
  const off = fixtureRoot();
  const on = fixtureRoot();
  try {
    await withGhShim([{ when: "repo clone", writes: { path: join(on.root, "repos", PRIVATE_NAME, ".git", "HEAD"), content: "ref: refs/heads/main\n" } }], async (shim) => {
      const without = await bootDaemon(off);
      const callsWithout = shim.calls();
      assert.equal(without.code, 0);
      assert.equal(without.reachedLoop, true);
      assert.deepEqual(cloneCalls(callsWithout), [], "no clone");
      assert.deepEqual(destinationRows(without.rows), [], "no row for a switch that is off");
      assert.equal(existsSync(join(off.root, "repos")), false, "no repos directory is made");
      assert.equal(existsSync(planDestinationPath(off.stateDir)), false, "the boot does not write the switch");

      // The same boot with the switch on differs by exactly the one row and the one clone.
      writeSwitch(on.stateDir, { repository: PRIVATE, kinds: ["decision"] });
      const withSwitch = await bootDaemon(on);
      const steps = (rows: Row[]): string[] => rows.map((row) => row.step);
      assert.deepEqual(steps(without.rows), steps(withSwitch.rows).filter((step) => step !== "daemon.plan_destination"),
        "the boot with no host file writes the rows of a boot today, in the same order");
      assert.equal(destinationRows(withSwitch.rows).length, 1);
      assert.deepEqual(shim.calls().slice(callsWithout.length).filter((call) => !callsWithout.includes(call)),
        [`repo clone ${PRIVATE} ${join(on.root, "repos", PRIVATE_NAME)}`], "the switch adds one call to GitHub; no switch adds none");
    });
  } finally {
    rmSync(off.home, { recursive: true, force: true });
    rmSync(on.home, { recursive: true, force: true });
  }
});
