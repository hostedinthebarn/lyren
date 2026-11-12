// Sort choice for the sidebar's Projects list (client only; `position`, the Projects page's drag
// order, is never touched). 'manual' is the stored order and the default.

import type { ProjectDTO } from '@shared/types';

export type ProjectSort = 'manual' | 'name-asc' | 'name-desc' | 'key-asc' | 'key-desc';

export const PROJECT_SORT_KEY = 'lyren.sidebar.projectsSort';

export const PROJECT_SORTS: ReadonlyArray<{ value: ProjectSort; label: string; short: string }> = [
  { value: 'manual', label: 'Manual order', short: 'Manual' },
  { value: 'name-asc', label: 'Name, A to Z', short: 'Name ↑' },
  { value: 'name-desc', label: 'Name, Z to A', short: 'Name ↓' },
  { value: 'key-asc', label: 'Key, A to Z', short: 'Key ↑' },
  { value: 'key-desc', label: 'Key, Z to A', short: 'Key ↓' },
];

export const isProjectSort = (v: unknown): v is ProjectSort => PROJECT_SORTS.some((s) => s.value === v);

/** A sorted copy; 'manual' returns the list as given (the server's position order). */
export function sortProjects<T extends Pick<ProjectDTO, 'name' | 'key'>>(projects: readonly T[], sort: ProjectSort): T[] {
  if (sort === 'manual') return [...projects];
  const dir = sort.endsWith('desc') ? -1 : 1;
  const cmp =
    sort.startsWith('name')
      ? (a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
      : (a: T, b: T) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  // Array.prototype.sort is stable, so ties keep their manual order in both directions.
  return [...projects].sort((a, b) => dir * cmp(a, b));
}
