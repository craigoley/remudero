import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Config } from "../src/lib/config.js";
import type { Plan } from "../src/lib/plan.js";
import { readLedgerLines } from "../src/lib/status.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { buildSweepHook, DECLARED_BRANCH_GUARDS, reapBranchesCommand, runAutomaticBranchReapRung } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";

const SLUG = "w1t1060-instrument-declare";
const parsed = (): Plan => ({ tasks: [{ id: "W1-T1060" }], byId: new Map() }) as never;

function corpus(cmd: string, args: string[]): string {
  if (args[0] === "ls-remote") return ["a1\trefs/heads/main", `b2\trefs/heads/${SLUG}`].join("\n");
  if (args.includes("--merged=origin/main")) return "origin/main";
  if (args[0] === "for-each-ref") return `origin/main\ta1\t1\norigin/${SLUG}\tb2\t1`;
  if (cmd === "gh") return "";
  if (args[0] === "merge-base") throw new Error("not an ancestor");
  if (args[0] === "grep" && args.includes("-o")) return DECLARED_BRANCH_GUARDS.map((n) => `src/run-task.ts:1:${n}`).join("\n");
  if (args[0] === "grep") throw new Error("exit 1: no match");
  return "";
}

function scratch(t: TestContext): string {
  const root = makeTempDir("branch-reap-plan");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "ledger.ndjson"), "");
  return root;
}

const reapReasons = (ledger: string): Record<string, string> | undefined =>
  readLedgerLines(ledger).filter((r) => r.step === "branch_reap.dry_run").at(-1)?.reasons as Record<string, string> | undefined;

test("W1-T6590: a branch reap reuses the parsed plan", (t) => {
  const root = scratch(t);
  let reads = 0;
  const pass = (plan?: () => Plan) => {
    const ledgerPath = join(root, `ledger-${plan ? "tick" : "disk"}.ndjson`);
    writeFileSync(ledgerPath, "");
    const code = reapBranchesCommand([], {
      exec: corpus, root, quiet: true, ledgerPath, ...(plan ? { plan } : {}),
      loadPlan: () => { reads++; return parsed(); },
      readMergeCreditedTaskIds: () => ({ credited: new Set<string>(), filesRead: 1, complete: true, budgetExhausted: false }),
    });
    return { code, reasons: reapReasons(ledgerPath) };
  };
  const fromDisk = pass();
  assert.equal(reads, 1, "positive control: the seam counts a synchronous plan read");
  const fromTick = pass(parsed);
  assert.equal(reads, 1, "a pass with this tick's parsed plan does no synchronous plan read");
  assert.equal(fromTick.reasons?.[SLUG], "named_task_open");
  assert.deepEqual(fromTick, fromDisk, "reap decisions are unchanged");
});

test("W1-T6590: the automatic reap rung hands its plan to the classifier", async (t) => {
  const root = scratch(t);
  const ledger = join(root, "ledger.ndjson");
  const run = (plan?: () => Plan) =>
    runAutomaticBranchReapRung("acme", "demo", { root } as Config, ledger, "REAP", () => {}, {}, { root, exec: corpus, prune: false, ...(plan ? { plan } : {}) });
  await run();
  assert.equal(reapReasons(ledger)?.[SLUG], "no_pr_ever", "control: the checkout holds no plan file to read");
  await run(parsed);
  assert.equal(reapReasons(ledger)?.[SLUG], "named_task_open");
});

test("W1-T6590: the daemon sweep hands its tick plan to the branch reap", async (t) => {
  const root = scratch(t);
  const gh = ghShim([{ when: "--jq", stdout: "" }, { when: "", stdout: "[]" }], { kind: "branch-reap-plan-gh" });
  const git = ghShim([
    { when: "ls-remote", stdout: `a1\trefs/heads/main\nb2\trefs/heads/${SLUG}` },
    { when: "--merged=origin/main", stdout: "origin/main" },
    { when: "for-each-ref", stdout: `origin/main\ta1\t1\norigin/${SLUG}\tb2\t1` },
    { when: "remote", stdout: "https://github.com/acme/demo.git" },
    { when: "grep", exit: 1 },
  ], { kind: "branch-reap-plan-git", command: "git" });
  const priorPath = process.env.PATH;
  process.env.PATH = `${git.dir}:${gh.dir}:${priorPath ?? ""}`;
  t.after(() => {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    rmSync(gh.dir, { recursive: true, force: true });
    rmSync(git.dir, { recursive: true, force: true });
  });
  const ledger = join(root, "ledger.ndjson");
  const hook = buildSweepHook("acme", "demo", { root, claudeBin: "/bin/true" } as Config, ledger, "DAEMON-TEST", parsed(), () => {},
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, root);
  await hook();
  assert.ok(reapReasons(ledger)?.[SLUG]?.startsWith("named_task_"), JSON.stringify(reapReasons(ledger)));
});
