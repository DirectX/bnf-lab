#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Тема 4, занятие 2 — ПАРСЕР МЕТОДОМ РЕКУРСИВНОГО СПУСКА + ГЕНЕРАТОР КОДА
(референсное решение для мини-языка занятия 1).

Сюжет занятия, воплощённый в коде:

  • Правило → функция. Каждому нетерминалу — своя функция parse_X(),
    соответствие механическое (блок 1 занятия 2).

  • Левая рекурсия превратилась в цикл. <выражение> ::= <выражение> "+" <слагаемое>
    записанное напрямую вызвало бы себя первой строкой и ушло в бесконечность.
    Здесь оно стало циклом «пока подходит хвост», который даёт левую
    ассоциативность: 1 + 2 + 3 = ((1 + 2) + 3).

  • Разбор отделён от вычисления. Парсер строит дерево, генератор считает.
    Никакой арифметики в функциях разбора нет (блок 2 занятия 2).

  • Скобки в AST не попадают — они уже сделали своё дело, повлияв на форму
    дерева. Вопрос «где в вашем AST скобки?» — ответ: нигде.

  • Ошибки сообщаются с позицией: строка, столбец, что ожидалось. Здесь
    окупается то, что лексер занятия 1 сохранил позиции.

  • Генератор (блоки 3–4): один аккумулятор → вложенные выражения через
    PUSH/POP; ADD/SUB принимают только адрес → константы едут в память;
    умножения нет → цикл сложений; флага «меньше» нет → сравнение перебором;
    «адрес вперёд, которого ещё нет» → метки разрешаются двумя проходами
    (обратная правка).

Целевая машина — TinyCPU-8 (порт tinycpu.py). Этот генератор даёт ТЕ ЖЕ
байты, что и JS-версия в приложении: листинг можно скопировать на
https://directx.github.io/tinycpu-web/ и собрать.

