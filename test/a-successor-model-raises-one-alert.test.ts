import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  buildSuccessorEscalation,
  classifySuccessor,
  findSuccessors,
  MODEL_ID_RE,
  parseModelId,
  watchSuccessorModels,
  watchSuccessorModelsBestEffort,
  readCashCatalog,
  type CatalogSnapshot,
  type ModelAvailabilityAlertedEntry,
  type RoutedLadderRow,
  type SuccessorModel,
} from "../src/lib/model-availability.js";
import type { Escalation } from "../src/lib/escalate.js";

// W1-T4080 (operator ruling `operator-ruling#azure-gpt6-2026-09-22`): W1-T4079 makes the switch
// automatic once a model is deployed and priced; this task's watch exists so the operator hears
// about a successor the moment the catalog offers it, even before either of those manual acts.

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}model-availability-`));
}

function ledgerPath(): string {
  return join(tmpRoot(), "ledger.ndjson");
}

function readLines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// A minimal routed ladder: gpt-5.6-luna is the only READY row in the luna family, mirroring
// mounts.yaml's own shape before W1-T4079's promotion (gpt-6-luna still awaiting readiness).
const ROUTED: RoutedLadderRow[] = [
  { model: "gpt-5.6-luna", ready: true },
  { model: "gpt-6-luna", ready: false },
  { model: "gpt-5.6-sol", ready: true },
];

function catalog(overrides: Partial<CatalogSnapshot> = {}): CatalogSnapshot {
  return { listed: [], deployed: [], priced: [], ...overrides };
}

// ── parseModelId ─────────────────────────────────────────────────────────────

test("W1-T4080: parseModelId reads family and generation, and refuses a non-matching id", () => {
  assert.deepEqual(parseModelId("gpt-6-luna"), { family: "luna", generation: 6 });
  assert.deepEqual(parseModelId("gpt-5.6-terra"), { family: "terra", generation: 5.6 });
  assert.equal(parseModelId("gpt-oss-120b"), undefined);
  assert.equal(parseModelId("not-a-model"), undefined);
});

test("W1-T4080: MODEL_ID_RE accepts a gpt-<generation>-<family> id and rejects everything else", () => {
  // The healthy arm — a real routed/catalog id matches.
  assert.equal(MODEL_ID_RE.test("gpt-6-luna"), true);
  assert.equal(MODEL_ID_RE.test("gpt-5.6-terra"), true);
  // The unhealthy arm — an id with no generation segment, or no family segment, is refused.
  assert.equal(MODEL_ID_RE.test("gpt-oss-120b"), false);
  assert.equal(MODEL_ID_RE.test("gpt-6"), false);
  assert.equal(MODEL_ID_RE.test("not-a-model"), false);
});

// ── Acceptance (1): a higher generation in a routed family is a successor ────

test("W1-T4080: a higher generation in a routed family is a successor", () => {
  const successors = findSuccessors(["gpt-6-luna", "gpt-5.6-luna"], ROUTED);
  assert.equal(successors.length, 1);
  assert.equal(successors[0]!.model, "gpt-6-luna");
  assert.equal(successors[0]!.family, "luna");
  assert.equal(successors[0]!.predecessor, "gpt-5.6-luna");
});

test("W1-T4080: an id already routed as READY is never its own successor", () => {
  const successors = findSuccessors(["gpt-5.6-luna", "gpt-5.6-sol"], ROUTED);
  assert.deepEqual(successors, []);
});

test("W1-T4080: a lower or equal generation is never a successor", () => {
  const successors = findSuccessors(["gpt-5.3-luna", "gpt-5.6-luna"], ROUTED);
  assert.deepEqual(successors, []);
});

test("W1-T4080: classifySuccessor reads announced, deployed-unpriced, and ready off the catalog", () => {
  assert.equal(classifySuccessor("gpt-6-luna", catalog()), "announced");
  assert.equal(classifySuccessor("gpt-6-luna", catalog({ deployed: ["gpt-6-luna"] })), "deployed-unpriced");
  assert.equal(
    classifySuccessor("gpt-6-luna", catalog({ deployed: ["gpt-6-luna"], priced: ["gpt-6-luna"] })),
    "ready",
  );
});

// ── Acceptance (2): one alert per successor state, naming the next step ──────

test("W1-T4080: one alert per successor state, naming the next step", () => {
  const successor: SuccessorModel = { model: "gpt-6-luna", family: "luna", generation: 6, predecessor: "gpt-5.6-luna" };

  const announced = buildSuccessorEscalation(successor, "announced");
  assert.match(announced.detail, /az cognitiveservices account deployment create/);
  assert.match(announced.detail, /gpt-6-luna/);
  assert.equal(announced.options.length >= 1, true);

  const deployedUnpriced = buildSuccessorEscalation(successor, "deployed-unpriced");
  assert.match(deployedUnpriced.detail, /price row/);
  assert.match(deployedUnpriced.detail, /OPENWEIGHT_PRICES/);
  assert.doesNotMatch(deployedUnpriced.detail, /az cognitiveservices/);

  const ready = buildSuccessorEscalation(successor, "ready");
  assert.match(ready.detail, /nothing is missing/);
  assert.match(ready.detail, /automatically/);
  assert.doesNotMatch(ready.detail, /price row/);
  assert.doesNotMatch(ready.detail, /az cognitiveservices/);

  // Three distinct states name three distinct next steps — never the same sentence twice.
  const details = new Set([announced.detail, deployedUnpriced.detail, ready.detail]);
  assert.equal(details.size, 3);
});

test("W1-T4080: watchSuccessorModels raises exactly one escalation per successor found", async () => {
  const ledger = ledgerPath();
  const escalated: Escalation[] = [];
  const result = await watchSuccessorModels(
    catalog({ listed: ["gpt-6-luna"] }),
    ROUTED,
    {
      escalate: (e) => {
        escalated.push(e);
        return `https://example.invalid/issues/${escalated.length}`;
      },
      ledgerPath: ledger,
      runId: "TEST-RUN-1",
    },
  );
  assert.equal(escalated.length, 1);
  assert.equal(result.alerted.length, 1);
  const alerted: ModelAvailabilityAlertedEntry = result.alerted[0]!;
  assert.equal(alerted.state, "announced");
  assert.equal(alerted.successor.model, "gpt-6-luna");

  const lines = readLines(ledger);
  assert.equal(lines.filter((l) => l.step === "model-availability.read").length, 1);
  assert.equal(lines.filter((l) => l.step === "model-availability.alerted").length, 1);
});

