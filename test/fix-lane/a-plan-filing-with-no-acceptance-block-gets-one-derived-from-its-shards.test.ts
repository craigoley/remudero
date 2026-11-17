// W1-T13360. MEASURED 2026-11-17: two plan pull requests sat red for 5.5 and 3.6 hours on
// `acceptance-author-gate: REFUSED (no-header)` with every other check green. The body repair had no cure for a
// body with no acceptance block unless the diff added a test file, and a plan-only diff never adds one. For a
// FILING the block is derivable from the diff alone: one criterion per added task shard, proved by a grep of the
// shard's own id line, which misses at the base because the file is not there.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { addedPlanFilingDiffAtHead, repairPrMetadata } from "#src/run-task.js";
import {
  ATTRIBUTION_LINE_RE, PROOF_SAFE_PATH_RE, SHARD_ID_LINE_RE, planFilingAcceptanceCure, repairedProofsAreSafeToPush,
  type FilingDiffFile,
} from "#src/lib/body-repair.js";
import { acceptanceAuthorTimeCheck, parseAcceptanceBlock, parseWhitelistedProof } from "#src/lib/review.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const ATTRIBUTION = "🤖 Generated with [Claude Code](https://claude.com/claude-code)";
const PROSE = "File two tasks measured in the stuck-work review.\n\n## Why\nThe fleet left both red for hours.";
const NO_BLOCK_BODY = `${PROSE}\n\n${ATTRIBUTION}\n`;

/** The directory the plan loader reads task shards from; production resolves it from the repo layout. */
const SHARD_DIR = "plan/tasks.d";
const SHARD_A = "plan/tasks.d/W9-T501-a-first-filed-task.yaml";
const SHARD_B = "plan/tasks.d/w9-t502-a-second-filed-task.yaml";
const EDITED_SHARD = "plan/tasks.d/W9-T400-an-existing-task.yaml";

function shardText(id: string): string {
  return `- id: ${id}\n  title: "a fixture task"\n  repo: remudero\n  status: queued\n`;
}
const added = (path: string, headText: string): FilingDiffFile => ({ path, added: true, headText });
const edited = (path: string, headText?: string): FilingDiffFile => ({ path, added: false, ...(headText === undefined ? {} : { headText }) });

const FILING_DIFF: FilingDiffFile[] = [added(SHARD_A, shardText("W9-T501")), added(SHARD_B, shardText("W9-T502"))];

/** The executor's own argv for a `grep:` proof (`grep -arn -- <pattern> <path>`), run in `cwd`. */
function runGrepProof(proof: string, cwd: string): { status: number | null; lines: string[] } {
  const whitelisted = parseWhitelistedProof(proof);
  assert.ok(whitelisted !== null && whitelisted.kind === "grep", `not a runnable grep proof: ${proof}`);
  const run = spawnSync(whitelisted.command, whitelisted.args, { cwd, encoding: "utf8" });
  return { status: run.status, lines: run.stdout.split("\n").filter((line) => line.length > 0) };
}

/** Two trees on disk: `head` holds every file the diff carries text for, `base` holds only the ones it did not add. */
function writeTrees(t: TestContext, diff: readonly FilingDiffFile[]): { head: string; base: string } {
  const { dir } = ownedFixtureDir(t, "plan-filing-cure");
  const head = join(dir, "head"), base = join(dir, "base");
  mkdirSync(head);
  mkdirSync(base);
  for (const file of diff) {
    if (file.headText === undefined) continue;
    for (const root of file.added ? [head] : [head, base]) {
      mkdirSync(dirname(join(root, file.path)), { recursive: true });
      writeFileSync(join(root, file.path), file.headText);
    }
  }
  return { head, base };
}

test("W1-T13360 criterion 1: a plan-only diff that adds shards, under a body with no acceptance header, gets one criterion per added shard and every derived proof misses at the base", (t) => {
  assert.equal(acceptanceAuthorTimeCheck(NO_BLOCK_BODY).defect, "no-header", "the fixture body is the measured refusal");

  const cure = planFilingAcceptanceCure(NO_BLOCK_BODY, FILING_DIFF, SHARD_DIR, acceptanceAuthorTimeCheck);
  assert.ok(cure, "a filing with no acceptance block has a derivable cure");
  assert.deepEqual(cure.criteria, [
    { claim: "the W9-T501 shard is filed", proof: `grep: id: W9-T501 in ${SHARD_A}` },
    { claim: "the W9-T502 shard is filed", proof: `grep: id: W9-T502 in ${SHARD_B}` },
  ]);

  // The cure is a body the gate accepts, and the block it carries parses back to exactly the derived criteria.
  assert.equal(acceptanceAuthorTimeCheck(cure.repairedBody).ok, true);
  assert.deepEqual(parseAcceptanceBlock(cure.repairedBody).map(({ claim, proof }) => ({ claim, proof })), cure.criteria);
  assert.equal(repairedProofsAreSafeToPush(cure.criteria), true);

  // Nothing the author wrote is lost, and the block sits before the body's last attribution line.
  assert.ok(cure.repairedBody.startsWith(`${PROSE}\n\n## Acceptance\n`), cure.repairedBody);
  assert.ok(cure.repairedBody.endsWith(`\n\n${ATTRIBUTION}\n`), cure.repairedBody);
  assert.equal(cure.repairedBody.split(ATTRIBUTION).length, 2, "the attribution line is neither dropped nor repeated");

  // Run each derived proof the way the executor does: one hit in the head tree, a miss in the base tree.
  const { head, base } = writeTrees(t, FILING_DIFF);
  assert.equal(cure.criteria.length, FILING_DIFF.length);
  for (const { proof } of cure.criteria) {
    const atHead = runGrepProof(proof, head);
    assert.equal(atHead.status, 0, `${proof} must pass at the head`);
    assert.equal(atHead.lines.length, 1, `${proof} must hit one line at the head`);
    const atBase = runGrepProof(proof, base);
    assert.notEqual(atBase.status, 0, `${proof} must miss at the base`);
    assert.deepEqual(atBase.lines, [], `${proof} must match nothing at the base`);
  }
});

test("W1-T13360 criterion 2: no claim is invented — an edited shard, a diff that adds no shard, and a body that already has an acceptance block all get no cure", (t) => {
  const gate = acceptanceAuthorTimeCheck;

  // A plan-only diff that only EDITS shards: a claim about an amendment would have to be authored.
  const onlyEdits = [edited(EDITED_SHARD, shardText("W9-T400")), edited("plan/tasks.d/W9-T401-another-existing-task.yaml", shardText("W9-T401"))];
  assert.equal(planFilingAcceptanceCure(NO_BLOCK_BODY, onlyEdits, SHARD_DIR, gate), undefined);

  // A diff that adds no shard and no test, plan-only or not.
  assert.equal(planFilingAcceptanceCure(NO_BLOCK_BODY, [], SHARD_DIR, gate), undefined);
  assert.equal(planFilingAcceptanceCure(NO_BLOCK_BODY, [added("plan/notes/a-new-note.md", "# a note\n")], SHARD_DIR, gate), undefined);
  assert.equal(planFilingAcceptanceCure(NO_BLOCK_BODY, [edited("src/lib/sweep.ts")], SHARD_DIR, gate), undefined);
  assert.equal(planFilingAcceptanceCure(NO_BLOCK_BODY, [added("src/lib/a-new-module.ts", "export const x = 1;\n")], SHARD_DIR, gate), undefined);

  // A diff that adds a shard beside code is not a filing: the code's claims are not derivable from a shard.
  assert.equal(planFilingAcceptanceCure(NO_BLOCK_BODY, [...FILING_DIFF, edited("src/lib/sweep.ts")], SHARD_DIR, gate), undefined);

  // An existing acceptance block is never rewritten: healthy, defective, or stood in for by a task trailer.
  const healthy = `${PROSE}\n\n## Acceptance\n- the author's own claim | grep: fixture in ${SHARD_A}\n\n${ATTRIBUTION}\n`;
  const emptyProof = `${PROSE}\n\n## Acceptance\n- the author's own claim with no proof\n\n${ATTRIBUTION}\n`;
  const trailered = `${PROSE}\n\nRemudero-Task: W9-T501\n`;
  assert.equal(gate(healthy).ok, true);
  assert.equal(gate(emptyProof).defect, "empty-proofs");
  assert.equal(gate(trailered).ok, true);
  for (const body of [healthy, emptyProof, trailered]) {
    assert.equal(planFilingAcceptanceCure(body, FILING_DIFF, SHARD_DIR, gate), undefined, body);
  }

  // A filing that also amends an existing shard gets a criterion for the shard it adds and none for the edit.
  const mixed = [edited(EDITED_SHARD, shardText("W9-T400")), added(SHARD_A, shardText("W9-T501"))];
  const cure = planFilingAcceptanceCure(NO_BLOCK_BODY, mixed, SHARD_DIR, gate);
  assert.ok(cure);
  assert.deepEqual(cure.criteria, [{ claim: "the W9-T501 shard is filed", proof: `grep: id: W9-T501 in ${SHARD_A}` }]);
  assert.equal(cure.repairedBody.includes("W9-T400"), false, "the edited shard is named nowhere in the repaired body");
  // The control for "an edit earns no claim": the edited shard's id line passes at the base too.
  const { base } = writeTrees(t, mixed);
  assert.equal(runGrepProof(`grep: id: W9-T400 in ${EDITED_SHARD}`, base).status, 0);
});

test("W1-T13360: an added shard whose own id line cannot be read leaves the whole filing with no cure", () => {
  const gate = acceptanceAuthorTimeCheck;
  const noIdLine = added(SHARD_A, "- title: \"a record with no id\"\n  repo: remudero\n");
  const quotedId = added(SHARD_A, "- id: \"W9-T501\"\n  title: \"the grep pattern would not hit a quoted id\"\n");
  const anotherTasksId = added(SHARD_A, shardText("W9-T777"));
  const noText: FilingDiffFile = { path: SHARD_A, added: true };
  for (const shard of [noIdLine, quotedId, anotherTasksId, noText]) {
    assert.equal(planFilingAcceptanceCure(NO_BLOCK_BODY, [shard], SHARD_DIR, gate), undefined, JSON.stringify(shard));
    // One underivable shard is not skipped: a partial block would leave a filed task with no criterion.
    assert.equal(planFilingAcceptanceCure(NO_BLOCK_BODY, [added(SHARD_B, shardText("W9-T502")), shard], SHARD_DIR, gate), undefined);
  }
  // A path a `grep:` proof cannot name safely is not a shard this derives from.
  const spaced = added("plan/tasks.d/W9-T501 a name with spaces.yaml", shardText("W9-T501"));
  assert.equal(planFilingAcceptanceCure(NO_BLOCK_BODY, [spaced], SHARD_DIR, gate), undefined);
  const dotted = added("plan/tasks.d/W9-T501-a..b.yaml", shardText("W9-T501"));
  assert.equal(planFilingAcceptanceCure(NO_BLOCK_BODY, [dotted], SHARD_DIR, gate), undefined);
  assert.equal(planFilingAcceptanceCure(NO_BLOCK_BODY, [added(SHARD_B, shardText("W9-T502")), spaced], SHARD_DIR, gate), undefined);
  // A file the plan loader does not read as a shard is not one: it neither earns a claim nor blocks the cure.
  const beside = [added(SHARD_B, shardText("W9-T502")), added("plan/tasks.d/README.md", "# notes\n"), added("plan/tasks.d/drafts/W9-T503-a-draft.yaml", shardText("W9-T503"))];
  assert.deepEqual(planFilingAcceptanceCure(NO_BLOCK_BODY, beside, SHARD_DIR, gate)?.criteria, [{ claim: "the W9-T502 shard is filed", proof: `grep: id: W9-T502 in ${SHARD_B}` }]);
  // The shard directory is the caller's to name: a trailing slash reads the same, and another directory's files are not shards.
  assert.deepEqual(planFilingAcceptanceCure(NO_BLOCK_BODY, beside, `${SHARD_DIR}/`, gate)?.criteria, [{ claim: "the W9-T502 shard is filed", proof: `grep: id: W9-T502 in ${SHARD_B}` }]);
  assert.equal(planFilingAcceptanceCure(NO_BLOCK_BODY, beside, "plan/elsewhere.d", gate), undefined);
});

test("W1-T13360: the id is read from the shard's own record line, wherever it sits in the record", () => {
  // Some shards open with another key and carry `id:` further down; a shard may also declare follow-up tasks.
  const idNotFirst = "- repo: remudero\n  type: implement\n  id: W9-T501\n  title: \"id is not the first key\"\n";
  const followUps = `${shardText("W9-T501")}${shardText("W9-T888")}`;
  for (const text of [idNotFirst, followUps]) {
    const cure = planFilingAcceptanceCure(NO_BLOCK_BODY, [added(SHARD_A, text)], SHARD_DIR, acceptanceAuthorTimeCheck);
    assert.deepEqual(cure?.criteria, [{ claim: "the W9-T501 shard is filed", proof: `grep: id: W9-T501 in ${SHARD_A}` }]);
  }
});

test("W1-T13360: a body with no attribution line gets the block at its end, and an empty body becomes the block", () => {
  const gate = acceptanceAuthorTimeCheck;
  const block = `## Acceptance\n- the W9-T501 shard is filed | grep: id: W9-T501 in ${SHARD_A}\n`;
  const diff = [added(SHARD_A, shardText("W9-T501"))];
  assert.equal(planFilingAcceptanceCure(`${PROSE}\n`, diff, SHARD_DIR, gate)?.repairedBody, `${PROSE}\n\n${block}`);
  assert.equal(planFilingAcceptanceCure("", diff, SHARD_DIR, gate)?.repairedBody, block);
  // A body that is only its attribution line keeps it last.
  assert.equal(planFilingAcceptanceCure(`${ATTRIBUTION}\n`, diff, SHARD_DIR, gate)?.repairedBody, `${block}\n${ATTRIBUTION}\n`);
  // Only the LAST attribution line moves below the block; an earlier mention stays where the author put it.
  const twice = `${ATTRIBUTION}\n\n${PROSE}\n\n${ATTRIBUTION}`;
  assert.equal(planFilingAcceptanceCure(twice, diff, SHARD_DIR, gate)?.repairedBody, `${ATTRIBUTION}\n\n${PROSE}\n\n${block}\n${ATTRIBUTION}\n`);
});

test("W1-T13360: a derived body the gate would still refuse is not returned as a cure", () => {
  // The gate is the judge of the result, not only of the input: a cure that leaves the check red is no cure.
  const stillRefused = () => ({ ok: false, defect: "no-header" });
  assert.equal(planFilingAcceptanceCure(NO_BLOCK_BODY, FILING_DIFF, SHARD_DIR, stillRefused), undefined);
});

test("W1-T13360: repairPrMetadata writes the derived filing block for an added-shard no-header red", async () => {
  const writes: Array<{ title?: string; body?: string }> = [];
  const result = await repairPrMetadata(
    { prUrl: "https://github.com/acme/remudero/pull/501", headSha: "a".repeat(40) },
    ["acceptance-author-gate"],
    (_url, fields) => { writes.push(fields); },
    () => ({ title: "feat(plan): file tasks", body: NO_BLOCK_BODY, base: { ref: "main" } }),
    () => [],
    () => ({ kind: "read", files: [] }),
    () => ({ kind: "read", files: FILING_DIFF, shardDir: SHARD_DIR }),
  );

  assert.deepEqual(result, { repaired: true, reason: "edited body through the PR REST endpoint" });
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.title, undefined, "a green title is not edited");
  assert.equal(acceptanceAuthorTimeCheck(writes[0]?.body ?? "").ok, true);
  assert.deepEqual(parseAcceptanceBlock(writes[0]?.body ?? "").map(({ claim, proof }) => ({ claim, proof })), [
    { claim: "the W9-T501 shard is filed", proof: `grep: id: W9-T501 in ${SHARD_A}` },
    { claim: "the W9-T502 shard is filed", proof: `grep: id: W9-T502 in ${SHARD_B}` },
  ]);

  const mixedWrites: Array<{ title?: string; body?: string }> = [];
  const mixed = await repairPrMetadata(
    { prUrl: "https://github.com/acme/remudero/pull/502", headSha: "b".repeat(40) },
    ["acceptance-author-gate"],
    (_url, fields) => { mixedWrites.push(fields); },
    () => ({ body: NO_BLOCK_BODY, base: { ref: "main" } }),
    () => [],
    () => ({ kind: "read", files: [] }),
    () => ({ kind: "read", files: [...FILING_DIFF, edited("src/lib/sweep.ts")], shardDir: SHARD_DIR }),
  );
  assert.equal(mixed.repaired, false, "a code change beside a shard is not a plan-only filing");
  assert.equal(mixedWrites.length, 0, "the body is untouched when no claim can be derived safely");
});

