import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { withTempDir } from "#src/lib/tmp.js";
import { inboxThreadId } from "#src/lib/inbox-thread.js";
import { fixedClock } from "#src/lib/clock.js";
import { createReadModelWorker } from "#src/lib/read-model-worker.js";
import { viewEtag, type ViewBodyEntry, type ViewSource } from "#src/lib/views.js";
import { CODE_HEALTH_SCOPE_KEY, CODE_HEALTH_VIEW_NAME, createCodeHealthView, readCodeHealthInventory, readCodeHealthRelatedWork, validateCodeHealthRequest } from "#src/lib/code-health-view.js";
import * as store from "#src/lib/code-health-store.js";

function roster(dir: string) {
  const repository = "acme/atlas", instance = "atlas", root = join(dir, "atlas"); mkdirSync(join(root, "state"), { recursive: true }); mkdirSync(join(dir, "read-model"));
  writeFileSync(join(dir, "read-model", "repositories-sources.json"), JSON.stringify({ instances: [{ instanceId: instance, options: { controlRoot: root, ledgerPath: join(root, "state", "ledger.ndjson") } }], improvementEvidence: { version: "repository-evidence-inventory-v1", measurementState: "not_collected", repositories: [{ repository, instanceIds: [instance], expectedDailySources: ["pull_requests", "ledger_activity", "deployments"], expectedQualitySources: ["quality", "coverage"] }], unresolvedInstances: [] } }));
  return { repository, instance, root, inventory: readCodeHealthInventory(dir) };
}

async function withScopeReading(
  reading: (now: number) => ViewSource,
  key: string,
  visit: (source: ReturnType<typeof createReadModelWorker>, now: number, repository: string) => void,
): Promise<void> {
  await withTempDir("code-health-source-clock", async dir => {
    const { repository } = roster(dir), now = Date.now(), builtAt = now - 240_000;
    const entries: ViewBodyEntry[] = createCodeHealthView({ stateDir: dir, keys: () => ["repository=acme%2Fatlas"] })
      .materialize({ now: builtAt, instances: [] }).map(({ key, data, sources }) => ({
        view: CODE_HEALTH_VIEW_NAME, key, version: 1, generation: 1,
        etag: viewEtag(CODE_HEALTH_VIEW_NAME, 1, true, data),
        body: { view: CODE_HEALTH_VIEW_NAME, version: 1, generatedAt: fixedClock(builtAt).iso(), asOf: null, stale: true, sources, data },
      }));
    const updated = reading(now);
    // The real consumer receives the same two message kinds as production: an unchanged body,
    // then newer source readings. No judge fake can turn the held timestamp into a fresh one.
    const fixture = `import {parentPort,workerData} from 'node:worker_threads';
      parentPort.on('message',message=>{if(message.type==='stop'){
        const signal=new Int32Array(workerData.signal);Atomics.store(signal,1,1);Atomics.notify(signal,1);parentPort.close();}});
      for(const entry of ${JSON.stringify(entries)})parentPort.postMessage({type:'body',entry});
      parentPort.postMessage({type:'sources',sources:[${JSON.stringify(updated)}],bodies:[{view:'code-health',key:${JSON.stringify(key)},sources:[${JSON.stringify(updated)}]}]});`;
    let arrived!: () => void;
    const ready = new Promise<void>(resolve => { arrived = resolve; });
    const source = createReadModelWorker({ stateDir: dir, instances: [], clock: fixedClock(now),
      workerUrl: new URL(`data:text/javascript,${encodeURIComponent(fixture)}`),
      observe: message => { if (message.type === "sources") arrived(); } });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      source.start();
      await Promise.race([ready, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("source-clock fixture did not publish its bounded messages")), 10_000);
      })]);
      visit(source, now, repository);
    } finally { clearTimeout(timeout); assert.equal(source.stop(), true, "the owned fixture worker must confirm shutdown"); }
  });
}

const scopeReading = (now: number): ViewSource => ({ name: "repositories:code-health-scope", kind: "repositories", asOf: fixedClock(now).iso(), state: "fresh", budgetMs: 180_000 });

test("code health scope stays ready when only its source clock advances", async () => {
  await withScopeReading(scopeReading, CODE_HEALTH_SCOPE_KEY, (source, now, repository) => {
    const held = source.body(CODE_HEALTH_VIEW_NAME, CODE_HEALTH_SCOPE_KEY)!;
    const originalClock = held.body.sources.find(value => value.name === "repositories:code-health-scope")!.asOf;
    assert.equal(originalClock, fixedClock(now - 240_000).iso(), "the cached body must actually predate the scope budget");
    const etag = held.etag;
    assert.equal(source.judge(held.body.sources, now, held).find(value => value.name === "repositories:code-health-scope")?.asOf, fixedClock(now).iso());
    assert.equal(validateCodeHealthRequest(new URLSearchParams({ repository }), source, now), undefined);
    assert.equal(source.body(CODE_HEALTH_VIEW_NAME, CODE_HEALTH_SCOPE_KEY)!.etag, etag, "a source refresh does not require different report data");
    assert.equal(held.body.sources.find(value => value.name === "repositories:code-health-scope")!.asOf, originalClock);
    assert.equal((held.body.data as { freshness: string }).freshness, "unavailable", "a scope clock cannot renew missing measurements");
    assert.equal(validateCodeHealthRequest(new URLSearchParams("repository=acme/foreign"), source, now)?.status, 400);
    assert.equal(validateCodeHealthRequest(new URLSearchParams("repository=acme/atlas&page=bad"), source, now)?.status, 400);
  });
});