Зависимость: zanyatie1_lexer.py (рядом или в PYTHONPATH).
"""

import sys
import os

try:
    from zanyatie1_lexer import lex, Token, NUM, IDENT, KW, OP, ERR
except ImportError:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from zanyatie1_lexer import lex, Token, NUM, IDENT, KW, OP, ERR


# =========================================================================== AST

class Node:
    """Узел разбора. type='rule' — нетерминал (есть name и children),
    type='tok' — лексема-лист (есть tok). Скобок здесь нет: они растворились
    в форме дерева."""
    __slots__ = ("type", "name", "children", "tok", "start", "end")

    def __init__(self, type_, *, name=None, children=None, tok=None, start=0, end=0):
        self.type = type_
        self.name = name
        self.children = children or []
        self.tok = tok
        self.start = start
        self.end = end

    def __repr__(self):
        if self.type == "tok":
            return f"<{self.tok.text}>"
        return f"<{self.name} {' '.join(map(repr, self.children))}>"


class ParseError(Exception):
    def __init__(self, message, line=None, col=None):
        super().__init__(message)
        self.line, self.col = line, col


# =========================================================================== парсер

# Грамматика мини-языка (итог занятия 1, приоритет — структурой):
#
#   <программа>    ::= <оператор>*
#   <оператор>     ::= <присваивание> | <условный> | <цикл> | <блок>
#   <присваивание> ::= ИДЕНТ "=" <выражение> ";"
#   <условный>     ::= "if" "(" <условие> ")" <оператор> [ "else" <оператор> ]
#   <цикл>         ::= "while" "(" <условие> ")" <оператор>
#   <блок>         ::= "{" <оператор>* "}"
#   <условие>      ::= <выражение> <отношение> <выражение>
#   <отношение>    ::= "<" | ">" | "<=" | ">=" | "==" | "!="
#   <выражение>    ::= <слагаемое> | <выражение> "+" <слагаемое> | <выражение> "-" <слагаемое>
#   <слагаемое>    ::= <множитель> | <слагаемое> "*" <множитель> | <слагаемое> "/" <множитель>
#   <множитель>    ::= ЧИСЛО | ИДЕНТ | "(" <выражение> ")"
#
# Модификатор * и секция [ ... ] раскрыты в рекурсивные правила — так же, как
# их раскрывает desugar в приложении: <оператор>* = цепочка оператор#1,
# [ "else" <оператор> ] = секция#2#3 (есть «else оп» или пусто).


class Parser:
    def __init__(self, tokens):
        self.toks = tokens
        self.pos = 0
        # для диагностики: самая дальняя лексема, до которой дошёл разбор, и что там ожидалось
        self.furthest = -1
        self.expected = set()

    # ---- работа с токенами -------------------------------------------------
    def peek(self, k=0):
        i = self.pos + k
        return self.toks[i] if i < len(self.toks) else None

    def at_end(self):
        return self.pos >= len(self.toks)

    def take(self):
        t = self.toks[self.pos]
        self.pos += 1
        return t

    def is_lit(self, t, text):
        return t is not None and t.kind in (KW, OP, ERR) and t.text == text

    def is_class(self, t, cls):
        return t is not None and ((t.kind == IDENT) if cls == "ИДЕНТ" else (t.kind == NUM))

    def note(self, what, pos):
        """Запомнить, чего ожидали на позиции pos — для сообщения об ошибке."""
        if pos > self.furthest:
            self.furthest = pos
            self.expected = {what}
        elif pos == self.furthest:
            self.expected.add(what)

    def expect_lit(self, text):
        t = self.peek()
        if self.is_lit(t, text):
            return self.take()
        self.note(f'"{text}"', self.pos)
        return None

    # ---- нетерминалы -------------------------------------------------------
    # Каждый возвращает Node или None (не удалось). Позиция меняется только на успех.

    def parse_program(self):
        start = self.pos
        items = [self.parse_operator_seq()]
        return Node("rule", name="программа", children=[c for c in items if c], start=start, end=self.pos)

    def parse_operator_seq(self):
        """<оператор#1> ::= <оператор> <оператор#1> | ε  — левая рекурсия, ставшая рекурсией вправо."""
        start = self.pos
        op = self.parse_operator()
        if op is None:
            # пустая последовательность (ε) — корректно для <оператор>*
            return Node("rule", name="оператор#1", children=[], start=start, end=self.pos)
        tail = self.parse_operator_seq()
        return Node("rule", name="оператор#1", children=[op, tail], start=start, end=self.pos)

    def parse_operator(self):
        start = self.pos
        for alt in (self.parse_assign, self.parse_if, self.parse_while, self.parse_block):
            self.pos = start
            inner = alt()
            if inner is not None:
                return Node("rule", name="оператор", children=[inner], start=start, end=self.pos)
        # каждую альтернативу уже отметили её первым терминалом (ИДЕНТ/"if"/"while"/"{")
        return None

    def parse_assign(self):
        start = self.pos
        t = self.peek()
        if not self.is_class(t, "ИДЕНТ"):
            self.note("ИДЕНТ", start)
            return None
        ident = self.take()
        eq = self.expect_lit("=")
        if eq is None:
            self.pos = start
            return None
        expr = self.parse_expr()
        if expr is None:
            self.pos = start
            return None
        semi = self.expect_lit(";")
        if semi is None:
            self.pos = start
            return None
        return Node("rule", name="присваивание", children=[
            Node("tok", tok=ident, start=start, end=start + 1),
            Node("tok", tok=eq, start=self.pos - 3, end=self.pos - 2),
            expr,
            Node("tok", tok=semi, start=self.pos - 1, end=self.pos),
        ], start=start, end=self.pos)

    def parse_if(self):
        start = self.pos
        kw_if = self.expect_lit("if")
        if kw_if is None:
            return None
        lp = self.expect_lit("(")
        if lp is None:
            self.pos = start; return None
        cond = self.parse_cond()
        if cond is None:
            self.pos = start; return None
        rp = self.expect_lit(")")
        if rp is None:
            self.pos = start; return None
        then_op = self.parse_operator()
        if then_op is None:
            self.pos = start; return None
        # [ "else" <оператор> ] — необязательная секция, раскрыта как в desugar:
        # секция#2#3 ::= секция#2 | ε ;  секция#2 ::= "else" <оператор>
        sec_start = self.pos
        sec_children = []
        if self.is_lit(self.peek(), "else"):
            else_tok = self.take()
            else_op = self.parse_operator()
            if else_op is not None:
                sec_children = [Node("rule", name="секция#2", children=[
                    Node("tok", tok=else_tok, start=sec_start, end=sec_start + 1),
                    else_op,
                ], start=sec_start, end=self.pos)]
        sec = Node("rule", name="секция#2#3", children=sec_children, start=sec_start, end=self.pos)
        return Node("rule", name="условный", children=[
            Node("tok", tok=kw_if, start=start, end=start + 1),
            Node("tok", tok=lp, start=start + 1, end=start + 2),
            cond,
            Node("tok", tok=rp, start=sec_start - 1, end=sec_start),
            then_op,
            sec,
        ], start=start, end=self.pos)

    def parse_while(self):
        start = self.pos
        kw = self.expect_lit("while")
        if kw is None:
            return None
        lp = self.expect_lit("(")
        if lp is None:
            self.pos = start; return None
        cond = self.parse_cond()
        if cond is None:
            self.pos = start; return None
        rp = self.expect_lit(")")
        if rp is None:
            self.pos = start; return None
        body = self.parse_operator()
        if body is None:
            self.pos = start; return None
        return Node("rule", name="цикл", children=[
            Node("tok", tok=kw, start=start, end=start + 1),
            Node("tok", tok=lp, start=start + 1, end=start + 2),
            cond,
            Node("tok", tok=rp, start=self.pos - 2, end=self.pos - 1),
            body,
        ], start=start, end=self.pos)

    def parse_block(self):
        start = self.pos
        lb = self.expect_lit("{")
        if lb is None:
            return None
        seq = self.parse_operator_seq()
        rb = self.expect_lit("}")
        if rb is None:
            self.pos = start; return None
        return Node("rule", name="блок", children=[
            Node("tok", tok=lb, start=start, end=start + 1),
            seq,
            Node("tok", tok=rb, start=self.pos - 1, end=self.pos),
        ], start=start, end=self.pos)

    def parse_cond(self):
        start = self.pos
        left = self.parse_expr()
        if left is None:
            self.note("<выражение>", start); return None
        rel = self.parse_relation()
        if rel is None:
            self.pos = start; return None
        right = self.parse_expr()
        if right is None:
            self.pos = start; return None
        return Node("rule", name="условие", children=[left, rel, right], start=start, end=self.pos)

    def parse_relation(self):
        start = self.pos
        for r in ("<=", ">=", "==", "!=", "<", ">"):  # длинные вперёд: максимальное совпадение
            if self.is_lit(self.peek(), r):
                t = self.take()
                return Node("rule", name="отношение", children=[Node("tok", tok=t, start=start, end=start + 1)],
                            start=start, end=self.pos)
        for r in ("<", ">", "<=", ">=", "==", "!="):
            self.note(f'"{r}"', start)
        return None

    # ---- три уровня приоритета, левая рекурсия → цикл ---------------------
    # <выражение>  ::= <слагаемое> | <выражение> (+|-) <слагаемое>
    # <слагаемое>  ::= <множитель> | <слагаемое> (*|/) <множитель>
    # <множитель>  ::= ЧИСЛО | ИДЕНТ | "(" <выражение> ")"
    #
    # Запись напрямую дала бы бесконечный вызов. Здесь база — уровень ниже,
    # а леворекурсивные хвосты стали циклом «пока подходит оператор»:
    # он же даёт левую ассоциативность, 1 + 2 + 3 = ((1 + 2) + 3).

    def parse_expr(self):
        return self._binary("выражение", "слагаемое", ("+", "-"))

    def parse_slagaemoe(self):
        return self._binary("слагаемое", "множитель", ("*", "/"))

    def _binary(self, name, sub, ops):
        start = self.pos
        base = getattr(self, "parse_" + {"слагаемое": "slagaemoe", "множитель": "factor"}[sub])()
        if base is None:
            return None
        node = Node("rule", name=name, children=[base], start=start, end=self.pos)
        while True:
            save = self.pos
            t = self.peek()
            if not (t is not None and t.kind in (KW, OP, ERR) and t.text in ops):
                # как в JS: каждая непрошедшая альтернатива-хвост отмечает свой терминал
                for o in ops:
                    self.note(f'"{o}"', save)
                break
            op = self.take()
            right = getattr(self, "parse_" + {"слагаемое": "slagaemoe", "множитель": "factor"}[sub])()
            if right is None:
                self.pos = save
                break
            node = Node("rule", name=name, children=[
                node, Node("tok", tok=op, start=save, end=save + 1), right], start=start, end=self.pos)
        return node

    def parse_factor(self):
        start = self.pos
        t = self.peek()
        if self.is_class(t, "ЧИСЛО") or self.is_class(t, "ИДЕНТ"):
            self.take()
            return Node("rule", name="множитель", children=[Node("tok", tok=t, start=start, end=start + 1)],
                        start=start, end=self.pos)
        if self.is_lit(t, "("):
            self.take()
            inner = self.parse_expr()
            if inner is None:
                self.pos = start; return None
            rp = self.expect_lit(")")
            if rp is None:
                self.pos = start; return None
            # скобки остаются в дереве как листы, но в AST-смысле растворяются:
            # codegen ищет среди детей единственное <выражение>
            return Node("rule", name="множитель", children=[
                Node("tok", tok=t, start=start, end=start + 1),
                inner,
                Node("tok", tok=rp, start=self.pos - 1, end=self.pos),
            ], start=start, end=self.pos)
        self.note("ЧИСЛО", start)
        self.note("ИДЕНТ", start)
        self.note('"("', start)
        return None

    # ---- разбор с проверкой «не осталось ли лишних лексем» ----------------

    def parse_top(self):
        best = self.parse_program()
        if best is None:
            self._raise()
        if self.pos < len(self.toks):
            # зеркалим rd.js: если разбор куда-то дошёл дальше, чем сумел
            # построить дерево — сообщаем, где именно застрял и чего ожидал
            if self.furthest >= self.pos and self.expected:
                self._raise(self.pos)
            t = self.toks[self.pos]
            raise ParseError(
                f"разобрано лексем: {self.pos} из {len(self.toks)}; лишнее начинается с «{t.text}» "
                f"(строка {t.line}, столбец {t.col})", t.line, t.col)
        return best

    def _raise(self, end=None):
        if end is None:
            end = self.pos
        t = self.toks[self.furthest] if 0 <= self.furthest < len(self.toks) else None
        exp = ", ".join(sorted(self.expected)) if self.expected else "продолжения"
        if t:
            raise ParseError(
                f"дальше разобрать не удалось: в лексеме {self.furthest + 1} «{t.text}» "
                f"(строка {t.line}, столбец {t.col}) ни одно правило не продолжается. Ожидалось одно из: {exp}",
                t.line, t.col)
        raise ParseError(f"разобрано {end} лексем, дальше — конец программы, а грамматика требует "
                         f"продолжения. Ожидалось одно из: {exp}")


