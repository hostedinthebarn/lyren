# ranking-core (pairwise ranking engine)

Pure TypeScript, no dependencies, no Lyren imports. Given a list of items and the answers so far
(`{ a, b, winner | null }`), it picks the next pair to ask and ranks the items.

## Provenance: READ THIS BEFORE TRUSTING IT

This is meant to be a copy of `packages/ranking-core` from `hostedinthebarn/which-first`
(merged in PR #2, 2026-11-23). **The Worker that wrote this folder had no access to GitHub, so it is NOT a
verbatim copy.** It is a re-implementation of the behaviour described in the HL-4 comments:

- Bradley-Terry log-strengths by MM iteration with a small virtual-opponent prior; a tie counts half a win.
- A repeated pair overrides the earlier answer (the undo).
- `nextPair` skips any pair whose order already follows from chained answers, then picks the open pair
  with the closest strengths, and returns `null` when the order is settled.
- `rank` orders by chained-answer order first, strength second, and gives a 0-100 display score.

Follow-up (Lyren task for Primary): overwrite `index.ts` and `engine.test.ts` here with the real files and
record the which-first commit hash below. The service layer (`server/src/services/prioritize.ts`) only uses
`nextPair` and `rank`, through the `Answer` shape, so a swap should be a small adapter change at most.

Copied from which-first commit: **none yet (re-implementation)**.

Packaging as a shared package is HL-11, not this folder's job.
