/**
 * W1-T11625 — a plan PR that AMENDS an existing task shard carries a runnable, base-discriminating proof, or
 * opens no PR. `filingAcceptanceCriteria` pairs a shard only with the ids it is given, so a clarify of an
 * existing task fell through to prose that acceptance-author-gate refuses.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { buildPlanPrBody, planPrAcceptanceCriteria } from "#src/lib/plan-pr-emitter.js";
import { parseAcceptanceBlock, parseWhitelistedProof } from "#src/lib/review.js";

const scratch: string[] = [];
after(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });

const AMENDED = "plan/tasks.d/W1-T9649-existing-task.yaml";
const NEWSHARD = "plan/tasks.d/W1-T9700-brand-new-task.yaml";
const BASE_SHARD = "- id: W1-T9649\n  title: an existing task\n  status: queued\n  note: |\n    original note text\n";

/** A repo whose `origin/main` holds the amended shard, and whose HEAD amends it (and optionally files another). */
function fixture(opts: { amend: (shard: string) => string; extra?: boolean }): { dir: string; files: string[]; diff: string } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t11625-`));
  scratch.push(dir);
  git(dir, "init", "-q", "-b", "main");
  mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(dir, AMENDED), BASE_SHARD);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(dir, "checkout", "-q", "-b", "work");
  writeFileSync(join(dir, AMENDED), opts.amend(BASE_SHARD));
  if (opts.extra) writeFileSync(join(dir, NEWSHARD), "- id: W1-T9700\n  title: brand new\n  status: queued\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "work");
  const files = git(dir, "diff", "--name-only", "origin/main", "HEAD").split("\n").filter(Boolean);
  const diff = git(dir, "diff", "--no-color", "--no-ext-diff", "-U0", "origin/main...HEAD");
  return { dir, files, diff };
}

function monolithFixture(): { dir: string; files: string[]; diff: string } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t11625-monolith-`));
  scratch.push(dir);
  git(dir, "init", "-q", "-b", "main");
  mkdirSync(join(dir, "plan"), { recursive: true });
  const base = "- id: W1-T9649\n  title: an existing task\n  status: queued\n";
  writeFileSync(join(dir, "plan/tasks.yaml"), base);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(dir, "checkout", "-q", "-b", "work");
  writeFileSync(join(dir, "plan/tasks.yaml"), `${base}  clarification: the operator ruled this applies to every lane\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "work");
  const files = git(dir, "diff", "--name-only", "origin/main", "HEAD").split("\n").filter(Boolean);
  const diff = git(dir, "diff", "--no-color", "--no-ext-diff", "-U0", "origin/main...HEAD");
  return { dir, files, diff };
}

const clarify = (s: string): string => `${s}  clarification: the operator ruled this applies to every lane\n`;

test("an amended-shard plan PR with no used reserved id emits a stored parser-valid and base-discriminating proof", () => {
  const { dir, files, diff } = fixture({ amend: clarify });
  const criteria = planPrAcceptanceCriteria(["W1-T9801"], files, diff, dir);
  assert.equal(criteria.length, 1);
  assert.match(criteria[0].proof, /^grep: .*clarification.* in plan\/tasks\.d\/W1-T9649-existing-task\.yaml$/);
  assert.notEqual(criteria[0].proof, `grep: id: W1-T9649 in ${AMENDED}`, "the id line passes at base, so it must not be the proof");
  assert.match(criteria[0].claim, /W1-T9649 is amended \(not implemented\)/);
  // The REAL author-time check-proof, run at the fixture's own merge base: a stale proof throws here (exit 5).
  const body = buildPlanPrBody({ intro: "plan run", criteria, changedFiles: files, proofCwd: dir });
  const stored = parseAcceptanceBlock(body);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].proof, criteria[0].proof);
  assert.notEqual(parseWhitelistedProof(stored[0].proof), null);
});

test("the amended proof is refused by the base check when it passes at the merge base", () => {
  const { dir, files } = fixture({ amend: clarify });
  const staleCriteria = [{ claim: "stale", proof: `grep: id: W1-T9649 in ${AMENDED}` }];
  assert.throws(() => buildPlanPrBody({ intro: "plan run", criteria: staleCriteria, changedFiles: files, proofCwd: dir }));
});

test("a new filing keeps its id proof and a combined filing-plus-amendment carries both", () => {
  const { dir, files, diff } = fixture({ amend: clarify, extra: true });
  const criteria = planPrAcceptanceCriteria(["W1-T9700"], files, diff, dir);
  assert.deepEqual(
    criteria.map((c) => c.proof).filter((p) => p.startsWith("grep: id:")),
    [`grep: id: W1-T9700 in ${NEWSHARD}`],
  );
  assert.equal(criteria.length, 2);
  assert.ok(criteria.some((c) => /clarification/.test(c.proof) && c.proof.endsWith(AMENDED)));
  assert.ok(criteria.every((c) => parseWhitelistedProof(c.proof) !== null));
});

test("a monolith-only rewire gets a runnable proof from the added line in plan/tasks.yaml", () => {
  const { dir, files, diff } = monolithFixture();
  const [criterion] = planPrAcceptanceCriteria([], files, diff, dir);
  assert.equal(criterion.proof, "grep: clarification: the operator ruled this applies to every lane in plan/tasks.yaml");
  assert.match(criterion.claim, /plan\/tasks\.yaml is amended by this PR/);
  const body = buildPlanPrBody({ intro: "plan run", criteria: [criterion], changedFiles: files, proofCwd: dir });
  const stored = parseAcceptanceBlock(body);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].proof, criterion.proof);
});

test("a plan PR with no derivable proof is refused with no prose fallback", () => {
  // deletion-only amendment: nothing is added
  const del = fixture({ amend: (s) => s.replace("  note: |\n    original note text\n", "") });
  assert.throws(() => planPrAcceptanceCriteria([], del.files, del.diff, del.dir), /plan PR refused: no runnable acceptance proof derivable from/);
  // an added line that is too short, or contains ` in `, clears no bar
  const weak = fixture({ amend: (s) => `${s}  a: b\n  see the note in the shard\n` });
  assert.throws(() => planPrAcceptanceCriteria(["W1-T9801"], weak.files, weak.diff, weak.dir), /plan PR refused/);
  // no diff at all
  assert.throws(() => planPrAcceptanceCriteria(["W1-T9801"], [AMENDED], undefined, weak.dir), /plan PR refused/);
  // no shard changed
  assert.throws(() => planPrAcceptanceCriteria(["W1-T9801"], ["MASTER-PLAN.md"], "", weak.dir), /plan PR refused: no runnable acceptance proof derivable from MASTER-PLAN\.md/);
});

test("a shard whose id line disagrees with its filename, or that is unreadable, yields no proof", () => {
  const { dir, files, diff } = fixture({ amend: clarify });
  writeFileSync(join(dir, AMENDED), "- id: W1-T1111\n  clarification: the operator ruled this applies to every lane\n");
  assert.throws(() => planPrAcceptanceCriteria([], files, diff, dir), /plan PR refused/);
  rmSync(join(dir, AMENDED));
  assert.throws(() => planPrAcceptanceCriteria([], files, diff, dir), /plan PR refused/);
});

test("a line the shard repeats elsewhere is not chosen, because it would already match at base", () => {
  const dup = "  duplicated line that exists already\n";
  const { dir, files, diff } = fixture({ amend: (s) => `${s}${dup}${dup}  clarification: the operator ruled this applies to every lane\n` });
  const [c] = planPrAcceptanceCriteria([], files, diff, dir);
  assert.match(c.proof, /clarification/);
});
