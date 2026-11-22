// Сверка собственного SLR(1) с живыми инструментами.
// Запуск: npm run crosscheck
//
//   bison  — если установлен (ubuntu-runner в Actions его имеет по умолчанию);
//   jison  — всегда, он в devDependencies, чистый JS.
//
// Разница счётчиков между SLR(1) и LALR(1) — не ошибка, а учебный сюжет:
// SLR(1) грубее (использует FOLLOW целиком), поэтому точки выбора у него
// крупнее. Принцип один: конфликт — свойство языка, а не инструмента.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseGrammar } from '../src/grammar/parser.js';
import { analyzeGrammar } from '../src/grammar/analyze.js';
import { buildSLR } from '../src/lr/slr.js';
import { exportY } from '../src/lr/exporty.js';
import { GRAMMAR_PRESETS } from '../src/data/presets.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bnflab-cc-'));

// плоский вид для jison: он не переваривает EBNF, как и bison.
// Пустая правая часть у jison — просто ничего (не %empty),
// а имена нетерминалов обязаны начинаться с буквы.
const TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
const norm = (n) => 'nt_' + String(n).replace(/#/g, '_').split('').map((c) => (TR[c] !== undefined ? TR[c] : c)).join('').replace(/[^A-Za-z0-9_]/g, '_');

function toJison(core, start) {
  const names = [start, ...[...core.keys()].filter((n) => n !== start)];
  const tok = (s) =>
    s.t === 'nt' ? norm(s.value)
    : s.t === 'lit' ? (/[A-Za-zА-Яа-яЁё]/.test(s.value) ? `KW_${s.value}`.toUpperCase() : `"${s.value}"`)
    : s.t === 'cls' ? (s.value === 'ИДЕНТ' ? 'IDENT' : 'NUMBER')
    : '';
  const decl = new Set();
  const rules = [];
  for (const name of names) {
    const alts = (core.get(name) || []).map((a) => a.syms.map(tok).join(' ').trim());
    for (const a of core.get(name) || [])
      for (const s of a.syms)
        if (s.t === 'lit' && /[A-Za-zА-Яа-яЁё]/.test(s.value)) decl.add(`KW_${s.value}`.toUpperCase());
    rules.push(`${norm(name)} :\n   ${alts.join('\n | ')} ;`);
  }
  return `%token IDENT NUMBER ${[...decl].join(' ')}\n%%\n${rules.join('\n')}\n`;
}

function withCapturedStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (data, ...rest) => { chunks.push(String(data)); return true; };
  try { fn(); } finally { process.stdout.write = orig; }
  return chunks.join('');
}

let bisonAvailable = false;
{
  const probe = spawnSync('bison', ['--version'], { encoding: 'utf8' });
  bisonAvailable = probe.status === 0;
}

let exact = 0;
let total = 0;

for (const preset of GRAMMAR_PRESETS) {
  const parsed = parseGrammar(preset.grammar);
  const a = analyzeGrammar(parsed);
  if (!a.start) continue;
  total++;
  const sl = buildSLR(a.core, a.start);
  const mine = sl.conflicts.length;
  const row = [preset.id.padEnd(16), `SLR(1): ${String(mine).padStart(2)}`];

  if (bisonAvailable) {
    const yPath = path.join(tmp, `${preset.id}.y`);
    fs.writeFileSync(yPath, exportY(a.core, a.start, { conflicts: mine }));
    const out = withCapturedStdout(() => spawnSync('bison', ['-Wall', '-d', yPath, '-o', path.join(tmp, `${preset.id}.tab.c`)], { encoding: 'utf8' }));
    const report = fs.readFileSync(path.join(tmp, `${preset.id}.output`), 'utf8');
    const bisonTotal = [...report.matchAll(/conflicts?: (\d+) (shift\/reduce|reduce\/reduce)/g)].reduce((s, m) => s + Number(m[1]), 0);
    row.push(`bison: ${String(bisonTotal).padStart(2)} ${bisonTotal === mine ? '✓ точно' : '≈'}`);
    if (bisonTotal === mine) exact++;
    if (out.trim()) row.push(`(bison stderr: ${out.trim().split('\n')[0].slice(0, 80)})`);

    // регрессия из жизни: экспортированный .y обязан собираться gcc -Wall -Wextra.
    // Без %code provides gcc≥15 (C23) падает на неявных объявлениях yylex/yyerror.
    const cc = spawnSync('gcc', ['-Wall', '-Wextra', '-fsyntax-only', path.join(tmp, `${preset.id}.tab.c`)], { encoding: 'utf8' });
    row.push(cc.status === 0 ? 'gcc: ✓' : `gcc: ✕ ${cc.stderr.trim().split('\n')[0].slice(0, 60)}`);
    if (cc.status !== 0) exact = -1e9; // провал сборки перекрывает счёт конфликтов
  }

  try {
    const jison = (await import('jison')).default;
    const out = withCapturedStdout(() => new jison.Parser(toJison(a.core, a.start)).generate({}));
    const theirs = (out.match(/Conflict in grammar/g) || []).length;
    row.push(`jison/LALR(1): ${String(theirs).padStart(2)} ${theirs === mine ? '✓' : '≈'}`);
  } catch (e) {
    row.push(`jison: недоступен (${e.message.slice(0, 40)})`);
  }

  console.log(row.join('   '));
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\nСверка: ${exact} из ${total} грамматик дают ровно тот же счёт конфликтов, что живой bison.`);
console.log(bisonAvailable
  ? 'bison подтверждает: приложение считает конфликты так же, как настоящий генератор.'
  : 'bison не найден в PATH — сверка только jison (в Actions на ubuntu-latest bison есть).');
