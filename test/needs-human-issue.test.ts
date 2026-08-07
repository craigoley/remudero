import { strict as assert } from "node:assert";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// scripts/** sits outside tsconfig's `include`, so a static import of a .mjs from TS is a TS7016.
// The repo idiom (see test/mutation-ratchet.test.ts) is a runtime import of the real module --
// which also guarantees these assertions run against the file the workflow executes, not a copy.
const MODULE_URL = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "needs-human-issue.mjs"),
).href;

type Issue = { number: number; body: string; title: string };
type Delivered = { action: string; number?: number; url?: string; marker: string };

const mod = (await import(MODULE_URL)) as {
  MAX_BODY: number;
  markerFor: (source: string) => string;
  decideDelivery: (issues: Issue[], marker: string) => { action: string; number?: number };
  truncateBody: (body: string, max?: number) => string;
  buildBody: (input: {
    source: string;
    marker: string;
    runUrl?: string;
    log?: string;
    when?: string;
  }) => string;
  deliver: (
    input: { source: string; title: string; body: string; label?: string; repo?: string },
    exec: (file: string, args: string[]) => string,
  ) => Delivered;
  main: (opts?: {
    argv?: string[];
    env?: Record<string, string>;
    readFile?: (p: string) => string;
    deliverFn?: (input: { source: string; title: string; body: string }) => Delivered;
    log?: (m: string) => void;
    error?: (m: string) => void;
  }) => number;
};

const { MAX_BODY, markerFor, decideDelivery, truncateBody, buildBody, deliver, main } = mod;

test("decideDelivery opens a new issue when nothing is tracking this source yet", () => {
  assert.deepEqual(decideDelivery([], markerFor("mutation-nightly")), { action: "create" });
});

test("decideDelivery comments on the existing issue instead of opening a nightly duplicate", () => {
  const marker = markerFor("mutation-nightly");
  const issues: Issue[] = [{ number: 42, body: `${marker}\nscore dropped`, title: "mutation-nightly is failing" }];
  assert.deepEqual(decideDelivery(issues, marker), { action: "comment", number: 42 });
});

test("decideDelivery still matches after a human retitles the issue while triaging it", () => {
  const marker = markerFor("mutation-nightly");
  const issues: Issue[] = [{ number: 7, body: `${marker}\nlog`, title: "investigating: classify.ts regressed" }];
  assert.deepEqual(decideDelivery(issues, marker), { action: "comment", number: 7 });
});

test("decideDelivery does not hijack a DIFFERENT source's issue", () => {
  // The falsifier that matters: if the marker did not discriminate by source, mutation-nightly
  // would comment onto clock-sweep's open issue and its own failure would be buried in an
  // unrelated thread -- a delivery gap dressed up as a delivered notification.
  const issues: Issue[] = [{ number: 9, body: `${markerFor("clock-sweep")}\nsweep drifted`, title: "clock-sweep is failing" }];
  assert.deepEqual(decideDelivery(issues, markerFor("mutation-nightly")), { action: "create" });
});

test("truncateBody keeps the TAIL, where the diagnosis is, and says it truncated", () => {
  const body = `${"H".repeat(500)}DIAGNOSIS-AT-THE-END`;
  const out = truncateBody(body, 200);
  assert.ok(out.length <= 200, `expected <=200, got ${out.length}`);
  assert.ok(out.includes("DIAGNOSIS-AT-THE-END"), "tail must survive truncation");
  assert.ok(out.includes("log truncated"), "truncation must be disclosed, never silent");
  assert.ok(!out.includes("HHHHHHHHHH".repeat(10)), "head should be the part dropped");
});

test("truncateBody leaves a body that already fits completely alone", () => {
  const body = "short body";
  assert.equal(truncateBody(body, MAX_BODY), body);
});

