// Personal access tokens as Account settings → Security lists them (design §5.12).
import { describe, expect, it } from 'vitest';
import { tokenDetails, tokenExpired, tokenScopeText } from './accessTokens';

const NOW = Date.parse('2026-10-20T12:00:00Z');

describe('access token texts', () => {
  it('names the scope: every space, a space by name, or one the account left', () => {
    const names = new Map([['abcdefghijklmnop', 'Web']]);
    expect(tokenScopeText({ spaceId: null }, names)).toBe('Every space');
    expect(tokenScopeText({ spaceId: 'abcdefghijklmnop' }, names)).toBe('Web');
    expect(tokenScopeText({ spaceId: 'zzzzzzzzzzzzzzzz' }, names)).toBe('A space you left');
  });

  it('says when it was used and when it expires', () => {
    const base = { createdAt: '2026-10-01T12:00:00Z', lastUsedAt: null, expiresAt: null };
    expect(tokenDetails(base, NOW)).toMatch(/^Never used · Never expires · Created /);
    expect(tokenExpired({ expiresAt: '2026-10-20T11:59:59Z' }, NOW)).toBe(true);
    expect(tokenExpired({ expiresAt: '2026-10-21T00:00:00Z' }, NOW)).toBe(false);
    expect(tokenDetails({ ...base, expiresAt: '2026-10-19T12:00:00Z' }, NOW)).toContain('Expired ');
    expect(tokenDetails({ ...base, lastUsedAt: '2026-10-20T11:00:00Z', expiresAt: '2027-01-01T12:00:00Z' }, NOW)).toMatch(/^Last used .* · Expires /);
  });
});
