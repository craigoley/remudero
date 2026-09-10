import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";

import {
  LearningsError,
  RULE_BODY_POINTER_RE,
  parseRuleBodyPointer,
  parseRuleHeadlines,
  renderHeadlineOnlyIndex,
  resolveDoctrineForReader,
  resolveRuleBodyPointer,
} from "../src/lib/learnings.js";
import { buildRuleHeadlinesPart, followRuleBodyPointer } from "../src/run-task.js";

// ── W1-T3323: CLAUDE.md is an INDEX and doctrine/ holds the evidence ─────────────────────────────
//
// THE MEASUREMENT THAT MADE THIS A TASK. CLAUDE.md stood at 43685 bytes, of which 34357 were rule
// BODIES — the measurements, PRs and sessions that make each rule believable. An interactive
// session loaded all of it and paid for all of it, every session, whether or not it applied a
// single rule. The headline alone IS the instruction; the body is the evidence, and evidence is
// needed only when applying a rule precisely or doubting it. So the bodies moved to
// `doctrine/<section>/<rule>.md` and each headline kept a `→ <path>` pointer as READABLE TEXT —
// readable because an interactive agent has no runtime hook to call `retrieveRuleBody` with.
//
// WHAT THIS SUITE HAS TO PROVE, and why each half is load-bearing:
//   (1) every pointer resolves, and a dangling or MIS-POINTED one fails LOUD rather than handing
//       the reader another rule's evidence under this rule's instruction;
//   (2) nothing was lost — every rule the pre-migration file carried is still resolvable;
//   (3) the bodies MOVED, they were not rewritten, byte for byte;
//   (4) the path is readable text on the line, not an index a reader must know to consult;
//   (5) the eight section headings survive, because they are how a reader finds a rule by the
//       question they are asking.
//
// (2) AND (3) NEED A REFERENCE, AND IT IS A DIGEST MANIFEST, NOT A SECOND COPY OF THE PROSE.
// `test/fixtures/doctrine-pre-migration-W1-T3323.json` freezes each rule's headline verbatim plus
// the sha256 and byte length of its body, taken from CLAUDE.md at 888b2ffa1 — the commit before
// the move. A second 34KB copy of doctrine in the tree would answer every `git grep` for a rule
// phrase twice, and several suites here COUNT those hits; a digest cannot. `git show <sha>:` was
// the other option and is refused on this repo's own evidence: `actions/checkout` fetches shallow,
// so a fixture shelling git plumbing passes on every dev machine and fails on CI.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLAUDE_MD = join(REPO_ROOT, "CLAUDE.md");
const MANIFEST = join(REPO_ROOT, "test", "fixtures", "doctrine-pre-migration-W1-T3323.json");
const DOCTRINE_DIR = join(REPO_ROOT, "doctrine");

interface FrozenRule {
  headline: string;
  bodyBytes: number;
  bodySha256: string;
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
  frozenFromSha: string;
  sourceBytes: number;
  rules: FrozenRule[];
};

const readIndex = (): string => readFileSync(CLAUDE_MD, "utf8");
const indexRules = () => parseRuleHeadlines(readIndex());

/** Every `doctrine/**\/*.md` on disk, repo-relative and forward-slashed. */
function storeFiles(dir = DOCTRINE_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...storeFiles(abs));
    else if (entry.endsWith(".md")) out.push(relative(REPO_ROOT, abs).split(sep).join("/"));
  }
  return out;
}

// ── (1) every headline resolves to exactly one body, and a dangling pointer FAILS ───────────────

test("W1-T3323 (1): every headline in the index resolves to exactly one body on disk", () => {
  const rules = indexRules();
  assert.ok(rules.length >= 56, `positive control: the index must carry the real corpus; got ${rules.length}`);

  const targets = new Map<string, string>();
  for (const rule of rules) {
    const pointer = parseRuleBodyPointer(rule.body);
    assert.ok(pointer, `rule has no body pointer: ${rule.headline.slice(0, 70)}`);
    assert.ok(existsSync(join(REPO_ROOT, pointer.target)), `dangling pointer: ${pointer.target}`);
    const claimedBy = targets.get(pointer.target);
    assert.equal(
      claimedBy,
      undefined,
      `two headlines point at ${pointer.target}: "${claimedBy}" and "${rule.headline.slice(0, 40)}"`,
    );
    targets.set(pointer.target, rule.headline);
  }
  // …and no body file is orphaned. A rule deleted from the index without its body is doctrine
  // that still costs bytes and reaches no reader.
  assert.deepEqual(
    storeFiles().filter((f) => !targets.has(f)),
    [],
    "doctrine/ holds body files no headline points at",
  );
});

