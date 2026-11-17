// Смоук-тесты ядра (грамматика + лексер) без браузера: node scripts/smoke.mjs
import assert from 'node:assert/strict';
import { parseGrammar } from '../src/grammar/parser.js';
import { analyzeGrammar } from '../src/grammar/analyze.js';
import { lex } from '../src/lexer/lexer.js';
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

console.log(`\nВсего проверок: ${passed} — все пройдены.`);