def parse(tokens):
    p = Parser(tokens)
    return p.parse_top()


# =========================================================================== генератор

# Точная копия src/cpu8/codegen.js по порядку эмиссии и раскладке данных —
# иначе байты разойдутся с приложением. Комментарии в листинге — учебные.

MNEMONICS = ["HLT", "LDA", "STA", "LDI", "ADD", "SUB", "JMP", "JZ", "PUSH", "POP", "CALL", "RET"]
OPS = {m: i for i, m in enumerate(MNEMONICS)}
HAS_OPERAND = {OPS["LDA"], OPS["STA"], OPS["LDI"], OPS["ADD"], OPS["SUB"], OPS["JMP"], OPS["JZ"], OPS["CALL"]}


class GenError(Exception):
    def __init__(self, message, line=None):
        super().__init__(message)
        self.line = line


TRANSLIT = {"а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh", "з": "z",
            "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r",
            "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "c", "ч": "ch", "ш": "sh", "щ": "sch",
            "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya"}


def latin(name):
    out = "".join(TRANSLIT.get(c, c) for c in str(name).lower())
    out = "".join(c if (c.isalnum() and c.isascii()) or c == "_" else "_" for c in out).strip("_")
    return out or "id"


def is_rule(node, name=None):
    return node is not None and node.type == "rule" and (name is None or node.name == name)


