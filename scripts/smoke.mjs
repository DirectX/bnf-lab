// Смоук-тесты ядра (грамматика + лексер) без браузера: node scripts/smoke.mjs
import assert from 'node:assert/strict';
import { parseGrammar } from '../src/grammar/parser.js';
import { analyzeGrammar } from '../src/grammar/analyze.js';
import { lex } from '../src/lexer/lexer.js';
import { rdParse } from '../src/parser/rd.js';
import { pseudocode } from '../src/parser/pseudocode.js';
import { generate } from '../src/cpu8/codegen.js';
import { runCPU8 } from '../src/cpu8/cpu8.js';
import { buildSLR } from '../src/lr/slr.js';
import { runSLR } from '../src/lr/run.js';
import { exportY } from '../src/lr/exporty.js';
import { GRAMMAR_PRESETS } from '../src/data/presets.js';

let passed = 0;
const ok = (cond, what) => {
  assert.ok(cond, what);
  passed++;
  console.log('  ✓', what);
};

// ---------------------------------------------------------------- грамматика
console.log('Грамматика:');

for (const preset of GRAMMAR_PRESETS) {
  const parsed = parseGrammar(preset.grammar);
  const errs = parsed.errors.filter((e) => e.severity === 'error');
  ok(errs.length === 0, `пресет «${preset.label}» разбирается без ошибок ${errs.length ? ': ' + JSON.stringify(errs, null, 2) : ''}`);
}

{
  const mini = GRAMMAR_PRESETS.find((p) => p.id === 'mini');
  const a = analyzeGrammar(parseGrammar(mini.grammar));
  const info = a.diagnostics.filter((d) => d.severity === 'info' && d.message.includes('левая рекурсия'));
  ok(info.length >= 2, `миниязык: левая рекурсия <выражение> и <слагаемое> отмечена (${info.length})`);
  ok(a.diagnostics.some((d) => d.message.includes('висячего else')), 'миниязык: схема «висячего else» в <условный> помечена');
  ok(a.info.keywords.join(',') === 'else,if,while', 'ключевые слова извлечены: if, else, while');
  ok(a.info.puncts.includes('<=') && a.info.puncts.includes('='), 'знаки <= и = извлечены');
  ok(a.info.classes.join(',') === 'ИДЕНТ,ЧИСЛО', 'классы: ИДЕНТ, ЧИСЛО');
  ok(a.start === 'программа', 'стартовый символ — первый нетерминал');
}

{
  const a = analyzeGrammar(parseGrammar(`<a> ::= <b> "x"\n<c> ::= "y"\n`));
  ok(a.diagnostics.some((d) => d.severity === 'error' && d.message.includes('<b>')), 'ссылка на несуществующее правило — ошибка');
  ok(a.diagnostics.some((d) => d.severity === 'warn' && d.message.includes('недостижим')), 'недостижимые правила — предупреждение');
}

{
  const a = analyzeGrammar(parseGrammar(`<а> ::= "1"\n`));
  ok(a.diagnostics.length === 0, 'минимальная корректная грамматика чиста');
}

{
  const parsed = parseGrammar(`<а> ::= <б> <в\n`);
  ok(parsed.errors.some((e) => e.message.includes('угловая')), 'незакрытая «<» — ошибка с позицией');
}

{
  const parsed = parseGrammar(`программа ::= х\n`);
  ok(parsed.errors.some((e) => e.message.includes('не понимаю')), 'строчное слово без скобок — подсказка');
}

// ---------------------------------------------------------------- лексер
console.log('Лексер:');

const base = {
  keywords: new Set(['if', 'else', 'while']),
  puncts: new Set(['=', ';', '+', '-', '*', '/', '(', ')', '{', '}', '<', '>', '<=', '>=', '==', '!=']),
};

{
  const r = lex('x = 2 + 3 * (4 - 1);', base);
  ok(r.errors.length === 0, '«x = 2 + 3 * (4 - 1);» — без ошибок');
  ok(r.tokens.length === 12, `12 лексем, получено ${r.tokens.length}`);
  ok(r.tokens.every((t) => t.line >= 1 && t.col >= 1), 'у каждой лексемы есть строка и столбец');
}

{
  const strict = lex('12abc', { ...base });
  ok(strict.errors.length === 1, '12abc при строгих числах — ошибка');
  const lenient = lex('12abc', { ...base, strictNumbers: false });
  ok(lenient.errors.length === 0 && lenient.tokens.length === 2, '12abc нестрого — два токена (максимальное совпадение)');
}

