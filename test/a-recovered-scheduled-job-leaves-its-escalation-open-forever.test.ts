// W1-T3030 — the raiser opened a delivery-of-record issue and appended to it by marker, but nothing
// anywhere closed one when the job recovered. The general escalation reconciler cannot: it needs a
// task referent and a cron job has none. These tests drive the REAL entry point (`main`) with
// injected collaborators, so they assert the behaviour a workflow gets, not the table's contents.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// scripts/** sits outside tsconfig's `include`, so a static import of a .mjs from TS is a TS7016.
// The repo idiom (see test/needs-human-issue.test.ts) is a runtime import of the real module --
// which also guarantees these assertions run against the file the workflow executes, not a copy.
const MODULE_URL = pathToFileURL(join(REPO_ROOT, "scripts", "needs-human-issue.mjs")).href;

type Issue = { number: number; body: string; title: string };
type Recovery = { action: string; number?: number; marker?: string };

const { buildRecoveryBody, decideDelivery, decideRecovery, main, markerFor, resolve } = (await import(
  MODULE_URL
)) as {
  markerFor: (source: string) => string;
  decideDelivery: (issues: Issue[] | undefined, marker: string) => { action: string; number?: number };
  decideRecovery: (issues: Issue[] | undefined, marker: string) => Recovery;
  buildRecoveryBody: (input: { source: string; marker: string; runUrl?: string; when?: string }) => string;
  resolve: (
    input: { source: string; label?: string; repo?: string; body: string },
    exec: (file: string, args: string[]) => string,
  ) => Recovery;
  main: (opts: Record<string, unknown>) => number;
};
const MARKER = markerFor("mutation-nightly");

/** An open issue as `gh issue list --json number,body,title` returns it. */
const issue = (number: number, body: string, title = "t"): Issue => ({ number, body, title });

test("W1-T3030 criterion 1: a recovered job closes the issue carrying its own marker", () => {
  assert.deepEqual(decideRecovery([issue(3387, `${MARKER}\nmutation-nightly is failing`)], MARKER), {
    action: "close",
    number: 3387,
  });
});

test("W1-T3030 criterion 1: and the closing comment names the recovering run", () => {
  const body = buildRecoveryBody({
    source: "mutation-nightly",
    marker: MARKER,
    runUrl: "https://github.com/craigoley/remudero/actions/runs/34101068822",
    when: "schedule",
  });
  assert.ok(body.startsWith(MARKER), "the marker must lead, so the thread stays identifiable");
  assert.match(body, /recovered/);
  assert.match(body, /34101068822/, "auditable from the issue alone");
  assert.match(body, /closes the RECORD, not a judgment/, "the close must not overclaim health");
});

test("W1-T3030 criterion 2 (falsifier): a DIFFERENT source's marker is never closed", () => {
  // The row that matters: fleet-heartbeat recovering must not close mutation-nightly's escalation.
  assert.deepEqual(decideRecovery([issue(3387, `${markerFor("fleet-heartbeat")}\nbeat stopped`)], MARKER), {
    action: "none",
  });
});

test("W1-T3030 criterion 2 (falsifier): a matching TITLE with no marker is never closed", () => {
  // THE HAND-WRITTEN-ISSUE ROW. A careless implementation falls back to title matching, and that is
  // exactly how a cron job closes an issue a human opened.
  assert.deepEqual(
    decideRecovery([issue(9001, "a human wrote this and it has no marker", "mutation-nightly is failing")], MARKER),
    { action: "none" },
  );
});

test("W1-T3030 criterion 3 (falsifier): no matching issue is a no-op, not an error", () => {
  assert.deepEqual(decideRecovery([], MARKER), { action: "none" });
  assert.deepEqual(decideRecovery(undefined, MARKER), { action: "none" });
});

