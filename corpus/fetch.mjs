#!/usr/bin/env node
// corpus/fetch.mjs — pull a subset of the DocAI corpus sources (see SOURCES.md)
// into corpus/data/ and write corpus/manifest.json, which the in-app
// "Load corpus" button reads. No dependencies; uses git for the clones.
//
//   node corpus/fetch.mjs --list
//   node corpus/fetch.mjs funsd xfund
//
// Real DCS/Family Case File scans are confidential, so these are adjacent
// domains (forms, handwriting, gov scans) used for transfer.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data');

const SETS = {
  funsd: { kind: 'form', note: 'scanned forms, text + field links (small)', url: 'https://github.com/guillaumejaume/FUNSD.git' },
  xfund: { kind: 'form', note: 'FUNSD extended to 7 languages', url: 'https://github.com/doc-analysis/XFUND.git' },
  naf:   { kind: 'form', note: 'US National Archives + FamilySearch forms', url: 'https://github.com/herobd/NAF_dataset.git' },
  tabme: { kind: 'form', note: 'handwritten form OCR + JSON', url: 'https://github.com/bernardadhitya/handwritten-form-ocr-ie-json-dataset.git' },
};

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help') || args.includes('--list')) {
  console.log('usage: node corpus/fetch.mjs [set...]   (default: funsd)\n\nsets:');
  for (const [k, v] of Object.entries(SETS)) console.log('  ' + k.padEnd(6), v.note + '  ' + v.url);
  process.exit(0);
}

function walk(dir) {
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    if (e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const chosen = args.filter((a) => !a.startsWith('-'));
const sets = chosen.length ? chosen : ['funsd'];
fs.mkdirSync(DATA, { recursive: true });
const documents = [];
for (const name of sets) {
  const s = SETS[name];
  if (!s) { console.warn('unknown set:', name); continue; }
  const dir = path.join(DATA, name);
  console.log('·', name, '→', dir);
  if (!fs.existsSync(dir)) {
    try { execFileSync('git', ['clone', '--depth', '1', s.url, dir], { stdio: 'inherit' }); }
    catch (e) { console.warn('  clone failed:', e.message); continue; }
  }
  const files = walk(dir).filter((f) => /\.(txt|json|md|csv)$/i.test(f));
  let n = 0;
  for (const f of files) {
    let t = ''; try { t = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    if (t.length < 40) continue;
    documents.push({ id: name + '_' + n, kind: s.kind, title: name + ': ' + path.basename(f), file: path.relative(HERE, f) });
    if (++n >= 80) break;
  }
  console.log('   ', n, 'items');
}
fs.writeFileSync(path.join(HERE, 'manifest.json'), JSON.stringify({ corpus: 'docai-sources', documents }, null, 2));
console.log('wrote corpus/manifest.json with', documents.length, 'documents');
