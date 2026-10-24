REPORT
- The active SQLite fixture cleanup lesson records diagnostic publication ordering:
  close the database, await flushReadModelTransactions(), then remove the owned directory.
- The SQLite fixture cleanup lesson preserves evidence when close or flush fails.
- PR#13850 and PR#13848 job 120713354605 supply the incident provenance.
