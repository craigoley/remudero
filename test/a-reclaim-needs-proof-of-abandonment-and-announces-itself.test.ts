import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { fixedClock } from "../src/lib/clock.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
// Namespace imports: this file must LOAD on a base without W1-T6026's symbols, so each proof fails
// there on its own assertion rather than on a missing export.
import * as reservation from "../src/lib/task-id-reservation.js";
import * as runTask from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

// W1-T6026, MEASURED 2026-10-06: W1-T5997 was taken over 15 s after a codex session reserved it, from
// a checkout 687 commits behind origin/main, and the takeover printed only a hand-off line that the
// operator's `| grep RESERVED` dropped. Three pins: a fresh branch=unknown holder is held, a takeover
// is named on the RESERVED line and in one ledger row, and stale reservation code advances instead.

type GitResult = { status: number; stdout: string; stderr: string };
type Currency = ReturnType<NonNullable<reservation.RemoteReserveDeps["policyCurrency"]>>;

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const clock = fixedClock(NOW);
const FILER = "run-W1-T6026-1791308824119";
const STALE_HOLDER = "file-followups2-1791000000000";
const GRACE_MS = 2 * 60 * 60 * 1000;
const CURRENT = (): Currency => ({ status: "current" });

function startedAgo(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

function holderLine(branch: string, ageMs: number | null): string {
  return reservation.formatReservationHolderLine({
    branch,
    pid: 4242,
    host: "codex-host",
    startedAt: ageMs === null ? undefined : startedAgo(ageMs),
    source: "automatic",
  });
}

/** A scripted origin where every id is held by `line`'s holder except those in `free`, and every
 *  named holder branch is absent. Records each takeover push. */
function originHolding(line: string, free: ReadonlySet<string> = new Set()): { run: (args: string[]) => GitResult; pushes: string[] } {
  const pushes: string[] = [];
  const ok = (stdout = ""): GitResult => ({ status: 0, stdout, stderr: "" });
  const run = (args: string[]): GitResult => {
    if (args[0] === "remote") return ok("/tmp/local-origin.git\n");
    if (args[0] === "hash-object") return ok("TREE\n");
    if (args[0] === "commit-tree") return ok("RECLAIMED\n");
    if (args[0] === "fetch") return ok();
    if (args[0] === "log") return ok(`rmd-id reservation 4242@codex-host\n\n${line}\n`);
    if (args[0] === "ls-remote") return args.includes("--heads") ? { status: 2, stdout: "", stderr: "" } : ok();
    if (args[0] === "push") {
      const refspec = args[2] ?? "";
      const id = refspec.slice(refspec.lastIndexOf("/") + 1);
      if (refspec.startsWith("ANCHOR:") && !free.has(id)) return { status: 1, stdout: "", stderr: " ! [rejected] (already exists)" };
      pushes.push(refspec);
      return ok();
    }
    return ok();
  };
  return { run, pushes };
}

function reserverOver(
  run: (args: string[]) => GitResult,
  said: string[],
  policyCurrency: () => Currency = CURRENT,
): reservation.RemoteRefReserver {
  return reservation.gitRemoteRefReserver({ run, filingBranch: FILER, clock, anchor: () => "ANCHOR", say: (l) => void said.push(l), policyCurrency });
}

// ── (1) a fresh branch=unknown holder is held ─────────────────────────────────────────────────────

test("W1-T6026: a branch=unknown holder inside the push grace is held, and past it stays unattributable", () => {
  const fresh = reservation.parseReservationHolderLine(holderLine("unknown", 5_000));
  assert.equal(reservation.reservationHolderDrift(fresh, "unreadable", clock), "held");
  const stale = reservation.parseReservationHolderLine(holderLine("unknown", GRACE_MS + 1_000));
  assert.equal(reservation.reservationHolderDrift(stale, "unreadable", clock), "unattributable");
  const noBranchKey = reservation.parseReservationHolderLine(`rmd-id holder pid=x started_at=${startedAgo(5_000)}`);
  assert.equal(reservation.reservationHolderDrift(noBranchKey, "unreadable", clock), "held", "a line with no branch key is the same missing-branch holder");
});

test("W1-T6026: the main-branch and no-started_at readings are unchanged, and so is the parsed shape", () => {
  const undated = reservation.parseReservationHolderLine(holderLine("unknown", null));
  assert.equal(reservation.reservationHolderDrift(undated, "unreadable", clock), "unattributable");
  const freshMain = reservation.parseReservationHolderLine(holderLine("main", 5_000));
  assert.equal(reservation.reservationHolderDrift(freshMain, "present", clock), "unattributable");
  // W1-T3640 deep-equals this arm's shape; the recorded age rides along without changing it.
  assert.deepEqual(reservation.parseReservationHolderLine(holderLine("unknown", 5_000)), { status: "unreadable", reason: "missing branch" });
});

test("W1-T6026: reclaim of a branch=unknown holder reserved 5 s ago returns taken and pushes nothing", () => {
  const origin = originHolding(holderLine("unknown", 5_000));
  const said: string[] = [];
  assert.equal(reserverOver(origin.run, said).reclaim?.("W1-T5997"), "taken");
  assert.deepEqual(origin.pushes, [], "a filer mid-flight must not lose its id to a source=reclaimed child");
  assert.deepEqual(said, []);
});

// ── (2) a takeover announces itself ──────────────────────────────────────────────────────────────

const mintRepo = gitRepo({ kind: "w6026-mint-plan" });
mkdirSync(join(mintRepo.dir, "plan"), { recursive: true });
writeFileSync(join(mintRepo.dir, "plan", "tasks.yaml"), "- id: W1-T5996\n  title: seed\n");
mintRepo.git("add", "plan/tasks.yaml");
mintRepo.git("commit", "--quiet", "-m", "fixture plan");

/** Runs `next-task-id --branch FILER` under a scratch HOME whose config is `config`. */
async function nextTaskId(
  deps: runTask.NextTaskIdReserveDeps,
  config: "valid" | "unparseable" = "valid",
): Promise<{ code: number; out: string[]; err: string[]; ledger: Record<string, unknown>[] }> {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w6026-home-`));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(
    join(home, ".config", "remudero", "config.json"),
    config === "valid" ? JSON.stringify({ claudeBin: "/usr/bin/true", root }) : "{ not json",
  );
  const out: string[] = [];
  const err: string[] = [];
  const saved = { home: process.env.HOME, log: console.log, error: console.error };
  process.env.HOME = home;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    const code = await runTask.nextTaskIdCommand(["--branch", FILER], {}, { repoRoot: mintRepo.dir, holderOf: () => "unknown", openPrTexts: () => [], ...deps });
    let raw = "";
    try {
      raw = readFileSync(join(root, "state", "ledger.ndjson"), "utf8");
    } catch {
      raw = ""; // no config ⇒ no ledger was ever written
    }
    const ledger = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    return { code, out, err, ledger };
  } finally {
    console.log = saved.log;
    console.error = saved.error;
    if (saved.home === undefined) delete process.env.HOME;
    else process.env.HOME = saved.home;
  }
}

test("W1-T6026: a takeover is named ON the RESERVED line and in one next_task_id.reclaimed ledger row", async () => {
  const origin = originHolding(holderLine(STALE_HOLDER, 3 * 60 * 60 * 1000));
  const said: string[] = [];
  const r = await nextTaskId({ reserver: reserverOver(origin.run, said) });
  assert.equal(r.code, 0, r.err.join("\n"));
  const grepped = r.out.filter((l) => l.includes("RESERVED"));
  assert.equal(grepped.length, 1, r.out.join("\n"));
  assert.ok(grepped[0]!.includes("TAKEN OVER from"), `\`| grep RESERVED\` must show the takeover: ${grepped[0]}`);
  assert.ok(
    grepped[0]!.endsWith(`TAKEN OVER from ${STALE_HOLDER} (4242@codex-host, reserved ${startedAgo(3 * 60 * 60 * 1000)}, 3h old)`),
    grepped[0],
  );
  const rows = r.ledger.filter((row) => row.step === "next_task_id.reclaimed");
  assert.equal(rows.length, 1, JSON.stringify(r.ledger));
  assert.equal(rows[0]!.task_id, "W1-T5997");
  assert.equal(rows[0]!.taken_over_from, STALE_HOLDER);
  assert.equal(rows[0]!.holder_host, "codex-host");
  assert.equal(rows[0]!.age_ms, 3 * 60 * 60 * 1000);
});