test("W1-T4080: an unchanged state is never re-alerted, but every reading is still ledgered", async () => {
  const ledger = ledgerPath();
  let escalateCalls = 0;
  const deps = {
    escalate: () => {
      escalateCalls += 1;
      return "https://example.invalid/issues/1";
    },
    ledgerPath: ledger,
    runId: "TEST-RUN-1",
  };

  const first = await watchSuccessorModels(catalog({ listed: ["gpt-6-luna"] }), ROUTED, deps);
  assert.equal(first.alerted.length, 1);
  assert.equal(escalateCalls, 1);

  // Same state ("announced") on a second reading — no second escalation, but a second reading.
  const second = await watchSuccessorModels(catalog({ listed: ["gpt-6-luna"] }), ROUTED, { ...deps, runId: "TEST-RUN-2" });
  assert.equal(second.alerted.length, 0);
  assert.equal(second.skippedUnchanged.length, 1);
  assert.equal(escalateCalls, 1, "no repeat escalation for an unchanged state");

  const lines = readLines(ledger);
  assert.equal(lines.filter((l) => l.step === "model-availability.read").length, 2, "every reading is ledgered");
  assert.equal(lines.filter((l) => l.step === "model-availability.alerted").length, 1);

  // The state CHANGES (now deployed-and-priced) — a fresh alert fires.
  const third = await watchSuccessorModels(
    catalog({ listed: ["gpt-6-luna"], deployed: ["gpt-6-luna"], priced: ["gpt-6-luna"] }),
    ROUTED,
    { ...deps, runId: "TEST-RUN-3" },
  );
  assert.equal(third.alerted.length, 1);
  assert.equal(third.alerted[0]!.state, "ready");
  assert.equal(escalateCalls, 2, "a changed state raises a fresh alert");
});

// ── Acceptance (3): a gated family is reported but never proposed for routing ────