{
  const r = lex('while1 = 7;', base);
  const t0 = r.tokens[0];
  ok(t0.kind === 'ident' && t0.text === 'while1' && t0.note, 'while1 — идентификатор, а не while + 1');
}

{
  const r = lex('a <= b', base);
  ok(r.tokens.some((t) => t.text === '<=' && t.kind === 'op'), '<= — одна лексема (максимальное совпадение)');
}

{
  const r = lex(') ) + = while', base);
  ok(r.errors.length === 0, '«) ) + = while» — корректный вход: лексер не знает про грамматику');
  ok(r.tokens.some((t) => t.text === 'while' && t.kind === 'kw'), 'while опознан ключевым словом');
}

{
  const r = lex('x = 256;', base);
  ok(r.tokens.some((t) => t.note && t.note.includes('восьмибитн')), '256 — замечание про восьмибитную ячейку');
}

{
  const r = lex('i = 0; // счётчик\nx = i;', { ...base, comments: true });
  ok(r.errors.length === 0 && r.skipped.length === 1 && r.tokens.length === 8, 'комментарий // пропущен (режим «домашка»)');
  const r2 = lex('x = 1; // коммент', base);
  ok(r2.errors.length === 0 && r2.tokens.filter((t) => t.text === '/').length === 2,
    'без режима комментариев // = два символа деления (в языке есть /)');
  const r3 = lex('x = 1; # х', base);
  ok(r3.errors.length === 1 && r3.errors[0].message.includes('неизвестный символ'), 'символ # вне комментариев — ошибка');
}

{
  const r = lex('x @= 1;', base);
  ok(r.errors.some((e) => e.message.includes('неизвестный символ')), 'неизвестный символ — ошибка с позицией');
}

// ---------------------------------------------------------------- парсер (часть 2)
console.log('Парсер (рекурсивный спуск по БНФ со страницы):');

const miniPreset = GRAMMAR_PRESETS.find((p) => p.id === 'mini');
const miniAn = analyzeGrammar(parseGrammar(miniPreset.grammar));

const fullLex = (src) => lex(src, {
  keywords: new Set(miniAn.info.keywords),
  puncts: new Set(miniAn.info.puncts),
  strictNumbers: true,
});

{
  const { ast, error } = rdParse(fullLex('x = 2 + 3 * (4 - 1);').tokens, miniAn.core, miniAn.start);
  ok(!error && ast, `«x = 2 + 3 * (4 - 1);» разбирается ${error ? ': ' + error.message : ''}`);

  // приоритет, закодированный структурой: узел <слагаемое> с «*» глубже верхнего «+»
  let plusDepth = -1, starDepth = -1;
  const find = (node, d) => {
    if (node.type === 'rule') {
      const kids = node.children;
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i];
        if (k.type === 'tok' && k.tok.text === '+' && node.name === 'выражение') plusDepth = Math.max(plusDepth, d);
        if (k.type === 'tok' && k.tok.text === '*' && node.name === 'слагаемое') starDepth = Math.max(starDepth, d);
      }
      kids.forEach((c) => find(c, d + 1));
    }
  };
  find(ast, 0);
  ok(plusDepth >= 0 && starDepth > plusDepth, `умножение глубже сложения (${starDepth} > ${plusDepth})`);

  // левая ассоциация: 1 + 2 + 3 = ((1 + 2) + 3) — левый ребёнок верхнего <выражение> тоже <выражение>
  const la = rdParse(fullLex('y = 1 + 2 + 3;').tokens, miniAn.core, miniAn.start);
  const exprTop = (() => {
    let found = null;
    la.ast && (function walk(n) {
      if (n.type !== 'rule') return;
      if (n.name === 'выражение' && n.children.some((c) => c.type === 'tok' && c.tok.text === '+')) found = n;
      n.children.forEach(walk);
    })(la.ast);
    return found;
  })();
  ok(exprTop && exprTop.children[0].type === 'rule' && exprTop.children[0].name === 'выражение',
    'левая ассоциативность: левый ребёнок верхнего «+» — тоже <выражение>');
}

{
  const r = rdParse(fullLex('x = 2 +').tokens, miniAn.core, miniAn.start);
  ok(r.error && r.error.message.toLowerCase().includes('ожидалось'), 'незавершённое выражение — «ожидалось одно из…»');
  const r2 = rdParse(fullLex('x = 1 2;').tokens, miniAn.core, miniAn.start);
  ok(r2.error && r2.error.message.includes('";"'), 'после «x = 1» без «;» — ошибка «ожидалось … ";"» с позицией');
}

