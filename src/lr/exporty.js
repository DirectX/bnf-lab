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
  lines.push('   собирается сам:  bison -d mini-lang.y && gcc -Wall -o mini-lang mini-lang.tab.c');
  lines.push('   на реальных программах нужен лексер занятия 1 (см. README):');
  lines.push('   gcc -Wall -DMINI_LEXER_PROVIDED=1 -o mini-lang mini-lang.tab.c mini-lexer.c');
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
  lines.push('%code requires { #include <stdio.h>\n#include <stdlib.h> }');
  lines.push('%code provides { int yylex(void); void yyerror(const char *s); extern int yylineno;');
  lines.push('#ifndef MINI_LEXER_PROVIDED');
  lines.push('extern int yylex_tokens;   /* сколько лексем съел каркасный лексер */');
  lines.push('#endif');
  lines.push('}');
  lines.push('');

  // Bison 3.8 не позволяет объявлять ГОЛЫЕ строковые литералы в %token —
  // только «именем + строкой». Имя возвращает yylex, строку видит человек
  // в отчёте .output и в сообщении yyerror. По одному объявлению на строку:
  // одна длинная строка распирает поле предпросмотра и нечитаема в diff.
  const clsTokens = [...classes].map((c) => CLASS_TOKEN[c] || latin(c).toUpperCase());
  if (clsTokens.length) lines.push(`%token ${clsTokens.join(' ')}      /* классы лексем из БНФ */`);
  for (const k of [...keywords].sort()) lines.push(`%token ${tokenName(k)} "${cstr(k)}"`);
  for (const p of [...puncts].sort()) lines.push(`%token ${tokenName(p)} "${cstr(p)}"`);
  lines.push('');
  lines.push('%%');

  for (const { name, rhs } of rendered) {
    lines.push(`${latin(name)} :`);
    rhs.forEach((r, i) => lines.push(`   ${i === 0 ? ' ' : '|'} ${r}`));
    lines.push('   ;');
    lines.push('');
  }
  lines.push('%%');
  lines.push('/* каркас: yyerror — печать с позицией (сюжет занятия 1: позиция окупается) */');
  lines.push('int main(void) {');
  lines.push('  if (getenv("YYDEBUG")) yydebug = 1;   /* YYDEBUG=1 ./mini-lang — трасса состояний, */');
  lines.push('  int r = yyparse();                    /* как в отчёте mini-lang.output             */');
  lines.push('  if (r == 0) {');
  lines.push('#ifdef MINI_LEXER_PROVIDED');
  lines.push('    printf("принято: программа разобрана\\n");');
  lines.push('#else');
  lines.push('    printf("принято: программа разобрана, %d лексем\\n", yylex_tokens);');
  lines.push('#endif');
  lines.push('  }');
  lines.push('  return r;');
  lines.push('}');
  lines.push('#ifndef MINI_LEXER_PROVIDED');
  lines.push('void yyerror(const char *s) { fprintf(stderr, "строка %d: %s\\n", yylineno, s); }');
  lines.push('#endif');
  lines.push('');
  // Лексер, встроенный в пример: методичка занятия 3 прямо разрешает это
  // («стыковка с существующим лексером — если возникнут трудности, разрешить
  // использовать лексер, встроенный в пример, цель занятия не в этом»).
  // Он НЕ знает про грамматику — только словарь лексем, ровно как на занятии 1.
  // Свой лексер: gcc -DMINI_LEXER_PROVIDED=1 … mylexer.c
  lines.push('#ifndef MINI_LEXER_PROVIDED');
  lines.push(lexerC(classes, keywords, puncts));
  lines.push('#endif');
  return lines.join('\n');
}