test("buildBody carries the marker, the run URL and the captured log", () => {
  const body = buildBody({
    source: "mutation-nightly",
    marker: markerFor("mutation-nightly"),
    runUrl: "https://example.invalid/run/1",
    log: "mutation-ratchet: NIGHTLY BLOCKED -- mutation score dropped",
    when: "schedule",
  });
  assert.ok(body.includes(markerFor("mutation-nightly")), "marker carries identity across runs");
  assert.ok(body.includes("https://example.invalid/run/1"), "must not be a dead end");
  assert.ok(body.includes("NIGHTLY BLOCKED"), "the actionable diagnosis must reach the reader");
  assert.ok(body.length <= MAX_BODY);
});

test("buildBody keeps the marker when the log is far too big, so idempotency survives truncation", () => {
  // The falsifier for idempotency itself. truncateBody keeps the TAIL and the marker sits at the
  // HEAD, so trimming the ASSEMBLED body drops the marker first -- and a delivered body with no
  // marker is invisible to decideDelivery, which would then open a fresh issue every single run.
  // mutation-nightly's captured log really is this size: its report carries over 27,000 surviving
  // mutants and Stryker prints each one.
  const marker = markerFor("mutation-nightly");
  const body = buildBody({
    source: "mutation-nightly",
    marker,
    runUrl: "https://example.invalid/run/2",
    log: `${"x".repeat(MAX_BODY * 8)}\nmutation-ratchet: NIGHTLY BLOCKED -- INVALID RUN`,
    when: "schedule",
  });
  assert.ok(body.length <= MAX_BODY, `expected <=${MAX_BODY}, got ${body.length}`);
  assert.ok(body.includes(marker), "the marker must survive, or every run opens a new issue");
  assert.deepEqual(decideDelivery([{ number: 3, body, title: "renamed by a human" }], marker), {
    action: "comment",
    number: 3,
  });
  assert.ok(body.includes("INVALID RUN"), "the tail diagnosis must still reach the reader");
  assert.ok(body.includes("https://example.invalid/run/2"), "the envelope must survive too");
});

test("deliver creates a labelled issue when none exists, and never sends a bare `gh issue create` without the label", () => {
  const calls: string[][] = [];
  const exec = (_file: string, args: string[]): string => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") return "[]";
    return "https://example.invalid/issues/5\n";
  };
  const out = deliver({ source: "mutation-nightly", title: "t", body: "b" }, exec);
  assert.equal(out.action, "create");
  assert.equal(out.url, "https://example.invalid/issues/5");
  const create = calls.find((c) => c[0] === "issue" && c[1] === "create");
  assert.ok(create, "expected an issue create call");
  assert.ok(create.includes("--label") && create.includes("needs-human"), "must be discoverable by label");
});

test("deliver comments on the tracked issue and does NOT create a second one", () => {
  const marker = markerFor("mutation-nightly");
  const calls: string[][] = [];
  const exec = (_file: string, args: string[]): string => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") {
      return JSON.stringify([{ number: 31, body: `${marker}\nprev`, title: "mutation-nightly is failing" }]);
    }
    return "";
  };
  const out = deliver({ source: "mutation-nightly", title: "t", body: "b" }, exec);
  assert.deepEqual({ action: out.action, number: out.number }, { action: "comment", number: 31 });
  assert.ok(
    !calls.some((c) => c[0] === "issue" && c[1] === "create"),
    "a nightly job must never open a duplicate per failure",
  );
  const comment = calls.find((c) => c[0] === "issue" && c[1] === "comment");
  assert.equal(comment?.[2], "31");
});

test("deliver still notifies when the label lookup itself fails", () => {
  // `gh issue list --label` errors if the label does not exist yet. An unnotified human is a worse
  // outcome than an unlabelled issue, so the lookup failure must degrade to `create`, not throw.
  const calls: string[][] = [];
  const exec = (_file: string, args: string[]): string => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") throw new Error("could not find any label named needs-human");
    return "https://example.invalid/issues/6\n";
  };
  const out = deliver({ source: "mutation-nightly", title: "t", body: "b" }, exec);
  assert.equal(out.action, "create");
  assert.ok(calls.some((c) => c[1] === "create"), "delivery must survive a missing label");
});

