// test/a-secret-is-never-read-half-written.test.ts
//
// `loadEscalationLinkSecret` (escalate.ts) and `resolveServiceTokens` (serve.ts) used to create
// their file with `wx` and only THEN write it. A reader between the two got `raw: ""`, and a
// creator that crashed between them left an empty file forever. For the link secret, `"".trim()`
// became the HMAC key, so every answer link was forgeable from the payload format alone; for the
// service tokens, `JSON.parse("")` took serve down until someone deleted the file. Both now
// publish over the claim (`createOrReadPublished`, W1-T4641) and refuse a present-but-invalid file.

import assert from "node:assert/strict";
import fsMod from "node:fs";
import { closeSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { escalationLinkSecretPath, loadEscalationLinkSecret, signOptionLink } from "../src/lib/escalate.js";
import {
  createOrReadPublished,
  HEX_SECRET_RE,
  InvalidSecretFileError,
  StillBeingWrittenError,
  writeAtomic,
} from "../src/lib/fs-race-safe.js";
import { resolveServiceTokens, serviceTokensPath } from "../src/lib/serve.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const PUBLISHED = "b".repeat(64);

function tmpRoot(tag: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}secret-half-written-${tag}-`));
}

function withRoot(tag: string, fn: (root: string) => void): void {
  const root = tmpRoot(tag);
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function seedFile(path: string, raw: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, raw, { mode: 0o600 });
}

function isInvalidSecret(path: string): (err: unknown) => boolean {
  return (err) => err instanceof InvalidSecretFileError && err.reason === "invalid-secret-file" && err.path === path && /delete it to regenerate/.test(err.message);
}

test("a reader meeting the empty escalation secret claim waits, then signs with the secret its creator published", () => {
  withRoot("wait", (root) => {
    const path = escalationLinkSecretPath(root);
    let peerFd: number | undefined;
    const reads: string[] = [];
    const sleeps: number[] = [];
    const fsImpl = {
      openSync: ((p: string, flags: string, mode?: number) => {
        // A peer wins the `wx` claim an instant before this reader's own, and has not written yet.
        if (flags === "wx" && peerFd === undefined) peerFd = fsMod.openSync(p, "wx", 0o600);
        return fsMod.openSync(p, flags as never, mode as never);
      }) as typeof fsMod.openSync,
      readFileSync: ((fd: number, enc: BufferEncoding) => {
        const raw = fsMod.readFileSync(fd, enc);
        reads.push(raw);
        return raw;
      }) as typeof fsMod.readFileSync,
      closeSync: fsMod.closeSync,
    };
    const sleep = (ms: number): void => {
      sleeps.push(ms);
      if (sleeps.length === 1 && peerFd !== undefined) {
        writeAtomic(path, `${PUBLISHED}\n`, { mode: 0o600 }); // the peer publishes while we wait
        closeSync(peerFd);
      }
    };

    const secret = loadEscalationLinkSecret(root, {
      claim: (p, mode) => createOrReadPublished(p, mode, fsImpl, sleep),
      mkdir: mkdirSync,
    });

    assert.equal(secret, PUBLISHED, "the reader hands back the published secret, never the empty claim");
    assert.deepEqual(reads, ["", `${PUBLISHED}\n`], "the window was exercised: the first read saw zero bytes");
    assert.equal(sleeps.length, 1, "one wait bridged the creator's claim-to-publish span");
    const claims = { escalationId: "W1-T1", cls: "MANUAL", route: "/v1/control/pause" as const, expiresAtMs: 1 };
    assert.notEqual(signOptionLink(claims, secret), signOptionLink(claims, ""), "the link is not signed with the empty key");
  });
});

test("an escalation secret left empty by a crashed creator throws, never returns an empty key", () => {
  withRoot("crashed", (root) => {
    const path = escalationLinkSecretPath(root);
    seedFile(path, ""); // the creator's `wx` claim, never written
    let refusal: unknown;
    try {
      const got = loadEscalationLinkSecret(root);
      assert.fail(`an empty secret file must throw, but the loader returned ${JSON.stringify(got)}`);
    } catch (err) {
      refusal = err;
    }
    assert.ok(refusal instanceof StillBeingWrittenError, `expected the named reason, got ${String(refusal)}`);
    assert.equal(refusal.path, path);
    assert.match(refusal.message, /delete it to regenerate/);
  });
});

test("a short, whitespace-only or non-hex escalation secret throws InvalidSecretFileError naming the file to delete", () => {
  for (const raw of [" \n", "abc\n", `${"a".repeat(63)}\n`, `${"a".repeat(65)}\n`, `${"g".repeat(64)}\n`, `${"A".repeat(64)}\n`]) {
    withRoot("malformed", (root) => {
      const path = escalationLinkSecretPath(root);
      seedFile(path, raw);
      assert.throws(() => loadEscalationLinkSecret(root), isInvalidSecret(path), `refused ${JSON.stringify(raw)}`);
      assert.equal(readFileSync(path, "utf8"), raw, "the loader never rewrites an operator's file");
    });
  }
});

test("the escalation secret is minted once at mode 0600 and every later load reads the same value", () => {
  withRoot("mint", (root) => {
    const secret = loadEscalationLinkSecret(root);
    const path = escalationLinkSecretPath(root);
    assert.match(secret, HEX_SECRET_RE);
    assert.equal(readFileSync(path, "utf8"), `${secret}\n`, "published whole, newline-terminated as before");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(loadEscalationLinkSecret(root), secret);
    assert.equal(loadEscalationLinkSecret(root), secret);
    assert.deepEqual(readdirSync(join(root, "state")), ["escalation-link-secret"], "no staging file is left beside it");
  });
});

test("a creator that fails before publishing withdraws its escalation secret claim, so the next load mints", () => {
  withRoot("withdraw", (root) => {
    const path = escalationLinkSecretPath(root);
    assert.throws(
      () =>
        loadEscalationLinkSecret(root, {
          claim: (p, mode) => {
            const claim = createOrReadPublished(p, mode);
            if (!claim.created) return claim;
            return { ...claim, publish: () => { throw new Error("disk full"); } };
          },
          mkdir: mkdirSync,
        }),
      /disk full/,
    );
    assert.deepEqual(readdirSync(join(root, "state")), [], "the empty claim is gone, not left for readers to wait on");
    const secret = loadEscalationLinkSecret(root);
    assert.equal(readFileSync(path, "utf8"), `${secret}\n`);
  });
});

test("service tokens are minted once at mode 0600 and every later resolve reads the same pair", () => {
  withRoot("tokens-mint", (root) => {
    const first = resolveServiceTokens(root);
    const path = serviceTokensPath(root);
    assert.match(first.read, HEX_SECRET_RE);
    assert.match(first.write, HEX_SECRET_RE);
    assert.equal(readFileSync(path, "utf8"), JSON.stringify(first, null, 2) + "\n", "the file format is unchanged");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(resolveServiceTokens(root), first);
    assert.deepEqual(readdirSync(join(root, "state")), ["service-tokens.json"], "no staging file is left beside it");
  });
});

test("a service tokens file left empty by a crashed creator throws StillBeingWrittenError, not a JSON parse error", () => {
  withRoot("tokens-crashed", (root) => {
    const path = serviceTokensPath(root);
    seedFile(path, "");
    assert.throws(
      () => resolveServiceTokens(root),
      (err: unknown) => err instanceof StillBeingWrittenError && err.path === path,
    );
  });
});

test("service tokens that are not JSON or lack a 64-hex read and write throw InvalidSecretFileError", () => {
  const hex = "c".repeat(64);
  const bad = [
    "{ not json",
    "[]\n",
    "null\n",
    "{}\n",
    JSON.stringify({ read: hex }),
    JSON.stringify({ read: "", write: hex }),
    JSON.stringify({ read: hex, write: "short" }),
    JSON.stringify({ read: hex, write: 42 }),
    JSON.stringify({ read: hex, write: hex, ingest: 7 }),
  ];
  for (const raw of bad) {
    withRoot("tokens-malformed", (root) => {
      const path = serviceTokensPath(root);
      seedFile(path, raw);
      assert.throws(() => resolveServiceTokens(root), isInvalidSecret(path), `refused ${raw}`);
    });
  }
});

test("service tokens carrying an operator-set ingest token still load with it", () => {
  withRoot("tokens-ingest", (root) => {
    const tokens = { read: "d".repeat(64), write: "e".repeat(64), ingest: "operator-set" };
    seedFile(serviceTokensPath(root), JSON.stringify(tokens));
    assert.deepEqual(resolveServiceTokens(root), tokens);
  });
});

test("HEX_SECRET_RE accepts exactly a minted 64-hex secret and refuses every near miss", () => {
  assert.equal(HEX_SECRET_RE.test("0123456789abcdef".repeat(4)), true);
  for (const near of ["", "a".repeat(63), "a".repeat(65), "A".repeat(64), `${"a".repeat(63)}g`, ` ${"a".repeat(64)}`]) {
    assert.equal(HEX_SECRET_RE.test(near), false, JSON.stringify(near));
  }
});
