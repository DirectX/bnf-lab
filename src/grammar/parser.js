// Разбор текста грамматики в БНФ в AST с позициями.
//
// Синтаксис:
//   <нетерминал> ::= альтернатива | альтернатива ...
//   правило может продолжаться с новой строки, если строка начинается с |
//   элементы: <нетерминал>, "литерал", КЛАСС (прописными: ИДЕНТ, ЧИСЛО),
//             ( гр | уппа ), [ необязательное ], ε (пустая последовательность)
//   модификаторы после элемента: * (ноль и более), + (одно и более), ? (необязательно)
//   дефис правила: ::= , := или →
//   комментарий: с # до конца строки

const LETTER = /[A-Za-zА-Яа-яЁё]/;
const DIGIT = /[0-9]/;
const isLetter = (c) => !!c && LETTER.test(c);
const isDigit = (c) => !!c && DIGIT.test(c);
const isWordChar = (c) => isLetter(c) || isDigit(c) || c === '_';
const isUpperWord = (s) => /^[A-ZА-ЯЁ][A-ZА-ЯЁ0-9_]*$/.test(s);

// ---------------------------------------------------------------- lexer грамматики

function tokenize(text, err) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const advance = (ch) => {
    if (ch === '\n') { line++; col = 1; } else { col++; }
  };

  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n' || ch === ' ' || ch === '\t' || ch === '\r') { advance(ch); i++; continue; }
    if (ch === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }

    if (text.startsWith('::=', i)) { tokens.push({ t: 'def', line, col, len: 3 }); i += 3; col += 3; continue; }
    if (text.startsWith(':=', i)) { tokens.push({ t: 'def', line, col, len: 2 }); i += 2; col += 2; continue; }
    if (text.startsWith('→', i)) { tokens.push({ t: 'def', line, col, len: 1 }); i += 1; col += 1; continue; }

    if (ch === '<') {
      const end = text.indexOf('>', i);
      if (end === -1 || text.slice(i + 1, end).includes('\n')) {
        err('не закрыта угловая скобка «<»', line, col);
        const stop = text.indexOf('\n', i);
        const upto = stop === -1 ? text.length : stop;
        col += upto - i; i = upto;
        continue;
      }
      const name = text.slice(i + 1, end).trim();
      const len = end - i + 1;
      if (!name) err('пустое имя нетерминала: <>', line, col, len);
      tokens.push({ t: 'nt', value: name, line, col, len });
      col += len; i = end + 1;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"' && text[j] !== '\n') j++;
      if (text[j] !== '"') {
        err('незакрытый литерал — не найдена закрывающая кавычка «"»', line, col);
        continue;
      }
      const value = text.slice(i + 1, j);
      const len = j - i + 1;
      if (!value) err('пустой литерал "" — для пустой последовательности пишите ε', line, col, len);
      tokens.push({ t: 'lit', value, line, col, len });
      col += len; i = j + 1;
      continue;
    }

    if (ch === '|') { tokens.push({ t: 'pipe', line, col, len: 1 }); i++; col++; continue; }
    if (ch === '(') { tokens.push({ t: 'lparen', line, col, len: 1 }); i++; col++; continue; }
    if (ch === ')') { tokens.push({ t: 'rparen', line, col, len: 1 }); i++; col++; continue; }
    if (ch === '[') { tokens.push({ t: 'lbracket', line, col, len: 1 }); i++; col++; continue; }
    if (ch === ']') { tokens.push({ t: 'rbracket', line, col, len: 1 }); i++; col++; continue; }
    if (ch === '*') { tokens.push({ t: 'star', line, col, len: 1 }); i++; col++; continue; }
    if (ch === '+') { tokens.push({ t: 'plus', line, col, len: 1 }); i++; col++; continue; }
    if (ch === '?') { tokens.push({ t: 'quest', line, col, len: 1 }); i++; col++; continue; }
    if (ch === 'ε') { tokens.push({ t: 'eps', line, col, len: 1 }); i++; col++; continue; }

    if (isLetter(ch) || ch === '_') {
      let j = i;
      while (j < text.length && isWordChar(text[j])) j++;
      const word = text.slice(i, j);
      if (isUpperWord(word)) {
        tokens.push({ t: 'cls', value: word, line, col, len: word.length });
      } else {
        err(
          `не понимаю «${word}»: нетерминал пишется <вот_так>, литерал — "в кавычках", класс лексем — ПРОПИСНЫМИ`,
          line, col, word.length,
        );
      }
      col += word.length; i = j;
      continue;
    }

    err(`неизвестный символ «${ch}»`, line, col);
    i++; col++;
  }
  return tokens;
}

// ---------------------------------------------------------------- парсер

