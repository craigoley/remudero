#!/usr/bin/env node
import { isMainModule } from "./lib/argv.mjs";
import { git } from "./lib/git.mjs";

function hasTrailer(message, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^Remudero-Task:[ \\t]*${escaped}[ \\t]*$`, "m").test(message);
}

export function main(args = process.argv.slice(2)) {
  const [id] = args;
  if (args.length !== 1 || !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(id)) {
    console.log("unmeasured: usage: node scripts/task-shipped.mjs <id>");
    return 3;
  }

  console.log(`Caveat: a run-${id}-* head merged with no trailer is not visible in git log.`);
  console.log("Head-ref query (when that credit path matters; use rmd gh -- while a broker is live):");
  console.log(`gh api --paginate 'repos/<owner>/<repo>/pulls?state=closed&per_page=100' --jq ` +
    `'[.[]|select(.merged_at!=null)|select(.head.ref|startswith("run-${id}-"))|.number]'`);

  // NUL fields preserve multiline messages; one log read binds the result and age to the same SHA.
  const result = git(["log", "--no-show-signature", "--no-decorate", "-z",
    "--format=%H%x00%ct%x00%B", "origin/main", "--"]);
  if (result.error || result.status !== 0) {
    console.log(`unmeasured: cannot read origin/main: ${result.error?.message || result.stderr.trim()}`);
    return 3;
  }
  const fields = result.stdout.split("\0");
  const commits = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    commits.push({ sha: fields[i], timestamp: Number(fields[i + 1]), message: fields[i + 2] });
  }
  if (commits.length === 0 || commits.some((c) => !/^[a-f0-9]+$/.test(c.sha) ||
      !Number.isFinite(c.timestamp))) {
    console.log("unmeasured: origin/main history could not be parsed");
    return 3;
  }
  const head = commits[0];
  console.log(`origin/main: ${head.sha}`);
  console.log(`age_seconds: ${Math.floor(Date.now() / 1000) - head.timestamp} ` +
    `(committed ${new Date(head.timestamp * 1000).toISOString()})`);

  const control = commits.find((c) => /^Remudero-Task:[ \t]*([^ \t\r\n]+)[ \t]*$/m.test(c.message));
  const controlId = control?.message.match(/^Remudero-Task:[ \t]*([^ \t\r\n]+)[ \t]*$/m)?.[1];
  if (!control || !hasTrailer(control.message, controlId)) {
    console.log("unmeasured: no trailer found by the positive control on origin/main");
    return 3;
  }
  console.log(`positive control: ${controlId} at ${control.sha}`);

  const shipped = commits.filter((c) => hasTrailer(c.message, id));
  console.log(`${shipped.length > 0 ? "shipped" : "not shipped"}: ${id}`);
  for (const c of shipped) console.log(`shipped commit: ${c.sha} ${c.message.split("\n")[0]}`);
  for (const c of commits) {
    const subject = c.message.split("\n")[0];
    if (subject.split(/[^A-Za-z0-9-]+/).includes(id) &&
        !/^Remudero-Task:[ \t]*([^ \t\r\n]+)[ \t]*$/m.test(c.message)) {
      console.log(`named only: ${c.sha} ${subject}`);
    }
  }
  return shipped.length > 0 ? 4 : 0;
}

if (isMainModule(import.meta.url)) process.exitCode = main();
