// third-party-notices.txt: the licence notices the app must carry (LYR-15). It lists Lyren Plan's own
// MIT notice (LICENSE: Darren Eberly's copyright first) and then every production dependency in
// package-lock.json, its licence and its licence text as installed in node_modules. Production means
// the lockfile entries not flagged dev: the client bundle and the server bundle both draw only from
// those. Vite's minifier strips the licence comments of bundled code, so this file is the notice.
// Run after `npm ci`; it throws if a production package is not installed or ships no licence text,
// so a gap fails the build instead of shipping a short notice. Pure apart from reading files; the
// Vite plugin in web/vite.config.ts emits the result as /third-party-notices.txt.

import fs from 'node:fs';
import path from 'node:path';

// Licences a production package may carry. Anything else (or none declared) fails the build, so a new
// dependency under an unfamiliar licence gets a human decision instead of shipping unreviewed.
export const ALLOWED_LICENCES = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'CC0-1.0', 'Apache-2.0']);

const LICENCE_FILE = /^(licen[cs]e|copying|notice)(\.|$|-)/i;

/** The production packages of `lock` (a parsed package-lock.json): [{ name, version, license, dir }], sorted. */
export function productionPackages(lock) {
  const out = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (key === '' || entry.dev || entry.devOptional || entry.link) continue;
    const name = entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    out.push({ name, version: entry.version, license: entry.license ?? 'UNKNOWN', dir: key });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
}

const norm = (text) => text.replace(/\r\n/g, '\n').trim();

/** The text of every licence/notice file in `dir`, joined, or '' when there is none. */
function licenceText(dir) {
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && LICENCE_FILE.test(e.name))
    .map((e) => e.name)
    .sort();
  return files.map((f) => norm(fs.readFileSync(path.join(dir, f), 'utf8'))).join('\n\n');
}

// Build-tool code that ends up in the shipped bundle although its package is dev-only. Vite injects its
// modulepreload polyfill into the client entry (CodeRabbit on PR #13, confirmed in dist/web: `relList.supports`),
// so Vite's own MIT notice ships too. Only the "Vite core license" section is taken: the rest of Vite's
// LICENSE.md covers dependencies bundled into the build tool, none of which reach the browser.
export const INJECTED_BY_BUILD = [
  { name: 'vite', what: 'modulepreload polyfill', file: 'LICENSE.md', from: '# Vite core license', to: '# Licenses of bundled dependencies' },
];

/** The notice text for one INJECTED_BY_BUILD entry, read from node_modules; throws if it can't be found. */
function injectedNotice(root, lock, item) {
  const entry = lock.packages?.[`node_modules/${item.name}`];
  if (!entry) throw new Error(`third-party notices: ${item.name} is not in package-lock.json`);
  const file = path.join(root, 'node_modules', item.name, item.file);
  if (!fs.existsSync(file)) throw new Error(`third-party notices: ${item.name} is not installed (${file}); run npm ci`);
  const all = norm(fs.readFileSync(file, 'utf8'));
  const start = all.indexOf(item.from);
  const end = all.indexOf(item.to);
  if (start === -1 || end <= start) throw new Error(`third-party notices: can't find the ${item.name} notice in ${item.file}`);
  return { label: `${item.name}@${entry.version} (${entry.license}), for its ${item.what}`, text: norm(all.slice(start, end)) };
}

/** Builds the notices text for the project at `root`. */
export function buildNotices(root) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const own = norm(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'));
  const groups = new Map(); // licence text -> ["name@version (SPDX)"]
  for (const pkg of productionPackages(lock)) {
    if (!ALLOWED_LICENCES.has(pkg.license)) {
      throw new Error(`third-party notices: ${pkg.name}@${pkg.version} has licence "${pkg.license}", which is not on the allowlist (${[...ALLOWED_LICENCES].join(', ')})`);
    }
    const dir = path.join(root, pkg.dir);
    if (!fs.existsSync(dir)) throw new Error(`third-party notices: ${pkg.name}@${pkg.version} is not installed (${pkg.dir}); run npm ci`);
    const text = licenceText(dir);
    if (text === '') throw new Error(`third-party notices: ${pkg.name}@${pkg.version} (${pkg.license}) ships no licence file`);
    const list = groups.get(text) ?? [];
    list.push(`${pkg.name}@${pkg.version} (${pkg.license})`);
    groups.set(text, list);
  }
  for (const item of INJECTED_BY_BUILD) {
    const { label, text } = injectedNotice(root, lock, item);
    const list = groups.get(text) ?? [];
    list.push(label);
    groups.set(text, list);
  }
  const rule = '='.repeat(72);
  const parts = [
    'Third-party notices',
    '',
    'Lyren Plan was created by Darren Eberly and is released under the MIT licence, reproduced below.',
    'It is built on these open-source packages, each under its own licence.',
    '',
    rule,
    'Lyren Plan',
    rule,
    '',
    own,
  ];
  for (const [text, names] of groups) {
    parts.push('', rule, names.join('\n'), rule, '', text);
  }
  return `${parts.join('\n')}\n`;
}