test("deliver propagates a real create failure so the workflow reports it loudly", () => {
  // A notifier that swallows its own failure recreates the silence it exists to remove.
  const exec = (_file: string, args: string[]): string => {
    if (args[0] === "issue" && args[1] === "list") return "[]";
    throw new Error("HTTP 403");
  };
  assert.throws(() => deliver({ source: "mutation-nightly", title: "t", body: "b" }, exec), /403/);
});

test("deliver treats unparseable `gh issue list` output as no-issues rather than crashing", () => {
  // gh can emit a warning banner ahead of the JSON; a parse crash here would sink the delivery.
  const exec = (_file: string, args: string[]): string =>
    args[1] === "list" ? "not json at all" : "https://example.invalid/issues/8\n";
  assert.equal(deliver({ source: "mutation-nightly", title: "t", body: "b" }, exec).action, "create");
});

// Shared on purpose: a test asserting "delivery was never attempted" cannot cover its own inline
// stub (the body is unreachable by construction), which would leave permanently uncovered added
// lines. Hoisting it means the body is exercised by the tests that DO deliver.
function deliverRecorder(result: Delivered) {
  const calls: Array<{ source: string; title: string; body: string }> = [];
  return {
    calls,
    deliverFn: (input: { source: string; title: string; body: string }) => {
      calls.push(input);
      return result;
    },
  };
}

test("main exits 1 without notifying when required arguments are missing", () => {
  const errs: string[] = [];
  const d = deliverRecorder({ action: "create", marker: "" });
  const code = main({
    argv: ["--source", "mutation-nightly"], // no --title
    deliverFn: d.deliverFn,
    error: (m) => errs.push(m),
    log: () => {},
  });
  assert.equal(code, 1);
  assert.equal(d.calls.length, 0, "must not attempt a delivery it cannot address");
  assert.match(errs.join("\n"), /required/);
});

test("main reads the body file, stamps the run URL, and reports the issue it opened", () => {
  const logs: string[] = [];
  const seen: Array<{ source: string; title: string; body: string }> = [];
  const code = main({
    argv: ["--source", "mutation-nightly", "--title", "mutation-nightly is failing", "--body-file", "/x.log"],
    env: { RUN_URL: "https://example.invalid/run/3", RUN_WHEN: "schedule" },
    readFile: () => "NIGHTLY BLOCKED -- score dropped",
    deliverFn: (input) => {
      seen.push(input);
      return { action: "create", url: "https://example.invalid/issues/12", marker: "" };
    },
    log: (m) => logs.push(m),
    error: () => {},
  });
  assert.equal(code, 0);
  assert.equal(seen.length, 1, "deliver must be called exactly once");
  assert.ok(seen[0].body.includes("NIGHTLY BLOCKED"), "the captured diagnosis must reach the issue body");
  assert.ok(seen[0].body.includes("https://example.invalid/run/3"), "run URL must be stamped from the environment");
  assert.match(logs.join("\n"), /opened https:\/\/example\.invalid\/issues\/12/);
});

test("main reports the comment path distinctly, so a reader can tell a repeat night from a new one", () => {
  const logs: string[] = [];
  // Uses the SHARED recorder, which is what covers its body for the never-invoked assertion above.
  const d = deliverRecorder({ action: "comment", number: 77, marker: markerFor("mutation-nightly") });
  const code = main({
    argv: ["--source", "mutation-nightly", "--title", "t"],
    deliverFn: d.deliverFn,
    log: (m) => logs.push(m),
    error: () => {},
  });
  assert.equal(code, 0);
  assert.equal(d.calls.length, 1);
  assert.match(logs.join("\n"), /commented on existing issue #77/);
});

test("main exits 1 when delivery itself fails, so the job never looks green-adjacent", () => {
  const errs: string[] = [];
  const code = main({
    argv: ["--source", "mutation-nightly", "--title", "t"],
    deliverFn: () => {
      throw new Error("HTTP 403");
    },
    log: () => {},
    error: (m) => errs.push(m),
  });
  assert.equal(code, 1);
  assert.match(errs.join("\n"), /DELIVERY FAILED -- HTTP 403/);
});
