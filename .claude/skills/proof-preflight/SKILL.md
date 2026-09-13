---
name: proof-preflight
description: Verify a task's declared proofs and file scope before and after an implementation.
applies-to: implement
---

# Proof Preflight

Use this procedure for implementation tasks before changing files.

1. Read the task record's acceptance proofs before editing.
2. Run the exact reachable proof before editing when that is safe.
3. State the task's declared file scope before editing.
4. Implement only the declared scope.
5. Rerun the exact proof after editing.
6. Run the test-tier check after editing.
7. Report every proof as OBSERVED or NOT OBSERVED.

Boundaries:

- Do not generate a script.
- Do not download a script.
- Do not execute a script.
- Do not self-approve.
- Do not deploy.
- Do not expand scope.
