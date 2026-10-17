- **recurrence is a class signal, not a root-cause diagnosis; preserve the per-PR disposition and file a bounded observation proposal before class-wide repair.**
  Three PRs reached the blocked-ambiguous repair surface within seven days, but the recorded evidence
  does not establish one shared mechanism:

  - #3030 was dirty around a deletion (or had no captured file evidence) and escalated without
    auto-resolution.
  - #3039 exhausted 2/2 strikes with CI red; the attempted failed-log fetch itself failed, leaving
    the triggering test or mechanism unknown.
  - #3043 exhausted 3/2 strikes with CI and coverage-ratchet red.

  Preserve those per-PR dispositions and their evidence gaps. A recurrence count justifies looking
  for a common cause; it does not supply one. Before proposing a class-wide repair, file a bounded
  observation plan that names the cohort, observation window, exact per-PR evidence to capture,
  and a falsifier that would show the cases are not one class. Keep the existing dispositions
  unchanged while collecting that evidence. If the observations do not converge on a mechanism,
  close the class hypothesis and retain separate causes rather than broadening the repair.