test("W1-T3323 (1): a DANGLING pointer throws — the reader never silently loses a rule's evidence", () => {
  assert.throws(
    () =>
      resolveDoctrineForReader(
        () => "- **A RULE** → doctrine/nowhere/absent.md",
        undefined,
        () => {
          throw new Error("ENOENT");
        },
      ),
    (err: unknown) =>
      err instanceof LearningsError && /doctrine body "doctrine\/nowhere\/absent\.md".*is unreadable/.test((err as Error).message),
  );
});

test("W1-T3323 (1): a MIS-POINTED pointer throws — being handed another rule's evidence is the worse failure", () => {
  assert.throws(
    () =>
      resolveRuleBodyPointer(
        "THE RULE THE READER ASKED FOR",
        { target: "doctrine/x/y.md", trailer: "" },
        () => "- **A COMPLETELY DIFFERENT RULE** with a body that reads perfectly well\n",
      ),
    (err: unknown) =>
      err instanceof LearningsError &&
      /does not open with its own headline "THE RULE THE READER ASKED FOR"/.test((err as Error).message),
  );
});

test("W1-T3323 (1): CONTROL — the same call with a MATCHING stored headline resolves, so the guard is not refusing everything", () => {
  assert.equal(
    resolveRuleBodyPointer("A RULE", { target: "doctrine/x/y.md", trailer: "\n" }, () => "- **A RULE** the evidence.\n"),
    " the evidence.\n",
  );
});

test("W1-T3323: RULE_BODY_POINTER_RE ACCEPTS the shapes the index really emits, including a section-final trailer", () => {
  // Driven on the regex itself, not only through `parseRuleBodyPointer`, because this pattern is
  // the whole discriminator between "an address to follow" and "prose that mentions a path" — and
  // `negative-reachability-ratchet` counts a validator with no direct rejecting AND accepting
  // fixture as an unexercised surface, which is exactly what it was until this test existed.
  assert.equal(RULE_BODY_POINTER_RE.test(" → doctrine/before-you-push/a-rule.md"), true);
  assert.equal(RULE_BODY_POINTER_RE.test(" -> doctrine/ci-and-merging/a-rule.md"), true);
  // The section-final case: `parseRuleHeadlines` folds the blank line before the next `##` into
  // the body, so an anchored pattern with no trailer group would refuse five real rules.
  assert.equal(RULE_BODY_POINTER_RE.test(" → doctrine/code-traps/a-rule.md\n"), true);
  const m = RULE_BODY_POINTER_RE.exec(" → doctrine/coverage-traps/a-rule.md\n");
  assert.notEqual(m, null);
  assert.equal(m?.[1], "doctrine/coverage-traps/a-rule.md");
  assert.equal(m?.[2], "\n");
});

test("W1-T3323: RULE_BODY_POINTER_RE REJECTS prose that merely names a path, and every store escape", () => {
  // A body that TALKS about a doctrine path is a body, not an address. This is the arm that keeps
  // an ordinary rule from being silently replaced by a file read.
  assert.equal(RULE_BODY_POINTER_RE.test(" see doctrine/code-traps/a-rule.md for the measurement"), false);
  assert.equal(RULE_BODY_POINTER_RE.test(" → doctrine/code-traps/a-rule.md and then some prose"), false);
  // Not a markdown file, and not under doctrine/ — a pointer must not reach arbitrary files.
  assert.equal(RULE_BODY_POINTER_RE.test(" → doctrine/code-traps/a-rule.ts"), false);
  assert.equal(RULE_BODY_POINTER_RE.test(" → src/lib/learnings.ts"), false);
  assert.equal(RULE_BODY_POINTER_RE.test(" → /etc/passwd.md"), false);
  // No traversal out of the store: `..` carries no `/`-free segment this pattern admits.
  assert.equal(RULE_BODY_POINTER_RE.test(" → doctrine/../../etc/shadow.md"), false);
  assert.equal(RULE_BODY_POINTER_RE.exec(" an ordinary body."), null);
});

test("W1-T3323 (1): an INLINE body still resolves unchanged — an un-migrated corpus is not broken by the pointer path", () => {
  assert.equal(parseRuleBodyPointer(" an ordinary body naming doctrine/x/y.md in passing"), undefined);
  assert.equal(
    resolveDoctrineForReader(() => "- **A RULE** an ordinary inline body.", undefined, () => {
      throw new Error("the store must not be consulted for an inline body");
    }),
    "- **A RULE** an ordinary inline body.",
  );
});

// ── (2) nothing was lost, and (3) the bodies MOVED rather than being rewritten ───────────────────

