// SLR(1): построение таблиц снизу вверх по РАСКРЫТОЙ грамматике (core) и честный
// разбор конфликтов. Это то, что делает bison — но здесь всё видно изнутри, без
// внешнего инструмента и без бэкенда.
//
// Педагогический смысл (занятие 3, блок 3):
//   конфликт сдвига/свёртки — не сообщение об ошибке в инструменте,
//   а сообщение о неоднозначности самого языка. Автомат честно говорит:
//   «этот префикс допускает два хода, выберите».

const key = (s) => (s.t === 'lit' ? `L:${s.value}` : s.t === 'cls' ? `C:${s.value}` : `N:${s.value}`);
const text = (s) => (s.t === 'lit' ? `"${s.value}"` : s.t === 'cls' ? s.value : `<${s.value}>`);
const isTerm = (s) => s.t !== 'nt';
const END = '$end';

export function buildSLR(core, startName) {
  const AUG = "S'";
  const g = new Map();
  for (const [n, alts] of core) g.set(n, alts.map((a) => a.syms));
  g.set(AUG, [[{ t: 'nt', value: startName }]]);

  // ---- терминалы
  const termText = new Map([[END, 'конец ввода']]);
  for (const alts of g.values())
    for (const syms of alts)
      for (const s of syms) if (isTerm(s)) termText.set(key(s), text(s));

  const names = [...g.keys()];

  // ---- nullable / FIRST / FOLLOW
  const nullable = new Set();
  let ch = true;
  while (ch) {
    ch = false;
    for (const n of names) {
      if (nullable.has(n)) continue;
      if (g.get(n).some((syms) => syms.every((s) => s.t === 'nt' && nullable.has(s.value)))) { nullable.add(n); ch = true; }
    }
  }
  const firstN = new Map(names.map((n) => [n, new Set()]));
  ch = true;
  while (ch) {
    ch = false;
    for (const n of names) {
      const set = firstN.get(n);
      for (const syms of g.get(n)) {
        for (const s of syms) {
          if (isTerm(s)) { if (!set.has(key(s))) { set.add(key(s)); ch = true; } break; }
          const sub = firstN.get(s.value);
          for (const t of sub) if (!set.has(t)) { set.add(t); ch = true; }
          if (!nullable.has(s.value)) break;
        }
      }
    }
  }
  const firstSeq = (syms) => {
    const set = new Set();
    for (const s of syms) {
      if (isTerm(s)) { set.add(key(s)); return { set, all: false }; }
      for (const t of firstN.get(s.value)) set.add(t);
      if (!nullable.has(s.value)) return { set, all: false };
    }
    return { set, all: true };
  };
  const follow = new Map(names.map((n) => [n, new Set()]));
  follow.get(AUG).add(END);
  ch = true;
  while (ch) {
    ch = false;
    for (const n of names) {
      for (const syms of g.get(n)) {
        for (let i = 0; i < syms.length; i++) {
          const s = syms[i];
          if (s.t !== 'nt') continue;
          const { set, all } = firstSeq(syms.slice(i + 1));
          const dst = follow.get(s.value);
          let grew = false;
          for (const t of set) if (!dst.has(t)) { dst.add(t); grew = true; }
          if (all) for (const t of follow.get(n)) if (!dst.has(t)) { dst.add(t); grew = true; }
          if (grew) ch = true;
        }
      }
    }
  }

  // ---- множества пунктов LR(0)
  const itemStr = (it) => {
    const syms = g.get(it.lhs);
    const rhs = syms[it.idx];
    const left = rhs.slice(0, it.dot).map(text).join(' ');
    const right = rhs.slice(it.dot).map(text).join(' ');
    return `${it.lhs} → ${left}${left ? ' ' : ''}· ${right}`.replace(/\s+$/, '');
  };
  const closure = (items) => {
    const map = new Map(items.map((it) => [`${it.lhs}|${it.idx}|${it.dot}`, it]));
    const stack = [...items];
    while (stack.length) {
      const it = stack.pop();
      const rhs = g.get(it.lhs);
      const s = rhs[it.idx][it.dot];
      if (!s || s.t !== 'nt') continue;
      g.get(s.value).forEach((alt, idx) => {
        const k = `${s.value}|${idx}|0`;
        if (!map.has(k)) { const nt = { lhs: s.value, idx, dot: 0 }; map.set(k, nt); stack.push(nt); }
      });
    }
    return [...map.values()];
  };
  const canon = (items) => items.map((it) => `${it.lhs}|${it.idx}|${it.dot}`).sort().join(';');
  const gotoSet = (items, sk) => {
    const adv = [];
    for (const it of items) {
      const s = g.get(it.lhs)[it.idx][it.dot];
      if (s && key(s) === sk) adv.push({ lhs: it.lhs, idx: it.idx, dot: it.dot + 1 });
    }
    return adv.length ? closure(adv) : null;
  };

  const states = [];
  const index = new Map();
  const path = []; // путь из символов грамматики до состояния (для примера входа)
  const push = (items, p) => {
    const c = canon(items);
    if (index.has(c)) return index.get(c);
    const id = states.length;
    index.set(c, id);
    states.push(items);
    path.push(p);
    return id;
  };
  push(closure([{ lhs: AUG, idx: 0, dot: 0 }]), []);
  for (let id = 0; id < states.length; id++) {
    const syms = new Set();
    for (const it of states[id]) {
      const s = g.get(it.lhs)[it.idx][it.dot];
      if (s) syms.add(key(s));
    }
    for (const sk of syms) {
      const nxt = gotoSet(states[id], sk);
      if (nxt) push(nxt, [...path[id], sk]);
    }
  }

  // ---- таблицы ACTION / GOTO + конфликты
  const action = states.map(() => new Map());  // termKey → [{type,…}]
  const gotoT = states.map(() => new Map());  // ntName → stateId
  for (let id = 0; id < states.length; id++) {
    for (const it of states[id]) {
      const rhs = g.get(it.lhs)[it.idx];
      if (it.dot < rhs.length) {
        const s = rhs[it.dot];
        if (isTerm(s)) {
          const sk = key(s);
          const tgt = (() => { const nx = gotoSet(states[id], sk); return nx ? index.get(canon(nx)) : null; })();
          if (!action[id].has(sk)) action[id].set(sk, []);
          const list = action[id].get(sk);
          // несколько альтернатив могут сдвигать один и тот же терминал в одно
          // и то же состояние — это не конфликт, а один и тот же ход
          if (!list.some((a) => a.type === 'shift' && a.to === tgt)) list.push({ type: 'shift', to: tgt, item: it });
        } else {
          const nx = gotoSet(states[id], key(s));
          if (nx) gotoT[id].set(s.value, index.get(canon(nx)));
        }
      } else if (it.lhs === AUG) {
        if (!action[id].has(END)) action[id].set(END, []);
        action[id].get(END).push({ type: 'accept', item: it });
      } else {
        for (const la of follow.get(it.lhs)) {
          if (!action[id].has(la)) action[id].set(la, []);
          const list = action[id].get(la);
          if (!list.some((a) => a.type === 'reduce' && a.item.lhs === it.lhs && a.item.idx === it.idx))
            list.push({ type: 'reduce', item: it });
        }
      }
    }
  }

  // ---- пример входа: разворачиваем путь в терминальную последовательность
  const yieldMemo = new Map();
  function yieldOfSym(sk, depth) {
    if (sk === END) return null;
    if (sk[0] === 'L' || sk[0] === 'C') return termText.get(sk);
    const name = sk.slice(2);
    if (yieldMemo.has(name)) return yieldMemo.get(name);
    if (depth > 8) return `…<${name}>`;
    yieldMemo.set(name, '⟲'); // защита от левой рекурсии при разворачивании
    const alts = g.get(name) || [];
    // предпочитаем альтернативы, которые заканчиваются (не леворекурсивные)
    const ordered = [...alts].sort((a, b) => (a[0] && a[0].t === 'nt' && a[0].value === name ? 1 : 0) - (b[0] && b[0].t === 'nt' && b[0].value === name ? 1 : 0));
    for (const syms of ordered) {
      const parts = [];
      let okAll = true;
      for (const s of syms) {
        const y = yieldOfSym(key(s), depth + 1);
        if (y === null) continue;
        if (typeof y === 'string' && y.startsWith('⟲')) { okAll = false; break; }
        parts.push(y);
      }
      if (okAll && parts.length) { const res = parts.join(' '); yieldMemo.set(name, res); return res; }
    }
    const fallback = alts.length ? `…<${name}>` : 'ε';
    yieldMemo.set(name, fallback);
    return fallback;
  }
  const exampleFor = (id, la) => {
    const parts = [];
    for (const sk of path[id]) { const y = yieldOfSym(sk, 0); if (y && y !== 'ε') parts.push(y); }
    return { sentential: parts.join(' ') || 'ε', lookahead: termText.get(la) };
  };

  const conflicts = [];
  for (let id = 0; id < states.length; id++) {
    for (const [la, acts] of action[id]) {
      if (acts.length < 2) continue;
      const shifts = acts.filter((a) => a.type === 'shift');
      const reduces = acts.filter((a) => a.type === 'reduce');
      const type = shifts.length && reduces.length ? 'shift/reduce' : 'reduce/reduce';
      const ex = exampleFor(id, la);
      conflicts.push({
        state: id,
        lookahead: la,
        lookaheadText: termText.get(la),
        type,
        items: [
          ...shifts.map((a) => ({ role: 'сдвиг', text: itemStr(a.item), to: a.to })),
          ...reduces.map((a) => ({ role: 'свёртка', text: itemStr(a.item) })),
        ],
        sentential: ex.sentential,
        note: type === 'shift/reduce'
          ? 'автомат может либо сдвинуть лексему (присоединить к более глубокой конструкции), либо свернуть (закрыть конструкцию). Язык допускает два разбора этого префикса.'
          : 'две разные свёртки подходят к одному lookahead — правило, по которому закрывать конструкцию, не определено.',
      });
    }
  }

  return {
    grammar: g,
    AUG,
    termText,
    states: states.map((items, id) => ({ id, items: items.map(itemStr), path: path[id] })),
    action,
    goto: gotoT,
    follow: Object.fromEntries([...follow].map(([n, s]) => [n, [...s]])),
    first: Object.fromEntries([...firstN].map(([n, s]) => [n, [...s]])),
    conflicts,
    isSLR: conflicts.length === 0,
    itemCount: states.reduce((a, s) => a + s.length, 0),
  };
}
