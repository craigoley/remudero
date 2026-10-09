import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(new URL("../hooks/deny-floor.sh", import.meta.url));

function check(command: string, expected: 0 | 2): void {
  const home = mkdtempSync(join(tmpdir(), "rmd-test-gh-heredoc-"));
  try {
    mkdirSync(join(home, "remudero"));
    writeFileSync(join(home, "remudero", "gh-last-read"), "");
    const result = spawnSync("bash", [hook], {
      input: JSON.stringify({ tool_input: { command } }),
      encoding: "utf8",
      env: { ...process.env, HOME: home, RMD_GH_CACHE_HOME: home, RMD_GH_COOLDOWN_S: "180" },
    });
    assert.equal(result.status, expected, `${command}\n${result.stderr}`);
    if (expected === 2) assert.match(result.stderr, /read-shaped/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("test/a-heredoc-body-that-names-gh-is-not-a-gh-call.test.ts", () => {
  check("gh pr view 1", 2); // Positive control: the isolated cadence stamp is live.
  for (const reader of ["python3 -", "cat > source.txt"]) {
    for (const delimiter of ["EOF", "'EOF'", '"EOF"']) {
      check(`${reader} <<${delimiter}\nover the async gh transport\nEOF`, 0);
      check(`${reader} <<${delimiter}\n$( gh pr view 1)\nEOF`, 2);
      check(`${reader} <<${delimiter}\n\u0060gh pr view 1\u0060\nEOF`, 2);
    }
  }
  check("gh pr view 1 <<'EOF'\ninput data\nEOF", 2);
  check("cat <<-'EOF'\n\tover the async gh transport\n\tEOF\ngh pr view 1", 2);
  check("cat <<'EOF'\nover the async gh transport\nEOF\necho finished", 0);
  check("cat <<'EOF' | cat\nover the async gh transport\nEOF", 0);
});

test("a heredoc fed to an interpreter that runs gh is still a gh call", () => {
  for (const reader of ["bash", "sh", "zsh", "/bin/bash", "env bash", "ssh host bash -s", "ssh host"]) {
    for (const delimiter of ["EOF", "'EOF'", '"EOF"']) {
      check(`${reader} <<${delimiter}\ngh pr view 1\nEOF`, 2);
    }
  }
  check("bash <<-'EOF'\n\tgh pr view 1\n\tEOF", 2);
  check("cat <<'EOF'; bash <<'CODE'\ndata\nEOF\ngh pr view 1\nCODE", 2);
});