test("W1-T4080: a gated family is reported but never proposed", () => {
  // Astra has no routed predecessor at all (mounts.yaml deliberately never routes it) — it is
  // still found, because design (iv) reports a gated family unconditionally.
  const successors = findSuccessors(["gpt-6-astra"], ROUTED);
  assert.equal(successors.length, 1);
  assert.equal(successors[0]!.model, "gpt-6-astra");
  assert.equal(successors[0]!.predecessor, undefined, "astra has no routed predecessor to succeed");

  for (const state of ["announced", "deployed-unpriced", "ready"] as const) {
    const escalation = buildSuccessorEscalation(successors[0]!, state);
    assert.match(escalation.detail, /human-gated astra family/);
    assert.match(escalation.detail, /never (?:be )?proposed for automatic routing/i);
    assert.match(escalation.detail, /modelApprovals/);
    // Never claims the family switches over automatically, whatever the deploy/price state is.
    assert.doesNotMatch(escalation.detail, /switches to gpt-6-astra over/);
  }
});

test("W1-T4080: watchSuccessorModels still escalates a gated successor, naming it as gated", async () => {
  const ledger = ledgerPath();
  const escalated: Escalation[] = [];
  await watchSuccessorModels(
    catalog({ listed: ["gpt-6-astra"] }),
    ROUTED,
    {
      escalate: (e) => {
        escalated.push(e);
        return "https://example.invalid/issues/astra";
      },
      ledgerPath: ledger,
      runId: "TEST-RUN-ASTRA",
    },
  );
  assert.equal(escalated.length, 1);
  assert.match(escalated[0]!.detail, /human-gated astra family/);
  const lines = readLines(ledger);
  const read = lines.find((l) => l.step === "model-availability.read");
  assert.equal(read?.gated, "astra");
});

test("W1-T4080: the cadence's best-effort watch runs the watch and reports it as watched", async () => {
  const ledger = ledgerPath();
  const escalated: Escalation[] = [];
  const outcome = await watchSuccessorModelsBestEffort(async () => ({
    catalog: catalog({ listed: ["gpt-6-luna"] }),
    routed: ROUTED,
    deps: {
      escalate: (e) => {
        escalated.push(e);
        return "https://example.invalid/issues/1";
      },
      ledgerPath: ledger,
      runId: "TEST-RUN-BEST-EFFORT",
    },
  }));
  assert.equal(outcome.status, "watched");
  assert.equal(outcome.status === "watched" ? outcome.result.alerted.length : -1, 1);
  assert.equal(escalated.length, 1);
});

test("W1-T4080: a failed catalog read never throws out of the cadence, and escalates nothing", async () => {
  const escalated: Escalation[] = [];
  const boom = new Error("cash catalog unreachable");
  const outcome = await watchSuccessorModelsBestEffort(async () => {
    throw boom;
  });
  // The failure is CARRIED, not erased: a caller can tell "the watch failed" from "nothing to alert".
  assert.deepEqual(outcome, { status: "failed", error: boom });
  assert.equal(escalated.length, 0);
});

/** A fetch fake answering the two cash listing paths by suffix. */
function cashFetch(answer: (url: string) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request) => answer(String(input))) as typeof fetch;
}

test("W1-T4080: readCashCatalog reads listed and deployed ids off the two cash listing paths", async () => {
  const seen: string[] = [];
  const result = await readCashCatalog({
    cashEndpoint: "https://cash.example.invalid",
    apiKey: "test-key",
    fetchImpl: cashFetch((url) => {
      seen.push(url);
      const ids = url.includes("openai/deployments") ? ["gpt-6-luna"] : ["gpt-6-luna", "gpt-7-luna"];
      // A non-string id is dropped rather than coerced.
      return Response.json({ data: [...ids.map((id) => ({ id })), { id: 7 }] });
    }),
  });
  assert.deepEqual(result, { listed: ["gpt-6-luna", "gpt-7-luna"], deployed: ["gpt-6-luna"] });
  assert.ok(seen.every((url) => url.startsWith("https://cash.example.invalid/openai/")), JSON.stringify(seen));
});

test("W1-T4080: a cash listing with no data array, a non-2xx status, or a failed fetch reads as nothing observed", async () => {
  const deps = { cashEndpoint: "https://cash.example.invalid/", apiKey: "test-key" };
  const noArray = await readCashCatalog({ ...deps, fetchImpl: cashFetch(() => Response.json({ data: "unexpected" })) });
  assert.deepEqual(noArray, { listed: [], deployed: [] });
  const refused = await readCashCatalog({ ...deps, fetchImpl: cashFetch(() => new Response("nope", { status: 503 })) });
  assert.deepEqual(refused, { listed: [], deployed: [] });
  const unreachable = await readCashCatalog({
    ...deps,
    fetchImpl: cashFetch(() => {
      throw new Error("ECONNREFUSED");
    }),
  });
  assert.deepEqual(unreachable, { listed: [], deployed: [] });
});
