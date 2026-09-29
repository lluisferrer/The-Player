// Genera legal/THIRD-PARTY-NOTICES.txt: la llista de components de tercers que
// es distribueixen amb ezyPlayer, amb la seva llicència i el text de llicència.
//
// Fonts:
//   - Rust: `cargo metadata` filtrat per a Windows i Linux (les plataformes que
//     es distribueixen), recorrent NOMÉS les dependències normals des del crate
//     de l'app (les de build i dev no acaben a l'executable).
//   - Frontend: les `dependencies` de package.json i les seves transitives
//     (el que Vite empaqueta), llegides de node_modules.
//   - Afegits manuals: components que no surten de cap gestor (SDK d'ASIO, fonts).
//
// Els textos de llicència idèntics (p. ex. Apache-2.0) s'escriuen un sol cop i
// es referencien, perquè el fitxer no pesi megues.
//
// Ús:  node tools/licenses/generate.mjs   (tornar-lo a executar en canviar deps)

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = path.join(root, 'src-tauri', 'Cargo.toml');
const outFile = path.join(root, 'legal', 'THIRD-PARTY-NOTICES.txt');
const PLATFORMS = ['x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu'];
const LICENSE_FILE_RE = /^(licen[cs]e|copying|notice)/i;

// Fitxers de llicència d'un directori de paquet (i de la carpeta LICENSES/ si n'hi ha).
function licenseFiles(dir) {
  const found = [];
  const scan = (d) => {
    if (!fs.existsSync(d)) return;
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      if (fs.statSync(full).isFile() && LICENSE_FILE_RE.test(name)) found.push(full);
    }
  };
  scan(dir);
  scan(path.join(dir, 'LICENSES'));
  return found;
}

// ── Rust ─────────────────────────────────────────────────────────────────────
function rustComponents() {
  const byId = new Map();
  for (const platform of PLATFORMS) {
    const meta = JSON.parse(execFileSync('cargo', [
      'metadata', '--format-version', '1', '--manifest-path', manifest, '--filter-platform', platform,
    ], { maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' }));
    const pkgs = new Map(meta.packages.map((p) => [p.id, p]));
    const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
    // Recorregut des de l'arrel seguint només arestes de tipus normal (kind null).
    const seen = new Set([meta.resolve.root]);
    const queue = [meta.resolve.root];
    while (queue.length) {
      const node = nodes.get(queue.shift());
      for (const dep of node.deps) {
        const normal = dep.dep_kinds.some((k) => k.kind === null);
        if (normal && !seen.has(dep.pkg)) { seen.add(dep.pkg); queue.push(dep.pkg); }
      }
    }
    for (const id of seen) {
      const p = pkgs.get(id);
      if (!p.source) continue; // crates propis (path), no són de tercers
      byId.set(`${p.name}@${p.version}`, {
        name: p.name,
        version: p.version,
        license: p.license || (p.license_file ? 'see license file' : 'UNKNOWN'),
        url: p.repository || p.homepage || `https://crates.io/crates/${p.name}`,
        files: licenseFiles(path.dirname(p.manifest_path)),
      });
    }
  }
  return [...byId.values()];
}

// ── Frontend (npm) ───────────────────────────────────────────────────────────
function npmComponents() {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const out = new Map();
  const queue = Object.keys(rootPkg.dependencies || {});
  while (queue.length) {
    const name = queue.shift();
    if (out.has(name)) continue;
    const dir = path.join(root, 'node_modules', name);
    const pkgFile = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgFile)) throw new Error(`Falta node_modules/${name} (cal npm install)`);
    const p = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    const repo = typeof p.repository === 'string' ? p.repository : p.repository?.url;
    out.set(name, {
      name,
      version: p.version,
      license: typeof p.license === 'string' ? p.license : p.license?.type || 'UNKNOWN',
      url: (repo || p.homepage || `https://www.npmjs.com/package/${name}`).replace(/^git\+/, ''),
      files: licenseFiles(dir),
    });
    queue.push(...Object.keys(p.dependencies || {}));
  }
  return [...out.values()];
}

// ── Afegits manuals ──────────────────────────────────────────────────────────
const MANUAL = `ASIO
  ASIO is a trademark and software of Steinberg Media Technologies GmbH.
  ezyPlayer for Windows includes support for the ASIO interface, used under
  licence from Steinberg Media Technologies GmbH (https://www.steinberg.net).

Symphonia (MPL-2.0)
  The Symphonia audio decoding crates are distributed under the Mozilla Public
  License 2.0 and are used unmodified. Their source code is available at
  https://github.com/pdeljanov/Symphonia.

Fonts: Inter and JetBrains Mono
  Licensed under the SIL Open Font License 1.1 (https://openfontlicense.org).
  Inter: https://github.com/rsms/inter
  JetBrains Mono: https://github.com/JetBrains/JetBrainsMono
`;

// ── Sortida ──────────────────────────────────────────────────────────────────
const sortByName = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version);
const rust = rustComponents().sort(sortByName);
const npm = npmComponents().sort(sortByName);

// Textos únics: hash → { n, text }; cada component referencia els seus números.
const texts = new Map();
const refsFor = (c) => c.files.map((f) => {
  const text = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n').trim();
  const h = createHash('sha256').update(text).digest('hex');
  if (!texts.has(h)) texts.set(h, { n: texts.size + 1, text, first: `${c.name} ${c.version} (${path.basename(f)})` });
  return texts.get(h).n;
});

const line = '='.repeat(78);
const section = (title, list) => [
  line, title, line, '',
  ...list.map((c) => {
    const refs = refsFor(c);
    // Sense fitxer al paquet: enllaç al text estàndard de cada identificador SPDX.
    const spdx = [...new Set(c.license.match(/[A-Za-z0-9.-]+/g) || [])]
      .filter((id) => !['OR', 'AND', 'WITH'].includes(id))
      .map((id) => `https://spdx.org/licenses/${id}.html`);
    const where = refs.length ? `license text: [${refs.join('], [')}]` : `standard license text: ${spdx.join(' , ')}`;
    return `${c.name} ${c.version}\n  license: ${c.license}\n  url: ${c.url}\n  ${where}\n`;
  }),
].join('\n');

const body = [
  'ezyPlayer — Third-Party Notices',
  '',
  'ezyPlayer includes the third-party components listed below. Each component is',
  'the property of its respective authors and is distributed under its own',
  'licence, reproduced at the end of this file. Nothing in the ezyPlayer End User',
  'License Agreement restricts rights granted to you by these licences.',
  '',
  `Generated ${new Date().toISOString().slice(0, 10)} by tools/licenses/generate.mjs.`,
  `${rust.length} Rust crates, ${npm.length} JavaScript packages.`,
  '',
  line, 'Additional notices', line, '', MANUAL,
  section('JavaScript packages (user interface)', npm),
  section('Rust crates (application and audio engine)', rust),
  line, 'License texts', line, '',
  ...[...texts.values()].map((t) => `----- [${t.n}] first seen in ${t.first} -----\n\n${t.text}\n`),
].join('\n');

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, body.replace(/\n/g, '\r\n'), 'utf8');

const missing = [...rust, ...npm].filter((c) => !c.files.length).map((c) => `${c.name} ${c.version} (${c.license})`);
console.log(`Escrit ${path.relative(root, outFile)}: ${rust.length} crates, ${npm.length} paquets npm, ${texts.size} textos únics.`);
if (missing.length) console.log(`Sense fitxer de llicència (${missing.length}):\n  ${missing.join('\n  ')}`);