def rules_of(node, pred=None):
    return [c for c in node.children if is_rule(c) and (pred is None or pred(c))]


def first_rule(node, pred=None):
    r = rules_of(node, pred)
    return r[0] if r else None


def first_tok(node):
    for c in node.children:
        if c.type == "tok":
            return c
    return None


def line_of(node):
    t = first_tok(node)
    if t:
        return t.tok.line
    for c in node.children:
        if is_rule(c):
            return line_of(c)
    return None


def collect_ops(node):
    """Собрать <оператор>-и из цепочки <оператор#1> (раскрытие *)."""
    out = []
    for c in rules_of(node):
        if c.name == "оператор":
            out.append(c)
        elif "#" in c.name:
            out.extend(collect_ops(c))
    return out


def first_rule_deep(node, pred):
    found = [None]

    def walk(n):
        if found[0]:
            return
        for c in n.children:
            if not is_rule(c):
                continue
            if pred(c):
                found[0] = c
                return
            walk(c)
    walk(node)
    return found[0]


class Generator:
    def __init__(self):
        self.entries = []          # (kind, ...)
        self.labels = set(m.lower() for m in MNEMONICS) | {"db"}
        self.vars = {}             # имя -> {label, write}
        self.consts = {}           # значение -> label
        self.scratch = {}          # ключ -> {label, comment}
        self.warnings = []
        self.seq = 0

    # ---- примитивы эмиссии
    def emit(self, mnem, arg=None, comment=""):
        self.entries.append(("inst", mnem, arg, comment))

    def emit_label(self, name):
        self.labels.add(name)
        self.entries.append(("label", name))

    def new_label(self, hint):
        self.seq += 1
        return f"{hint}{self.seq}"

    def var_label(self, name, write):
        if name not in self.vars:
            lab = "v_" + latin(name)
            n = 2
            while lab in self.labels:
                lab = "v_" + latin(name) + n
                n += 1
            self.labels.add(lab)
            self.vars[name] = {"label": lab, "write": bool(write)}
            if not write:
                self.warnings.append(f"переменная «{name}» нигде не присваивается — при чтении будет 0")
        elif write:
            self.vars[name]["write"] = True
        return self.vars[name]["label"]

    def check_const(self, value, line=None):
        if value > 255:
            raise GenError(f"константа {value} не влезает в байт: тип в языке один — восьмибитный беззнаковый", line)
        if value not in self.consts:
            lab = f"k_{value}"
            self.labels.add(lab)
            self.consts[value] = lab

    def scr(self, key, comment=""):
        if key not in self.scratch:
            lab = "s_" + latin(key)
            self.scratch[key] = {"label": lab, "comment": comment}
            self.labels.add(lab)
        return self.scratch[key]["label"]

    # ---- выражения: результат всегда в аккумуляторе A
    def op_symbol(self, bin_node):
        mid = bin_node.children[1]
        if mid.type == "tok":
            return mid.tok.text
        t = first_tok(mid)
        return t.tok.text if t else None

    def emit_simple_tok(self, t):
        if t.kind == NUM:
            self.check_const(int(t.text), t.line)
            self.emit("LDI", int(t.text))
            return True
        if t.kind == IDENT:
            self.emit("LDA", self.var_label(t.text, False))
            return True
        return False

    def emit_expr(self, node):
        if not is_rule(node):
            raise GenError("выражение отсутствует в дереве разбора")
        kids = node.children

        if len(kids) == 1 and kids[0].type == "tok":
            if self.emit_simple_tok(kids[0].tok):
                return
            raise GenError(f"элемент «{kids[0].tok.text}» непонятен генератору", kids[0].tok.line)

        if node.name == "множитель":
            if len(kids) == 1 and kids[0].type == "tok":
                t = kids[0].tok
                if t.kind == NUM:
                    self.check_const(int(t.text), t.line); self.emit("LDI", int(t.text)); return
                if t.kind == IDENT:
                    self.emit("LDA", self.var_label(t.text, False)); return
                raise GenError(f"множитель «{t.text}» непонятен генератору", t.line)
            inner = next((c for c in kids if is_rule(c)), None)
            if inner:
                return self.emit_expr(inner)   # ( <выражение> )
            raise GenError("пустой множитель", line_of(node))

        if len(kids) == 1 and is_rule(kids[0]):
            return self.emit_expr(kids[0])

        if len(kids) == 3 and is_rule(kids[0]) and is_rule(kids[2]):
            op = self.op_symbol(node)
            if op not in "+-*/":
                raise GenError(f"операция «{op}» не поддерживается генератором", line_of(node))
            left, _, right = kids
            self.emit_expr(left)
            right_simple = (is_rule(right, "множитель") and len(right.children) == 1
                            and right.children[0].type == "tok" and right.children[0].tok.kind == IDENT)
            if right_simple and op in "+-":
                self.emit("ADD" if op == "+" else "SUB", self.var_label(right.children[0].tok.text, False))
                return
            # общий случай: левый операнд переживает правый на стеке
            self.emit("PUSH")
            self.emit_expr(right)
            self.emit("STA", self.scr("t1", "временная ячейка"))
            self.emit("POP")            # A = левое, s_t1 = правое
            if op == "+":
                self.emit("ADD", "s_t1"); return
            if op == "-":
                self.emit("SUB", "s_t1"); return
            if op == "*":
                return self.mul_inline()
            raise GenError("деление генератором не поддерживается: на этой машине деление — цикл вычитаний "
                           "со сравнением, это самостоятельная работа", line_of(node))

        inner = first_rule(node)
        if inner:
            return self.emit_expr(inner)
        raise GenError(f"не умею компилировать узел <{node.name}>", line_of(node))

    def mul_inline(self):
        t1 = self.scr("t1", "временная ячейка")
        t2 = self.scr("t2", "временная ячейка")
        x = self.scr("x", "накопитель произведения")
        y = self.scr("y", "счётчик множителя")
        one = self.scr("one", "константа 1")
        loop = self.new_label("mul")
        done = self.new_label("mul_done")
        self.emit("STA", t2, "умножение — циклом сложений: множимое")
        self.emit("LDI", 0); self.emit("STA", x)
        self.emit("LDA", t1); self.emit("STA", y)
        self.emit_label(loop)
        self.emit("LDA", y); self.emit("JZ", done)
        self.emit("LDA", x); self.emit("ADD", t2); self.emit("STA", x)
        self.emit("LDA", y); self.emit("SUB", one); self.emit("STA", y)
        self.emit("JMP", loop)
        self.emit_label(done)
        self.emit("LDA", x)

    # ---- сравнения: флага «меньше» нет, разворачиваем перебором вниз
    def le_inline(self, rel1):
        x = self.scr("x", "перебор для сравнения")
        y = self.scr("y", "перебор для сравнения")
        one = self.scr("one", "константа 1")
        loop = self.new_label("cmp_loop")
        yes = self.new_label("cmp_yes")
        no = self.new_label("cmp_no")
        end = self.new_label("cmp_end")
        self.emit("LDA", self.scr("t1", ""), "перебор вниз: у машины нет флага «меньше»")
        self.emit("STA", x, rel1)
        self.emit("LDA", self.scr("t2", ""))
        self.emit("STA", y)
        self.emit_label(loop)
        self.emit("LDA", x); self.emit("JZ", yes)     # a закончился раньше или одновременно → a <= b
        self.emit("LDA", y); self.emit("JZ", no)      # a ещё есть, b кончился → a > b
        self.emit("LDA", x); self.emit("SUB", one); self.emit("STA", x)
        self.emit("LDA", y); self.emit("SUB", one); self.emit("STA", y)
        self.emit("JMP", loop)
        self.emit_label(yes); self.emit("LDI", 1); self.emit("JMP", end)
        self.emit_label(no); self.emit("LDI", 0)
        self.emit_label(end)

    def cmp_inline(self, kind):
        if kind in ("==", "!="):
            eq = self.new_label("cmp_eq")
            end = self.new_label("cmp_end")
            self.emit("LDA", self.scr("t1", ""), f"сравнение {'==' if kind == '==' else '!='} разностью")
            self.emit("SUB", self.scr("t2", ""))
            self.emit("JZ", eq)
            self.emit("LDI", 0 if kind == "==" else 1); self.emit("JMP", end)
            self.emit_label(eq); self.emit("LDI", 1 if kind == "==" else 0)
            self.emit_label(end)
            return
        if kind == "<=":
            return self.le_inline("a <= b: a и b убывают вместе")
        if kind == "<":
            x = self.scr("x", "перебор для сравнения")
            eq = self.new_label("cmp_eq")
            end = self.new_label("cmp_end")
            self.le_inline("a < b = (a <= b) и не равно")
            self.emit("STA", x)
            self.emit("LDA", self.scr("t1", "")); self.emit("SUB", self.scr("t2", "")); self.emit("JZ", eq)
            self.emit("LDA", x); self.emit("JMP", end)
            self.emit_label(eq); self.emit("LDI", 0)   # равны → не «меньше»
            self.emit_label(end)
            return
        raise GenError(f"сравнение «{kind}» не поддерживается")

    def emit_cond(self, cond_node):
        if not is_rule(cond_node, "условие"):
            raise GenError("ожидалось <условие>", line_of(cond_node))
        rel_node = first_rule(cond_node, lambda c: c.name == "отношение")
        rel = first_tok(rel_node).tok.text if rel_node else None
        if not rel:
            raise GenError("в условии нет <отношение>", line_of(cond_node))
        exprs = rules_of(cond_node, lambda c: c.name != "отношение")
        if len(exprs) < 2:
            raise GenError("в условии два выражения, а найдено одно", line_of(cond_node))
        left, right = exprs
        swap = rel in (">=", ">")
        kind = {"<": "<", "<=": "<=", ">": "<", ">=": "<=", "==": "==", "!=": "!="}[rel]

        self.emit_expr(right if swap else left)
        self.emit("PUSH")
        self.emit_expr(left if swap else right)
        self.emit("STA", self.scr("t2", "правая часть условия"))
        self.emit("POP")
        self.emit("STA", self.scr("t1", "левая часть условия"))
        self.cmp_inline(kind)   # A = 0 (ложь) или 1 (истина)

    # ---- операторы
    def emit_stmt(self, node):
        if not is_rule(node):
            raise GenError("ожидался оператор")
        if node.name in ("программа", "блок"):
            for op in collect_ops(node):
                self.emit_stmt(op)
            return
        if node.name == "оператор":
            inner = first_rule(node)
            if inner is None:
                raise GenError("пустой оператор", line_of(node))
            return self.emit_stmt(inner)
        if node.name == "присваивание":
            ident = next((c.tok for c in node.children if c.type == "tok" and c.tok.kind == IDENT), None)
            expr = first_rule(node, lambda c: c.name == "выражение")
            if ident is None or expr is None:
                raise GenError("не узнаю присваивание", line_of(node))
            lab = self.var_label(ident.text, True)
            self.emit_expr(expr)
            self.emit("STA", lab, f"строка {ident.line}: {ident.text} = …")
            return
        if node.name == "условный":
            cond = first_rule(node, lambda c: c.name == "условие")
            ops = rules_of(node, lambda c: c.name == "оператор")
            sec = next((c for c in rules_of(node) if "#" in c.name), None)
            then_op = ops[0] if ops else None
            else_op = ops[1] if len(ops) >= 2 else (first_rule_deep(sec, lambda c: c.name == "оператор") if sec else None)
            if then_op is None:
                raise GenError("у if нет ветки", line_of(node))
            ln = line_of(node)
            l_else = self.new_label("else") if else_op else None
            l_end = self.new_label("endif")
            self.emit_cond(cond)
            self.emit("JZ", l_else or l_end, f"строка {ln}: if …")
            self.emit_stmt(then_op)
            if else_op:
                self.emit("JMP", l_end)
                self.emit_label(l_else)
                self.emit_stmt(else_op)
            self.emit_label(l_end)
            return
        if node.name == "цикл":
            cond = first_rule(node, lambda c: c.name == "условие")
            body = first_rule(node, lambda c: c.name == "оператор")
            ln = line_of(node)
            l_start = self.new_label("loop")
            l_end = self.new_label("endloop")
            self.emit_label(l_start)
            self.emit_cond(cond)
            self.emit("JZ", l_end, f"строка {ln}: while …")
            self.emit_stmt(body)
            self.emit("JMP", l_start)
            self.emit_label(l_end)
            return
        raise GenError(f"генератор покрывает грамматику мини-языка занятия 1, а тут <{node.name}> — "
                       "свою грамматику компилируют вручную, в этом смысл занятия 2", line_of(node))

    # ---- сборка: два прохода, метки разрешаются вторым (обратная правка)
    def build(self, ast):
        self.emit_stmt(ast)
        self.emit("HLT", None, "останов")

        data_rows = []
        for key, s in self.scratch.items():
            data_rows.append({"label": s["label"], "value": 1 if key == "one" else 0, "comment": s["comment"]})
        for value, label in sorted(self.consts.items()):
            data_rows.append({"label": label, "value": value, "comment": f"константа {value}"})
        for name, v in self.vars.items():
            data_rows.append({"label": v["label"], "value": 0, "comment": f"переменная {name}", "var_name": name})

        # проход 1: адреса меток
        addr_of = {}
        addr = 0
        for e in self.entries:
            if e[0] == "label":
                addr_of[e[1]] = addr
            else:
                addr += 1 if e[2] is None else 2
        code_len = addr
        for i, r in enumerate(data_rows):
            addr_of[r["label"]] = code_len + i

        total = code_len + len(data_rows)
        if total > 240:
            raise GenError(f"код + данные заняли {total} байт из 256: оставьте место стеку (он растёт вниз с 0xFF)")

        # проход 2: байты; операнды-метки дописываются сейчас
        out = bytearray()
        code_rows = []
        listing = ["; мини-язык → TinyCPU-8 — сгенерировано референсом занятия 2",
                   "; код с 0x00, данные — DB после кода, стек сверху вниз"]
        for e in self.entries:
            if e[0] == "label":
                listing.append(f"{e[1]}:")
                code_rows.append({"addr": len(out), "label": e[1], "text": f"{e[1]}:", "comment": ""})
                continue
            _, mnem, arg, comment = e
            at = len(out)
            out.append(OPS[mnem])
            operand = ""
            if arg is not None:
                if isinstance(arg, int):
                    operand = str(arg)
                    val = arg
                else:
                    if arg not in addr_of:
                        raise GenError(f"метка {arg} не определена")
                    operand = arg
                    val = addr_of[arg]
                out.append(val & 0xFF)
            text = f"{mnem} {operand}" if arg is not None else mnem
            code_rows.append({"addr": at,
                              "hex": " ".join(f"{b:02X}" for b in out[at:]),
                              "text": text, "comment": comment})
            listing.append(f"{text:<16}; {comment}" if comment else text)
        listing += ["", "; ---- данные ----"]
        for r in data_rows:
            r["addr"] = addr_of[r["label"]]
            out.append(r["value"] & 0xFF)
            listing.append(f"{r['label']}: DB {r['value']}    ; {r['comment']}" if r["comment"] else f"{r['label']}: DB {r['value']}")

        var_addrs = {name: addr_of[v["label"]] for name, v in self.vars.items()}
        return {"bytes": list(out), "listing": "\n".join(listing), "code_rows": code_rows,
                "data_rows": data_rows, "var_addrs": var_addrs, "warnings": list(dict.fromkeys(self.warnings)),
                "code_len": code_len}


