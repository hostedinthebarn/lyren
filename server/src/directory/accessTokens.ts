// Personal access tokens: how a script or an assistant (the MCP endpoint, gateway/mcp.ts) reaches the
// space API without a browser. A token is `lyr_pat_` and 32 random bytes in base64url, shown once; the
// directory keeps only its sha256, like sessions and device tokens.
//
// What a token can do is less than its account can:
// - it reaches space routes only: the gateways refuse it on every directory path (account, admin, auth),
//   so it cannot change a password, add a passkey or manage the instance;
// - its role in a space is the lower of the member's role and the token's max_role (never owner);
// - it can be limited to one space (space_id);
// - its re-auth time is the epoch, so routes behind the re-auth window (export, replace imports) refuse it.
//
// It stops working when it expires or is revoked, when the account is disabled, and when the account's
// auth_epoch moves on (password reset or change, email change): the token records the epoch it was
// created under, so the places that end an account's other credentials end its tokens without a line here.

import { ROLE_RANK, type SpaceRole } from '@shared/roles';
import { TOKEN_PREFIX } from '../core/accessToken';
import { randomToken, sha256Hex } from '../core/crypto';
import type { Db } from '../core/db';
import type { TrustedMeta } from '../core/ports';
import { recordEvent } from './security';
import type { UserRow } from './users';

export { TOKEN_PREFIX, TOKEN_RE } from '../core/accessToken';

/** Roles a token can be capped at: never owner (owner-only routes are the archive and the space's life). */
export const TOKEN_ROLES = ['viewer', 'member', 'admin'] as const;
export type TokenRole = (typeof TOKEN_ROLES)[number];

const MAX_TOKENS_PER_USER = 20;
const NAME_MAX = 80;
/** last_used_at is written at most this often. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/** The re-auth time of every token identity: long past, so the re-auth window is never open (§5.4.4). */
export const TOKEN_REAUTH_AT = new Date(0).toISOString();

