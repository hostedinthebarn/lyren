export function buildNotices(root: string): string;
export function productionPackages(lock: unknown): { name: string; version: string; license: string; dir: string }[];
export const ALLOWED_LICENCES: ReadonlySet<string>;
export const INJECTED_BY_BUILD: { name: string; what: string; file: string; from: string; to: string }[];
