import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createService, resolveStaticRequest, STATIC_CONTENT_TYPES, type StaticMount } from "../src/lib/service.js";

// W1-T3175 — `rmd serve` COULD NOT SERVE A BUILT CONSOLE.
//
// The complete set of content types src/lib/serve.ts ever set was FOUR entries of TWO kinds,
// application/json and text/html. No text/javascript, no text/css, no font/woff2 — and a bundled
// SPA is precisely a set of those files.
//
// THE MOUNT LIVES IN service.ts AND NOT serve.ts, because this module's routing is EXACT-MATCH ONLY
// and a built SPA is content-hashed filenames under a prefix. serve.ts hands its routes to
// createService and never wraps the handler, so an asset route that must enforce the SAME read
// scope as the shell has to sit inside that dispatch.

const READ_TOKEN = "read-tok";
const WRITE_TOKEN = "write-tok";

/** A build directory shaped like a real Vite output, plus the two hazards. */
function buildTree(): { root: string; outside: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "rmd-console-assets-"));
  mkdirSync(join(base, "dist", "assets", "nested"), { recursive: true });
  // REALPATH THE ROOT ITSELF. On macOS $TMPDIR is a symlink (/var -> /private/var), so a root kept
  // as the requested path would never prefix-match the realpath of a file inside it, and every
  // legitimate asset would read as escaping — a containment check that refuses everything.
  const root = realpathSync(join(base, "dist"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>console</title>");
  writeFileSync(join(root, "assets", "app.a1b2c3.js"), "export const x = 1;");
  writeFileSync(join(root, "assets", "app.a1b2c3.css"), ".x{}");
  writeFileSync(join(root, "assets", "nested", "deep.css"), ".deep{}");
  writeFileSync(join(root, "weird.bin"), "not an asset kind");
  // A secret NEXT TO the build, the thing a traversal is actually after.
  const outside = join(base, "secret.txt");
  writeFileSync(outside, "the operator's token");
  // And a symlink INSIDE the root pointing out of it — the case a textual `..` check misses.
  symlinkSync(outside, join(root, "escape.txt"));
  return { root, outside, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function mountFor(root: string, clientRoutes: string[] = ["/console/", "/console/tasks"]): StaticMount {
  return {
    prefix: "/console/",
    root,
    scope: "read",
    clientRoutes,
    io: {
      realpath: (p) => {
        try {
          return realpathSync(p);
        } catch {
          return null;
        }
      },
      readFile: (p) => readFileSync(p),
    },
  };
}

// AWAITED, NOT JUST RETURNED. `try { return fn(t) } finally { cleanup() }` runs the finally when
// fn RETURNS ITS PROMISE, not when it resolves — so the tree was deleted mid-test and every asset
// resolved `absent`, which reads as a 404 from the route rather than as a broken fixture.
async function withTree(fn: (t: { root: string; outside: string }) => void | Promise<void>) {
  const t = buildTree();
  try {
    await fn(t);
  } finally {
    t.cleanup();
  }
}

test("W1-T3175: a built asset is served with a content type from the CLOSED allow-list", async () => {
  await withTree(({ root }) => {
    const mount = mountFor(root);
    for (const [path, ext] of [
      ["/console/assets/app.a1b2c3.js", ".js"],
      ["/console/assets/app.a1b2c3.css", ".css"],
      ["/console/assets/nested/deep.css", ".css"],
    ] as const) {
      const r = resolveStaticRequest(mount, path);
      assert.equal(r?.kind, "asset", `${path} must be served`);
      assert.equal(r!.kind === "asset" ? r.contentType : "", STATIC_CONTENT_TYPES[ext]);
    }
    // The allow-list is CLOSED, not a mime lookup: octet-stream must appear nowhere in it.
    assert.ok(!Object.values(STATIC_CONTENT_TYPES).includes("application/octet-stream"));
  });
});

test("W1-T3175: a path that RESOLVES outside the root is refused — and a nested asset in the same test is still SERVED", async () => {
  await withTree(({ root }) => {
    const mount = mountFor(root);
    // THE FALSIFIER THE SHARD DEMANDS: a suite where every path 404s proves the route is broken,
    // not that it is safe. So the legitimate nested asset is asserted alongside the refusals.
    assert.equal(resolveStaticRequest(mount, "/console/assets/nested/deep.css")?.kind, "asset", "a legit nested asset is served");

    for (const path of [
      "/console/../secret.txt", // a bare ..
      "/console/..%2fsecret.txt", // URL-encoded separator: decodes AFTER any textual check
      "/console/%2e%2e%2fsecret.txt", // both halves encoded
      "/console/assets/../../secret.txt", // escapes through a legitimate prefix
      "/console/escape.txt", // a symlink INSIDE the root whose target is outside it
    ]) {
      const r = resolveStaticRequest(mount, path);
      assert.equal(r?.kind, "refused", `${path} must be refused`);
      assert.equal(r!.kind === "refused" ? r.reason : "", "escapes_root", `${path} must be refused for escaping`);
    }
  });
});

test("W1-T3175: an unknown extension INSIDE the root is refused, never served as octet-stream", async () => {
  await withTree(({ root }) => {
    const r = resolveStaticRequest(mountFor(root), "/console/weird.bin");
    assert.equal(r?.kind, "refused");
    assert.equal(r!.kind === "refused" ? r.reason : "", "unknown_extension", "the file exists and is still refused");
  });
});

test("W1-T3175: a DECLARED client route returns the shell, and a MISSING asset 404s — the fallback never masks an absent build", async () => {
  await withTree(({ root }) => {
    const mount = mountFor(root);
    const shell = resolveStaticRequest(mount, "/console/tasks");
    assert.equal(shell?.kind, "shell", "a declared client route returns index.html");
    assert.equal(shell!.kind === "shell" ? shell.contentType : "", STATIC_CONTENT_TYPES[".html"]);

    // THE DEFECT THIS PREVENTS: a catch-all returns HTML for a missing .js, so the browser reports a
    // syntax error on a text/html body and a deploy failure reads as a blank page. A missing asset
    // must be ABSENT, and an UNDECLARED path must not be quietly answered with the shell either.
    const missing = resolveStaticRequest(mount, "/console/assets/never-built.js");
    assert.equal(missing?.kind, "refused");
    assert.equal(missing!.kind === "refused" ? missing.reason : "", "absent");

    const undeclared = resolveStaticRequest(mount, "/console/not-a-declared-route");
    assert.equal(undeclared?.kind, "refused", "an undeclared client path is not silently given the shell");

    // A path outside the mount prefix is none of this mount's business at all.
    assert.equal(resolveStaticRequest(mount, "/v1/status"), null);
  });
});

test("W1-T3175: the asset route requires the SAME read scope as the shell — through the real dispatch", async () => {
  await withTree(async ({ root }) => {
    // Driven through createService itself, not a re-implementation: the synthesised route must reach
    // the SAME auth path every declared route reaches, or the mount has invented a second way in.
    const server = createService({
      tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
      routes: [],
      staticMount: mountFor(root),
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    const url = `http://127.0.0.1:${port}/console/assets/app.a1b2c3.js`;
    try {
      const anon = await fetch(url);
      assert.equal(anon.status, 401, "no asset is readable by a caller who could not load the console");

      const authed = await fetch(url, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
      assert.equal(authed.status, 200, "and the read token that loads the shell loads the asset");
      assert.equal(authed.headers.get("content-type"), STATIC_CONTENT_TYPES[".js"]);
      assert.equal(await authed.text(), "export const x = 1;");

      // A REFUSAL IS A 404, NOT A LEAK. The escaping path must not report that a file is there.
      const escaped = await fetch(`http://127.0.0.1:${port}/console/escape.txt`, {
        headers: { authorization: `Bearer ${READ_TOKEN}` },
      });
      assert.equal(escaped.status, 404, "an escaping path is indistinguishable from a missing one");
      assert.doesNotMatch(await escaped.text(), /operator/, "and never returns the file it was after");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

test("W1-T3175: the mount NEVER shadows a declared route, and is inert when unset", async () => {
  await withTree(async ({ root }) => {
    // Consulted LAST, so a real API route at a colliding path always wins.
    const server = createService({
      tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
      routes: [
        {
          method: "GET",
          path: "/console/assets/app.a1b2c3.js",
          scope: "read",
          handler: (_q, s) => {
            s.writeHead(200, { "content-type": "application/json" });
            s.end('{"declared":true}');
          },
        },
      ],
      staticMount: mountFor(root),
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/console/assets/app.a1b2c3.js`, {
        headers: { authorization: `Bearer ${READ_TOKEN}` },
      });
      assert.equal(await res.text(), '{"declared":true}', "the declared route wins");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }

    // AND OMITTED, THE MODULE BEHAVES AS IT DID BEFORE — a console path is a plain 404.
    const bare = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes: [] });
    await new Promise<void>((r) => bare.listen(0, "127.0.0.1", r));
    const { port: p2 } = bare.address() as { port: number };
    try {
      const res = await fetch(`http://127.0.0.1:${p2}/console/assets/app.a1b2c3.js`, {
        headers: { authorization: `Bearer ${READ_TOKEN}` },
      });
      assert.equal(res.status, 404);
      assert.match(await res.text(), /not_found/);
    } finally {
      await new Promise<void>((r) => bare.close(() => r()));
    }
    void resolve;
  });
});
