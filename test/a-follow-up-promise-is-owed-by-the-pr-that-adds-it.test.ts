import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisedFollowUps, unreportedFollowUps } from "#src/lib/promised-follow-ups.js";
import { judgeReview, observePromisedFollowUps } from "#src/lib/review.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const adrPath = "docs/adr/0006-example.md";
const bullet = "precompiled daemon child entries built once per release";
const adrWith = (update: string) => `# Decision\n\n${update}\n\n- Follow-up tasks this record files:\n  - ${bullet}\n`;
const taskRecord = (extra = "") => `- id: W1-T8775\n  title: the build\n  repo: remudero\n  type: implement\n  verify: auto\n  status: queued\n${extra}`;
const criteria = [{ claim: "a real change", proof: "grep: example in src/example.ts" }];

/** A repo whose origin/main holds `baseAdr` (when given) and `plan/tasks.yaml`, and whose PR head holds `headAdr`. */
function fixture(baseAdr: string | undefined, headAdr: string, records: string) {
  const repo = gitRepo();
  mkdirSync(join(repo.dir, "plan"));
  mkdirSync(join(repo.dir, "docs/adr"), { recursive: true });
  writeFileSync(join(repo.dir, "plan/tasks.yaml"), records);
  if (baseAdr !== undefined) writeFileSync(join(repo.dir, adrPath), baseAdr);
  repo.git("add", "."); repo.git("commit", "-m", "base");
  const base = repo.git("rev-parse", "HEAD"); repo.git("update-ref", "refs/remotes/origin/main", base);
  repo.git("switch", "-c", "pr-head");
  mkdirSync(dirname(join(repo.dir, adrPath)), { recursive: true }); writeFileSync(join(repo.dir, adrPath), headAdr);
  repo.git("add", "."); repo.git("commit", "-m", "head"); const head = repo.git("rev-parse", "HEAD");
  return { repo, args: { diff: repo.git("diff", `${base}...${head}`), headSha: head, headCheckoutDir: repo.dir,
    task: { id: "W1-T8775", sourcePath: join(repo.dir, "plan/tasks.yaml") } } };
}

test("W1-T9283: a bullet already on base is not owed by a later edit", async t => {
  const baseAdr = adrWith("Update: first paragraph.");
  const { repo, args } = fixture(baseAdr, adrWith("Update: first paragraph, now edited."), taskRecord());
  t.after(() => repo.cleanup());
  const observed = await observePromisedFollowUps(args);
  assert.equal(observed.state, "complete");
  if (observed.state !== "complete") return;
  assert.deepEqual(observed.promised, [], "the ADR's bullet is on origin/main, so this edit owes nothing");
  // The comparison is on normalized text, and a reworded bullet is a NEW promise.
  const text = (adr: string, base: string) => promisedFollowUps([adrPath], () => adr, () => base).map(p => p.text);
  assert.deepEqual(text(adrWith("x").toUpperCase().replace("FOLLOW-UP TASKS THIS RECORD FILES:", "Follow-up tasks this record files:"), adrWith("x")), []);
  assert.deepEqual(text(adrWith("x").replace(bullet, `${bullet} reworded`), adrWith("x")), [`${bullet} reworded`]);
  assert.deepEqual(text(adrWith("x"), ""), [bullet], "a path new at base reads as an empty list");
  assert.throws(() => promisedFollowUps([adrPath], () => adrWith("x"), () => { throw new Error("EACCES"); }), /EACCES/, "an unreadable base is never an empty list");
});

test("W1-T9283: the task that files the promise satisfies it", async t => {
  const own = taskRecord(`  rationale: |\n    PROMISE IDENTITY: ${bullet}\n`);
  const { repo, args } = fixture(undefined, adrWith("Update: adds the ADR."), own);
  t.after(() => repo.cleanup());
  const observed = await observePromisedFollowUps(args);
  assert.equal(observed.state, "complete");
  if (observed.state !== "complete") return;
  assert.equal(observed.promised.length, 1, "the bullet is new in this PR, so it is a promise");
  assert.deepEqual(observed.planRecords.map(r => r.id), ["W1-T8775"], "the PR's own record is kept, not only records that list it in plan_refs");
  assert.deepEqual(unreportedFollowUps(observed.promised, "", observed.planRecords), []);
  const verdict = judgeReview(criteria, { diff: args.diff, report: "a real change", implementationReport: "", headCheckoutDir: "/unused",
    execProof: () => "pass", ...({ promisedFollowUpObservation: observed } as object) });
  assert.equal(verdict.state, "success");
  // A record that is NOT the promise's task and does not list it in plan_refs still does not count.
  assert.deepEqual(unreportedFollowUps(observed.promised, "", [{ id: "W1-T0001", title: bullet }]), observed.promised);
});

test("W1-T9283: an added unreported bullet still blocks review", async t => {
  const { repo, args } = fixture(undefined, adrWith("Update: adds the ADR."), taskRecord(`  rationale: unrelated words\n`));
  t.after(() => repo.cleanup());
  const observed = await observePromisedFollowUps(args);
  assert.equal(observed.state, "complete");
  if (observed.state !== "complete") return;
  const verdict = judgeReview(criteria, { diff: args.diff, report: "a real change", implementationReport: "", headCheckoutDir: "/unused",
    execProof: () => "pass", ...({ promisedFollowUpObservation: observed } as object) });
  assert.equal(verdict.state, "failure");
  const unmet = verdict.criteria.find(c => c.claim === "promised follow-ups reported for harvest");
  assert.equal(unmet?.met, false);
  assert.ok(unmet?.reason.includes(bullet), "the reason still names the bullet verbatim");
  assert.match(unmet?.reason ?? "", /rewording or deleting the promise text does not satisfy it/);
});
