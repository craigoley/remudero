// W1-T4642: openapi/daemon.yaml must describe the bodies the daemon ACTUALLY SENDS, not the ones
// it sent when a route was first written. W1-T4579 checks that every served PATH is declared; this
// suite checks the SHAPES on the routes the 2026-09-28 thread audit found mis-stated -- the
// /v1/registry 503, the confirm-nonce 403 on every HIGH-tier route, /v1/pr-actions' tier since
// W1-T4077's ruling, and the feedback entry GET /v1/feedback serves -- plus the two HighTier refusal
// schemas W1-T4611 and W1-T4612 declared side by side.
//
// Every body below comes off the REAL assembled server (buildServeServer over injected deps) or the
// real feedback writer, and is validated against the schema the spec declares for that exact route
// and status. The validator is STRICT on one axis JSON Schema is not: a key the body carries that
// the schema never declares is a violation, because "the contract says what the daemon sends" is
// exactly the claim an undeclared key falsifies. Its own positive/negative control runs first.
import type { PrQueueRow } from "../src/lib/board.js";
import type { BlockedPrBlocker, MergeHeldRow } from "../src/lib/status-board.js";
import type { ConsoleModelApproval } from "../src/lib/serve.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { captureFeedback, setFeedbackStatus } from "../src/lib/feedback.js";
import { prActionSwitchOffPath } from "../src/lib/fleet-control.js";
import { buildServeRoutes, buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import { fakeGitHub } from "./helpers/fake-github.js";

const ROOT = join(import.meta.dirname, "..");
const SPEC = parseYaml(readFileSync(join(ROOT, "openapi", "daemon.yaml"), "utf8")) as Spec;

const READ_TOKEN = "contract-read-token";
const WRITE_TOKEN = "contract-write-token";
const CAPABILITY = "example.com/cap/console-write";
const bearerRead = { authorization: `Bearer ${READ_TOKEN}` };
const bearerWrite = { authorization: `Bearer ${WRITE_TOKEN}` };
/** Tailnet identity is the HIGH-tier grantor, so on a HIGH route only the nonce gate is left to refuse. */
const identityHigh = { "tailscale-app-capabilities": JSON.stringify({ [CAPABILITY]: [{ role: "member" }] }) };

type Schema = Record<string, unknown>;
type Operation = { description?: string; parameters?: Schema[]; responses: Record<string, Schema> };
type Spec = { paths: Record<string, Record<string, Operation>>; components: { schemas: Record<string, Schema>; responses: Record<string, Schema> } };

function resolve(node: Schema): Schema {
  const ref = node.$ref;
  if (typeof ref !== "string") return node;
  const m = /^#\/components\/(schemas|responses)\/(.+)$/.exec(ref);
  assert.ok(m, `unsupported $ref ${ref}`);
  const target = SPEC.components[m[1] as "schemas" | "responses"][m[2]!];
  assert.ok(target, `$ref ${ref} names nothing`);
  return resolve(target);
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/** Every way `value` fails `schema` -- the OpenAPI subset daemon.yaml uses, strict on undeclared keys. */
function violations(value: unknown, node: Schema, at = "$"): string[] {
  const schema = resolve(node);
  if (Array.isArray(schema.oneOf)) {
    const matching = (schema.oneOf as Schema[]).filter((branch) => violations(value, branch, at).length === 0).length;
    return matching === 1 ? [] : [`${at}: matches ${matching} oneOf branches, not exactly one`];
  }
  const types = schema.type === undefined ? [] : ([] as string[]).concat(schema.type as string | string[]);
  const actual = jsonType(value);
  if (types.length > 0 && !types.includes(actual) && !(actual === "integer" && types.includes("number"))) {
    return [`${at}: is ${actual}, declared ${types.join("|")}`];
  }
  if ("const" in schema && value !== schema.const) return [`${at}: is ${JSON.stringify(value)}, declared const ${JSON.stringify(schema.const)}`];
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return [`${at}: ${JSON.stringify(value)} is not in enum ${JSON.stringify(schema.enum)}`];
  if (typeof schema.pattern === "string" && typeof value === "string" && !new RegExp(schema.pattern).test(value)) {
    return [`${at}: ${JSON.stringify(value)} does not match ${schema.pattern}`];
  }
  if (actual === "array" && schema.items) return (value as unknown[]).flatMap((item, i) => violations(item, schema.items as Schema, `${at}[${i}]`));
  if (actual !== "object") return [];
  const record = value as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, Schema>;
  const missing = ((schema.required ?? []) as string[]).filter((key) => !(key in record)).map((key) => `${at}.${key}: required, absent`);
  const perKey = Object.entries(record).flatMap(([key, v]) => {
    if (properties[key]) return violations(v, properties[key]!, `${at}.${key}`);
    if (typeof schema.additionalProperties === "object") return violations(v, schema.additionalProperties as Schema, `${at}.${key}`);
    return schema.additionalProperties === true ? [] : [`${at}.${key}: sent, never declared`];
  });
  return [...missing, ...perKey];
}

function operation(path: string, method: string): Operation {
  const op = SPEC.paths[path]?.[method.toLowerCase()];
  assert.ok(op, `${method} ${path} is not declared in openapi/daemon.yaml`);
  return op;
}

/** The JSON body schema the spec declares for one route's one status. */
function declaredBody(path: string, method: string, status: number): Schema {
  const response = operation(path, method).responses[String(status)];
  assert.ok(response, `${method} ${path} declares no ${status}`);
  const schema = (resolve(response).content as Record<string, { schema: Schema }> | undefined)?.["application/json"]?.schema;
  assert.ok(schema, `${method} ${path}'s ${status} declares no JSON body`);
  return schema;
}

function assertSends(path: string, method: string, status: number, body: unknown): void {
  assert.deepEqual(violations(body, declaredBody(path, method, status)), [], `${method} ${path} ${status} sent ${JSON.stringify(body)}`);
}

/** Whether a route's declared 403 admits the HIGH tier's second-factor refusal -- the contract's tier signal. */
function admitsNonceRefusal(path: string, method: string): boolean {
  return violations({ error: "confirm_nonce_required" }, declaredBody(path, method, 403)).length === 0;
}

function depsFor(root: string, extra: Partial<ServeDeps> = {}): ServeDeps {
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(ledgerPath, "");
  writeFileSync(planPath, "[]\n");
  return {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github: fakeGitHub() },
    panelGraph: {
      root,
      planPath,
      ledgerPath,
      github: { prView: () => null },
      statusGithub: fakeGitHub(),
      ratify: { approve: () => {}, reframe: () => {} },
    },
    ledgerPath,
    issues: { close: () => {} },
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    identity: { trustedLocalAddress: "127.0.0.1", capability: CAPABILITY },
    log: () => {},
    ...extra,
  };
}

async function withServer<T>(deps: ServeDeps, fn: (base: string) => Promise<T>): Promise<T> {
  const server = buildServeServer(deps);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

async function call(base: string, method: string, path: string, headers: Record<string, string>, payload: unknown = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    ...(method === "GET" ? {} : { body: JSON.stringify(payload) }),
  });
  return { status: res.status, body: await res.json() };
}

