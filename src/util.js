// Утилиты.

export function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export const LABEL = {
  num: 'ЧИСЛО',
  ident: 'ИДЕНТ',
  kw: 'КЛЮЧ',
  op: 'СИМВОЛ',
  err: 'ОШИБКА',
};