test("W1-T13360: the production diff reader returns complete paths and text for added task shards", () => {
  const repo = gitRepo({ kind: "plan-filing-diff" });
  repo.git("remote", "add", "origin", repo.dir);
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const shardPath = "plan/tasks.d/W9-T501-a-new-task.yaml";
  const shard = shardText("W9-T501");
  mkdirSync(dirname(join(repo.dir, shardPath)), { recursive: true });
  writeFileSync(join(repo.dir, shardPath), shard);
  repo.git("add", shardPath);
  repo.git("commit", "--quiet", "-m", "feat(plan): add a task shard");
  const headSha = repo.git("rev-parse", "HEAD");

  const diff = addedPlanFilingDiffAtHead(headSha, repo.dir);
  assert.equal(diff.kind, "read");
  if (diff.kind !== "read") return;
  assert.equal(diff.shardDir, "plan/tasks.d");
  assert.deepEqual(diff.files, [{ path: shardPath, added: true, headText: shard }]);
});

test("W1-T13360: each line shape the cure reads accepts its own form and refuses the near misses", () => {
  // A record's bare id line, as a list item or a later key; never a quoted id, a nested key or another key's value.
  assert.equal(SHARD_ID_LINE_RE.exec("- id: W9-T501")?.[1], "W9-T501");
  assert.equal(SHARD_ID_LINE_RE.exec("  id: W9-T501\r")?.[1], "W9-T501");
  assert.equal(SHARD_ID_LINE_RE.exec("- id: \"W9-T501\""), null);
  assert.equal(SHARD_ID_LINE_RE.exec("  task_id: W9-T501"), null);
  assert.equal(SHARD_ID_LINE_RE.exec("- id: W9-T501 # a trailing comment"), null);

  // A path both a grep proof and a single-line bullet can carry.
  assert.equal(PROOF_SAFE_PATH_RE.test(SHARD_A), true);
  assert.equal(PROOF_SAFE_PATH_RE.test("plan/tasks.d/W9-T501 a name with spaces.yaml"), false);
  assert.equal(PROOF_SAFE_PATH_RE.test("plan/tasks.d/W9-T501-a|b.yaml"), false);
  assert.equal(PROOF_SAFE_PATH_RE.test("plan/tasks.d/../W9-T501-a.yaml"), false);

  // The attribution line a session's body ends with, not prose that merely mentions it.
  assert.equal(ATTRIBUTION_LINE_RE.test(ATTRIBUTION), true);
  assert.equal(ATTRIBUTION_LINE_RE.test("Generated with care, by hand"), false);
  assert.equal(ATTRIBUTION_LINE_RE.test(`This body ends with ${ATTRIBUTION}`), false);
});
