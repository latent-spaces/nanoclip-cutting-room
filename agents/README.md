# agents/ — Composer and Finisher

- **[composer.md](composer.md)**: one Composer per scaffolded clip —
  Kit styling + palette wiring + check-green loop on that clip's composition only.
  Parallelism ≤3; each Composer reads ONLY `references/compose-short.md` (the
  distilled HF contract), never the full hyperframes suite. Spawn contract, steering
  (SendMessage while alive), and the no-Agent-tool degraded path are in the file.
- **[finisher.md](finisher.md)**: one light agent before the delivery
  render — fresh eyes across all clips (check, switch-scan, snapshots,
  captions-vs-words sync, mount integrity). Reports only, fixes nothing; findings
  route per references/iterate.md §1.
