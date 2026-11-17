// Редактор с подсветкой: прозрачная textarea поверх подсвеченного <pre>.

export function createEditor(host, { value = '', highlight, onChange }) {
  host.classList.add('editor');

  const pre = document.createElement('pre');
  pre.className = 'editor-hl';
  pre.setAttribute('aria-hidden', 'true');
  const code = document.createElement('code');
  pre.appendChild(code);

  const ta = document.createElement('textarea');
  ta.className = 'editor-input';
  ta.spellcheck = false;
  ta.autocapitalize = 'off';
  ta.setAttribute('wrap', 'off');
  ta.value = value;

  host.append(pre, ta);

  function paint() {
    code.innerHTML = highlight(ta.value) + '\n';
  }

  ta.addEventListener('input', () => {
    paint();
    if (onChange) onChange(ta.value);
  });
  ta.addEventListener('scroll', () => {
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
  });
  // Tab — две пробела, чтобы студент не ловил фокус на кнопках
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = ta.selectionStart;
      ta.setRangeText('  ', s, ta.selectionEnd, 'end');
      paint();
      if (onChange) onChange(ta.value);
    }
  });

  paint();

  return {
    get value() { return ta.value; },
    set value(v) { ta.value = v; paint(); },
    repaint: paint,
    focusLine(line) {
      const lines = ta.value.split('\n');
      const idx = Math.min(Math.max(line, 1), lines.length) - 1;
      let off = 0;
      for (let k = 0; k < idx; k++) off += lines[k].length + 1;
      const len = (lines[idx] || '').length;
      ta.focus();
      ta.setSelectionRange(off, off + len);
      const lh = parseFloat(getComputedStyle(ta).lineHeight) || 21;
      ta.scrollTop = Math.max(0, idx * lh - ta.clientHeight / 3);
      pre.scrollTop = ta.scrollTop;
    },
  };
}