test("W1-T6026: a reservation that took nothing over adds no suffix and no reclaimed row", async () => {
  const origin = originHolding(holderLine(STALE_HOLDER, 3 * 60 * 60 * 1000), new Set(["W1-T5997"]));
  const r = await nextTaskId({ reserver: reserverOver(origin.run, []) });
  assert.equal(r.code, 0, r.err.join("\n"));
  const grepped = r.out.filter((l) => l.includes("RESERVED"));
  assert.deepEqual(grepped, ["RESERVED W1-T5997 on origin (refs/rmd-id/W1-T5997) after 1 attempt(s)"]);
  assert.equal(r.ledger.filter((row) => row.step === "next_task_id.reclaimed").length, 0);
});

test("W1-T6026: an undated, unknown-host takeover still names itself, and an unreadable config costs only the row", async () => {
  const origin = originHolding("rmd-id holder branch=main");
  const r = await nextTaskId({ reserver: reserverOver(origin.run, []) }, "unparseable");
  assert.equal(r.code, 0, r.err.join("\n"));
  const grepped = r.out.filter((l) => l.includes("RESERVED"));
  assert.ok(grepped[0]!.endsWith("TAKEN OVER from main (?@?, reserved ?, age unknown)"), grepped[0]);
  assert.deepEqual(r.ledger, []);
});

