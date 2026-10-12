import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(REPO_ROOT, "hooks", "pre-push");
const ZERO = "0".repeat(40);
const SHA = "1".repeat(40);

/** The nine content gates the hook runs, each by its script name. */
const GATES = [
  "rule15-precheck.mjs",
  "rule25-precheck.mjs",
  "ci-control-plane-precheck.mjs",
  "test-tier-manifest.mjs",
  "census-precheck.mjs",
  "lint-plan-precheck.mjs",
  "head-identity-gate.mjs",
  "worker-branch-shape.mjs",
  "proof-resolve-precheck.mjs",
];

/** W1-T6120: the hook runs its checks from its OWN code root, so a fixture runs it as the tree's own hook. */
function ownHook(tree: string): string {
  mkdirSync(join(tree, "hooks"), { recursive: true });
  copyFileSync(HOOK, join(tree, "hooks", "pre-push"));
  return join(tree, "hooks", "pre-push");
}

/** A tree whose every gate script records its argv and exits 1 — a REFUSAL, so a gate that runs is visible twice. */
function fixture(): { dir: string; log: string } {
  const dir = gitRepo({ kind: "delete-push", seedCommit: false }).dir;
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "seed"],
    { cwd: dir },
  );
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
  writeFileSync(join(dir, "tsconfig.json"), "{}\n");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  for (const gate of GATES) {
    writeFileSync(
      join(dir, "scripts", gate),
      `import { appendFileSync } from "node:fs";
appendFileSync(process.env.GATE_LOG, process.argv.slice(1).map((a) => a.split("/").pop()).join(" ") + "\\n");
process.exit(1);
`,
    );
  }
  return { dir, log: join(dir, "gate.log") };
}

function push(dir: string, log: string, stdin: string): { status: number; stderr: string; ran: string[] } {
  const res = spawnSync("sh", [ownHook(dir)], {
    cwd: dir,
    encoding: "utf8",
    input: stdin,
    env: { PATH: process.env.PATH ?? "", HOME: dir, RMD_PREPUSH_GATES: "1", GATE_LOG: log },
  });
  assert.equal(res.error, undefined, `the hook itself failed to launch: ${String(res.error)}`);
  const ran = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  return { status: res.status ?? -1, stderr: res.stderr ?? "", ran };
}

const names = (ran: string[]): string[] => ran.map((l) => l.split(" ")[0] ?? "");

test("W1-T8000: a deletion-only push runs no content gate", () => {
  const { dir, log } = fixture();
  const { status, stderr, ran } = push(
    dir,
    log,
    `(delete) ${ZERO} refs/heads/run-W1-T7952-1791721932695 ${SHA}\n(delete) ${ZERO} refs/heads/run-W1-T7953-1 ${SHA}\n`,
  );

  assert.deepEqual(ran, [], "no gate may run for a push that carries no content");
  assert.equal(status, 0, `a deletion must not be refused: ${stderr}`);
  assert.match(stderr, /deletion-only push of refs\/heads\/run-W1-T7952-1791721932695 refs\/heads\/run-W1-T7953-1/);
  assert.match(stderr, /every check skipped/);
});

test("W1-T8000: a mixed push judges the pushed ref, not the deleted one", () => {
  const { dir, log } = fixture();
  const { status, ran } = push(
    dir,
    log,
    `(delete) ${ZERO} refs/heads/run-W1-T7952-1791721932695 ${SHA}\nrefs/heads/work ${"2".repeat(40)} refs/heads/run-W1-T9-1 ${ZERO}\n`,
  );

  for (const gate of GATES) assert.ok(names(ran).includes(gate), `${gate} must run for the content ref (ran: ${names(ran)})`);
  const judged = ran.filter((l) => /head-identity-gate|worker-branch-shape|proof-resolve-precheck/.test(l));
  assert.equal(judged.length, 3);
  for (const line of judged) {
    assert.doesNotMatch(line, /run-W1-T7952-1791721932695/, `a gate judged the deleted ref: ${line}`);
    assert.doesNotMatch(line, new RegExp(ZERO), `a gate was handed the zero sha: ${line}`);
    assert.match(line, /run-W1-T9-1|2{40}/);
  }
  assert.equal(status, 1, "the recording gates refuse, so the content push is still refused");
});

test("W1-T8000: an empty stdin still runs every gate", () => {
  const { dir, log } = fixture();
  const { status, ran } = push(dir, log, "");

  for (const gate of GATES) assert.ok(names(ran).includes(gate), `${gate} must still run (ran: ${names(ran)})`);
  assert.equal(status, 1, "the recording gates refuse, so the hook refuses as before");
});
