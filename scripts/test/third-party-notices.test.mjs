// The generated third-party-notices.txt (scripts/lib/third-party-notices.mjs): Darren's notice first, every
// production package of the real lockfile present, no dev-only package.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALLOWED_LICENCES, buildNotices, productionPackages } from '../lib/third-party-notices.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const lock = JSON.parse(fs.readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));

describe('third-party notices', () => {
  it('skips dev-only packages and keeps production ones', () => {
    const names = productionPackages(lock).map((p) => p.name);
    expect(names).toContain('react');
    expect(names).toContain('lucide-react');
    expect(names).not.toContain('vite');
    expect(names).not.toContain('vitest');
  });

  it('opens with the Lyren Plan MIT notice naming Darren Eberly', () => {
    const text = buildNotices(ROOT);
    expect(text.indexOf('Copyright (c) 2026 Darren Eberly')).toBeGreaterThan(-1);
    expect(text.indexOf('Copyright (c) 2026 Darren Eberly')).toBeLessThan(text.indexOf('react@'));
  });

  it('lists every production package once', () => {
    const text = buildNotices(ROOT);
    for (const p of productionPackages(lock)) expect(text).toContain(`${p.name}@${p.version} (${p.license})`);
  });

  it('has Lyren Plan production packages only, with no dev-only licence in the file', () => {
    const text = buildNotices(ROOT);
    expect(text).toContain('lucide-react@');
    expect(text).not.toContain('lightningcss');
    expect(text).not.toContain('sharp-libvips');
  });

  it("includes Vite's own MIT notice for the modulepreload polyfill it injects, not its bundled deps", () => {
    const text = buildNotices(ROOT);
    expect(text).toMatch(/vite@[\d.]+ \(MIT\), for its modulepreload polyfill/);
    expect(text).toContain('Vite contributors');
    expect(text).not.toContain('# Licenses of bundled dependencies');
  });

  it('every production package carries an allowed licence', () => {
    for (const p of productionPackages(lock)) expect(ALLOWED_LICENCES.has(p.license), `${p.name}: ${p.license}`).toBe(true);
  });
});
