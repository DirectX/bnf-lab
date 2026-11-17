// Прогон по SLR-таблице снизу вверх: стек состояний, трасса ходов, AST.
// Конфликт разрешается политикой (по умолчанию — «сдвиг», как в bison:
// else цепляется к ближайшему if). Это и есть тот «молчаливый выбор»,
// который рукописный парсер делает за студента, — здесь он вынесен наружу.

import { LABEL } from '../util.js';

const END = '$end';

export function runSLR(sl, tokens, { policy = 'shift' } = {}) {
  const { grammar, action, goto, termText, AUG } = sl;
  const tokKey = (t) => (t.kind === 'kw' || t.kind === 'op' || t.kind === 'err' ? `L:${t.text}` : `C:${LABEL[t.kind]}`);

  const stack = [{ st: 0 }];
  const trace = [];
  const errors = [];
  let ip = 0;
  let steps = 0;

  const snap = (tk) => {
    const top = stack[stack.length - 1].st;
    return {
      stack: stack.map((f) => f.st).join(' '),
      input: tokens.slice(ip, ip + 8).map((t) => t.text).join(' ') + (ip + 8 < tokens.length ? ' …' : ''),
      action: '',
      top,
    };
  };

  const pushRow = (kind, detail, s) => {
    if (trace.length < 4000) trace.push({ n: steps, kind, detail, ...s });
  };

  outer: while (true) {
    if (++steps > 20000) { errors.push({ message: 'больше 20000 ходов — остановлено' }); break; }
    const top = stack[stack.length - 1].st;
    const tk = tokens[ip];
    const la = tk ? tokKey(tk) : END;
    const acts = action[top]?.get(la);

    if (!acts || acts.length === 0) {
      errors.push({
        message: tk
          ? `состояние ${top}, lookahead «${tk.text}» (строка ${tk.line}, столбец ${tk.col}) — в таблице пусто: разбор остановлен`
          : `состояние ${top}, конец ввода — в таблице пусто: грамматика не принимает такой хвост`,
        state: top,
      });
      break outer;
    }

    let act = acts[0];
    if (acts.length > 1) {
      const shifts = acts.filter((a) => a.type === 'shift');
      const reduces = acts.filter((a) => a.type === 'reduce');
      act = policy === 'reduce' ? reduces[0] : shifts[0] || reduces[0];
      pushRow('conflict', `${acts.length} хода на «${termText.get(la) || tk?.text}»: выбран ${act.type === 'shift' ? 'сдвиг' : 'свёртка'} (политика «${policy}»)`, snap(tk));
    }

    if (act.type === 'accept') {
      pushRow('accept', 'принято', snap(tk));
      break outer;
    }
    if (act.type === 'shift') {
      stack.push({ st: act.to, tok: tk });
      pushRow('shift', `сдвинуть «${tk.text}» → состояние ${act.to}`, snap(tk));
      ip++;
      continue;
    }

    // reduce
    const it = act.item;
    const rhs = grammar.get(it.lhs)[it.idx];
    const children = [];
    for (let k = 0; k < rhs.length; k++) {
      const frame = stack.pop();
      children.unshift(frame.node ?? (frame.tok ? { type: 'tok', tok: frame.tok } : null));
    }
    const node = rhs.length || it.lhs !== AUG
      ? { type: 'rule', name: it.lhs, children: children.filter(Boolean), synthetic: it.lhs.includes('#') }
      : children[0];
    const prev = stack[stack.length - 1].st;
    const next = goto[prev]?.get(it.lhs);
    if (next === undefined) {
      errors.push({ message: `после свёртки <${it.lhs}> из состояния ${prev} нет перехода — таблица неполная` });
      break outer;
    }
    stack.push({ st: next, node });
    pushRow('reduce', `свернуть ${rhs.map((s) => (s.t === 'lit' ? `"${s.value}"` : s.t === 'cls' ? s.value : `<${s.value}>`)).join(' ') || 'ε'} → <${it.lhs}>`, snap(tk));
  }

  const finalNode = stack.length === 2 && stack[1].node ? stack[1].node : null;
  return { trace, errors, accepted: steps > 0 && !errors.length && !!finalNode, ast: finalNode, consumed: ip, steps };
}
