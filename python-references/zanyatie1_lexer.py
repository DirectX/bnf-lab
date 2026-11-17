#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Тема 4, занятие 1 — ЛЕКСЕР мини-языка (референсное решение).

Граница модуля, которую требует занятие 1: лексер НЕ знает про грамматику.
Он проверяет только ФОРМУ лексем. Строка ") ) + = while" для него корректна —
осмысленность последовательности дело парсера (занятие 2).

Три сюжета, на которых студенты спотыкаются (и тесты ниже это покрывают):

  1. Ключевое слово против идентификатора.
     while1 — идентификатор, а не while + 1.
     Правило: прочитать МАКСИМАЛЬНУЮ последовательность букв и цифр,
     и только потом проверить по таблице ключевых слов.

  2. Многосимвольные операции.
     <= — одна лексема. Правило максимального совпадения: пробуем самый
     длинный кандидат из словаря знаков, потом короче.

  3. Позиция.
     У каждой лексемы номер строки и столбца. Без них парсер не сможет
     сообщить, ГДЕ ошибка — «пять минут сейчас экономят час потом».

Язык: один тип — восьмибитное беззнаковое (0..255). Числа больше 255
лексер всё равно пропускает (это форма), но помечает: генератор занятия 2
такой константой откажется компилировать.
"""

from dataclasses import dataclass, field
import unicodedata

UINT8_MAX = 255

# Классы лексем. Имена совпадают с классами в БНФ (ИДЕНТ, ЧИСЛО), чтобы
# словарь лексера и грамматика занимались одним языком.
NUM, IDENT, KW, OP, ERR = "num", "ident", "kw", "op", "err"


@dataclass
class Token:
    kind: str
    text: str
    line: int
    col: int
    note: str = ""   # учебные пометки: какое правило максимального совпадения сработало


@dataclass
class LexResult:
    tokens: list = field(default_factory=list)
    errors: list = field(default_factory=list)      # (line, col, message)
    skipped: list = field(default_factory=list)     # пропущенные комментарии (domashka)


def _is_letter(c: str) -> bool:
    # Буквы латиницы и кириллицы, плюс подчёркивание трактуется отдельно.
    return c.isalpha() or "_" == c


def _is_digit(c: str) -> bool:
    return c.isdigit() and c.isascii()


def lex(src: str, keywords=set(), puncts=set(), strict_numbers=True, comments=False) -> LexResult:
    res = LexResult()
    i, line, col = 0, 1, 1
    n = len(src)
    max_punct = max((len(p) for p in puncts), default=0)

    def adv(length):
        nonlocal i, line, col
        for k in range(length):
            if src[i + k] == "\n":
                line += 1
                col = 1
            else:
                col += 1
        i += length

    while i < n:
        ch = src[i]
        l0, c0 = line, col

        # пропуск пробелов
        if ch in " \t\r\n":
            adv(1)
            continue

        # комментарии — домашнее задание к занятию 1, включается переключателем
        if comments and ch == "/" and i + 1 < n and src[i + 1] == "/":
            j = i
            while j < n and src[j] != "\n":
                j += 1
            res.skipped.append((i, j, "//-комментарий"))
            adv(j - i)
            continue
        if comments and ch == "/" and i + 1 < n and src[i + 1] == "*":
            start = i
            end = src.find("*/", i + 2)
            if end == -1:
                res.errors.append((l0, c0, "незакрытый блочный комментарий — не найдено */"))
                res.skipped.append((i, n, "/*-комментарий (незакрытый)"))
                i = n
                continue
            adv((end + 2) - i)
            res.skipped.append((start, end + 2, "/*-комментарий"))
            continue

        # ЧИСЛО: максимальная последовательность цифр
        if _is_digit(ch):
            j = i
            while j < n and _is_digit(src[j]):
                j += 1
            text = src[i:j]
            tok = Token(NUM, text, l0, c0)
            if int(text) > UINT8_MAX:
                tok.note = f"значение {text} не влезет в восьмибитную ячейку (0..{UINT8_MAX})"
            # число, слипшееся с буквами: 12abc
            if j < n and (_is_letter(src[j])):
                if strict_numbers:
                    res.errors.append((l0, c0 + len(text),
                                       f"число {text} слиплось с идентификатором — при строгих числах это ошибка"))
                    tok.note = "число слиплось с идентификатором"
                else:
                    tok.note = "число и идентификатор распознаны как две лексемы (максимальное совпадение)"
            res.tokens.append(tok)
            adv(len(text))
            continue

        # ИДЕНТ / КЛЮЧ: читаем МАКСИМУМ букв, цифр и _, потом сверяем с таблицей
        if _is_letter(ch):
            j = i
            while j < n and (_is_letter(src[j]) or _is_digit(src[j])):
                j += 1
            text = src[i:j]
            is_kw = text in keywords
            tok = Token(KW if is_kw else IDENT, text, l0, c0)
            if not is_kw and keywords:
                for kw in keywords:
                    if len(text) > len(kw) and text.startswith(kw):
                        tok.note = (f"начинается с ключевого слова «{kw}», но целиком не совпадает — "
                                    "это идентификатор")
                        break
            res.tokens.append(tok)
            adv(len(text))
            continue

        # СИМВОЛ: максимальное совпадение среди знаков грамматики
        matched = None
        for length in range(min(max_punct, n - i), 0, -1):
            cand = src[i:i + length]
            if cand in puncts:
                matched = cand
                break
        if matched:
            tok = Token(OP, matched, l0, c0)
            if len(matched) > 1 and matched[0] in puncts:
                tok.note = (f"максимальное совпадение: «{matched}» — одна лексема, "
                            f"а не «{matched[0]}» + «{matched[1:]}»")
            res.tokens.append(tok)
            adv(len(matched))
            continue

        # неизвестный символ
        res.errors.append((l0, c0, f"неизвестный символ «{ch}» — такого знака нет среди литералов грамматики"))
        res.tokens.append(Token(ERR, ch, l0, c0))
        adv(1)

    return res


# --------------------------------------------------------------------------- тесты

def selftest():
    """Пограничные и негативные случаи из блока 5 занятия 1."""
    keywords = {"if", "else", "while"}
    puncts = {"=", ";", "+", "-", "*", "/", "(", ")", "{", "}", "<", ">", "<=", ">=", "==", "!="}
    base = dict(keywords=keywords, puncts=puncts)
    fails = 0

    def check(cond, what):
        nonlocal fails
        print(("  ok  " if cond else "  ПАД ") + what)
        if not cond:
            fails += 1

    # корректная программа
    r = lex("x = 2 + 3 * (4 - 1);", **base)
    check(not r.errors, "x = 2 + 3 * (4 - 1); — без ошибок")
    check(len(r.tokens) == 12, f"12 лексем (получено {len(r.tokens)})")
    check(all(t.line >= 1 and t.col >= 1 for t in r.tokens), "у каждой лексемы есть строка и столбец")

    # максимальное совпадение для <=
    r = lex("if (a<=b) c = 1;", **base)
    check(any(t.text == "<=" and t.kind == OP for t in r.tokens), "<= — одна лексема (максимальное совпадение)")

    # while1 — идентификатор, а не while + 1
    r = lex("while1 = 7;", **base)
    check(r.tokens[0].kind == IDENT and r.tokens[0].text == "while1", "while1 — идентификатор, а не while+1")

    # 12abc: строгие числа — ошибка; нестрогие — два токена
    r = lex("12abc", **base, strict_numbers=True)
    check(len(r.errors) == 1, "12abc при строгих числах — ошибка")
    r = lex("12abc", **base, strict_numbers=False)
    check(not r.errors and len(r.tokens) == 2, "12abc нестрого — два токена")

    # лексер не знает про грамматику: мусор из знаков корректен
    r = lex(") ) + = while", **base)
    check(not r.errors, ") ) + = while — корректный вход (лексер не проверяет последовательность)")
    check(any(t.text == "while" and t.kind == KW for t in r.tokens), "while опознан ключевым словом")

    # восьмибитный тип
    r = lex("y = 256;", **base)
    check(any(t.note and "восьмибитн" in t.note for t in r.tokens), "256 — замечание про восьмибитную ячейку")

    # неизвестный символ
    r = lex("x @= 1;", **base)
    check(any("неизвестный символ" in e[2] for e in r.errors), "неизвестный символ — ошибка с позицией")

    # многострочность
    r = lex("i = 0;\nwhile (i < 3) { i = i + 1; }", **base)
    check(not r.errors and r.tokens[-1].line == 2, "строки считаются при переходе на новую строку")

    # комментарии (домашка)
    r = lex("x = 1; // счётчик\ny = 2;", **base, comments=True)
    check(not r.errors and len(r.skipped) == 1 and len(r.tokens) == 8, "//-комментарий пропущен (домашка)")
    r = lex("x = /* a */ 2;", **base, comments=True)
    check(not r.errors and len(r.skipped) == 1 and [t.text for t in r.tokens] == ["x", "=", "2", ";"],
          "/*-комментарий вырезан целиком (домашка)")
    r = lex("x = 1; // коммент", **base, comments=False)
    check(not r.errors and sum(1 for t in r.tokens if t.text == "/") == 2,
          "без режима комментариев // = два символа деления (в языке есть /)")

    print(f"\nлексер: провалено {fails}")
    return fails


if __name__ == "__main__":
    import sys
    sys.exit(1 if selftest() else 0)
