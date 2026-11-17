# tinycpu.py — учебный процессор TinyCPU-8
# Реализованы HLT и LDI. Остальн1 команды — задание.

MEM_SIZE = 256

HLT, LDA, STA, LDI, ADD, SUB, JMP, JZ, PUSH, POP, CALL, RET = range(12)

MNEMONICS = {
    HLT: "HLT", LDA: "LDA", STA: "STA", LDI: "LDI",
    ADD: "ADD", SUB: "SUB", JMP: "JMP", JZ: "JZ",
    PUSH: "PUSH", POP: "POP", CALL: "CALL", RET: "RET",
}


class TinyCPU:
    def __init__(self, memory=None):
        self.memory = list(memory or [0] * MEM_SIZE)
        self.memory += [0] * (MEM_SIZE - len(self.memory))
        self.pc = 0
        self.a = 0
        self.sp = 0xFF
        self.zero = False
        self.halted = False

    def fetch(self):
        """Прочитать байт по адресу PC и сдвинуть PC."""
        value = self.memory[self.pc]
        self.pc = (self.pc + 1) & 0xFF
        return value

    def set_a(self, value):
        self.a = value & 0xFF
        self.zero = (self.a == 0)

    def step(self):
        """Выполнить одну команду."""
        if self.halted:
            return
        opcode = self.fetch()

        if opcode == HLT:
            self.halted = True

        elif opcode == LDI:
            self.set_a(self.fetch())

        elif opcode == LDA:
            self.set_a(self.memory[self.fetch()])

        elif opcode == STA:
            self.memory[self.fetch()] = self.a

        elif opcode == ADD:
            self.a = (self.a + self.memory[self.fetch()]) & 0xFF

        elif opcode == SUB:
            self.a = (self.a - self.memory[self.fetch()]) & 0xFF

        elif opcode == JMP:
            self.pc = self.fetch()

        elif opcode == JZ:
            addr = self.fetch()
            if self.a == 0:
                self.pc = addr

        elif opcode == PUSH:
            self.sp -= 1
            self.memory[self.sp] = self.a

        elif opcode == POP:
            self.a = self.memory[self.sp]
            self.sp += 1

        elif opcode == CALL:
            addr = self.fetch()
            self.sp -= 1
            self.memory[self.sp] = self.pc
            self.pc = addr

        elif opcode == RET:
            self.pc = self.memory[self.sp]
            self.sp += 1

        else:
            raise ValueError(f"неизвестный код операции: {opcode:02X} на адресе {self.pc - 1:02X}")

    def run(self, max_steps=10000):
        """Выполнять до остановки. Ограничитель спасает от вечного цикла."""
        steps = 0
        while not self.halted and steps < max_steps:
            self.step()
            steps += 1
        if steps >= max_steps:
            raise RuntimeError(f"превышено {max_steps} шагов — вероятно, бесконечный цикл")
        return steps

    def print_memory(self):
        green_on = "\x1b[92m"
        yellow_on = "\x1b[93m"
        color_off = "\x1b[0m"

        def decorate(i, m):
            if i == self.pc:
                return f"{green_on}{m:02X}{color_off}"
            elif i == self.sp:
                return f"{yellow_on}{m:02X}{color_off}"
            else:
                return f"{m:02X}"

        mem = [decorate(i, m) for i, m in enumerate(self.memory)]

        for i in range(0, len(mem), 16):
            chunk = mem[i : i + 16]
            print(" ".join(map(str, chunk)))

    def state(self):
        """Состояние машины наружу. Печатать здесь ничего нельзя."""
        return {
            f"pc": self.pc, "a": self.a, "sp": self.sp,
            "zero": self.zero, "halted": self.halted,
        }


if __name__ == "__main__":
    # # LDI 7 / ADD 8 / STA 20 / HLT, в ячейке 8 лежит 5
    # program = [0x03, 0x07, 0x04, 0x08, 0x02, 0x14, 0x00, 0x00, 0x05]

    # # LDI 7 / PUSH / LDI 9 / POP / HLT
    # program = [0x03, 0x07, 0x08, 0x03, 0x09, 0x09, 0x00]

    # CALL 5 / STA 48 / HLT / LDI 99 / RET
    # 1        4        5     2        3
    program = [0x0A, 0x05, 0x02, 0x30, 0x00, 0x03, 0x63, 0x0B]

    cpu = TinyCPU(program)

    # print(cpu.state())
    # cpu.run()
    # print(cpu.state())

    while not cpu.halted:
        print(cpu.state())
        cpu.print_memory()
        input("\nPress enter...")
        cpu.step()
        print("")

    print(cpu.state())
    cpu.print_memory()
