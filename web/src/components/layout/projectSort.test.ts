// The sidebar Projects sort: each mode and direction, and the choice restored on reload.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isProjectSort, PROJECT_SORT_KEY, sortProjects, type ProjectSort } from './projectSort';
import { usePersistentState } from './usePersistentState';

// Manual order is the array order (the server's position order).
const LIST = [
  { name: 'beta', key: 'WEB' },
  { name: 'Alpha 10', key: 'API' },
  { name: 'Alpha 2', key: 'ZED' },
  { name: 'Gamma', key: 'MKT' },
];
const names = (s: ProjectSort) => sortProjects(LIST, s).map((p) => p.name);
const keys = (s: ProjectSort) => sortProjects(LIST, s).map((p) => p.key);

describe('sortProjects', () => {
  it('manual keeps the given order and does not mutate it', () => {
    expect(names('manual')).toEqual(['beta', 'Alpha 10', 'Alpha 2', 'Gamma']);
    const copy = [...LIST];
    sortProjects(LIST, 'name-desc');
    expect(LIST).toEqual(copy);
  });

  it('name: case-insensitive and natural, ascending and descending', () => {
    expect(names('name-asc')).toEqual(['Alpha 2', 'Alpha 10', 'beta', 'Gamma']);
    expect(names('name-desc')).toEqual(['Gamma', 'beta', 'Alpha 10', 'Alpha 2']);
  });

  it('key: plain string comparison, ascending and descending', () => {
    expect(keys('key-asc')).toEqual(['API', 'MKT', 'WEB', 'ZED']);
    expect(keys('key-desc')).toEqual(['ZED', 'WEB', 'MKT', 'API']);
  });
});

describe('persisted choice', () => {
  afterEach(() => vi.unstubAllGlobals());

  const store = (initial: Record<string, string>) => {
    const data = new Map(Object.entries(initial));
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    });
    return data;
  };
  const read = () => {
    function Probe() {
      const [sort] = usePersistentState<ProjectSort>(PROJECT_SORT_KEY, 'manual', isProjectSort);
      return createElement('span', null, sort);
    }
    return renderToStaticMarkup(createElement(Probe));
  };

  it('is restored on reload', () => {
    store({ [PROJECT_SORT_KEY]: JSON.stringify('key-desc') });
    expect(read()).toBe('<span>key-desc</span>');
  });

  it('defaults to manual when nothing, or something unknown, is stored', () => {
    store({});
    expect(read()).toBe('<span>manual</span>');
    store({ [PROJECT_SORT_KEY]: JSON.stringify('size-asc') });
    expect(read()).toBe('<span>manual</span>');
  });
});