test("W1-T3323 (2): every rule the pre-migration file carried is still resolvable from the index", () => {
  assert.equal(manifest.rules.length, 56, "positive control: the frozen manifest must describe the real corpus");
  const resolved = parseRuleHeadlines(resolveDoctrineForReader(readIndex));
  const headlines = new Set(resolved.map((r) => r.headline));
  const lost = manifest.rules.filter((r) => !headlines.has(r.headline)).map((r) => r.headline.slice(0, 70));
  assert.deepEqual(lost, [], "rules present before the migration and absent after it");
});

test("W1-T3323 (3): each body is byte-identical to the one frozen before the move", () => {
  const resolved = parseRuleHeadlines(resolveDoctrineForReader(readIndex));
  const byHeadline = new Map(resolved.map((r) => [r.headline, r.body.replace(/\n+$/, "")]));

  const drifted: string[] = [];
  for (const frozen of manifest.rules) {
    const body = byHeadline.get(frozen.headline);
    if (body === undefined) continue; // (2) owns absence; this test owns CONTENT
    const sha = createHash("sha256").update(body, "utf8").digest("hex");
    if (sha !== frozen.bodySha256 || Buffer.byteLength(body) !== frozen.bodyBytes) {
      drifted.push(`${frozen.headline.slice(0, 60)} (${frozen.bodyBytes} -> ${Buffer.byteLength(body)} bytes)`);
    }
  }
  assert.deepEqual(drifted, [], "a rule body was REWRITTEN by the move, not moved");
});

test("W1-T3323 (3): CONTROL — the digest comparison really discriminates; one added character reddens it", () => {
  const frozen = manifest.rules[0];
  const resolved = parseRuleHeadlines(resolveDoctrineForReader(readIndex));
  const body = resolved.find((r) => r.headline === frozen.headline)?.body.replace(/\n+$/, "");
  assert.ok(body !== undefined, "positive control: the first frozen rule must still resolve");
  assert.equal(createHash("sha256").update(body, "utf8").digest("hex"), frozen.bodySha256);
  assert.notEqual(createHash("sha256").update(`${body} `, "utf8").digest("hex"), frozen.bodySha256);
});

test("W1-T3323 (3): every stored body file opens with its OWN headline, so the store is readable standalone", () => {
  for (const rule of indexRules()) {
    const pointer = parseRuleBodyPointer(rule.body);
    assert.ok(pointer);
    const stored = readFileSync(join(REPO_ROOT, pointer.target), "utf8");
    assert.ok(
      stored.startsWith(`- **${rule.headline}**`),
      `${pointer.target} does not open with the headline that points at it`,
    );
    assert.ok(stored.endsWith("\n"), `${pointer.target} must end with a newline`);
  }
});

// ── (4) the path is READABLE TEXT on the line ────────────────────────────────────────────────────

test("W1-T3323 (4): each headline carries its body's path as plain text an agent with no runtime hook can read", () => {
  const raw = readIndex();
  const rules = indexRules();
  for (const rule of rules) {
    const pointer = parseRuleBodyPointer(rule.body);
    assert.ok(pointer, `no readable pointer for: ${rule.headline.slice(0, 60)}`);
    assert.ok(
      raw.includes(`** → ${pointer.target}`),
      `the pointer for "${rule.headline.slice(0, 40)}" is not on the line in readable form`,
    );
  }
  // …and the file SAYS so, because a path a reader does not know to follow is not an affordance.
  assert.match(raw, /THIS FILE IS AN INDEX, AND THE ARROW IS AN INSTRUCTION TO YOU/);
});

