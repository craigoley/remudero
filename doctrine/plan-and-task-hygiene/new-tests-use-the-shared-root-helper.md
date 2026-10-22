- **New tests compute the repository root with `REPO_ROOT` or `repoRoot()` from
  `#test/helpers/repo-root.js`, never from their own location.** The existing W1-T9863 census in
  `test/every-test-finds-the-repo-root-through-one-helper.test.ts` rejects a new own-folder root
  and net growth of that population. A correctly placed nested test has a different depth;
  `new URL("..", import.meta.url)` does not identify the repository independently of its caller.
  The helper does. PR #13555's new nested rehearsal test hit this gate before its native repair.
  Caller-relative fixture assets remain fixture assets; this rule concerns the repository root.

Run `test/every-test-finds-the-repo-root-through-one-helper.test.ts` alongside the new test before its first push. Keep existing tests within the task's declared scope; this instruction adds no task companions.
