- **A shard's `status:` field is not a completion signal — it stays `queued` on tasks that
  shipped.** THREE THIS SESSION: W1-T1127 read `queued` on main while its build had merged as
  #2476 (both credit paths — trailer AND a `run-W1-T1127-<digits>` head); W1-T1065's
  admission-time re-check is in `daemon.ts` under its own name; W1-T1059's caller is wired in
  `run-task.ts`. Read alone it cost a full rebuild that was discarded. The credit projection above
  is the ONLY completion signal; `status:` is what the FILING wrote and nothing updates it on
  merge. Pair it with the `ls-remote` hazard already under "Investigation discipline": a deleted
  head and a stale `status:` agree on "not done" and are both wrong. *(#2476 — a whole build
  discarded on two signals that agreed)*
