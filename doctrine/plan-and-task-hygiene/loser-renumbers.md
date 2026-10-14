- **A contested reservation is never deleted and an unfiled one is never free — the
  LOSER of a race renumbers.** A reserved id with no shard anywhere is HELD, not abandoned; deleting
  the ref re-opens the race it settled, and reclaiming one is an operator decision. *(2026-08-18: two hosts
  minted `refs/rmd-id/W1-T967` 5.76s apart; the first read back its own nonce, then after the PR
  opened re-read the other's commit — it carried `+`. Only the message's pid+host+time named the
  winner; the ref has no identity field.)*
