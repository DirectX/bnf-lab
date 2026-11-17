// Парсер: рекурсивный спуск с откатом и мемоизацией, работающий по
// РАСКРЫТОЙ грамматике из analyze.js — то есть по той самой БНФ, которую
// студент видит в редакторе. Соответствие «правило → функция» механическое,
// как на блоке 1 занятия 2:
//
//   <выражение> ::= <слагаемое> | <выражение> "+" <слагаемое>
//
//   разобрать_выражение():
//       результат = разобрать_слагаемое()
//       пока следующий токен это "+":
//           ...
//
// Прямая левая рекурсия превращена в цикл (иначе функция вызвала бы себя
// первой строкой). Косвенные левые рекурсии пресекаются стражем активной
// позиции (name@pos) — такие правила анализатор помечает отдельно.

export function rdParse(tokens, core, start) {
  const splitCache = new Map();
  function split(name) {
    if (splitCache.has(name)) return splitCache.get(name);
    const bases = [];
    const tails = [];
    for (const a of core.get(name) || []) {
      const s0 = a.syms[0];
      if (s0 && s0.t === 'nt' && s0.value === name) tails.push(a.syms.slice(1));
      else bases.push(a.syms);
    }
    const v = { bases, tails };
    splitCache.set(name, v);
    return v;
  }

  const okMemo = new Map();
  const failMemo = new Set();
  const active = new Set();
  const trace = [];
  const TRACE_LIMIT = 5000;
  const STEP_LIMIT = 400000;
  let steps = 0;
  let aborted = false;

  let failPos = -1;
  let expected = new Set();
  const symText = (s) => (s.t === 'lit' ? `"${s.value}"` : s.t === 'cls' ? s.value : `<${s.value}>`);
  function note(s, pos) {
    if (pos > failPos) { failPos = pos; expected = new Set([symText(s)]); }
    else if (pos === failPos) expected.add(symText(s));
  }

  function matchTerm(s, tk) {
    if (!tk || tk.kind === 'err') return false;
    if (s.t === 'lit') return tk.text === s.value;
    return tk.kind === (s.value === 'ИДЕНТ' ? 'ident' : s.value === 'ЧИСЛО' ? 'num' : '_');
  }

  function parseSeq(syms, pos, depth) {
    const nodes = [];
    for (const s of syms) {
      if (s.t === 'nt') {
        const r = parseName(s.value, pos, depth);
        if (!r) return null;
        nodes.push(r.node);
        pos = r.end;
      } else {
        const tk = tokens[pos];
        if (!matchTerm(s, tk)) { note(s, pos); return null; }
        nodes.push({ type: 'tok', tok: tk, start: pos, end: pos + 1 });
        pos++;
      }
    }
    return { nodes, end: pos };
  }

  function parseName(name, pos, depth) {
    if (aborted) return null;
    if (++steps > STEP_LIMIT) { aborted = true; return null; }

    const key = `${name}@${pos}`;
    if (okMemo.has(key)) return okMemo.get(key);
    if (failMemo.has(key) || active.has(key)) return null;
    if (!core.has(name)) { note({ t: 'nt', value: name }, pos); failMemo.add(key); return null; }

    active.add(key);
    try {
      const { bases, tails } = split(name);
      const traceLen = trace.length;

      let best = null;
      // не «первый успешный», а «самый длинный»: иначе <оператор>* схлопнется в ε
      // и сообщение об ошибке укажет не туда, куда дошёл разбор
      for (const base of bases) {
        const r = parseSeq(base, pos, depth + 1);
        if (r && (!best || r.end > best.end)) best = r;
      }
      if (!best) {
        trace.length = traceLen;
        failMemo.add(key);
        return null;
      }

      let node = { type: 'rule', name, children: best.nodes, start: pos, end: best.end };

      // та самая левая рекурсия, ставшая циклом: «пока следующий токен…»
      if (tails.length) {
        let grew = true;
        while (grew && !aborted) {
          grew = false;
          for (const tail of tails) {
            const tl = trace.length;
            const r = parseSeq(tail, best.end, depth + 1);
            if (r) {
              node = { type: 'rule', name, children: [node, ...r.nodes], start: pos, end: r.end };
              best.end = r.end;
              grew = true;
              break;
            }
            trace.length = tl;
          }
        }
      }

      const res = { node, end: best.end };
      if (!aborted) {
        okMemo.set(key, res);
        if (trace.length < TRACE_LIMIT) trace.push({ d: depth, name, from: pos, to: res.end });
      }
      return res;
    } finally {
      active.delete(key);
    }
  }

  const res = parseName(start, 0, 0);

  let error = null;
  let ast = null;
  if (aborted) {
    error = {
      message: 'разбор не уложился в лимит шагов: грамматика уходит в разветрённый перебор. ' +
        'Сделайте правила более детерминированными (как приоритетная грамматика из занятия 1).',
    };
  } else if (!res) {
    const tk = tokens[failPos];
    const exp = [...expected].slice(0, 10).join(', ');
    error = {
      pos: failPos,
      message: tk
        ? `разбор дошёл до лексемы ${failPos + 1} «${tk.text}» (строка ${tk.line}, столбец ${tk.col}) — ` +
          `ни одно правило этим не продолжается. Ожидалось одно из: ${exp}`
        : `дальше — конец программы, а грамматика требует продолжения. Ожидалось одно из: ${exp}`,
    };
  } else if (res.end < tokens.length) {
    if (failPos >= res.end && expected.size) {
      const tk = tokens[failPos];
      const exp = [...expected].slice(0, 10).join(', ');
      error = {
        pos: failPos,
        message: tk
          ? `дальше разобрать не удалось: в лексеме ${failPos + 1} «${tk.text}» ` +
            `(строка ${tk.line}, столбец ${tk.col}) ни одно правило не продолжается. Ожидалось одно из: ${exp}`
          : `разобрано ${res.end} лексем, дальше — конец программы, а грамматика требует продолжения. ` +
            `Ожидалось одно из: ${exp}`,
      };
    } else {
      const tk = tokens[res.end];
      error = {
        pos: res.end,
        message: `разобрано лексем: ${res.end} из ${tokens.length}; лишнее начинается с «${tk.text}» ` +
          `(строка ${tk.line}, столбец ${tk.col}) — ни одно правило такого продолжения не принимает`,
      };
    }
  } else {
    ast = res.node;
  }

  return { ast, error, trace, aborted, steps };
}

// обходы AST для UI

export function walkRules(node, fn, depth = 0) {
  if (node.type !== 'rule') return;
  fn(node, depth);
  for (const c of node.children) walkRules(c, fn, depth + 1);
}

export function deepestAt(node, idx) {
  let best = null;
  walkRules(node, (n) => { if (n.start <= idx && idx < n.end) best = n; });
  return best;
}
