// /api/prioritize — pairwise prioritization (HL-5): make a set of tasks, answer "which first?", read the result,
// and confirm it onto tasks.priority_rank. The logic is services/prioritize.ts; the engine is ranking-core.

import { Hono } from 'hono';
import { prioritizeChoiceInput, prioritizeConfirmInput, prioritizeSetCreateInput } from '@shared/schemas';
import type {
  PrioritizeChoiceDTO,
  PrioritizeItemDTO,
  PrioritizeNextDTO,
  PrioritizeResultDTO,
  PrioritizeSetDTO,
} from '@shared/types';
import type { AppEnv, Deps } from '../env';
import { readId, readJson } from '../http/validate';
import {
  confirmResult,
  createSet,
  getResult,
  getSet,
  listChoices,
  listSets,
  nextQuestion,
  recordChoice,
  undoChoice,
} from '../services/prioritize';
import { currentUser } from '../space/context';

export function prioritizeRoutes({ db }: Deps) {
  const r = new Hono<AppEnv>();

  r.get('/sets', (c) => c.json<PrioritizeSetDTO[]>(listSets(db)));

  r.post('/sets', async (c) => {
    const input = await readJson(c, prioritizeSetCreateInput);
    return c.json<PrioritizeSetDTO>(createSet(db, { userId: currentUser(c).id }, input), 201);
  });

  r.get('/sets/:id', (c) => c.json<PrioritizeSetDTO & { items: PrioritizeItemDTO[] }>(getSet(db, readId(c))));

  r.get('/sets/:id/next', (c) => c.json<PrioritizeNextDTO>(nextQuestion(db, readId(c))));

  r.get('/sets/:id/choices', (c) => c.json<PrioritizeChoiceDTO[]>(listChoices(db, readId(c))));

  r.post('/sets/:id/choices', async (c) => {
    const id = readId(c);
    const input = await readJson(c, prioritizeChoiceInput);
    return c.json<PrioritizeChoiceDTO>(recordChoice(db, { userId: currentUser(c).id }, id, input));
  });

  r.delete('/sets/:id/choices/:a/:b', (c) => {
    undoChoice(db, readId(c), readId(c, 'a'), readId(c, 'b'));
    return c.json({ ok: true as const });
  });

  r.get('/sets/:id/result', (c) => c.json<PrioritizeResultDTO>(getResult(db, readId(c))));

  r.post('/sets/:id/confirm', async (c) => {
    const id = readId(c);
    const input = await readJson(c, prioritizeConfirmInput);
    return c.json<PrioritizeResultDTO>(confirmResult(db, { userId: currentUser(c).id }, id, input));
  });

  return r;
}
