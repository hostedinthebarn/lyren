import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { WeekStart } from '@shared/dates';
import type { DashboardDTO, SearchResultDTO } from '@shared/types';
import { useSpaceId } from '../app/space';
import { qs, spaceApi } from './client';
import { qk } from './keys';

/** The `assignees` query parameter of GET /api/dashboard: ids and `none`, comma-separated ('' = everyone). */
export function assigneesParam(ids: readonly (number | null)[]): string {
  return ids.map((id) => (id === null ? 'none' : String(id))).join(',');
}

/**
 * `weekStartsOn`: the account's preference (the week's totals). `assignees`: only their tasks (LYR-17; null =
 * unassigned), everyone's when empty.
 */
export function useDashboard(today: string, weekStartsOn: WeekStart, assignees: readonly (number | null)[] = []) {
  const sid = useSpaceId();
  const param = assigneesParam(assignees);
  return useQuery({
    queryKey: qk.dashboard(sid, today, weekStartsOn, param),
    queryFn: () => spaceApi(sid).get<DashboardDTO>(`/dashboard${qs({ today, weekStartsOn, ...(param && { assignees: param }) })}`),
    // Switching whose tasks are shown keeps the old numbers on screen until the new ones arrive.
    placeholderData: keepPreviousData,
  });
}

/** Search in the page's space; disabled for queries shorter than 1 character after trimming. */
export function useSearch(q: string, limit = 10) {
  const sid = useSpaceId();
  const term = q.trim();
  return useQuery({
    queryKey: qk.search(sid, `${term}|${limit}`),
    queryFn: () => spaceApi(sid).get<SearchResultDTO>(`/search${qs({ q: term, limit })}`),
    enabled: term.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
}
