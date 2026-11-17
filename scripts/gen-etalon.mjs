// Генерирует python-references/etalon-js.json — байтовый эталон для сверки
// Python-референсов занятий 1–2 с приложением.
//
//   npm run gen-etalon
//
// После изменения src/cpu8/codegen.js или src/parser/rd.js перегенерируйте
// эталон и перегоните python3 python-references/zanyatie2_parser_codegen.py:
// если байты разошлись, референс отстаёт от приложения.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseGrammar } from '../src/grammar/parser.js';
import { analyzeGrammar } from '../src/grammar/analyze.js';
import { lex } from '../src/lexer/lexer.js';
import { rdParse } from '../src/parser/rd.js';
import { generate } from '../src/cpu8/codegen.js';
import { runCPU8 } from '../src/cpu8/cpu8.js';
import { GRAMMAR_PRESETS } from '../src/data/presets.js';

const here = dirname(fileURLToPath(import.meta.url));

const mini = GRAMMAR_PRESETS.find((p) => p.id === 'mini');
const a = analyzeGrammar(parseGrammar(mini.grammar));

const PROGRAMS = {
  '01_prioritet': 'x = 2 + 3 * (4 - 1);',
  '02_prisvoivanie': 'x = 7;',
  '03_cycle': 'i = 0;\nwhile (i < 10) { i = i + 1; }',
  '04_if_then': 'if (a <= b) y = 1; else y = 2;',
  '05_sravneniya': 'a = 5; b = 2;\nif (a <= b) y = 1; else y = 0;',
  '06_mul': 'a = 4; b = 5;\nx = a * b;',
  '07_preset': mini.source,
};

const out = {};
for (const [name, src] of Object.entries(PROGRAMS)) {
  const l = lex(src, {
    keywords: new Set(a.info.keywords),
    puncts: new Set(a.info.puncts),
    strictNumbers: true,
  });
  const r = rdParse(l.tokens, a.core, a.start);
  if (r.error) { out[name] = { source: src, parse_error: r.error.message }; continue; }
  const gen = generate(r.ast);
  const run = runCPU8(gen.bytes, { maxSteps: 500000 });
  out[name] = {
    source: src,
    bytes: gen.bytes,
    listing: gen.listing,
    vars: gen.varAddrs,
    code_len: gen.codeLen,
    result: run.error ? { error: run.error.message }
      : Object.fromEntries(Object.entries(gen.varAddrs).map(([n, ad]) => [n, run.memory[ad]])),
    steps: run.steps,
  };
}

const dest = join(here, '..', 'python-references', 'etalon-js.json');
writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
console.log(`эталон записан: ${dest} (${Object.keys(out).length} программ)`);
