# Risk-judge disposition corpus

This corpus pins the autonomous consequence policy around the existing risk-judge seam.

The judge does not decide whether a deterministic finding is true. The gate supplies that fact;
the judge chooses what the automation should do with it:

- `LAND` — close the finding and continue;
- `REPAIR` — apply a computable repair and continue;
- `LAND+DEBT` — continue and file bounded follow-up work;
- `STOP` — stop only when the finding is unrecoverable.

The healthy control and recoverable cases are intentional. A corpus that only contains stops would
train the controller to confuse uncertainty with danger and would damage autonomous flow.

The candidate-risk cases also pin the ordinary judge action: a high-confidence low-risk judgment
proceeds, while an explicitly high-risk judgment escalates. This is not a blanket approval gate;
it is the existing risk-judge action mapping under evaluation.

These fixtures exercise the existing pure/controller path. They do not spawn an LLM, change live
production routing, or spend money. A later integration task can promote the same corpus to a
bounded shadow or replay run once the observed outcomes are available.
