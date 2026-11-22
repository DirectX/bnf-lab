// Экспорт БНФ со страницы в файл .y для bison — блок 2 занятия 3.
//
// Два решения, выстраданных на живых сборках:
//
// 1. bison НЕ понимает EBNF (звёздочки, скобки, квадратные скобки).
//    Поэтому экспортируется РАСКРЫТАЯ грамматика из analyze.js — обычный BNF,
//    где модификаторы свёрнуты во вспомогательные правила. И главное:
//    ЛЕВАЯ РЕКУРСИЯ ЗДЕСЬ ЗАПИСЫВАЕТСЯ НАПРЯМУЮ, потому что метод снизу вверх.
//
// 2. bison НЕ объявляет yylex и yyerror — это функции пользователя, они должны
//    быть объявлены ДО кода yyparse. Определение в эпилоге (после %% … %%)
//    слишком поздно: gcc ≥15 собирает по C23, где неявное объявление — ошибка.
//    Поэтому прототипы выводятся через %code provides (попадают в .tab.h),
//    а каркас в эпилоге их реализует.
//
// Строковым литералам даются имена токенов (%token KW_IF "if"): yylex из
// лексера занятия 1 возвращает именно имена (из .tab.h), а в правилах и в
// отчёте .output литералы остаются читаемыми («ожидалось "else"»).

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};

// Имя нетерминала → bison-идентификатор: транслит + #N → _N
export function latin(name) {
  const base = String(name).replace(/#/g, '_').split('').map((c) => (TRANSLIT[c] !== undefined ? TRANSLIT[c] : c)).join('')
    .replace(/[^A-Za-z0-9_]/g, '_');
  return /^[0-9]/.test(base) ? '_' + base : base || 'sym';
}

// Классы лексем → принятые в примерах англоязычные имена токенов
const CLASS_TOKEN = { ИДЕНТ: 'IDENT', ЧИСЛО: 'NUMBER' };

// Знаки → имена токенов, чтобы yylex мог их возвращать
const PUNCT_NAME = {
  '=': 'OP_ASSIGN', ';': 'OP_SEMI', '+': 'OP_PLUS', '-': 'OP_MINUS', '*': 'OP_STAR', '/': 'OP_SLASH',
  '(': 'OP_LPAREN', ')': 'OP_RPAREN', '{': 'OP_LBRACE', '}': 'OP_RBRACE',
  '<': 'OP_LT', '>': 'OP_GT', '<=': 'OP_LE', '>=': 'OP_GE', '==': 'OP_EQEQ', '!=': 'OP_NE',
};

const cstr = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export function tokenName(literal) {
  if (PUNCT_NAME[literal]) return PUNCT_NAME[literal];
  if (/^[A-Za-zА-Яа-яЁё]+$/.test(literal)) return `KW_${latin(literal).toUpperCase()}`;
  return `SYM_${literal.split('').map((c) => c.charCodeAt(0).toString(16).toUpperCase()).join('_')}`;
}

export function exportY(core, start, { conflicts = 0 } = {}) {
  const names = [...core.keys()];
  // старт — первым: bison берёт первое правило как начальный символ
  const ordered = [start, ...names.filter((n) => n !== start)];

  const keywords = new Set();
  const puncts = new Set();
  const classes = new Set();

  const symY = (s) => {
    if (s.t === 'nt') return latin(s.value);
    if (s.t === 'lit') {
      (/^[A-Za-zА-Яа-яЁё]+$/.test(s.value) ? keywords : puncts).add(s.value);
      return `"${cstr(s.value)}"`;
    }
    if (s.t === 'cls') { classes.add(s.value); return CLASS_TOKEN[s.value] || latin(s.value); }
    return '%empty';
  };

  // первый проход: собираем словарь, пока не печатая правил (иначе %token окажутся пустыми)
  const rendered = ordered.map((name) => ({
    name,
    rhs: (core.get(name) || []).map((a) => a.syms.map(symY).join(' ') || '%empty'),
  }));

  const lines = [];
  lines.push('/* тема 4, занятие 3 — мини-язык: грамматика из BNF-лаборатории');
  lines.push('   экспортирована автоматом (обычный BNF: bison не понимает EBNF)');
  lines.push('   сборка:  bison -d mini-lang.y  &&  gcc -Wall -o mini-lang mini-lang.tab.c');
  lines.push('   главное отличие от занятия 2: левая рекурсия пишется напрямую,');
  lines.push('   цикл её превращать не нужно — метод разбора снизу вверх */');
  lines.push('');
  lines.push('%defines');
  lines.push('%debug');
  lines.push('%verbose');
  if (conflicts > 0) {
    lines.push(`%expect ${conflicts}   /* лаборатория нашла ${conflicts} конфликт(ов) — bison должен подтвердить */`);
  }
  lines.push('');
  // Прототипы обязательны ДО yyparse: bison их не объявляет, а gcc ≥15 (C23)
  // считает неявное объявление ошибкой, не предупреждением.
  lines.push('%code requires { #include <stdio.h> }');
  lines.push('%code provides { int yylex(void); void yyerror(const char *s); }');
  lines.push('');

  // Bison 3.8 не позволяет объявлять ГОЛЫЕ строковые литералы в %token —
  // только «именем + строкой». Имя возвращает yylex, строку видит человек
  // в отчёте .output и в сообщении yyerror.
  const clsTokens = [...classes].map((c) => CLASS_TOKEN[c] || latin(c).toUpperCase());
  if (clsTokens.length) lines.push(`%token ${clsTokens.join(' ')}      /* классы лексем из БНФ */`);
  const kwLine = [...keywords].sort().map((k) => `${tokenName(k)} "${cstr(k)}"`);
  if (kwLine.length) lines.push(`%token ${kwLine.join(' ')}   /* ключевые слова: yylex возвращает имена */`);
  const opLine = [...puncts].sort().map((p) => `${tokenName(p)} "${cstr(p)}"`);
  if (opLine.length) lines.push(`%token ${opLine.join(' ')}   /* знаки */`);
  lines.push('');
  lines.push('%%');

  for (const { name, rhs } of rendered) {
    lines.push(`${latin(name)} :`);
    rhs.forEach((r, i) => lines.push(`   ${i === 0 ? ' ' : '|'} ${r}`));
    lines.push('   ;');
    lines.push('');
  }
  lines.push('%%');
  lines.push('/* каркас: yylex — мост к лексеру занятия 1 (там готовые имена лексем,');
  lines.push('   остаётся таблица соответствия: if→KW_IF, "<="→OP_LE, конец ввода→0 (YYEOF));');
  lines.push('   yyerror — печать с позицией: строку/столбец хранит лексер. */');
  lines.push('int main(void) { return yyparse(); }');
  lines.push('int yylex(void) { return 0; }   /* TODO: подставить лексер занятия 1; 0 = YYEOF */');
  lines.push('void yyerror(const char *s) { fprintf(stderr, "ошибка разбора: %s\\n", s); }');
  return lines.join('\n');
}