test("code health scope refuses unqualified source clock updates", async () => {
  for (const reading of [
    (now: number) => scopeReading(now - 180_001),
    (now: number): ViewSource => ({ ...scopeReading(now), state: "unavailable" }),
    (now: number): ViewSource => ({ ...scopeReading(now), asOf: "not-a-time" }),
    (now: number): ViewSource => ({ ...scopeReading(now), asOf: null }),
    (now: number) => scopeReading(now + 1),
  ]) await withScopeReading(reading, CODE_HEALTH_SCOPE_KEY, (source, now, repository) => {
    assert.equal(validateCodeHealthRequest(new URLSearchParams({ repository }), source, now)?.status, 503);
  });
  await withScopeReading(scopeReading, "repository=acme%2Fatlas", (source, now, repository) => {
    assert.equal(validateCodeHealthRequest(new URLSearchParams({ repository }), source, now)?.status, 503, "another body's fresh clock cannot authorize the held roster");
  });
  await withScopeReading(scopeReading, CODE_HEALTH_SCOPE_KEY, (source, now, repository) => {
    assert.equal(validateCodeHealthRequest(new URLSearchParams({ repository }), source, now), undefined, "a genuinely refreshed scope is the positive control for these refusals");
  });
});

test("code health related work links the native saved conversation without inventing its freshness", async () => {
  await withTempDir("code-health-chat-links", dir => {
    const { repository, instance, root, inventory } = roster(dir), proposalId = "codeql-quality:quality-rule";
    const id = `improvement:${createHash("sha256").update(JSON.stringify([repository, instance, proposalId])).digest("hex")}`, threadId = inboxThreadId(id);
    const row = { id, summary: "A saved planning conversation", evidenceAnchors: [], improvement: { version: "improvement-thread-v1", repository, instance, opportunityId: `${repository}/${proposalId}`, snapshotId: "a".repeat(64), requestId: "b".repeat(64), goalDigest: "c".repeat(64), conversationReady: true, threadId } };
    const path = join(root, "state", "inbox-proposals.json"); writeFileSync(path, JSON.stringify({ proposals: [row] }));
    const read = () => readCodeHealthRelatedWork(dir, inventory, repository, Date.parse("2026-11-02T12:00:00.000Z"));
    const result = read(); assert.deepEqual(result.work, [{ repository, proposalId, threadId }]); assert.equal(result.asOf, null, "a file read or mtime is not a saved conversation timestamp");
    writeFileSync(path, JSON.stringify({ proposals: [{ ...row, improvement: { ...row.improvement, repository: "acme/foreign" } }] })); assert.equal(read().work.length, 0);
    writeFileSync(path, JSON.stringify({ proposals: [{ ...row, improvement: { ...row.improvement, conversationReady: false } }] })); assert.equal(read().work.length, 0);
    writeFileSync(path, "{broken"); assert.notEqual(read().state, "reported");
  });
});

test("code health related work joins isolated improvement outcomes to the original finding", async () => {
  await withTempDir("code-health-effect-links", dir => {
    const { repository, instance, inventory } = roster(dir), proposalId = "codeql-quality:quality-rule", now = "2026-11-02T12:00:00.000Z";
    const locate = (store as unknown as { improvementOutcomeStateDir?: (state: string, repo: string, instance: string) => string }).improvementOutcomeStateDir;
    assert.equal(typeof locate, "function", "the producer and consumer need one scoped outcome namespace"); assert(locate);
    const target = locate(dir, repository, instance); mkdirSync(target, { recursive: true });
    const source = { repository, opportunityId: `${repository}/${proposalId}`, threadId: "thread:improvement:one", snapshotId: "a".repeat(64), taskIds: ["W1-T7", "W1-T8"] };
    writeFileSync(join(target, "opportunity-outcomes.json"), JSON.stringify([{ key: `${repository}/improvement:one`, proposalId: "improvement:one", sourceIds: [source.snapshotId], candidate: { repo: repository, key: "improvement:one", observedAt: now }, at: now, state: "merged", improvement: source, task: { repo: repository, key: "improvement:one", id: "W1-T7" }, pr: { repo: repository, taskId: "W1-T7", url: `https://github.com/${repository}/pull/7` } }]));
    const result = readCodeHealthRelatedWork(dir, inventory, repository, Date.parse(now));
    assert(result.work.some(row => row.proposalId === proposalId && row.threadId === source.threadId && row.taskId === "W1-T7" && row.prUrl?.endsWith("/pull/7")));
    assert(result.work.some(row => row.proposalId === proposalId && row.taskId === "W1-T8"));
    assert(!result.work.some(row => row.proposalId === "improvement:one"), "the finding group is the join key; the planning proposal is separate");
    const path = join(target, "opportunity-outcomes.json"), saved = JSON.parse(readFileSync(path, "utf8"));
    for (const url of ["javascript:alert(1)", "https://github.com/acme/foreign/pull/7", `https://github.com/${repository}/pull/7?unexpected=1`]) {
      saved[0].pr.url = url; writeFileSync(path, JSON.stringify(saved));
      assert(readCodeHealthRelatedWork(dir, inventory, repository, Date.parse(now)).work.every(work => work.prUrl === undefined), "a saved repository label cannot authorize a foreign or executable link");
    }
    assert.notEqual(locate(dir, repository, instance), locate(dir, repository, "another-instance"));
    assert.throws(() => locate(dir, repository, "../other"));
  });
});


