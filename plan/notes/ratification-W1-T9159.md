# Validation note — W1-T9159

The validation task is recorded in `plan/tasks.d/W1-T9159-validation-pass-ensure-new-placeholder-tasks-declare-touched-files-and-a.yaml`.
That task record declares its touched files and provides an executable `grep:` acceptance proof.
The index anchor in `plan/tasks.yaml` points here so the task is discoverable from the canonical
plan without duplicating its claim or proof.

This note records the intended invariant for new placeholder tasks: each declares the files it
will touch and includes at least one executable acceptance proof. Validation of the draft-writing
behavior itself is outside this plan-only file scope.
