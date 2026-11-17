// TinyCPU-8 — порт эталонного tinycpu.py (семаантика один в один).
//
//   память 256 байт; PC, A (аккумулятор), SP (стартует с 0xFF, растёт вниз);
//   ни флагов переноса, ни борроу — есть только «A == 0» для JZ.
//   Операнд всегда один байт = АДРЕС (ADD/SUB тоже читают память, не immediate).

export const MNEMONICS = [
  'HLT', 'LDA', 'STA', 'LDI', 'ADD', 'SUB', 'JMP', 'JZ', 'PUSH', 'POP', 'CALL', 'RET',
];
export const OP = Object.fromEntries(MNEMONICS.map((m, i) => [m, i]));
export const HAS_OPERAND = (op) => [OP.LDA, OP.STA, OP.LDI, OP.ADD, OP.SUB, OP.JMP, OP.JZ, OP.CALL].includes(op);

export function runCPU8(bytes, { maxSteps = 100000, trace = false } = {}) {
  const memory = new Array(256).fill(0);
  bytes.forEach((b, i) => { if (i < 256) memory[i] = b & 0xFF; });

  let pc = 0, a = 0, sp = 0xFF, halted = false, steps = 0;
  let error = null;
  const traceLog = [];
  const fetch = () => { const v = memory[pc]; pc = (pc + 1) & 0xFF; return v; };
  const setA = (v) => { a = v & 0xFF; };

  while (!halted && steps < maxSteps && !error) {
    if (trace && traceLog.length < 2000) traceLog.push({ pc, a, sp });
    const at = pc;
    const opcode = fetch();

    if (opcode === OP.HLT) halted = true;
    else if (opcode === OP.LDI) setA(fetch());
    else if (opcode === OP.LDA) setA(memory[fetch()]);
    else if (opcode === OP.STA) memory[fetch()] = a;
    else if (opcode === OP.ADD) setA(a + memory[fetch()]);
    else if (opcode === OP.SUB) setA(a - memory[fetch()]);
    else if (opcode === OP.JMP) pc = fetch();
    else if (opcode === OP.JZ) { const addr = fetch(); if (a === 0) pc = addr; }
    else if (opcode === OP.PUSH) { sp -= 1; memory[sp & 0xFF] = a; }
    else if (opcode === OP.POP) { a = memory[sp & 0xFF]; sp += 1; }
    else if (opcode === OP.CALL) { const addr = fetch(); sp -= 1; memory[sp & 0xFF] = pc; pc = addr; }
    else if (opcode === OP.RET) { pc = memory[sp & 0xFF]; sp += 1; }
    else error = { at, message: `неизвестный код операции: ${opcode.toString(16).toUpperCase().padStart(2, '0')} на адресе ${at.toString(16).toUpperCase().padStart(2, '0')}` };

    steps++;
  }

  if (!error && !halted) error = { message: `превышено ${maxSteps} шагов — вероятно, бесконечный цикл` };

  return { memory, pc, a, sp, steps, halted, zero: a === 0, error, traceLog };
}