test("W1-T3323 (4): the WORKER lane is pointed at doctrine/ too — the prompt cannot name a file that no longer holds the evidence", () => {
  const part = buildRuleHeadlinesPart(true, CLAUDE_MD);
  assert.match(part, /doctrine\/ in your own worktree/);
  assert.equal(/Read a headline's full body from .*CLAUDE\.md in your own worktree/.test(part), false);
  // The 56 paths stay OUT of the prompt: this part exists to spend fewer bytes.
  assert.equal(part.includes("→ doctrine/"), false, "the worker index must not inline every body path");
});

test("W1-T3323 (4): an UN-MIGRATED corpus keeps the original worker pointer line", () => {
  const part = buildRuleHeadlinesPart(true, "/nonexistent/CLAUDE.md", () => "- **A RULE** an inline body.\n");
  assert.match(part, /Read a headline's full body from \/nonexistent\/CLAUDE\.md/);
});

test("W1-T3323 (4): the worker's on-demand retrieval FOLLOWS the pointer instead of quoting it", () => {
  const body = followRuleBodyPointer("A RULE", " → doctrine/x/y.md", "/repo/CLAUDE.md", (p) => {
    assert.equal(p, join("/repo", "doctrine/x/y.md"));
    return "- **A RULE** the evidence that earned it.\n";
  });
  assert.equal(body, " the evidence that earned it.");
});

test("W1-T3323 (4): the worker lane DEGRADES where the reader lane throws — a worker prompt must never go silent", () => {
  assert.match(
    followRuleBodyPointer("A RULE", " → doctrine/x/y.md", "/repo/CLAUDE.md", () => undefined) ?? "",
    /unavailable — could not read doctrine body doctrine\/x\/y\.md/,
  );
  assert.match(
    followRuleBodyPointer("A RULE", " → doctrine/x/y.md", "/repo/CLAUDE.md", () => "- **ANOTHER RULE** x\n") ?? "",
    /does not carry the headline "A RULE"/,
  );
});

// ── (5) the sections survive ─────────────────────────────────────────────────────────────────────

test("W1-T3323 (5): the eight section headings survive, and every rule still sits under one", () => {
  const raw = readIndex();
  const headings = raw.match(/^## .*/gm) ?? [];
  assert.deepEqual(headings, [
    "## Before you push",
    "## Writing proofs and acceptance criteria",
    "## Coverage traps",
    "## Plan and task hygiene",
    "## CI and merging",
    "## Ledger and evidence discipline",
    "## Investigation discipline",
    "## Code traps",
  ]);
  // A rule bullet before the first heading would sit under no question at all.
  assert.ok(raw.indexOf("\n- **") > raw.indexOf("\n## "), "a rule bullet precedes the first section heading");
  // The store mirrors the sections, so the path itself says which question a rule answers.
  const dirs = readdirSync(DOCTRINE_DIR).filter((e) => statSync(join(DOCTRINE_DIR, e)).isDirectory());
  assert.equal(dirs.length, headings.length, "doctrine/ must carry one directory per section");
});

// ── the falsifier: PROVE the saving, do not assert it ────────────────────────────────────────────

test("W1-T3323 falsifier: the index really is a fraction of the corpus it indexes", () => {
  const indexBytes = Buffer.byteLength(readIndex());
  const resolvedBytes = Buffer.byteLength(resolveDoctrineForReader(readIndex));

  // The shard's own bar: "a migration that lands at 30KB has moved furniture, not solved the
  // problem." Measured with the same primitive that sized the task.
  assert.ok(indexBytes < 30_000, `CLAUDE.md is ${indexBytes} bytes — the move did not solve the problem`);
  assert.ok(
    indexBytes < manifest.sourceBytes / 2,
    `CLAUDE.md is ${indexBytes} bytes against a pre-migration ${manifest.sourceBytes}`,
  );
  assert.ok(
    resolvedBytes > indexBytes * 2,
    `the resolved corpus (${resolvedBytes}) must dwarf the index (${indexBytes}) — otherwise nothing moved`,
  );
  // The headline half the shard measured at 7301 bytes is still the bulk of what a session pays,
  // so shortening a HEADLINE is what folding means now.
  const headlineBytes = Buffer.byteLength(renderHeadlineOnlyIndex(indexRules()));
  assert.ok(headlineBytes < indexBytes, "the headlines must be a subset of the index");
  assert.ok(headlineBytes > indexBytes / 3, "the headlines must dominate the index, not the scaffolding");
});

test("W1-T3323 falsifier: the budget ratchet's cap still covers the real file, and the file is well under it", () => {
  const baseline = JSON.parse(readFileSync(join(REPO_ROOT, "scripts", "claude-md-budget-baseline.json"), "utf8")) as {
    capBytes: number;
    foldDebtCeilingBytes: number;
  };
  const actual = Buffer.byteLength(readIndex());
  assert.ok(actual <= baseline.capBytes, `CLAUDE.md (${actual}) exceeds capBytes (${baseline.capBytes})`);
  assert.ok(baseline.foldDebtCeilingBytes > baseline.capBytes, "the fold-debt allowance must sit above the cap");
  // NOT ASSERTED HERE, DELIBERATELY: that the cap came DOWN with the file. `scripts/*-baseline.json`
  // is on Standing rule 25's INSTRUMENT_SURFACE, and this PR changes `src/lib/learnings.ts` and
  // `src/run-task.ts` — MEASURED through `detectInstrumentEntanglement` against this diff:
  // `entangled: true`, which forces an unsuppressible review FAILURE. So re-deriving 44000 -> 17000
  // rides alone in its own instrument-only PR, the sanctioned shape, and the assertion that the cap
  // tracked the file lands with it. Until then the ratchet is a ceiling this file sits far under —
  // honest, and weaker than it will be, which is why it is said out loud rather than left implied.
});
