// Статический анализ грамматики: достижимость, левая рекурсия,
// эвристики неоднозначности, извлечение словаря лексера.
//
// Чтобы работать с «чистым» БНФ, модификаторы (*, +, ?), группы и
// необязательные секции раскрываются (desugar) в дополнительные правила.

// ---------------------------------------------------------------- раскрытие

function desugar(rules) {
  const core = new Map();      // имя → [{syms:[{t,value}]}]
  const genLine = new Map();   // имя порождённого правила → строка источника
  const genCache = new Map();
  let counter = 0;

  const canonSym = (s) =>
    `${s.t}:${s.value || ''}${s.mods ? JSON.stringify(s.mods) : ''}` +
    (s.items ? `(${s.items.map((a) => a.syms.map(canonSym).join(' ')).join('|')})` : '');
  const canonAlt = (alt) => alt.syms.map(canonSym).join(' ');

  function addGen(name, alts, line) {
    core.set(name, alts);
    if (!genLine.has(name)) genLine.set(name, line);
  }

  function wrap(kind, ref, line) {
    const key = `${kind}:${ref.t}:${ref.value}`;
    if (genCache.has(key)) return genCache.get(key);
    const base = ref.t === 'nt' ? ref.value : ref.value || 'ЛЕКСЕМА';
    const name = `${base}#${++counter}`;
    const refObj = { t: 'nt', value: name };
    genCache.set(key, refObj); // именно объект: на этом же key бывает повторный запрос (оператор* в <программа> и <блок>)
    if (kind === 'q') addGen(name, [{ syms: [ref] }, { syms: [] }], line);
    if (kind === 's') addGen(name, [{ syms: [ref, { t: 'nt', value: name }] }, { syms: [] }], line);
    if (kind === 'p') addGen(name, [{ syms: [ref] }, { syms: [ref, { t: 'nt', value: name }] }], line);
    return refObj;
  }

  function expandSyms(syms) {
    const out = [];
    for (const s of syms) {
      if (s.t === 'eps') continue;
      const mods = s.mods || {};
      let ref;
      if (s.t === 'grp') {
        const key = 'grp(' + s.items.map(canonAlt).join('|') + ')';
        if (genCache.has(key)) {
          ref = genCache.get(key);
        } else {
          const name = `секция#${++counter}`;
          genCache.set(key, { t: 'nt', value: name });
          addGen(name, s.items.map((a) => ({ syms: expandSyms(a.syms) })), s.line);
          ref = { t: 'nt', value: name };
        }
      } else {
        ref = { t: s.t, value: s.value };
      }
      let cur = ref;
      if (mods.q) cur = wrap('q', cur, s.line);
      if (mods.s) cur = wrap('s', cur, s.line);
      if (mods.p) cur = wrap('p', cur, s.line);
      out.push(cur);
    }
    return out;
  }

  for (const rule of rules) {
    const alts = core.get(rule.name) || [];
    for (const alt of rule.alts) alts.push({ syms: expandSyms(alt.syms) });
    core.set(rule.name, alts);
  }
  return { core, genLine };
}

// ---------------------------------------------------------------- обходы

function walkSyms(syms, fn) {
  for (const s of syms) {
    fn(s);
    if (s.items) for (const a of s.items) walkSyms(a.syms, fn);
  }
}

function findCycles(graph) {
  // graph: Map<name, Set<name>>; возвращает множество узлов, лежащих на циклах
  const onCycle = new Set();
  const state = new Map(); // 0 visiting, 1 done
  const stack = [];

  function dfs(node) {
    state.set(node, 0);
    stack.push(node);
    for (const next of graph.get(node) || []) {
      if (!graph.has(next)) continue;
      if (!state.has(next)) {
        dfs(next);
      } else if (state.get(next) === 0) {
        // нашлиback edge — весь хвост стека от next до вершины на цикле
        const idx = stack.lastIndexOf(next);
        if (idx >= 0) for (let k = idx; k < stack.length; k++) onCycle.add(stack[k]);
      }
    }
    stack.pop();
    state.set(node, 1);
  }
  for (const n of graph.keys()) if (!state.has(n)) dfs(n);
  return onCycle;
}

// ---------------------------------------------------------------- анализ