test("W1-T6026: a takeover's age reads in seconds, minutes, or hours", () => {
  const describe = (ageMs: number): string =>
    reservation.describeReservationTakeover({ from: "b", pid: 1, host: "h", startedAt: "t", ageMs });
  assert.equal(describe(15_000), "TAKEN OVER from b (1@h, reserved t, 15s old)");
  assert.equal(describe(45 * 60_000), "TAKEN OVER from b (1@h, reserved t, 45m old)");
  assert.equal(describe(26 * 3_600_000), "TAKEN OVER from b (1@h, reserved t, 26h old)");
});

// ── (3) stale reservation code advances instead of taking over ───────────────────────────────────

test("W1-T6026: reclaim from a module whose blob differs from origin/main returns taken and pushes nothing", () => {
  for (const currency of [
    { status: "differs", loaded: "aaaa", main: "bbbb" },
    { status: "unprovable", reason: "origin/main:src/lib/task-id-reservation.ts is unreadable" },
  ] as Currency[]) {
    const origin = originHolding(holderLine(STALE_HOLDER, 3 * 60 * 60 * 1000));
    const said: string[] = [];
    assert.equal(reserverOver(origin.run, said, () => currency).reclaim?.("W1-T5997"), "taken", currency.status);
    assert.deepEqual(origin.pushes, [], `${currency.status}: no takeover child may be pushed`);
    assert.equal(said.length, 1, currency.status);
    assert.match(said[0]!, /not taking over W1-T5997/);
    assert.match(said[0]!, currency.status === "differs" ? /aaaa.*bbbb/ : /cannot be proven current/);
  }
  const origin = originHolding(holderLine(STALE_HOLDER, 3 * 60 * 60 * 1000));
  assert.equal(reserverOver(origin.run, [], CURRENT).reclaim?.("W1-T5997"), "created", "positive control: current code still repairs");
  assert.deepEqual(origin.pushes, ["RECLAIMED:refs/rmd-id/W1-T5997"]);
});

