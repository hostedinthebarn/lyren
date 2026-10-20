// Personal access tokens as Account settings → Security shows them (design §5.12, /api/account/tokens).
// Pure, so the texts are unit-tested (accessTokens.test.ts).

import type { TokenRole } from '@shared/roles';
import type { TokenDTO } from '@shared/types';
import { formatDate, formatRelativeTime, isoToLocalDate } from '../../lib/format';

const day = (iso: string) => formatDate(isoToLocalDate(iso));

export const TOKEN_ROLE_LABELS: Readonly<Record<TokenRole, string>> = { viewer: 'Viewer', member: 'Member', admin: 'Admin' };

/** The lifetimes offered when creating a token (days; null: never expires). */
export const TOKEN_EXPIRY_OPTIONS: ReadonlyArray<{ value: string; label: string; days: number | null }> = [
  { value: '30', label: '30 days', days: 30 },
  { value: '90', label: '90 days', days: 90 },
  { value: '365', label: '1 year', days: 365 },
  { value: 'never', label: 'Never', days: null },
];

/** "Every space" or the space's name (a space the account left reads as "A space you left"). */
export function tokenScopeText(token: Pick<TokenDTO, 'spaceId'>, spaceNames: ReadonlyMap<string, string>): string {
  if (token.spaceId === null) return 'Every space';
  return spaceNames.get(token.spaceId) ?? 'A space you left';
}

export function tokenExpired(token: Pick<TokenDTO, 'expiresAt'>, nowMs: number): boolean {
  return token.expiresAt !== null && Date.parse(token.expiresAt) <= nowMs;
}

/** The row's details: when it was last used, and when it expires. */
export function tokenDetails(token: Pick<TokenDTO, 'lastUsedAt' | 'expiresAt' | 'createdAt'>, nowMs: number): string {
  const used = token.lastUsedAt === null ? 'Never used' : `Last used ${formatRelativeTime(token.lastUsedAt, nowMs)}`;
  const expiry =
    token.expiresAt === null
      ? 'Never expires'
      : tokenExpired(token, nowMs)
        ? `Expired ${day(token.expiresAt)}`
        : `Expires ${day(token.expiresAt)}`;
  return [used, expiry, `Created ${day(token.createdAt)}`].join(' · ');
}