export function analyzeGrammar(parsed) {
  const { rules } = parsed;
  const diagnostics = [...parsed.errors];

  const defined = new Set(rules.map((r) => r.name));
  const classes = new Set();
  const literals = new Set();
  const keywords = new Set();
  const puncts = new Set();
  const refsPerRule = new Map();
  const lineOf = new Map(rules.map((r) => [r.name, r.line]));

  for (const rule of rules) {
    const refs = new Set();
    for (const alt of rule.alts) {
      walkSyms(alt.syms, (s) => {
        if (s.t === 'nt') {
          refs.add(s.value);
          if (!defined.has(s.value) && !diagnostics.some((d) => d.message.includes(`<${s.value}>`))) {
            diagnostics.push({
              severity: 'error', line: s.line, col: s.col, len: (`<${s.value}>`).length,
              message: `нет правила <${s.value}> — он используется, но не определён`,
            });
          }
        }
        if (s.t === 'cls') classes.add(s.value);
        if (s.t === 'lit') {
          literals.add(s.value);
          if (/^[A-Za-zА-Яа-яЁё]+$/.test(s.value)) keywords.add(s.value);
          else puncts.add(s.value);
        }
      });
    }
    refsPerRule.set(rule.name, refs);
  }

  const start = rules.length ? rules[0].name : null;

  // достижимость от стартового символа
  if (start) {
    const reachable = new Set([start]);
    const queue = [start];
    while (queue.length) {
      for (const ref of refsPerRule.get(queue.pop()) || []) {
        if (!reachable.has(ref)) { reachable.add(ref); queue.push(ref); }
      }
    }
    for (const rule of rules) {
      if (!reachable.has(rule.name)) {
        diagnostics.push({
          severity: 'warn', line: rule.line, col: rule.col, len: (`<${rule.name}>`).length,
          message: `<${rule.name}> недостижим из <${start}> — разбор никогда до него не дойдёт`,
        });
      }
    }
  }

  // левая рекурсия на раскрытой грамматике
  const { core, genLine } = desugar(rules);
  const nullable = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, alts] of core) {
      if (nullable.has(name)) continue;
      if (alts.some((a) => a.syms.every((s) => s.t === 'nt' && nullable.has(s.value)))) {
        nullable.add(name); changed = true;
      }
    }
  }
  const leftGraph = new Map();
  for (const [name, alts] of core) {
    const set = new Set();
    for (const alt of alts) {
      for (const s of alt.syms) {
        if (s.t === 'nt') set.add(s.value);
        if (s.t !== 'nt' || !nullable.has(s.value)) break;
      }
    }
    leftGraph.set(name, set);
  }
  const onCycle = findCycles(leftGraph);
  const reportedRec = new Set();
  for (const name of onCycle) {
    if (name.includes('#')) continue; // порождённые правила не сообщаем
    if (reportedRec.has(name)) continue;
    reportedRec.add(name);
    const direct = (leftGraph.get(name) || new Set()).has(name);
    diagnostics.push({
      severity: 'info',
      line: lineOf.get(name) || genLine.get(name) || 1,
      col: 1,
      message: direct
        ? `<${name}>: левая рекурсия (прямая). Для рекурсивного спуска (занятие 2) её придётся превратить в цикл — иначе бесконечный вызов; bison (занятие 3) принимает такую запись как есть.`
        : `<${name}>: левая рекурсия через цепочку правил. В рекурсивном спуске (занятие 2) требуется переписывание в цикл.`,
    });
  }

  // эвристики неоднозначности по исходным правилам
  const canonTop = (alt) => alt.syms.map((s) => `${s.t}:${s.value || 'ε'}${s.mods ? '?' : ''}`).join(' ');
  for (const rule of rules) {
    const alts = rule.alts;
    for (let i = 0; i < alts.length; i++) {
      for (let j = i + 1; j < alts.length; j++) {
        const a = canonTop(alts[i]);
        const b = canonTop(alts[j]);
        if (!a || !b) continue;
        if (a === b) {
          diagnostics.push({
            severity: 'warn', line: rule.line, col: rule.col,
            message: `в <${rule.name}> две одинаковые альтернативы — разбор двусмыслен по построению`,
          });
        } else if ((b + ' ').startsWith(a + ' ') || (a + ' ').startsWith(b + ' ')) {
          diagnostics.push({
            severity: 'warn', line: rule.line, col: rule.col,
            message:
              `в <${rule.name}> одна альтернатива — начало другой. Это схема «висячего else»: ` +
              `для входа, подходящего обеим, возможно два дерева разбора. Так же устроено правило из блока 2 занятия 1.`,
          });
        }
      }
    }
    // необязательный хвост у вложенной конструкции — тот же «висячий else»,
    // записанный через [ ... ] вместо двух альтернатив
    function reachesSelf(name) {
      const seen = new Set();
      const queue = [...(refsPerRule.get(name) || [])];
      while (queue.length) {
        const r = queue.pop();
        if (r === name) return true;
        if (seen.has(r)) continue;
        seen.add(r);
        for (const nr of refsPerRule.get(r) || []) queue.push(nr);
      }
      return false;
    }
    if (rule.alts.some((a) => { const l = a.syms.at(-1); return l && l.mods && l.mods.q; }) && reachesSelf(rule.name)) {
      diagnostics.push({
        severity: 'warn', line: rule.line, col: rule.col,
        message:
          `<${rule.name}> содержит вложенную конструкцию и необязательный хвост [ ... ]. ` +
          `Это схема «висячего else»: неясно, к какой вложенной версии цепляется хвост. ` +
          `Соглашение надо зафиксировать явно (else — к ближайшему if), иначе возможны два дерева.`,
      });
    }

    // два вхождения одного нетерминала в альтернативу
    for (const alt of alts) {
      const counts = new Map();
      for (const s of alt.syms) if (s.t === 'nt') counts.set(s.value, (counts.get(s.value) || 0) + 1);
      for (const [nt, n] of counts) {
        if (n >= 2) {
          diagnostics.push({
            severity: 'info', line: rule.line, col: rule.col,
            message:
              `в <${rule.name}> нетерминал <${nt}> встречается ${n} раза подряд — проверьте неоднозначность: ` +
              `например, цепочка a < b < c может разбираться двояко.`,
          });
        }
      }
    }
  }

  const sevRank = { error: 0, warn: 1, info: 2 };
  diagnostics.sort((d1, d2) => d1.line - d2.line || sevRank[d1.severity] - sevRank[d2.severity]);

  return {
    diagnostics,
    start,
    core, // раскрытая грамматика (модификаторы свёрнуты в правила) — по ней парсит rd.js
    info: {
      nonterminals: rules.length,
      keywords: [...keywords].sort(),
      puncts: [...puncts].sort(),
      classes: [...classes].sort(),
      literals,
      classSet: classes,
    },
  };
}
