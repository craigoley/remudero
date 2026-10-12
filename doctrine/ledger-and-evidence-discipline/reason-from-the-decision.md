- **A ledger line must carry the reason from the DECISION THAT PRODUCED ITS OUTCOME.**
  `automerge.armed` once logged `outcome: "ledger-refused"` beside `reason: "verdict is a full PASS"`
  — outcome from the gate that refused, reason from `decideAutoMergeArm` which had APPROVED, with
  the real reason going only to stdout. A self-contradictory line is worse than a terse one: it
  sends every later diagnosis toward a policy question instead of the real defect. *(#981)*