def compile_source(src, *, strict_numbers=True, comments=False):
    """мини-язык → байты TinyCPU-8. Возвращает (result, gen)."""
    keywords = {"if", "else", "while"}
    puncts = {"=", ";", "+", "-", "*", "/", "(", ")", "{", "}", "<", ">", "<=", ">=", "==", "!="}
    lx = lex(src, keywords=keywords, puncts=puncts, strict_numbers=strict_numbers, comments=comments)
    ast = parse(lx.tokens)
    g = Generator()
    gen = g.build(ast)
    return lx, ast, gen


# =========================================================================== эмулятор (порт tinycpu.py)

def run_cpu8(bytecode, max_steps=100000):
    memory = [0] * 256
    for i, b in enumerate(bytecode):
        if i < 256:
            memory[i] = b & 0xFF
    pc, a, sp, halted, steps = 0, 0, 0xFF, False, 0
    error = None

    def fetch():
        nonlocal pc
        v = memory[pc]
        pc = (pc + 1) & 0xFF
        return v

    while not halted and steps < max_steps and error is None:
        opcode = fetch()
        if opcode == OPS["HLT"]:
            halted = True
        elif opcode == OPS["LDI"]:
            a = fetch() & 0xFF
        elif opcode == OPS["LDA"]:
            a = memory[fetch()] & 0xFF
        elif opcode == OPS["STA"]:
            memory[fetch()] = a
        elif opcode == OPS["ADD"]:
            a = (a + memory[fetch()]) & 0xFF
        elif opcode == OPS["SUB"]:
            a = (a - memory[fetch()]) & 0xFF
        elif opcode == OPS["JMP"]:
            pc = fetch()
        elif opcode == OPS["JZ"]:
            addr = fetch()
            if a == 0:
                pc = addr
        elif opcode == OPS["PUSH"]:
            sp -= 1
            memory[sp & 0xFF] = a
        elif opcode == OPS["POP"]:
            a = memory[sp & 0xFF]
            sp += 1
        elif opcode == OPS["CALL"]:
            addr = fetch()
            sp -= 1
            memory[sp & 0xFF] = pc
            pc = addr
        elif opcode == OPS["RET"]:
            pc = memory[sp & 0xFF]
            sp += 1
        else:
            error = f"неизвестный код операции: {opcode:02X}"
        steps += 1
    if error is None and not halted:
        error = f"превышено {max_steps} шагов — вероятно, бесконечный цикл"
    return {"memory": memory, "pc": pc, "a": a, "sp": sp, "steps": steps, "halted": halted, "error": error}


