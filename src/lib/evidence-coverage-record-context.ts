import { join, relative } from "node:path";
import { ghExec } from "./github-transport.js";
import { mergePlanBlobs } from "./plan.js";
import type { EvidenceRevision } from "./feedback-evidence-revision.js";
import { resolveRepoLayout } from "./repo-layout.js";
import { hostWorktreeGit } from "./worktree-git.js";

export interface EvidenceRecordContext {
  mainSha: string;
  expectedPlan: Record<string, string>;
  records: Map<string, string>;
  wasDeleted: (path: string) => boolean;
  closure: (id: string, status: string, pr?: string) => EvidenceRevision["closure"];
}

export interface EvidenceContextPorts {
  git?: (args: string[]) => string;
  gh?: (args: string[]) => string;
  repository?: string;
}

/** Search completeness and actual PR facts are separate evidence. Any bad page stays unknown. */
export function taskClosure(taskId: string, repository: string, gh: (args: string[]) => string): "open" | "closed" | "unknown" {
  try {
    const numbers = new Set<number>();
    for (const query of [`repo:${repository} is:pr "Remudero-Task: ${taskId}" in:body`, `repo:${repository} is:pr head:run-${taskId}-`]) {
      let received = 0, total: number | undefined;
      const seen = new Set<number>();
      for (let page = 1; ; page++) {
        const result = JSON.parse(gh(["api", `search/issues?q=${encodeURIComponent(query)}&per_page=100&page=${page}`]));
        if (result.incomplete_results !== false || !Number.isInteger(result.total_count) || result.total_count < 0
          || result.total_count > 1000 || !Array.isArray(result.items)) return "unknown";
        if (total !== undefined && total !== result.total_count) return "unknown";
        total = result.total_count;
        for (const item of result.items) {
          if (!Number.isInteger(item.number) || item.number <= 0 || seen.has(item.number)) return "unknown";
          seen.add(item.number);
          numbers.add(item.number);
        }
        received += result.items.length;
        if (received === result.total_count) break;
        if (received > result.total_count || result.items.length === 0) return "unknown";
      }
    }
    let matched = false, open = false;
    for (const number of numbers) {
      const pr = JSON.parse(gh(["api", `repos/${repository}/pulls/${number}`]));
      if (pr.number !== number || pr.base?.repo?.full_name !== repository || typeof pr.body !== "string"
        || typeof pr.head?.ref !== "string" || !["open", "closed"].includes(pr.state)
        || !(pr.merged_at === null || typeof pr.merged_at === "string" && Number.isFinite(Date.parse(pr.merged_at)))) return "unknown";
      if (!pr.body.split(/\r?\n/).includes(`Remudero-Task: ${taskId}`) && !pr.head.ref.startsWith(`run-${taskId}-`)) continue;
      matched = true;
      if (pr.state === "open") open = true;
      else if (pr.merged_at === null) return "unknown";
    }
    return open ? "open" : matched ? "closed" : "unknown";
  } catch (error) {
    // A transport/JSON failure is never evidence that a task is complete.
    return "unknown";
  }
}

/** Coverage records and both plan sources come from ONE immutable fetched main object. */
export function prepareEvidenceRecordContext(root: string, ports: EvidenceContextPorts = {}): EvidenceRecordContext {
  const git = ports.git ?? ((args: string[]) => hostWorktreeGit(root, args, { maxBuffer: 1 << 26 }));
  git(["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main", "--quiet"]);
  const mainSha = git(["rev-parse", "origin/main"]).trim();
  const layoutPath = relative(root, join(resolveRepoLayout(root, () => undefined).stateDir, "layout.json"));
  const layoutEntry = git(["ls-tree", mainSha, "--", layoutPath]).trim();
  if (layoutEntry !== "" && !/^100(?:644|755) blob /.test(layoutEntry)) {
    throw new Error("complete evidence layout unavailable: canonical plan-source layout is not a regular file");
  }
  const layoutBytes = layoutEntry === "" ? undefined : git(["show", `${mainSha}:${layoutPath}`]);
  const layout = resolveRepoLayout(root, () => layoutBytes);
  const monolith = relative(root, layout.planMonolith), shards = relative(root, join(layout.planDir, "tasks.d"));
  const monolithEntry = git(["ls-tree", mainSha, "--", monolith]).trim();
  const shardsEntry = git(["ls-tree", mainSha, "--", shards]).trim();
  if (!/^100(?:644|755) blob /.test(monolithEntry) || shardsEntry !== "" && !/^040000 tree /.test(shardsEntry)) {
    throw new Error("complete evidence plan unavailable: canonical plan-source is missing or has an unsupported object type");
  }
  const listing = git(["ls-tree", "-r", "--name-only", mainSha, "--", monolith, shards, "plan/feedback"]);
  const paths = listing.split("\n").filter(Boolean);
  if (!paths.includes(monolith)) throw new Error(`complete evidence plan unavailable: ${monolith} missing`);
  const expectedPlan: Record<string, string> = { [monolith]: monolithEntry.split(/[ \t]/)[2]!,
    [shards]: shardsEntry === "" ? "absent" : shardsEntry.split(/[ \t]/)[2]! };
  const blobs = paths.filter((path) => path === monolith || (path.startsWith(`${shards}/`) && /\.ya?ml$/.test(path)))
    .map((path) => ({ label: `${mainSha}:${path}`, text: git(["show", `${mainSha}:${path}`]) }));
  const plan = mergePlanBlobs(blobs);
  const records = new Map(paths.filter((path) => /^plan\/feedback\/evidence-coverage-[^/]+\.yaml$/.test(path))
    .map((path) => [path, git(["show", `${mainSha}:${path}`])]));
  const gh = ports.gh ?? ((args: string[]) => ghExec(args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const facts = new Map<string, ReturnType<typeof taskClosure>>();
  return { mainSha, expectedPlan, records,
    wasDeleted: (path) => !records.has(path) && git(["log", "-1", "--format=%H", mainSha, "--", path]).trim() !== "",
    closure: (id, status, pr) => {
    if (status === "rejected") return { eligible: true, reason: "rejected with a measured gap", ...(pr ? { pr } : {}) };
    if (!["accepted", "answered"].includes(status)) return { eligible: false, reason: "record is open" };
    const tasks = plan.tasks.filter((task) => JSON.stringify(task).split(/[^a-zA-Z0-9_-]+/).includes(id));
    for (const task of tasks) {
      let state = facts.get(task.id);
      if (state === undefined) {
        const repository = ports.repository ?? git(["config", "--get", "remote.origin.url"]).trim()
          .replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "");
        state = taskClosure(task.id, repository, gh);
        facts.set(task.id, state);
      }
      if (state !== "closed") return { eligible: false, reason: `task ${task.id} is ${state}` };
    }
    return { eligible: true, reason: tasks.length ? "complete task PR evidence" : "complete plan has no referenced tasks",
      completePlan: true, tasks: tasks.map((task) => ({ id: task.id, state: "closed" })), ...(pr ? { pr } : {}) };
  } };
}