function tmpRoot(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1t4642-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("the strict validator's own control: a declared shape passes, a wrong enum value and an undeclared key fail", () => {
  const error = { $ref: "#/components/schemas/Error" };
  assert.deepEqual(violations({ error: "forbidden", required_scope: "write" }, error), []);
  assert.equal(violations({ error: "no_such_code" }, error).length, 1, "an enum miss is a violation");
  assert.equal(violations({ error: "forbidden", extra: 1 }, error).length, 1, "an undeclared key is a violation");
  assert.equal(violations({}, error).length, 1, "a missing required key is a violation");
  assert.equal(violations("forbidden", error).length, 1, "a wrong JSON type is a violation");
});

test("the /v1/registry 503 the daemon sends validates against its declared 503, for an unreadable and a refused registry", async (t) => {
  const unreadable = depsFor(tmpRoot(t), {
    registry: {
      repoRegistryPath: "/nonexistent/daemon-instances.yaml",
      readText: async () => {
        throw new Error("ENOENT");
      },
    },
  });
  const refused = depsFor(tmpRoot(t), { registry: { repoRegistryPath: "/r.yaml", readText: async () => "no instances here\n" } });
  for (const deps of [unreadable, refused]) {
    await withServer(deps, async (base) => {
      const sent = await call(base, "GET", "/v1/registry", bearerRead);
      assert.equal(sent.status, 503);
      assert.equal((sent.body as { error: string }).error, "registry_unavailable");
      assertSends("/v1/registry", "GET", 503, sent.body);
    });
  }
});

test("every HIGH-tier route's two dispatch refusals -- the tier refusal and confirm_nonce_required -- validate against its declared 403", async (t) => {
  const deps = depsFor(tmpRoot(t));
  const high = buildServeRoutes(deps).filter((route) => route.tier === "high");
  // CORPUS CONTROL: a table that stopped yielding HIGH routes would pass this vacuously.
  assert.ok(high.length >= 10, `the assembled table must carry the HIGH routes, saw ${high.length}`);
  await withServer(deps, async (base) => {
    for (const route of high) {
      const tier = await call(base, route.method, route.path, bearerWrite);
      assert.equal(tier.status, 403, `${route.path}: the LOW bearer token must be refused`);
      assert.deepEqual(tier.body, { error: "forbidden", required_scope: "write", required_tier: "high" });
      assertSends(route.path, route.method, 403, tier.body);

      const nonce = await call(base, route.method, route.path, identityHigh);
      assert.equal(nonce.status, 403, `${route.path}: a HIGH credential with no nonce must be refused`);
      assert.deepEqual(nonce.body, { error: "confirm_nonce_required" });
      assertSends(route.path, route.method, 403, nonce.body);
    }
  });
});

test("a route's declared 403 admits the nonce refusal exactly when the daemon serves it HIGH", (t) => {
  const routes = buildServeRoutes(depsFor(tmpRoot(t))).filter((route) => route.scope === "write" && operationDeclares403(route.path, route.method));
  assert.ok(routes.length >= 40, `the assembled table's write routes must be read, saw ${routes.length}`);
  const mismatched = routes
    .filter((route) => admitsNonceRefusal(route.path, route.method) !== (route.tier === "high"))
    .map((route) => `${route.method} ${route.path} (served ${route.tier})`);
  assert.deepEqual(mismatched, []);
});

function operationDeclares403(path: string, method: string): boolean {
  return Boolean(SPEC.paths[path]?.[method.toLowerCase()]?.responses["403"]);
}

test("/v1/pr-actions is declared LOW, as W1-T4077's ruling serves it, and its real 403 validates", async (t) => {
  const deps = depsFor(tmpRoot(t));
  const served = buildServeRoutes(deps).find((route) => route.path === "/v1/pr-actions");
  assert.equal(served?.tier, "low", "control: the daemon serves pr-actions at the LOW tier");

  const op = operation("/v1/pr-actions", "POST");
  assert.equal(admitsNonceRefusal("/v1/pr-actions", "POST"), false, "a LOW route's 403 declares no nonce refusal");
  assert.equal(JSON.stringify(op.parameters ?? []).includes("ConfirmNonce"), false, "a LOW route takes no X-Confirm-Nonce");
  assert.match(op.description ?? "", /\bLOW\b/, "the route says which tier it is");
  assert.doesNotMatch(op.description ?? "", /HIGH-tier/, "and no longer claims the HIGH tier");
  assert.doesNotMatch(String(SPEC.components.schemas.PrActionRequest?.description), /HIGH-tier/);

  await withServer(deps, async (base) => {
    const sent = await call(base, "POST", "/v1/pr-actions", bearerRead);
    assert.equal(sent.status, 403);
    assertSends("/v1/pr-actions", "POST", 403, sent.body);
  });
});

test("exactly one HighTier refusal schema remains, carrying the consequence handler's optional consequenceId", () => {
  const highTier = Object.keys(SPEC.components.schemas).filter((name) => /^HighTier/.test(name));
  assert.deepEqual(highTier, ["HighTierRefusal"]);
  const refusal = SPEC.components.schemas.HighTierRefusal!;
  assert.deepEqual(violations({ error: "confirm_nonce_required", consequenceId: "c-1" }, refusal), []);
  assert.equal(((refusal.required ?? []) as string[]).includes("consequenceId"), false, "consequenceId is optional");
  assert.deepEqual(resolve(SPEC.components.responses.HighTierForbidden!).content, { "application/json": { schema: { $ref: "#/components/schemas/HighTierRefusal" } } });
});

test("Error.required_tier no longer says `rmd serve` leaves write tiers unenforced", () => {
  const requiredTier = (SPEC.components.schemas.Error!.properties as Record<string, Schema>).required_tier!;
  assert.doesNotMatch(String(requiredTier.description), /not yet set/);
});

test("every entry GET /v1/feedback serves -- a reply, the grill it answered, a machine origin -- validates against FeedbackEntry", async (t) => {
  const root = tmpRoot(t);
  const deps = depsFor(root);
  // Capture's landing step gets a git that refuses, so no fixture reaches a real repository; the
  // status writes pass no `land`, which is the local-write path.
  const land = {
    git: (): string => {
      throw new Error("no git in this fixture");
    },
  };
  const grill = captureFeedback(root, { raw: "which lane owns this?", origin: "ui", land });
  setFeedbackStatus(root, grill.id, "grilling");
  const reply = captureFeedback(root, { raw: "the review lane", origin: "ui", replyTo: grill.id, land });
  setFeedbackStatus(root, grill.id, "answered", { answeredBy: reply.id });
  captureFeedback(root, { raw: "a code-scanning alert", origin: "alert#code-scanning-105", land });

  await withServer(deps, async (base) => {
    const sent = await call(base, "GET", "/v1/feedback", bearerRead);
    assert.equal(sent.status, 200);
    const entries = (sent.body as { entries: Array<Record<string, unknown>> }).entries;
    assert.equal(entries.length, 3, "control: all three captured entries are served");
    assert.equal(entries.find((e) => e.id === reply.id)?.reply_to, grill.id);
    assert.equal(entries.find((e) => e.id === grill.id)?.answered_by, reply.id);
    // The ENTRIES, each against the item schema the route declares. The envelope around them, with
    // the console read cache's `staleness`, is the next test's.
    const inbox = resolve(declaredBody("/v1/feedback", "GET", 200));
    const entrySchema = (inbox.properties as Record<string, Schema>).entries!.items as Schema;
    assert.deepEqual(entrySchema, { $ref: "#/components/schemas/FeedbackEntry" });
    assert.deepEqual(entries.flatMap((entry, i) => violations(entry, entrySchema, `entries[${i}]`)), []);
  });
});

test("the whole GET /v1/feedback envelope, the read cache's staleness included, validates against FeedbackInboxResult", async (t) => {
  const root = tmpRoot(t);
  const land = {
    git: (): string => {
      throw new Error("no git in this fixture");
    },
  };
  captureFeedback(root, { raw: "an entry so the envelope is not empty", origin: "ui", land });
  await withServer(depsFor(root), async (base) => {
    const sent = await call(base, "GET", "/v1/feedback", bearerRead);
    assert.equal(sent.status, 200);
    const body = sent.body as { entries: unknown[]; staleness?: { status?: unknown } };
    // CONTROL: the envelope must really carry both the entry and the cache's splice, or this
    // validation would pass over a body that never exercised the declaration.
    assert.equal(body.entries.length, 1);
    assert.ok(body.staleness && typeof body.staleness.status === "string", `the console read cache splices staleness, got ${JSON.stringify(body)}`);
    assertSends("/v1/feedback", "GET", 200, sent.body);
  });
});

test("the /v1/pr-actions switched_off 409 the daemon sends validates against its declared 409", async (t) => {
  const root = tmpRoot(t);
  const deps = depsFor(root);
  const request = { action: "fix", prNumber: 4642 };
  await withServer(deps, async (base) => {
    // CONTROL: with no switch-off marker the same request is recorded, so the 409 below is the
    // marker's doing and not a refusal of the request itself.
    const armed = await call(base, "POST", "/v1/pr-actions", bearerWrite, request);
    assert.equal(armed.status, 200, `control: an unswitched request is recorded, got ${JSON.stringify(armed.body)}`);
    assertSends("/v1/pr-actions", "POST", 200, armed.body);

    writeFileSync(prActionSwitchOffPath(root, "fix"), "");
    const refused = await call(base, "POST", "/v1/pr-actions", bearerWrite, request);
    assert.equal(refused.status, 409);
    assert.equal((refused.body as { error: string }).error, "switched_off");
    assertSends("/v1/pr-actions", "POST", 409, refused.body);
  });
  // The shared Error enum stays closed: switched_off is the dedicated schema's, not Error's.
  assert.notEqual(violations({ error: "switched_off" }, { $ref: "#/components/schemas/Error" }).length, 0);
});


test("the whole GET /v1/status body the console reads validates against StatusSnapshot", async (t) => {
  const root = tmpRoot(t);
  await withServer(depsFor(root), async (base) => {
    const sent = await call(base, "GET", "/v1/status", bearerRead);
    assert.equal(sent.status, 200);
    const body = sent.body as Record<string, unknown>;
    // CONTROL: every key the console contract pins must really be on the body, or this proves nothing.
    for (const key of ["prQueue", "blockedPrs", "mergeHeld", "taskProjection", "counts", "spend", "modelApprovals", "repairLadder", "staleness"]) {
      assert.ok(key in body, `GET /v1/status sent no ${key}: ${JSON.stringify(body)}`);
    }
    assertSends("/v1/status", "GET", 200, sent.body);
  });
});

test("a populated status row of every declared kind validates against its declared schema", () => {
  const prRow: PrQueueRow = {
    prNumber: 8031, prUrl: "https://github.com/o/r/pull/8031", title: "t", headRefName: "run-x", headSha: "a".repeat(40), taskId: "W1-T1",
    disposition: "post-review", reason: "checks pending", reviewState: "pending", queueClass: "active", held: false,
    snapshotAt: "2026-09-30T12:00:00.000Z", observedAt: "2026-09-30T12:00:00.000Z",
  };
  const blocked: BlockedPrBlocker = { kind: "blocked_pr", taskId: "W1-T1", prNumber: 1, prUrl: "https://github.com/o/r/pull/1", disposition: "blocked-fixable", reason: "ci red" };
  const held: MergeHeldRow = { prNumber: 2, taskId: "W1-T2", by: "operator", reason: "hold" };
  const approval: ConsoleModelApproval = { model: "m", approvedBy: "op", approvedAt: "2026-09-30T00:00:00.000Z", expiresAt: "2026-10-30T00:00:00.000Z", expired: false };
  const schema = declaredBody("/v1/status", "GET", 200);
  const status = { generated_at: "2026-09-30T12:00:00.000Z", tasks: [], prQueue: { complete: true, rows: [prRow], lastGoodAt: "2026-09-30T11:00:00.000Z" }, blockedPrs: [blocked], blockedPrsUnverifiedReason: "gh down", mergeHeld: [held, { by: "operator", reason: "fleet hold" }], modelApprovals: [approval] };
  assert.deepEqual(violations(status, schema), []);
  assert.notDeepEqual(violations({ ...status, prQueue: { complete: true, rows: [{ ...prRow, queueClass: "someday" }] } }, schema), [], "the control: a wrong enum still fails");
});