test("W1-T6026: next-task-id from stale reservation code advances past the abandoned id", async () => {
  const origin = originHolding(holderLine(STALE_HOLDER, 3 * 60 * 60 * 1000), new Set(["W1-T5998"]));
  const differs = (): Currency => ({ status: "differs", loaded: "aaaa", main: "bbbb" });
  const run = (args: string[]): GitResult => {
    if (args[0] === "commit-tree" && !args.includes("-p")) return { status: 0, stdout: "ANCHOR\n", stderr: "" };
    return origin.run(args);
  };
  const r = await nextTaskId({ runGit: run, policyCurrency: differs } as runTask.NextTaskIdReserveDeps);
  assert.equal(r.code, 0, r.err.join("\n"));
  assert.deepEqual(r.out.filter((l) => l.includes("RESERVED")), ["RESERVED W1-T5998 on origin (refs/rmd-id/W1-T5998) after 2 attempt(s)"]);
  assert.deepEqual(origin.pushes, ["ANCHOR:refs/rmd-id/W1-T5998"], "the stale-coded filer took the next id, not the held one");
});

// ── the seam's default, really run ───────────────────────────────────────────────────────────────

const POLICY_PATH = "src/lib/task-id-reservation.ts";

test("W1-T6026: the policy-currency default compares the loaded file's blob with origin/main's, with real git", () => {
  const origin = gitRepo({ bare: true, kind: "w6026-policy-origin" });
  const work = gitRepo({ kind: "w6026-policy-work" });
  work.addRemote("origin", origin.dir);
  const file = join(work.dir, POLICY_PATH);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "export const policy = 1;\n");
  work.git("add", POLICY_PATH);
  work.git("commit", "--quiet", "-m", "policy");
  work.git("push", "--quiet", "origin", "main");
  work.git("fetch", "--quiet", "origin");

  assert.deepEqual(reservation.reservationPolicyCurrency(file), { status: "current" });
  writeFileSync(file, "export const policy = 2;\n");
  const loaded = work.git("hash-object", POLICY_PATH);
  const main = work.git("rev-parse", `origin/main:${POLICY_PATH}`);
  assert.deepEqual(reservation.reservationPolicyCurrency(file), { status: "differs", loaded, main });

  const lone = gitRepo({ kind: "w6026-policy-lone" });
  const loneFile = join(lone.dir, POLICY_PATH);
  mkdirSync(dirname(loneFile), { recursive: true });
  writeFileSync(loneFile, "export const policy = 1;\n");
  const unread = reservation.reservationPolicyCurrency(loneFile);
  assert.equal(unread.status, "unprovable");
  assert.match((unread as { reason: string }).reason, /origin\/main:src\/lib\/task-id-reservation\.ts/);

  const missing = reservation.reservationPolicyCurrency(join(lone.dir, "no-such-dir", "task-id-reservation.ts"));
  assert.equal(missing.status, "unprovable");
  assert.match((missing as { reason: string }).reason, /hash-object/);
});

test("W1-T6026: with no path the default reads the module that is actually loaded", () => {
  const modulePath = fileURLToPath(new URL("../src/lib/task-id-reservation.ts", import.meta.url));
  const git = (args: string[]) => spawnSync("git", ["-C", dirname(modulePath), ...args], { encoding: "utf8" });
  const loaded = git(["hash-object", modulePath]).stdout.trim();
  const main = git(["rev-parse", "--verify", "--quiet", `origin/main:${POLICY_PATH}`]);
  const got = reservation.reservationPolicyCurrency();
  if (main.status !== 0) assert.equal(got.status, "unprovable");
  else if (main.stdout.trim() === loaded) assert.deepEqual(got, { status: "current" });
  else assert.deepEqual(got, { status: "differs", loaded, main: main.stdout.trim() });
});
