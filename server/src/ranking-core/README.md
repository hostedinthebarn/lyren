# ranking-core (pairwise ranking engine)

Pure TypeScript, no dependencies, no Lyren imports. Given a list of items and the answers so far
(`{ a, b, winner | null }`), it picks the next pair to ask and ranks the items.

## Provenance

`engine.ts` is a **verbatim copy** of `packages/ranking-core/src/engine.ts` from
`hostedinthebarn/which-first`, commit **`c2b24fb`** (main, PR #2 "HL-4 ranking engine", 2026-11-23).
Its tests are in `server/test/ranking-core/` (`engine.test.ts`, `harness.ts`, `pyrandom.ts`), copied from
the same commit with only their import paths changed.

**Don't edit `engine.ts` here.** Fix it in which-first and copy it across again, updating the commit above.
Lyren's own needs are in `index.ts`, a thin adapter:

- It drops answers about unknown items, self-pairs and invalid winners before they reach the engine.
- `nextPair(items, answers, askAbout)` can leave items out of the questions. A set's deleted tasks stay
  in the result but aren't asked about.
- `rank` returns one row per item: position, score (0-100) and win, loss and tie counts.

The service layer (`server/src/services/prioritize.ts`) uses only the adapter.

Packaging this as a shared package instead of a copy is HL-11.