export interface TokenRow {
  id: number;
  user_id: number;
  name: string;
  token_hash: string;
  space_id: number | null;
  max_role: TokenRole;
  auth_epoch: number;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface TokenSummary {
  id: number;
  name: string;
  /** The space's public id, or null for every space of the account. */
  spaceId: string | null;
  maxRole: TokenRole;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function isTokenRole(value: unknown): value is TokenRole {
  return typeof value === 'string' && (TOKEN_ROLES as readonly string[]).includes(value);
}

/** The lower of a member's role and a token's cap. */
export function cappedRole(role: SpaceRole, cap: TokenRole): SpaceRole {
  return ROLE_RANK[role] <= ROLE_RANK[cap] ? role : cap;
}

/**
 * A new token for `user`; the raw token exists only in the returned value. Throws when the name is
 * empty or too long, the space is not one of the user's, or the account already has the maximum.
 */
export function createToken(
  db: Db,
  o: {
    user: UserRow;
    name: string;
    /** A space's public id, or null for every space. */
    spaceId: string | null;
    maxRole: TokenRole;
    expiresAt: string | null;
    meta: TrustedMeta | null;
    nowMs: number;
  },
): { token: string; summary: TokenSummary } {
  const name = o.name.trim();
  if (name === '' || name.length > NAME_MAX) throw new Error(`A token needs a name of 1 to ${NAME_MAX} characters`);
  if (!isTokenRole(o.maxRole)) throw new Error(`A token's role is one of ${TOKEN_ROLES.join(', ')}`);
  if (o.expiresAt !== null && !(Date.parse(o.expiresAt) > o.nowMs)) throw new Error('A token must expire in the future');
  let spaceRowId: number | null = null;
  if (o.spaceId !== null) {
    const space = db.get<{ id: number }>(
      `SELECT s.id FROM spaces s JOIN memberships m ON m.space_id = s.id AND m.user_id = :userId
       WHERE s.public_id = :publicId AND s.deleted_at IS NULL`,
      { userId: o.user.id, publicId: o.spaceId },
    );
    if (!space) throw new Error(`No space ${o.spaceId} for this account`);
    spaceRowId = space.id;
  }
  const count = db.get<{ n: number }>('SELECT count(*) AS n FROM personal_access_tokens WHERE user_id = :userId AND revoked_at IS NULL', {
    userId: o.user.id,
  });
  if ((count?.n ?? 0) >= MAX_TOKENS_PER_USER) throw new Error(`An account can have at most ${MAX_TOKENS_PER_USER} tokens`);

  const token = TOKEN_PREFIX + randomToken();
  const now = iso(o.nowMs);
  const row = db.tx(() => {
    const inserted = db.get<TokenRow>(
      `INSERT INTO personal_access_tokens (user_id, name, token_hash, space_id, max_role, auth_epoch, created_at, expires_at)
       VALUES (:userId, :name, :hash, :spaceId, :maxRole, :epoch, :now, :expires)
       RETURNING *`,
      {
        userId: o.user.id,
        name,
        hash: sha256Hex(token),
        spaceId: spaceRowId,
        maxRole: o.maxRole,
        epoch: o.user.auth_epoch,
        now,
        expires: o.expiresAt,
      },
    );
    if (!inserted) throw new Error('The token was not stored');
    recordEvent(db, {
      type: 'token_created',
      userId: o.user.id,
      meta: o.meta,
      data: { tokenId: inserted.id, name, spaceId: o.spaceId, maxRole: o.maxRole, expiresAt: o.expiresAt },
      nowMs: o.nowMs,
    });
    return inserted;
  });
  return { token, summary: { ...summarize(row), spaceId: o.spaceId } };
}

/**
 * The token and its account for a token hash, or null when there is none, or it is revoked or expired,
 * the account is disabled, or the account's auth_epoch has moved on since the token was created.
 */
export function findToken(db: Db, tokenHash: string, nowMs: number): { token: TokenRow; user: UserRow } | null {
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) return null;
  const token = db.get<TokenRow>('SELECT * FROM personal_access_tokens WHERE token_hash = :hash', { hash: tokenHash });
  if (!token || token.revoked_at !== null) return null;
  if (token.expires_at !== null && Date.parse(token.expires_at) <= nowMs) return null;
  const user = db.get<UserRow>("SELECT * FROM users WHERE id = :id AND status = 'active'", { id: token.user_id });
  if (!user || user.auth_epoch !== token.auth_epoch) return null;
  return { token, user };
}

/** Record the use of a token, at most hourly. */
export function touchToken(db: Db, token: TokenRow, nowMs: number): void {
  if (token.last_used_at !== null && nowMs - Date.parse(token.last_used_at) < TOUCH_INTERVAL_MS) return;
  db.run('UPDATE personal_access_tokens SET last_used_at = :now WHERE id = :id', { id: token.id, now: iso(nowMs) });
}

/** The spaces a token reaches, with the token's role in each (its cap applied). */
export function tokenSpaces(
  db: Db,
  token: TokenRow,
): Array<{ id: string; name: string; status: 'importing' | 'active'; role: SpaceRole }> {
  const rows = db.all<{ public_id: string; name: string; status: 'importing' | 'active'; role: SpaceRole }>(
    `SELECT s.public_id, s.name, s.status, m.role FROM spaces s JOIN memberships m ON m.space_id = s.id AND m.user_id = :userId
     WHERE s.deleted_at IS NULL AND s.status <> 'provisioning' AND (:spaceId IS NULL OR s.id = :spaceId)
     ORDER BY s.name COLLATE NOCASE, s.public_id`,
    { userId: token.user_id, spaceId: token.space_id },
  );
  return rows.map((r) => ({ id: r.public_id, name: r.name, status: r.status, role: cappedRole(r.role, token.max_role) }));
}

/** The account's tokens that are neither revoked nor expired, newest first. */
export function listTokens(db: Db, userId: number, nowMs: number): TokenSummary[] {
  const rows = db.all<TokenRow & { space_public_id: string | null }>(
    `SELECT t.*, s.public_id AS space_public_id FROM personal_access_tokens t LEFT JOIN spaces s ON s.id = t.space_id
     WHERE t.user_id = :userId AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > :now)
     ORDER BY t.created_at DESC, t.id DESC`,
    { userId, now: iso(nowMs) },
  );
  return rows.map((r) => ({ ...summarize(r), spaceId: r.space_public_id }));
}

/** Revoke one of the account's tokens; false when it has no such live token. */
export function revokeToken(db: Db, o: { userId: number; tokenId: number; meta: TrustedMeta | null; nowMs: number }): boolean {
  return db.tx(() => {
    const changed = db.run(
      'UPDATE personal_access_tokens SET revoked_at = :now WHERE id = :id AND user_id = :userId AND revoked_at IS NULL',
      { id: o.tokenId, userId: o.userId, now: iso(o.nowMs) },
    ).changes;
    if (changed === 0) return false;
    recordEvent(db, { type: 'token_revoked', userId: o.userId, meta: o.meta, data: { tokenId: o.tokenId }, nowMs: o.nowMs });
    return true;
  });
}

/** Maintenance: delete tokens revoked or expired more than 30 days ago. */
export function purgeOldTokens(db: Db, nowMs: number): number {
  const cutoff = iso(nowMs - 30 * 86_400_000);
  return db.run(
    `DELETE FROM personal_access_tokens
     WHERE (revoked_at IS NOT NULL AND revoked_at < :cutoff) OR (expires_at IS NOT NULL AND expires_at < :cutoff)`,
    { cutoff },
  ).changes;
}

function summarize(row: TokenRow): TokenSummary {
  return {
    id: row.id,
    name: row.name,
    spaceId: null,
    maxRole: row.max_role,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
  };
}