{
  const r = rdParse(fullLex('').tokens, miniAn.core, miniAn.start);
  ok(!r.error && r.ast, 'пустая программа корректна: <программа> ::= <оператор>* допускает ε');
}

{
  const r = rdParse(fullLex('if (a <= b) { x = 1; } else y = 2;').tokens, miniAn.core, miniAn.start);
  ok(!r.error, `if/else с блоком разбирается ${r.error ? ': ' + r.error.message : ''}`);
}

{
  // вся программа-пример из части 1 целиком: цикл, блок, вложенный if
  const r = rdParse(fullLex(miniPreset.source).tokens, miniAn.core, miniAn.start);
  ok(!r.error, `программа из пресета «мини-язык» разбирается целиком ${r.error ? ': ' + r.error.message : ''}`);
}

{
  // висячий else: один из возможных разборов находится без зависания
  const d = GRAMMAR_PRESETS.find((p) => p.id === 'dangling');
  const a = analyzeGrammar(parseGrammar(d.grammar));
  const l = lex(d.source, { keywords: new Set(a.info.keywords), puncts: new Set(a.info.puncts), strictNumbers: true });
  const r = rdParse(l.tokens, a.core, a.start);
  ok(!r.error, `висячий else: ${JSON.stringify(d.source.trim())} разбирается ${r.error ? ': ' + r.error.message : ''}`);
}

{
  // псевдокод: левая рекурсия показана превращённой в цикл
  const pc = pseudocode(parseGrammar(miniPreset.grammar).rules);
  const exprBlock = pc.find((b) => b.name === 'выражение');
  ok(exprBlock && exprBlock.rec && exprBlock.text.includes('пока'), 'псевдокод <выражение>: левая рекурсия → цикл «пока…»');
  ok(!pc.find((b) => b.name === 'блок').rec, 'псевдокод <блок> — без цикла (нечего превращать)');
}

// ---------------------------------------------------------------- TinyCPU-8 (эталон check.py)
console.log('TinyCPU-8 (порт эталонного check.py):');

const CHECK = [
  ['LDI', [0x03, 0x07, 0x00], {}, 7],
  ['LDA', [0x01, 0x05, 0x00, 0x00, 0x00, 0x2A], {}, 42],
  ['STA', [0x03, 0x09, 0x02, 0x20, 0x00], { 0x20: 9 }, 9],
  ['ADD', [0x03, 0x07, 0x04, 0x06, 0x00, 0x00, 0x05], {}, 12],
  ['SUB', [0x03, 0x0A, 0x05, 0x06, 0x00, 0x00, 0x03], {}, 7],
  ['переполнение', [0x03, 0xC8, 0x04, 0x06, 0x00, 0x00, 0x64], {}, 44],
  ['JMP', [0x06, 0x04, 0x00, 0x00, 0x03, 0x01, 0x00], {}, 1],
  ['JZ взят', [0x03, 0x00, 0x07, 0x06, 0x00, 0x00, 0x03, 0x05, 0x00], {}, 5],
  ['JZ не взят', [0x03, 0x01, 0x07, 0x06, 0x00, 0x00, 0x03, 0x05, 0x00], {}, 1],
  ['PUSH/POP', [0x03, 0x0F, 0x08, 0x03, 0x01, 0x09, 0x00], {}, 15],
  ['CALL/RET', [0x0A, 0x05, 0x02, 0x30, 0x00, 0x03, 0x63, 0x0B], { 0x30: 99 }, 99],
];

for (const [name, prog, memExp, aExp] of CHECK) {
  const r = runCPU8(prog, { maxSteps: 10000 });
  let bad = r.error ? r.error.message : (r.a !== aExp ? `A=${r.a}, ожидалось ${aExp}` : '');
  if (!bad) for (const [ad, v] of Object.entries(memExp)) if (r.memory[ad] !== v) bad = `mem[${ad}]=${r.memory[ad]}, ожидалось ${v}`;
  ok(!bad, `check.py: ${name}${bad ? ' — ' + bad : ''}`);
}

// ---------------------------------------------------------------- генератор: end-to-end
console.log('Генератор мини-языка → TinyCPU-8:');

