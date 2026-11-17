// Генератор кода: AST из rd.js → машинные байты TinyCPU-8 + листинг для
// ассемблера tinycpu-web (метки, DB, комментарии — листинг копируется целиком).
//
// Учебные сюжеты, заложенные в код:
//  • Адрес вперёд, которого ещё нет (блок 4 занятия 2): метки разрешаются
//    двумя проходами — первый считает размеры, второй заполняет операнды.
//  • Один аккумулятор: вложенные выражения сохраняются через PUSH/POP.
//  • Константы живут в памяти: ADD/SUB принимают только адрес, не immediate.
//  • У машины нет флага «меньше» — сравнение a <= b разворачивается перебором
//    вниз. Медленно, зато показывает цену абстракции.
import { OP } from './cpu8.js';

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};

function latinName(name) {
  return String(name).toLowerCase().split('').map((c) => (TRANSLIT[c] !== undefined ? TRANSLIT[c] : c)).join('')
    .replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'id';
}

class GenError extends Error {
  constructor(message, line) { super(message); this.line = line; }
}

// ---------------- обходы AST

const isRule = (n, name) => !!n && n.type === 'rule' && (name === undefined || n.name === name);
const rulesOf = (n, pred) => n.children.filter((c) => isRule(c) && (!pred || pred(c)));
const firstRule = (n, pred) => rulesOf(n, pred)[0];
const firstTok = (n) => n.children.find((c) => c.type === 'tok');
function lineOf(n) {
  const t = firstTok(n);
  if (t) return t.tok.line;
  const r = n.children.find(isRule);
  return r ? lineOf(r) : undefined;
}
// правила-обёртки от desugar (<оператор>* сворачивается в цепочку G ::= оп G | ε)
function collectOps(node) {
  const out = [];
  for (const c of rulesOf(node)) {
    if (c.name === 'оператор') out.push(c);
    else if (c.name.includes('#')) out.push(...collectOps(c));
  }
  return out;
}
function firstRuleDeep(n, pred) {
  let found = null;
  (function walk(node) {
    if (found) return;
    for (const c of node.children) {
      if (!isRule(c)) continue;
      if (pred ? pred(c) : true) { found = c; return; }
      walk(c);
    }
  })(n);
  return found;
}

// ---------------- генератор