// Порт лексера занятия 1 на C: максимальное совпадение, позиции, таблица ключей
// после чтения слова целиком. Словарь берётся из грамматики — тот же принцип,
// что и в веб-версии (лексер не знает правил, только виды лексем).
function lexerC(classes, keywords, puncts) {
  const cls = (name) => CLASS_TOKEN[name] || latin(name).toUpperCase();
  const has = (set, name) => set.has(name);
  const L = [];
  L.push('/* ---- лексер занятия 1 (встроенный каркас): stdin → токены ---- */');
  L.push('/* со своим лексером (-DMINI_LEXER_PROVIDED=1) определите yylineno в своём файле */');
  L.push('#include <ctype.h>');
  L.push('#include <string.h>');
  L.push('int yylineno = 1;');
  if (has(classes, 'ИДЕНТ') || keywords.size) {
    L.push('static const struct { const char *text; int tok; } KEYWORDS[] = {');
    for (const k of [...keywords].sort()) L.push(`  { "${cstr(k)}", ${tokenName(k)} },`);
    L.push('  { NULL, 0 } };');
  }
  if (puncts.size) {
    L.push('/* длинные вперёд: правило максимального совпадения («<=» — одна лексема) */');
    L.push('static const struct { const char *text; int tok; } PUNCTS[] = {');
    for (const p of [...puncts].sort((a, b) => b.length - a.length || a.localeCompare(b)))
      L.push(`  { "${cstr(p)}", ${tokenName(p)} },`);
    L.push('  { NULL, 0 } };');
  }
  L.push('static int skip_ws(void) {');
  L.push('  int c;');
  L.push('  while ((c = getchar()) != EOF && isspace((unsigned char)c)) { if (c == \'\\n\') yylineno++; }');
  L.push('  return c;');
  L.push('}');
  L.push('int yylex_tokens = 0;   /* сколько лексем съел лексер — для отклика main */');
  L.push('static int lexer_next(void) {');
  L.push('  int c = skip_ws();');
  L.push('  if (c == EOF) return 0;   /* YYEOF */');
  if (has(classes, 'ЧИСЛО')) {
    L.push('  if (isdigit(c)) {   /* ЧИСЛО: максимум цифр */');
    L.push('    long v = 0;');
    L.push('    do { v = v * 10 + (c - \'0\'); c = getchar(); } while (c != EOF && isdigit(c));');
    L.push('    if (c != EOF) ungetc(c, stdin);');
    L.push(`    yylval = (int)(v & 0xFF);   /* восьмибитный беззнаковый тип языка */`);
    L.push(`    return ${cls('ЧИСЛО')};`);
    L.push('  }');
  }
  if (has(classes, 'ИДЕНТ') || keywords.size) {
    L.push('  if (isalpha(c) || c == \'_\') {   /* ИДЕНТ: максимум букв/цифр/_, потом таблица ключей */');
    L.push('    char buf[128]; int n = 0;');
    L.push('    do { if (n < (int)sizeof buf - 1) buf[n++] = (char)c; c = getchar(); }');
    L.push('    while (c != EOF && (isalnum(c) || c == \'_\'));');
    L.push('    if (c != EOF) ungetc(c, stdin);');
    L.push('    buf[n] = 0;');
    L.push('    for (char *s = buf; *s; s++) *s = (char)tolower((unsigned char)*s);');
    L.push('    for (int i = 0; KEYWORDS[i].text; i++)');
    L.push('      if (!strcmp(buf, KEYWORDS[i].text)) return KEYWORDS[i].tok;   /* while ≠ while1 */');
    L.push(`    return ${cls('ИДЕНТ')};`);
    L.push('  }');
  }
  if (puncts.size) {
    L.push('  {   /* СИМВОЛ: максимальное совпадение по словарю знаков (длинные впереди) */');
    L.push('    for (int i = 0; PUNCTS[i].text; i++) {');
    L.push('      size_t len = strlen(PUNCTS[i].text);');
    L.push('      if (len == 1) { if ((unsigned char)c == (unsigned char)PUNCTS[i].text[0]) return PUNCTS[i].tok; continue; }');
    L.push('      if ((unsigned char)c != (unsigned char)PUNCTS[i].text[0]) continue;  /* ничего не съедено — c остаётся в переменной, не ungetc! */');
    L.push('      int buf[8]; size_t got = 0; int ok = 1;');
    L.push('      buf[got++] = c;');
    L.push('      for (size_t k = 1; k < len; k++) {');
    L.push('        int ch = getchar();');
    L.push('        if (ch == EOF || ch != (unsigned char)PUNCTS[i].text[k]) { ok = 0; break; }');
    L.push('        buf[got++] = ch;');
    L.push('      }');
    L.push('      if (ok) return PUNCTS[i].tok;   /* успех: хвост НЕ откатывать */');
    L.push('      while (got > 1) ungetc(buf[--got], stdin);   /* откат только съеденного хвоста при неудаче */');
    L.push('    }');
    L.push('  }');
  }
  L.push('  fprintf(stderr, "строка %d: неизвестный символ «%c» — лексер не знает про грамматику, но знает словарь\\n", yylineno, c);');
  L.push('  return 0;   /* стоп: разбор закончится ошибкой синтаксиса */');
  L.push('}');
  L.push('int yylex(void) {');
  L.push('  int t = lexer_next();');
  L.push('  if (t != 0) yylex_tokens++;');
  L.push('  return t;');
  L.push('}');
  return L.join('\n');
}
