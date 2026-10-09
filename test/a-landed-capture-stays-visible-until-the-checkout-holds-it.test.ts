import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  landFeedbackStatusContent,
  overlayQueuedFeedbackEntries,
  queuedFeedbackLandings,
  sweepFeedbackLanding,
  sweepFeedbackLandingAsync,
} from "../src/lib/feedback-landing.js";
import { listFeedback } from "../src/lib/feedback.js";
import { gitRepo } from "./helpers/git-repo.js";

const PROOF = "test/a-landed-capture-stays-visible-until-the-checkout-holds-it.test.ts";
const REL = "plan/feedback/fb-checkout.yaml";
const NEW = "id: fb-checkout\nstatus: new\nraw: capture awaiting checkout\n";
const ACCEPTED = "id: fb-checkout\nstatus: accepted\nraw: capture awaiting checkout\n";

function fixture(checkoutContent?: string) {
  const writer = gitRepo({ kind: "w5732-writer" });
  const write = (content: string) => {
    mkdirSync(dirname(join(writer.dir, REL)), { recursive: true });
    writeFileSync(join(writer.dir, REL), content);
    writer.git("add", REL);
    writer.git("commit", "-q", "-m", "chore: feedback");
  };
  if (checkoutContent) write(checkoutContent);
  const origin = gitRepo({ bare: true, kind: "w5732-origin" });
  writer.addRemote("origin", origin.dir);
  writer.git("push", "-q", "origin", "HEAD:main");
  const checkout = gitRepo({ cloneFrom: origin.dir, kind: "w5732-checkout" });
  const stateRoot = mkdtempSync(join(tmpdir(), "rmd-w5732-state-"));
  const rows: Array<Record<string, unknown>> = [];
  const opts = {
    stateRoot,
    sourceRepository: { owner: "o", repo: "r" },
    gh: () => { throw new Error("already merged records need no GitHub call"); },
    log: (_step: string, extra?: Record<string, unknown>) => rows.push(extra ?? {}),
  };
  const queue = (content: string) => {
    assert.deepEqual(landFeedbackStatusContent(checkout.dir, REL, content, { stateRoot }).queued, [REL]);
  };
  const landUpstream = (content: string) => {
    write(content);
    writer.git("push", "-q", "origin", "HEAD:main");
  };
  const listed = (): Array<{ id: string; status: string; landing?: "queued" }> =>
    overlayQueuedFeedbackEntries(listFeedback(checkout.dir), stateRoot);
  return { writer, checkout, stateRoot, rows, opts, queue, landUpstream, listed };
}

test(`${PROOF}: a fetched capture stays queued and listed until the checkout holds its bytes`, () => {
  const fx = fixture();
  fx.queue(NEW);
  fx.landUpstream(NEW);
  assert.equal(existsSync(join(fx.checkout.dir, REL)), false);

  for (let pass = 0; pass < 2; pass++) {
    const held = sweepFeedbackLanding(fx.checkout.dir, fx.opts);
    assert.equal(held.error, undefined);
    assert.deepEqual(queuedFeedbackLandings(fx.stateRoot), [REL]);
    assert.equal(fx.listed()[0]?.id, "fb-checkout");
    assert.equal(fx.listed()[0]?.status, "new");
    assert.equal(fx.listed()[0]?.landing, "queued");
    assert.equal(held.keptForCheckout, 1);
    assert.equal(fx.rows.at(-1)?.kept_for_checkout_count, 1);
  }

  fx.checkout.git("merge", "--ff-only", "origin/main");
  assert.equal(readFileSync(join(fx.checkout.dir, REL), "utf8"), NEW);
  const acknowledged = sweepFeedbackLanding(fx.checkout.dir, fx.opts);
  assert.equal(acknowledged.error, undefined);
  assert.equal(acknowledged.keptForCheckout, 0);
  assert.deepEqual(queuedFeedbackLandings(fx.stateRoot), []);
  assert.equal(fx.listed()[0]?.id, "fb-checkout");
  assert.equal(fx.listed()[0]?.landing, undefined);
  assert.equal(fx.rows.at(-1)?.kept_for_checkout_count, 0);
});

test(`${PROOF}: an async sweep preserves a landed decision over a stale checkout status`, async () => {
  const fx = fixture(NEW);
  fx.queue(ACCEPTED);
  fx.landUpstream(ACCEPTED);
  const held = await sweepFeedbackLandingAsync(fx.checkout.dir, fx.opts);
  assert.equal(held.error, undefined);
  assert.equal(held.keptForCheckout, 1);
  assert.equal(listFeedback(fx.checkout.dir)[0]?.status, "new");
  assert.equal(fx.listed()[0]?.status, "accepted");
  assert.equal(fx.listed()[0]?.landing, "queued");

  fx.checkout.git("merge", "--ff-only", "origin/main");
  const acknowledged = await sweepFeedbackLandingAsync(fx.checkout.dir, fx.opts);
  assert.equal(acknowledged.error, undefined);
  assert.equal(acknowledged.keptForCheckout, 0);
  assert.deepEqual(queuedFeedbackLandings(fx.stateRoot), []);
  assert.equal(fx.listed()[0]?.status, "accepted");
  assert.equal(fx.listed()[0]?.landing, undefined);
});

test(`${PROOF}: an unreadable checkout hash retains the queue and names the held count`, () => {
  const fx = fixture(NEW);
  fx.queue(ACCEPTED);
  fx.landUpstream(ACCEPTED);
  const held = sweepFeedbackLanding(fx.checkout.dir, {
    ...fx.opts,
    git: (args) => {
      if (args[0] === "hash-object" && args[1] === join(fx.checkout.dir, REL)) {
        throw new Error("checkout bytes unreadable");
      }
      return fx.checkout.git(...args);
    },
  });
  assert.equal(held.error, undefined);
  assert.equal(held.keptForCheckout, 1);
  assert.deepEqual(queuedFeedbackLandings(fx.stateRoot), [REL]);
  assert.equal(fx.listed()[0]?.status, "accepted");
});

test(`${PROOF}: a separate served checkout must hold the bytes even when the daemon already does`, () => {
  const fx = fixture();
  fx.queue(NEW);
  fx.landUpstream(NEW);
  const opts = { ...fx.opts, servedRoot: fx.checkout.dir };
  assert.equal(readFileSync(join(fx.writer.dir, REL), "utf8"), NEW);
  assert.equal(existsSync(join(fx.checkout.dir, REL)), false);

  const held = sweepFeedbackLanding(fx.writer.dir, opts);
  assert.equal(held.error, undefined);
  assert.equal(held.keptForCheckout, 1);
  assert.deepEqual(queuedFeedbackLandings(fx.stateRoot), [REL]);
  assert.equal(fx.listed()[0]?.landing, "queued");

  fx.checkout.git("pull", "--ff-only", "origin", "main");
  const acknowledged = sweepFeedbackLanding(fx.writer.dir, opts);
  assert.equal(acknowledged.error, undefined);
  assert.equal(acknowledged.keptForCheckout, 0);
  assert.deepEqual(queuedFeedbackLandings(fx.stateRoot), []);
  assert.equal(fx.listed()[0]?.id, "fb-checkout");
  assert.equal(fx.listed()[0]?.landing, undefined);
});