export function parseGrammar(text) {
  const errors = [];
  const err = (message, line, col, len = 1) =>
    errors.push({ severity: 'error', line, col, len, message });

  const tokens = tokenize(text, err);
  const rules = [];
  const defined = new Set();
  let p = 0;

  const peek = (k = 0) => tokens[p + k];
  const at = (k = 0) => {
    const a = peek(k);
    const b = peek(k + 1);
    return !!a && a.t === 'nt' && !!b && b.t === 'def';
  };
  const tokText = (tk) =>
    tk.t === 'nt' ? `<${tk.value}>` :
    tk.t === 'def' ? '::=' :
    tk.t === 'lit' ? `"${tk.value}"` :
    tk.t === 'cls' ? tk.value :
    tk.t === 'pipe' ? '|' :
    tk.t === 'eps' ? 'ε' : { lparen: '(', rparen: ')', lbracket: '[', rbracket: ']', star: '*', plus: '+', quest: '?' }[tk.t] || '?';

  function parsePrimary() {
    const tk = peek();
    if (!tk) return null;
    if (tk.t === 'nt' && !at()) { p++; return { t: 'nt', value: tk.value, line: tk.line, col: tk.col }; }
    if (tk.t === 'nt') {
      // <X> сразу followed by def — внутри альтернативы быть не может, до сюда не доходим
      err(`правая часть не может начинаться с нового правила; возможно, пропущен «::=» или «|»`, tk.line, tk.col, tk.len);
      p++;
      return null;
    }
    if (tk.t === 'lit' || tk.t === 'cls' || tk.t === 'eps') {
      p++;
      return { t: tk.t, value: tk.value, line: tk.line, col: tk.col };
    }
    if (tk.t === 'lparen') {
      p++;
      const items = [parseAlt('rparen')];
      while (peek() && peek().t === 'pipe') { p++; items.push(parseAlt('rparen')); }
      if (!peek() || peek().t !== 'rparen') err('не закрыта круглая скобка группы', tk.line, tk.col);
      else p++;
      return { t: 'grp', items, line: tk.line, col: tk.col };
    }
    if (tk.t === 'lbracket') {
      p++;
      const items = [parseAlt('rbracket')];
      while (peek() && peek().t === 'pipe') { p++; items.push(parseAlt('rbracket')); }
      if (!peek() || peek().t !== 'rbracket') err('не закрыта квадратная скобка необязательной группы', tk.line, tk.col);
      else p++;
      return { t: 'grp', items, mods: { q: true }, line: tk.line, col: tk.col };
    }
    err(`ожидался элемент правила, а встретился «${tokText(tk)}»`, tk.line, tk.col, tk.len || 1);
    p++;
    return null;
  }

  function parseElem() {
    const prim = parsePrimary();
    if (!prim) return null;
    let mods = prim.mods;
    while (peek() && (peek().t === 'star' || peek().t === 'plus' || peek().t === 'quest')) {
      const m = peek();
      mods = mods || {};
      const key = m.t === 'star' ? 's' : m.t === 'plus' ? 'p' : 'q';
      if (mods[key]) err(`повторный модификатор «${m.t === 'star' ? '*' : m.t === 'plus' ? '+' : '?'}»`, m.line, m.col);
      mods[key] = true;
      p++;
    }
    if (mods) prim.mods = mods;
    return prim;
  }

  function parseAlt(stopAt) {
    const syms = [];
    while (p < tokens.length) {
      const tk = peek();
      if (tk.t === 'pipe') break;
      if (stopAt && tk.t === stopAt) break;
      if (at()) break;
      const before = p;
      const sym = parseElem();
      if (sym) syms.push(sym);
      if (p === before) break; // защита от зацикливания
    }
    return { syms };
  }

  while (p < tokens.length) {
    const tk = peek();
    if (tk.t !== 'nt') {
      err('правило должно начинаться с <нетерминала>', tk.line, tk.col, tk.len || 1);
      do { p++; } while (p < tokens.length && !at());
      continue;
    }
    if (!(peek(1) && peek(1).t === 'def')) {
      err(`после «<${tk.value}>» ожидалось «::=»`, tk.line, tk.col, tk.len);
      p++;
      continue;
    }
    p += 2;
    if (defined.has(tk.value)) err(`правило <${tk.value}> уже определено выше`, tk.line, tk.col, tk.len);
    else defined.add(tk.value);

    const alts = [];
    const first = parseAlt();
    alts.push(first);
    while (peek() && peek().t === 'pipe') {
      p++;
      alts.push(parseAlt());
    }
    for (const a of alts) {
      if (a.syms.length === 0) {
        err('пустая альтернатива — если правило может ничего не порождать, напишите ε', tk.line, tk.col, tk.len);
      }
    }
    rules.push({ name: tk.value, line: tk.line, col: tk.col, alts });
  }

  return { rules, errors };
}