# =========================================================================== демо и самопроверка

PROGRAMS = {
    "01_prioritet": "x = 2 + 3 * (4 - 1);",
    "02_prisvoivanie": "x = 7;",
    "03_cycle": "i = 0;\nwhile (i < 10) { i = i + 1; }",
    "04_if_then": "if (a <= b) y = 1; else y = 2;",
    "05_sravneniya": "a = 5; b = 2;\nif (a <= b) y = 1; else y = 0;",
    "06_mul": "a = 4; b = 5;\nx = a * b;",
}


def selftest():
    print("Занятие 2 — парсер + генератор (референс). Компиляция и выполнение:\n")
    fails = 0
    for name, src in PROGRAMS.items():
        try:
            lx, ast, gen = compile_source(src)
            res = run_cpu8(gen["bytes"])
            vals = {n: res["memory"][addr] for n, addr in gen["var_addrs"].items()}
            if res["error"]:
                print(f"  ПАД {name}: {res['error']}")
                fails += 1
            else:
                print(f"  ok  {name}: {json_vals(vals)}  ({gen['code_len']} байт кода, {res['steps']} шагов)")
        except (ParseError, GenError) as e:
            print(f"  ПАД {name}: {e}")
            fails += 1

    # сверка с приложением: JS-версия (src/cpu8/codegen.js) даёт тот же байтовый код.
    # etalon-js.json сгенерирован приложением — это страховка, что референс и веб-лаборатория
    # не разъехались: листинг отсюда можно копировать на tinycpu-web один в один.
    etalon_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "etalon-js.json")
    if os.path.exists(etalon_path):
        print("\nСверка байтов с приложением (etalon-js.json):")
        import json
        etalon = json.load(open(etalon_path, encoding="utf-8"))
        for name, entry in etalon.items():
            if not entry.get("bytes"):
                continue
            try:
                _, _, gen = compile_source(entry["source"])
            except (ParseError, GenError) as e:
                print(f"  ПАД {name}: не компилируется — {e}")
                fails += 1
                continue
            same = gen["bytes"] == entry["bytes"]
            print(f"  {'ok  ' if same else 'ПАД '}{name}: {'байты совпадают с JS' if same else 'РАЗОШЛИСЬ с JS'}")
            if not same:
                fails += 1
    else:
        print("\n(etalon-js.json не найден — сверка с приложением пропущена)")

    # Сюжеты занятий 1–2, которые обязан видеть студент: ошибка с позицией
    # и честный отказ генератора.
    print("\nДиагностика (ошибки сообщаются с позицией — блок 2 занятия 2):")
    for src, expect in [
        ("x = 2 +", "ожидалось"),                     # незавершённое выражение
        ("x = 1 2;", '";"'),                          # забытая точка с запятой
        ("x = 256;", "восьмибитн"),                    # константа не влезает в байт
        ("x = 10 / 2;", "деление"),                    # деление генератор не умеет
        (") ) + = while", "лексеме"),                  # лексер пропустил, парсер поймал
    ]:
        try:
            compile_source(src)
            print(f"  ПАД {src!r}: ожидалась ошибка, а разобралось")
            fails += 1
        except (ParseError, GenError) as e:
            ok = expect.lower() in str(e).lower()
            print(f"  {'ok  ' if ok else 'ПАД '}{src!r} → {e}")
            if not ok:
                fails += 1

    print(f"\nреференс занятия 2: провалено {fails}")
    return fails


def json_vals(d):
    return ", ".join(f"{k}={v}" for k, v in d.items())


if __name__ == "__main__":
    sys.exit(1 if selftest() else 0)
