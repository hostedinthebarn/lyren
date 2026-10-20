// The format of a personal access token (directory/accessTokens.ts), shared by the gateways, which recognise
// one before any database is involved: `lyr_pat_` and 32 random bytes in base64url.

export const TOKEN_PREFIX = 'lyr_pat_';
export const TOKEN_RE = /^lyr_pat_[A-Za-z0-9_-]{43}$/;