export function generate(ast) {
  const entries = []; // {kind:'label',name} | {kind:'inst',mnem,arg,comment}
  const labels = new Set(Object.keys(OP).map((m) => m.toLowerCase()).concat(['db']));
  const vars = new Map();   // имя → {label, write}
  const consts = new Map(); // значение → label
  const scratch = new Map();
  const warnings = [];
  let seq = 0;

  const emit = (mnem, arg, comment) => entries.push({ kind: 'inst', mnem, arg, comment });
  const emitLabel = (name) => { labels.add(name); entries.push({ kind: 'label', name }); };
  const newLabel = (hint) => `${hint}${++seq}`;

  const varLabel = (name, { write }) => {
    if (!vars.has(name)) {
      let lab = 'v_' + latinName(name);
      let n = 2;
      while (labels.has(lab)) lab = 'v_' + latinName(name) + n++;
      labels.add(lab);
      vars.set(name, { label: lab, write: !!write });
      if (!write) warnings.push(`переменная «${name}» нигде не присваивается — при чтении будет 0`);
    } else if (write) vars.get(name).write = true;
    return vars.get(name).label;
  };
  const checkConst = (value, line) => {
    if (value > 255) throw new GenError(`константа ${value} не влезает в байт: тип в языке один — восьмибитный беззнаковый`, line);
    if (!consts.has(value)) {
      let lab = `k_${value}`;
      labels.add(lab);
      consts.set(value, lab);
    }
  };
  const scr = (key, comment) => {
    if (!scratch.has(key)) { scratch.set(key, { label: `s_${latinName(key)}`, comment }); labels.add(`s_${latinName(key)}`); }
    return scratch.get(key).label;
  };

  // ---------------- выражения: результат всегда в аккумуляторе A

  function opSymbolOf(bin) {
    const mid = bin.children[1];
    if (mid.type === 'tok') return mid.tok.text;
    const t = firstTok(mid);
    return t ? t.tok.text : null;
  }

  function emitSimpleTok(t) {
    if (t.kind === 'num') { checkConst(Number(t.text), t.line); emit('LDI', Number(t.text)); return true; }
    if (t.kind === 'ident') { emit('LDA', varLabel(t.text, { write: false })); return true; }
    return false;
  }

  function emitExpr(node) {
    if (!isRule(node)) throw new GenError('выражение отсутствует в дереве разбора');
    const kids = node.children;

    if (kids.length === 1 && kids[0].type === 'tok') {
      if (emitSimpleTok(kids[0].tok)) return;
      throw new GenError(`элемент «${kids[0].tok.text}» непонятен генератору`, kids[0].tok.line);
    }

    if (node.name === 'множитель') {
      if (kids.length === 1 && kids[0].type === 'tok') {
        const t = kids[0].tok;
        if (t.kind === 'num') { checkConst(Number(t.text), t.line); emit('LDI', Number(t.text)); return; }
        if (t.kind === 'ident') { emit('LDA', varLabel(t.text, { write: false })); return; }
        throw new GenError(`множитель «${t.text}» непонятен генератору`, t.line);
      }
      const inner = kids.find((c) => isRule(c));
      if (inner) return emitExpr(inner); // ( <выражение> )
      throw new GenError('пустой множитель', lineOf(node));
    }

    if (kids.length === 1 && isRule(kids[0])) return emitExpr(kids[0]);

    if (kids.length === 3 && isRule(kids[0]) && isRule(kids[2])) {
      const op = opSymbolOf(node);
      if (!'+-*/'.includes(op)) throw new GenError(`операция «${op}» не поддерживается генератором`, lineOf(node));
      const [left, , right] = kids;
      emitExpr(left);
      // оптимизация: правая часть — один идентификатор → без стека
      const rightSimple = isRule(right, 'множитель') && right.children.length === 1 &&
        right.children[0].type === 'tok' && right.children[0].tok.kind === 'ident';
      if (rightSimple && (op === '+' || op === '-')) {
        emit(op === '+' ? 'ADD' : 'SUB', varLabel(right.children[0].tok.text, { write: false }));
        return;
      }
      // общий случай: левый операнд переживает правый на стеке
      emit('PUSH');
      emitExpr(right);
      emit('STA', scr('t1', 'временная ячейка'));
      emit('POP'); // A = левое, s_t1 = правое
      if (op === '+') { emit('ADD', 's_t1'); return; }
      if (op === '-') { emit('SUB', 's_t1'); return; }
      if (op === '*') return mulInline();
      throw new GenError('деление генератором не поддерживается: на этой машине деление — цикл вычитаний со сравнением, это самостоятельная работа', lineOf(node));
    }

    const inner = firstRule(node);
    if (inner) return emitExpr(inner);
    throw new GenError(`не умею компилировать узел <${node.name}>`, lineOf(node));
  }

  // умножения в машине нет: a * b разворачивается в «прибавлять a, пока b не обнулится»
  function mulInline() {
    const t1 = scr('t1', 'временная ячейка');
    const t2 = scr('t2', 'временная ячейка');
    const x = scr('x', 'накопитель произведения');
    const y = scr('y', 'счётчик множителя');
    const one = scr('one', 'константа 1');
    const loop = newLabel('mul');
    const done = newLabel('mul_done');
    emit('STA', t2, 'умножение — циклом сложений: множимое');
    emit('LDI', 0); emit('STA', x);
    emit('LDA', t1); emit('STA', y);
    emitLabel(loop);
    emit('LDA', y); emit('JZ', done);
    emit('LDA', x); emit('ADD', t2); emit('STA', x);
    emit('LDA', y); emit('SUB', one); emit('STA', y);
    emit('JMP', loop);
    emitLabel(done);
    emit('LDA', x);
  }

  // ---------------- сравнения

  function leInline(rel1) {
    const x = scr('x', 'перебор для сравнения');
    const y = scr('y', 'перебор для сравнения');
    const one = scr('one', 'константа 1');
    const loop = newLabel('cmp_loop');
    const yes = newLabel('cmp_yes');
    const no = newLabel('cmp_no');
    const end = newLabel('cmp_end');
    emit('LDA', scr('t1', ''), 'перебор вниз: у машины нет флага «меньше»');
    emit('STA', x, rel1);
    emit('LDA', scr('t2', ''));
    emit('STA', y);
    emitLabel(loop);
    emit('LDA', x); emit('JZ', yes);       // a закончился раньше или одновременно → a <= b
    emit('LDA', y); emit('JZ', no);        // a ещё есть, b кончился → a > b
    emit('LDA', x); emit('SUB', one); emit('STA', x);
    emit('LDA', y); emit('SUB', one); emit('STA', y);
    emit('JMP', loop);
    emitLabel(yes); emit('LDI', 1); emit('JMP', end);
    emitLabel(no); emit('LDI', 0);
    emitLabel(end);
  }

  function cmpInline(kind) {
    if (kind === '==' || kind === '!=') {
      const eq = newLabel('cmp_eq');
      const end = newLabel('cmp_end');
      emit('LDA', scr('t1', ''), `сравнение ${kind === '==' ? '==' : '!='} разностью`);
      emit('SUB', scr('t2', ''));
      emit('JZ', eq);
      emit('LDI', kind === '==' ? 0 : 1); emit('JMP', end);
      emitLabel(eq); emit('LDI', kind === '==' ? 1 : 0);
      emitLabel(end);
      return;
    }
    if (kind === '<=') return leInline('a <= b: a и b убывают вместе');
    if (kind === '<') {
      const x = scr('x', 'перебор для сравнения');
      const eq = newLabel('cmp_eq');
      const end = newLabel('cmp_end');
      leInline('a < b = (a <= b) и не равно');
      emit('STA', x);
      emit('LDA', scr('t1', '')); emit('SUB', scr('t2', '')); emit('JZ', eq);
      emit('LDA', x); emit('JMP', end);
      emitLabel(eq); emit('LDI', 0); // равны → не «меньше»
      emitLabel(end);
      return;
    }
    throw new GenError(`сравнение «${kind}» не поддерживается`);
  }

  function emitCond(condNode) {
    if (!isRule(condNode, 'условие')) throw new GenError('ожидалось <условие>', lineOf(condNode));
    const relNode = firstRule(condNode, (c) => c.name === 'отношение');
    const rel = relNode ? firstTok(relNode).tok.text : null;
    if (!rel) throw new GenError('в условии нет <отношение>', lineOf(condNode));
    const exprs = rulesOf(condNode, (c) => c.name !== 'отношение');
    if (exprs.length < 2) throw new GenError('в условии два выражения, а найдено одно', lineOf(condNode));
    const [left, right] = exprs;
    const swap = rel === '>=' || rel === '>';
    const kind = { '<': '<', '<=': '<=', '>': '<', '>=': '<=', '==': '==', '!=': '!=' }[rel];

    emitExpr(swap ? right : left);
    emit('PUSH');
    emitExpr(swap ? left : right);
    emit('STA', scr('t2', 'правая часть условия'));
    emit('POP');
    emit('STA', scr('t1', 'левая часть условия'));
    cmpInline(kind); // A = 0 (ложь) или 1 (истина)
  }

  // ---------------- операторы

  function emitStmt(node) {
    if (!isRule(node)) throw new GenError('ожидался оператор');
    switch (node.name) {
      case 'программа':
      case 'блок':
        for (const op of collectOps(node)) emitStmt(op);
        return;
      case 'оператор': {
        const inner = firstRule(node);
        if (!inner) throw new GenError('пустой оператор', lineOf(node));
        return emitStmt(inner);
      }
      case 'присваивание': {
        const identTok = node.children.find((c) => c.type === 'tok' && c.tok.kind === 'ident');
        const expr = firstRule(node, (c) => c.name === 'выражение');
        if (!identTok || !expr) throw new GenError('не узнаю присваивание', lineOf(node));
        const lab = varLabel(identTok.tok.text, { write: true });
        emitExpr(expr);
        emit('STA', lab, `строка ${identTok.tok.line}: ${identTok.tok.text} = …`);
        return;
      }
      case 'условный': {
        const cond = firstRule(node, (c) => c.name === 'условие');
        const ops = rulesOf(node, (c) => c.name === 'оператор');
        const sec = rulesOf(node, (c) => c.name.includes('#'))[0];
        const thenOp = ops[0];
        const elseOp = ops.length >= 2 ? ops[1] : (sec ? firstRuleDeep(sec, (c) => c.name === 'оператор') : null);
        if (!thenOp) throw new GenError('у if нет ветки', lineOf(node));
        const ln = lineOf(node);
        const lElse = elseOp ? newLabel('else') : null;
        const lEnd = newLabel('endif');
        emitCond(cond);
        emit('JZ', lElse || lEnd, `строка ${ln}: if …`);
        emitStmt(thenOp);
        if (elseOp) {
          emit('JMP', lEnd);
          emitLabel(lElse);
          emitStmt(elseOp);
        }
        emitLabel(lEnd);
        return;
      }
      case 'цикл': {
        const cond = firstRule(node, (c) => c.name === 'условие');
        const body = firstRule(node, (c) => c.name === 'оператор');
        const ln = lineOf(node);
        const lStart = newLabel('loop');
        const lEnd = newLabel('endloop');
        emitLabel(lStart);
        emitCond(cond);
        emit('JZ', lEnd, `строка ${ln}: while …`);
        emitStmt(body);
        emit('JMP', lStart);
        emitLabel(lEnd);
        return;
      }
      default:
        throw new GenError(
          `генератор покрывает грамматику мини-языка занятия 1, а тут <${node.name}> — свою грамматику компилируют вручную, в этом смысл занятия 2`,
          lineOf(node));
    }
  }

  // ---------------- сборка

  emitStmt(ast);
  emit('HLT', undefined, 'останов');

  const dataRows = [];
  for (const [key, s] of scratch) dataRows.push({ label: s.label, value: key === 'one' ? 1 : 0, comment: s.comment });
  for (const [value, label] of [...consts.entries()].sort((a, b) => a[0] - b[0]))
    dataRows.push({ label, value, comment: `константа ${value}` });
  for (const [name, v] of vars)
    dataRows.push({ label: v.label, value: 0, comment: `переменная ${name}`, varName: name });

  // проход 1: размеры и адреса меток
  const addrOf = {};
  let addr = 0;
  for (const e of entries) {
    if (e.kind === 'label') addrOf[e.name] = addr;
    else addr += e.arg === undefined ? 1 : 2;
  }
  const codeLen = addr;
  dataRows.forEach((r, i) => { addrOf[r.label] = codeLen + i; });

  const total = codeLen + dataRows.length;
  if (total > 240) {
    throw new GenError(`код + данные заняли ${total} байт из 256: оставьте место стеку (он растёт вниз с 0xFF) — сократите программу`);
  }

  // проход 2: байты; операнды-метки дописываются сейчас — обратная правка в чистом виде
  const bytes = [];
  const codeRows = [];
  const listing = [
    '; мини-язык → TinyCPU-8 — сгенерировано BNF-лабораторией',
    '; код с 0x00, данные — DB после кода, стек сверху вниз',
  ];
  for (const e of entries) {
    if (e.kind === 'label') {
      listing.push(`${e.name}:`);
      codeRows.push({ addr: bytes.length, labelName: e.name, text: `${e.name}:`, comment: '' });
      continue;
    }
    const at = bytes.length;
    bytes.push(OP[e.mnem]);
    let operand = '';
    if (e.arg !== undefined) {
      if (typeof e.arg === 'number') {
        operand = String(e.arg);
      } else {
        if (addrOf[e.arg] === undefined) throw new GenError(`метка ${e.arg} не определена`);
        operand = e.arg;
      }
      bytes.push((typeof e.arg === 'number' ? e.arg : addrOf[e.arg]) & 0xFF);
    }
    const text = e.arg !== undefined ? `${e.mnem} ${operand}` : e.mnem;
    codeRows.push({
      addr: at,
      hex: bytes.slice(at).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' '),
      text,
      comment: e.comment || '',
    });
    listing.push(e.comment ? `${text.padEnd(16)}; ${e.comment}` : text);
  }
  const dataListing = ['', '; ---- данные ----'];
  dataRows.forEach((r) => {
    r.addr = addrOf[r.label];
    bytes.push(r.value & 0xFF); // байты данных идут сразу за кодом — адреса из pass 1 верны
    dataListing.push(`${r.label}: DB ${r.value}${r.comment ? '    ; ' + r.comment : ''}`);
  });
  listing.push(...dataListing);

  const varAddrs = {};
  for (const [name, v] of vars) varAddrs[name] = addrOf[v.label];

  return { bytes, listing: listing.join('\n'), codeRows, dataRows, varAddrs, warnings: [...new Set(warnings)], codeLen };
}
