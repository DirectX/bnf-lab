// Подсветка: БНФ-грамматики и программы (по результатам лексера).
import { escapeHtml } from '../util.js';

const BNF_RE =
  /#[^\n]*|<[A-Za-zА-Яа-яЁё_][^<>\n]*>|::=|→|:=|\||[()\[\]]|\*|\+|\?|"(?:[^"\n])*"?|ε|[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]*/g;

export function highlightBnf(text) {
  let out = '';
  let last = 0;
  BNF_RE.lastIndex = 0;
  for (let m = BNF_RE.exec(text); m; m = BNF_RE.exec(text)) {
    out += escapeHtml(text.slice(last, m.index));
    const s = m[0];
    let cls = 'g-plain';
    if (s[0] === '#') cls = 'g-comment';
    else if (s[0] === '<') cls = 'g-nt';
    else if (s === '::=' || s === '→' || s === ':=') cls = 'g-def';
    else if (s === '|') cls = 'g-pipe';
    else if (s[0] === '"') cls = 'g-lit';
    else if (s === 'ε') cls = 'g-eps';
    else if (/[*+?]/.test(s)) cls = 'g-mod';
    else if (/^[A-ZА-ЯЁ][A-ZА-ЯЁ0-9_]*$/.test(s)) cls = 'g-cls';
    else if (/[()[\]]/.test(s)) cls = 'g-bracket';
    out += `<span class="${cls}">${escapeHtml(s)}</span>`;
    last = m.index + s.length;
  }
  out += escapeHtml(text.slice(last));
  return out;
}

const TOK_CLS = {
  num: 'tok-num',
  ident: 'tok-ident',
  kw: 'tok-kw',
  op: 'tok-op',
  err: 'tok-err',
  comment: 'tok-comment',
};

export function highlightProgram(text, lexed) {
  const items = [];
  for (const t of lexed.tokens) items.push({ s: t.start, e: t.end, cls: TOK_CLS[t.kind] || 'tok-op' });
  for (const r of lexed.skipped) items.push({ s: r.start, e: r.end, cls: TOK_CLS.comment });
  items.sort((a, b) => a.s - b.s);

  let out = '';
  let last = 0;
  for (const it of items) {
    if (it.s < last) continue;
    out += escapeHtml(text.slice(last, it.s));
    out += `<span class="${it.cls}">${escapeHtml(text.slice(it.s, it.e))}</span>`;
    last = it.e;
  }
  out += escapeHtml(text.slice(last));
  return out;
}