const compile = (src) => {
  const l = lex(src, { keywords: new Set(miniAn.info.keywords), puncts: new Set(miniAn.info.puncts), strictNumbers: true });
  const r = rdParse(l.tokens, miniAn.core, miniAn.start);
  assert.ok(!r.error, `разобрать «${src}»: ${r.error && r.error.message}`);
  const gen = generate(r.ast);
  const run = runCPU8(gen.bytes, { maxSteps: 500000 });
  assert.ok(!run.error, `выполнить «${src}»: ${run.error && run.error.message}`);
  return { gen, run };
};
const varv = (c, name) => c.run.memory[c.gen.varAddrs[name]];

{
  const c = compile('x = 2 + 3 * (4 - 1);');
  ok(varv(c, 'x') === 11, 'x = 2 + 3 * (4 - 1) ⇒ x = 11 (приоритет структуры дожил до байтов)');
}
{
  const c = compile('i = 0;\nwhile (i < 10) { i = i + 1; }');
  ok(varv(c, 'i') === 10, 'while (i < 10) { i = i + 1 } ⇒ i = 10 (адрес вперёд и обратная правка работают)');
}
{
  const c = compile('if (2 > 1) y = 7; else y = 9;');
  ok(varv(c, 'y') === 7, 'if (2 > 1) ⇒ выбрана ветка «тогда»');
}
for (const [a, b, rel] of [[5, 2, '<='], [5, 5, '<='], [4, 5, '<'], [5, 5, '<'], [3, 3, '=='], [3, 4, '=='], [3, 3, '!='], [9, 2, '>='], [2, 9, '>='], [7, 3, '>'], [7, 7, '>']]) {
  const want = { '<=': a <= b, '<': a < b, '==': a === b, '!=': a !== b, '>=': a >= b, '>': a > b }[rel];
  const c = compile(`a = ${a}; b = ${b};\nif (a ${rel} b) y = 1; else y = 0;`);
  ok(varv(c, 'y') === (want ? 1 : 0), `сравнение ${a} ${rel} ${b} ⇒ ${want ? 'истина' : 'ложь'} (перебор без флага «меньше»)`);
}
{
  const c = compile('a = 4; b = 5;\nx = a * b;');
  ok(varv(c, 'x') === 20, 'умножение циклом сложений: 4 * 5 = 20');
}
{
  let msg = '';
  try { compile('y = 256;'); } catch (e) { msg = e.message; }
  ok(msg.includes('256') && msg.includes('восьмибит'), 'константа 256 — отказ генератора с объяснением типа');
}
{
  let msg = '';
  try { compile('x = 10 / 2;'); } catch (e) { msg = e.message; }
  ok(msg.includes('деление') || msg.includes('Деление') || msg.includes('деление'.toUpperCase()), 'деление — честный отказ («самостоятельная работа»)');
}
{
  // программа целиком из пресета части 1
  const c = compile(miniPreset.source);
  ok(varv(c, 'x') === 11 && varv(c, 'i') === 10 && varv(c, 'y') === 255,
    `программа-пресет целиком: x=${varv(c, 'x')} i=${varv(c, 'i')} y=${varv(c, 'y')}`);
}
{
  // листинг — валидный исходник для ассемблера tinycpu-web: пересобираем и сверяем байты
  const c = compile('x = 2 + 3 * (4 - 1);');
  const re = (function miniAssemble(src) {
    const MN = { HLT: 0, LDA: 1, STA: 2, LDI: 3, ADD: 4, SUB: 5, JMP: 6, JZ: 7, PUSH: 8, POP: 9, CALL: 10, RET: 11 };
    const lines = src.split('\n').map((l) => l.replace(/[#;].*$/, '').trim()).filter(Boolean);
    const labels = {};
    let addr = 0;
    for (let l of lines) {
      const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:?\s*(.*)$/);
      if (m && l.includes(':')) { labels[m[1]] = addr; l = m[2]; }
      if (!l) continue;
      const parts = l.split(/\s+/);
      if (parts[0] === 'DB') { addr += parts.slice(1).join('').split(',').length; continue; }
      addr += parts.length > 1 ? 2 : 1;
    }
    const out = [];
    for (let l of lines) {
      const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:?\s*(.*)$/);
      if (m && l.includes(':')) l = m[2];
      if (!l) continue;
      const parts = l.split(/\s+/);
      if (parts[0] === 'DB') { parts.slice(1).join('').split(',').forEach((v) => out.push(parseInt(v, 10))); continue; }
      out.push(MN[parts[0]]);
      if (parts.length > 1) out.push(labels[parts[1]] !== undefined ? labels[parts[1]] : parseInt(parts[1], 10));
    }
    return out;
  })(c.gen.listing);
  ok(re.join() === c.gen.bytes.join(), 'листинг заново ассемблируется в те же байты — формат tinycpu-web соблюдён');
}


// ---------------------------------------------------------------- SLR (часть 3)
console.log('SLR(1) снизу вверх:');


{
  const d = GRAMMAR_PRESETS.find((p) => p.id === 'dangling');
  const a = analyzeGrammar(parseGrammar(d.grammar));
  const sl = buildSLR(a.core, a.start);
  ok(sl.conflicts.length === 1 && sl.conflicts[0].type === 'shift/reduce' && sl.conflicts[0].lookaheadText === '"else"',
    `пресет «висячий else»: ровно 1 конфликт сдвига/свёртки на "else" (получено ${sl.conflicts.length})`);
  const l = lex(d.source, { keywords: new Set(a.info.keywords), puncts: new Set(a.info.puncts), strictNumbers: true });
  const rs = runSLR(sl, l.tokens, { policy: 'shift' });
  ok(rs.accepted, 'пресет «висячий else»: программа принимается политикой сдвига');
  const rc = runSLR(sl, l.tokens, { policy: 'reduce' });
  ok(!rc.accepted, 'пресет «висячий else»: слепая политика «свёртка» НЕ принимает программу — закрывает оба if; разрешение — не галка, а %prec или переписывание');
}
{
  const f = GRAMMAR_PRESETS.find((p) => p.id === 'dangling_fixed');
  const a = analyzeGrammar(parseGrammar(f.grammar));
  const sl = buildSLR(a.core, a.start);
  ok(sl.conflicts.length === 0 && sl.isSLR, 'пресет «переписан»: конфликтов 0 — чистый SLR(1)');
  const l = lex(f.source, { keywords: new Set(a.info.keywords), puncts: new Set(a.info.puncts), strictNumbers: true });
  ok(runSLR(sl, l.tokens).accepted, 'пресет «переписан»: программа принимается без политики');
}
{
  const m = GRAMMAR_PRESETS.find((p) => p.id === 'mini');
  const a = analyzeGrammar(parseGrammar(m.grammar));
  const sl = buildSLR(a.core, a.start);
  ok(sl.conflicts.length === 1 && sl.conflicts[0].lookaheadText === '"else"',
    'миниязык: один конфликт — тот же висячий else, что предсказала эвристика части 1');
  const l = lex(m.source, { keywords: new Set(a.info.keywords), puncts: new Set(a.info.puncts), strictNumbers: true });
  ok(runSLR(sl, l.tokens, { policy: 'shift' }).accepted, 'миниязык: программа-пресет принимается снизу вверх');
}
{
  const amb = GRAMMAR_PRESETS.find((p) => p.id === 'ambig');
  const a = analyzeGrammar(parseGrammar(amb.grammar));
  const sl = buildSLR(a.core, a.start);
  ok(sl.conflicts.length >= 4, `«выражение в лоб»: конфликты на каждый знак операции (${sl.conflicts.length}) — приоритет не определён`);
}
{
  const m = GRAMMAR_PRESETS.find((p) => p.id === 'mini');
  const a = analyzeGrammar(parseGrammar(m.grammar));
  const y = exportY(a.core, a.start, { conflicts: 1 });
  ok(y.includes('%%') && y.includes('%expect 1'), 'экспорт .y: секции правил и %expect с числом конфликтов из лаборатории');
  ok(y.includes('vyrazhenie') && !y.includes('выражение'), 'экспорт .y: кириллические имена транслитерированы (bison их не примет)');
  ok(y.includes('левая рекурсия пишется напрямую'), 'экспорт .y: напоминание о главном отличии от занятия 2 на месте');
  const rulesSection = y.split('%%')[1];
  const bare = rulesSection
    .split('\n')
    .map((l) => l.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"[^"]*"/g, '')) // строки и комментарии — не в счёт
    .join('\n');
  ok(!/[*+?[\]()]/.test(bare), 'экспорт .y: в секции правил нет EBNF-модификаторов и скобок — только обычный BNF');
}
{
  const f = GRAMMAR_PRESETS.find((p) => p.id === 'dangling_fixed');
  const af = analyzeGrammar(parseGrammar(f.grammar));
  const yf = exportY(af.core, af.start, { conflicts: 0 });
  ok(yf.includes('soglasovannyy') && yf.includes('nesoglasovannyy'), 'экспорт .y: переписанная грамматика экспортируется (транслитерация составных имён)');
  ok(!yf.includes('%expect'), 'экспорт .y: без конфликтов %expect не добавляется');
}

console.log(`\nВсего проверок: ${passed} — все пройдены.`);
