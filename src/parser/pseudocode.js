// «Правило → функция»: по исходной БНФ печатает псевдокод рекурсивного
// спуска в духе блока 1 занятия 2. Прямая левая рекурсия показана уже
// превращённой в цикл — это главный сюжет, его надо видеть в коде.

const symText = (s) => {
  if (s.t === 'nt') return `разобрать_${s.value}()`;
  if (s.t === 'lit') return `"${s.value}"`;
  if (s.t === 'cls') return `класс ${s.value}`;
  if (s.t === 'eps') return 'ε';
  if (s.t === 'grp') {
    const inner = s.items.map((a) => a.syms.map(symText).join(', ')).join(' | ');
    const m = s.mods || {};
    if (m.q && !m.bracket) return `[${inner}]`;
    if (m.q) return `[${inner}]`;
    if (m.s) return `(${inner})*`;
    if (m.p) return `(${inner})+`;
    return `(${inner})`;
  }
  return '?';
};

const altText = (alt) => alt.syms.map(symText).join(', ') || 'ε';

export function pseudocode(rules) {
  const out = [];
  for (const rule of rules) {
    const tails = [];
    const bases = [];
    for (const a of rule.alts) {
      const s0 = a.syms[0];
      if (s0 && s0.t === 'nt' && s0.value === rule.name) tails.push(a.syms.slice(1));
      else bases.push(a.syms);
    }

    const lines = [`разобрать_${rule.name}():`];
    if (tails.length) {
      lines.push(bases.length === 1
        ? `    результат = ${altText({ syms: bases[0] })}`
        : `    результат = одну из баз:\n${bases.map((b) => `        · ${altText({ syms: b })}`).join('\n')}`);
      lines.push('    пока один из хвостов подходит:');
      for (const t of tails) lines.push(`        · ${altText({ syms: t })}`);
      lines.push('        результат = узел(результат, хвост)');
      lines.push('    вернуть результат');
      out.push({ name: rule.name, line: rule.line, rec: true, text: lines.join('\n') });
    } else {
      lines.push(rule.alts.every((a) => a.syms.length === 0)
        ? '    вернуть ε'
        : `    вернуть: ${rule.alts.map((a) => altText(a)).join('   |   ')}`);
      out.push({ name: rule.name, line: rule.line, rec: false, text: lines.join('\n') });
    }
  }
  return out;
}