test("code health refuses contradictory configured source expectations", async () => {
  await withTempDir("code-health-inventory-contract", dir => {
    const configured = roster(dir); assert.equal(configured.inventory.repositories.length, 1);
    const path = join(dir, "read-model", "repositories-sources.json"), valid = JSON.parse(readFileSync(path, "utf8"));
    for (const mutate of [
      (value: typeof valid) => { value.improvementEvidence.measurementState = "measured"; },
      (value: typeof valid) => { value.improvementEvidence.repositories[0].expectedDailySources = []; },
      (value: typeof valid) => { value.improvementEvidence.repositories.push({ ...value.improvementEvidence.repositories[0], repository: "acme/foreign" }); },
    ]) {
      const changed = structuredClone(valid); mutate(changed); writeFileSync(path, JSON.stringify(changed));
      assert.throws(() => readCodeHealthInventory(dir), /configured repository list/, "an invalid scope must not publish another portfolio");
    }
  });
});

test("code health related work is unavailable when its saved sources cannot be read", async () => {
  await withTempDir("code-health-related-unreadable", dir => {
    const { repository, inventory } = roster(dir), now = Date.parse("2026-11-02T12:00:00.000Z");
    assert.equal(readCodeHealthRelatedWork(dir, inventory, repository, now).state, "not_collected", "control: a readable scope with no saved work");
    writeFileSync(join(dir, "read-model", "repositories-sources.json"), "{broken");
    const result = readCodeHealthRelatedWork(dir, inventory, repository, now);
    assert.deepEqual([result.state, result.work, result.asOf], ["unavailable", [], null], "an unreadable scope withholds completeness; it never certifies no existing work");
    assert.match(result.reason ?? "", /could not be read or verified/);
  });
});

test("code health answers not ready until the configured repository list is held, and builds nothing it cannot read", async () => {
  await withTempDir("code-health-not-ready", dir => {
    const wanted: Array<[string, string]> = [];
    const source = (body?: unknown) => ({ body: () => body as never, want: (view: string, key: string) => void wanted.push([view, key]) });
    const notReady = { error: "view_not_ready", status: 503, detail: "Code health is waiting for the configured repository list." };
    assert.deepEqual(validateCodeHealthRequest(new URLSearchParams(""), source(undefined) as never, Date.parse("2026-11-02T12:00:00.000Z")), notReady);
    const staleScope = { body: { data: { version: "code-health-view-v1", repository: "all", expectedRepositories: ["acme/atlas"] },
      sources: [{ name: "repositories:code-health-scope", asOf: "2026-11-02T11:00:00.000Z" }] } };
    assert.deepEqual(validateCodeHealthRequest(new URLSearchParams("repository=acme/atlas"), source(staleScope) as never, Date.parse("2026-11-02T12:00:00.000Z")), notReady,
      "an hour-old repository list is not current scope evidence");
    assert.deepEqual(wanted, [[CODE_HEALTH_VIEW_NAME, ""], [CODE_HEALTH_VIEW_NAME, ""]], "each refusal asks for the repository list to be built");

    const view = createCodeHealthView({ stateDir: dir, keys: () => ["repository=acme/unknown"] });
    assert.deepEqual(view.materialize({ now: Date.parse("2026-11-02T12:00:00.000Z"), instances: [] }), [], "with no saved repository list there is no body to build");
    const { repository } = roster(dir);
    const built = view.materialize({ now: Date.parse("2026-11-02T12:00:00.000Z"), instances: [] });
    assert.deepEqual(built.map(entry => [entry.key, entry.data.repository]), [["", "all"], [CODE_HEALTH_SCOPE_KEY, "all"]],
      `an unknown repository request builds nothing, while the configured ${repository} portfolio is built`);
  });
});
