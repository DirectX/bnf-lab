// Лексер мини-языка (Тема 4, занятие 1).
//
// Главный принцип, который закладывали на занятии: лексер НЕ знает про
// грамматику. Он не проверяет осмысленность последовательности — «) ) + = while»
// для него корректный вход. Он знает только классы лексем:
//   ЧИСЛО   — цифры;
//   ИДЕНТ   — буквы/цифры/_ с нецифры, ключевые слова проверяются по таблице ПОСЛЕ
//             чтения максимальной последовательности (иначе while1 — это «while» + «1»);
//   СИМВОЛ  — знаки операций из словаря, максимальное совпадение («<=» — одна лексема);
//   комментарии (по включению) — // и /* */ — домашнее задание к занятию.
// У каждой лексемы — строка и столбец: без них парсер не сможет сказать, ГДЕ ошибка.

const LETTER = /[A-Za-zА-Яа-яЁё]/;
const DIGIT = /[0-9]/;
const isLetter = (c) => !!c && LETTER.test(c);
const isDigit = (c) => !!c && DIGIT.test(c);

export const UINT8_MAX = 255;

export function lex(src, opts = {}) {
  const {
    keywords = new Set(),
    puncts = new Set(),
    strictNumbers = true,
    comments = false,
  } = opts;

  const tokens = [];   // распознанные лексемы (включая err)
  const errors = [];   // ошибки лексера
  const skipped = [];  // пропущенные участки (комментарии) — для подсветки

  const maxPunctLen = Math.max(0, ...[...puncts].map((s) => s.length));
  let i = 0;
  let line = 1;
  let col = 1;

  const push = (tok, len) => {
    tokens.push({ ...tok, start: i, end: i + len });
    for (let k = 0; k < len; k++) {
      if (src[i + k] === '\n') { line++; col = 1; } else { col++; }
    }
    i += len;
  };

  while (i < src.length) {
    const ch = src[i];
    const l0 = line;
    const c0 = col;

    if (ch === '\n' || ch === ' ' || ch === '\t' || ch === '\r') {
      if (ch === '\n') { line++; col = 1; } else { col++; }
      i++;
      continue;
    }

    // комментарии — «домашнее задание» занятия 1, включается переключателем
    if (comments && ch === '/' && src[i + 1] === '/') {
      const start = i;
      while (i < src.length && src[i] !== '\n') { i++; col++; }
      skipped.push({ kind: 'comment', start, end: i, line: l0, col: c0, block: false });
      continue;
    }
    if (comments && ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) {
        errors.push({ line: l0, col: c0, message: 'незакрытый блочный комментарий — не найдено «*/»' });
        skipped.push({ kind: 'comment', start: i, end: src.length, line: l0, col: c0, block: true });
        i = src.length;
        continue;
      }
      const text = src.slice(i, end + 2);
      for (const chr of text) { if (chr === '\n') { line++; col = 1; } else { col++; } }
      skipped.push({ kind: 'comment', start: i, end: end + 2, line: l0, col: c0, block: true });
      i += text.length;
      continue;
    }

    // ЧИСЛО
    if (isDigit(ch)) {
      let j = i;
      while (isDigit(src[j])) j++;
      const text = src.slice(i, j);
      const tok = { kind: 'num', text, line: l0, col: c0 };
      if (Number(text) > UINT8_MAX) {
        tok.note = `значение ${text} не влезет в восьмибитную ячейку (0…${UINT8_MAX})`;
      }
      if (isLetter(src[j]) || src[j] === '_') {
        if (strictNumbers) {
          errors.push({
            line: l0, col: c0 + text.length,
            message: `число ${text} слиплось с идентификатором — при строгих числах это ошибка`,
          });
          tok.warn = 'число слиплось с идентификатором';
        } else {
          tok.note = 'число и идентификатор распознаны как две лексемы (максимальное совпадение)';
        }
      }
      push(tok, text.length);
      continue;
    }

    // ИДЕНТ / КЛЮЧ — читаем МАКСИМАЛЬНУЮ последовательность, потом смотрим в таблицу
    if (isLetter(ch) || ch === '_') {
      let j = i;
      while (j < src.length && (isLetter(src[j]) || isDigit(src[j]) || src[j] === '_')) j++;
      const text = src.slice(i, j);
      const isKw = keywords.has(text);
      const tok = { kind: isKw ? 'kw' : 'ident', text, line: l0, col: c0 };
      if (!isKw && keywords.size) {
        for (const kw of keywords) {
          if (text.length > kw.length && text.startsWith(kw)) {
            tok.note = `начинается с ключевого слова «${kw}», но целиком не совпадает — это идентификатор`;
            break;
          }
        }
      }
      push(tok, text.length);
      continue;
    }

    // СИМВОЛ — максимальное совпадение среди знаков из грамматики
    if (maxPunctLen) {
      let matched = null;
      for (let len = Math.min(maxPunctLen, src.length - i); len >= 1; len--) {
        const cand = src.slice(i, i + len);
        if (puncts.has(cand)) { matched = cand; break; }
      }
      if (matched) {
        const tok = { kind: 'op', text: matched, line: l0, col: c0 };
        if (matched.length > 1 && puncts.has(matched[0])) {
          tok.note = `максимальное совпадение: «${matched}» — одна лексема, а не «${matched[0]}» + «${matched.slice(1)}»`;
        }
        push(tok, matched.length);
        continue;
      }
    }

    errors.push({
      line: l0, col: c0,
      message: `неизвестный символ «${ch}» — такого знака нет среди литералов грамматики`,
    });
    push({ kind: 'err', text: ch, line: l0, col: c0 }, 1);
  }

  return { tokens, errors, skipped };
}
