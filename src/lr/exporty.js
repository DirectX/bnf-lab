// Экспорт БНФ со страницы в файл .y для bison — блок 2 занятия 3.
//
// Важно: bison НЕ понимает EBNF (звёздочки, скобки, квадратные скобки).
// Поэтому экспортируется РАСКРЫТАЯ грамматика из analyze.js — обычный BNF,
// где модификаторы свёрнуты во вспомогательные правила. Студент видит то же
// самое, что получил бы, расписав рекурсию вручную, — и главное:
// ЛЕВАЯ РЕКУРСИЯ ЗДЕСЬ ЗАПИСЫВАЕТСЯ НАПРЯМУЮ, потому что метод снизу вверх.

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

const cstr = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export function exportY(core, start, { conflicts = 0 } = {}) {
  const names = [...core.keys()];
  // старт — первым: bison берёт первое правило как начальный символ
  const ordered = [start, ...names.filter((n) => n !== start)];

  const tokens = new Set();
  const keywords = new Set();
  const puncts = new Set();
  const classes = new Set();

  const symY = (s) => {
    if (s.t === 'nt') return latin(s.value);
    if (s.t === 'lit') {
      tokens.add(s.value);
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
  lines.push('   сборка:  bison -d mini.y  &&  gcc mini.tab.c -o mini');
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

  // Bison 3.8 не позволяет объявлять строковые литералы в %token —
  // они выводятся из правил. Объявляем только классы лексем.
  const clsTokens = [...classes].map((c) => CLASS_TOKEN[c] || latin(c).toUpperCase());
  if (clsTokens.length) lines.push(`%token ${clsTokens.join(' ')}      /* классы лексем из БНФ */`);
  lines.push('');
  lines.push('%%');

  for (const { name, rhs } of rendered) {
    lines.push(`${latin(name)} :`);
    rhs.forEach((r, i) => lines.push(`   ${i === 0 ? ' ' : '|'} ${r}`));
    lines.push('   ;');
    lines.push('');
  }
  lines.push('%%');
  lines.push('/* каркас: yylex — от лексера занятия 1, yyerror — печать с позицией */');
  lines.push('int yyparse(void);');
  lines.push('int main(void) { return yyparse(); }');
  lines.push('void yyerror(const char *s) { (void)s; }');
  return lines.join('\n');
}