test("W1-T3030 criterion 3: the CLI reports the no-op and exits 0, so every green run may call it", () => {
  const calls: string[][] = [];
  const code = main({
    argv: ["--resolved", "--source", "mutation-nightly"],
    env: {},
    resolveFn: (a: { source: string }) => {
      calls.push(["resolve", a.source]);
      return { action: "none", marker: markerFor(a.source) };
    },
    log: () => {},
    error: () => {},
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [["resolve", "mutation-nightly"]]);
});

test("W1-T3030: --resolved still requires --source, because the marker is the close identity", () => {
  const errors: string[] = [];
  const calls: string[][] = [];
  const code = main({
    argv: ["--resolved"],
    env: {},
    resolveFn: () => {
      calls.push(["resolve"]);
      return { action: "none", marker: "" };
    },
    log: () => {},
    error: (m: string) => errors.push(m),
  });
  assert.equal(code, 1);
  assert.deepEqual(calls, [], "must not resolve without the source marker identity");
  assert.match(errors.join("\n"), /--source is required/);
});

test("W1-T3030: --resolved does not require --title, which a green run has no reason to pass", () => {
  const code = main({
    argv: ["--resolved", "--source", "clock-sweep"],
    env: {},
    resolveFn: () => ({ action: "close", number: 1, marker: markerFor("clock-sweep") }),
    log: () => {},
    error: () => {},
  });
  assert.equal(code, 0);
});

test("W1-T3030: --resolved reports resolver failures loudly", () => {
  const errors: string[] = [];
  const code = main({
    argv: ["--resolved", "--source", "mutation-nightly"],
    env: {},
    resolveFn: () => {
      throw new Error("HTTP 500");
    },
    log: () => {},
    error: (m: string) => errors.push(m),
  });
  assert.equal(code, 1);
  assert.match(errors.join("\n"), /RESOLVE FAILED -- HTTP 500/);
});

test("W1-T3030 (falsifier): a FAILED issue read closes nothing", () => {
  // Design (iv): deliver() swallows a failed list because an unnotified human is worse. The
  // opposite polarity applies here -- an empty list from a failed read is indistinguishable from
  // "nothing to close", so the swallow may only ever produce the no-op.
  const seen: string[] = [];
  const out = resolve(
    { source: "mutation-nightly", body: "b" },
    (_file: string, args: string[]) => {
      seen.push(args[0]);
      if (args[0] === "issue" && args[1] === "list") throw new Error("network down");
      return "";
    },
  );
  assert.deepEqual(out.action, "none");
  assert.ok(!seen.includes("close"), "a read failure must never reach a close");
});

test("W1-T3030 (falsifier): resolve() closes via comment-then-close, and only the matched number", () => {
  const argv: string[][] = [];
  const out = resolve(
    { source: "mutation-nightly", body: "recovered" },
    (_file: string, args: string[]) => {
      argv.push(args);
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([issue(4242, `${MARKER}\nfailing`), issue(7, "unrelated")]);
      }
      return "";
    },
  );
  assert.equal(out.action, "close");
  assert.equal(out.number, 4242);
  const acted = argv.filter((a) => a[1] === "comment" || a[1] === "close");
  assert.deepEqual(
    acted.map((a) => [a[1], a[2]]),
    [["comment", "4242"], ["close", "4242"]],
  );
});

test("W1-T3030 (falsifier): the RAISE path is unmoved by the new mode", () => {
  // If adding a resolver changed the raiser at all, the change is wrong however well it closes.
  assert.deepEqual(decideDelivery([issue(5, `${MARKER}\nx`)], MARKER), { action: "comment", number: 5 });
  assert.deepEqual(decideDelivery([], MARKER), { action: "create" });
});

test("W1-T3030 criterion 4: every workflow that RAISES also RESOLVES", () => {
  // The wiring is the half that makes this reach production, and a test that only exercises the
  // script would pass with all four call sites missing. Derived from the workflow files themselves,
  // so a fifth caller added later without a recovery path fails here.
  const dir = join(REPO_ROOT, ".github", "workflows");
  const files = ["mutation-nightly", "fleet-heartbeat-watch", "clock-sweep", "recovery-drill"];
  const raisers: string[] = [];
  for (const f of files) {
    const text = readFileSync(join(dir, `${f}.yml`), "utf8");
    if (!text.includes("needs-human-issue.mjs")) continue;
    raisers.push(f);
    assert.match(text, /--resolved --source \S+/, `${f} raises a needs-human issue but never resolves one`);
    assert.match(text, /if: success\(\)/, `${f}'s resolver must be gated on success`);
  }
  assert.equal(raisers.length, 4, "all four known raisers must be covered");
});
