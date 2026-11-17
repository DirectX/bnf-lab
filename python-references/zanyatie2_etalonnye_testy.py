#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Тема 4, занятие 2, блок 6 — ЭТАЛОННЫЕ ТЕСТЫ компилятора.

Приём из Темы 3: программа на мини-языке → эталонное состояние памяти после
выполнения. Требования занятия: 5–6 тестов, запуск одной командой, ненулевой
код возврата при падении. Обязательно тест с циклом — он проверяет корректность
вычисления адресов переходов, самое хрупкое место компилятора.

Сравнивается ОБЛАСТЬ ДАННЫХ (после кода), а не вся память: код детерминированно
следует из листинга, а вот где лежат переменные — вопрос. Если студент разместит
переменные с адреса 0x00, он затрёт собственную программу, и этот тест это поймает.

Запуск:  python3 zanyatie2_etalonnye_testy.py       (0 — всё прошло, 1 — падение)
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from zanyatie2_parser_codegen import compile_source, run_cpu8, ParseError, GenError


# (имя, исходный текст на мини-языке, {имя_переменной: ожидаемое значение})
TESTS = [
    ("присваивание константы",
     "x = 7;",
     {"x": 7}),

    ("приоритет структурой (блок 2 занятия 1 дожил до байтов)",
     "x = 2 + 3 * (4 - 1);",
     {"x": 11}),

    ("вложенные выражения: один аккумулятор, PUSH/POP",
     "x = (1 + 2) * (3 + 4);",
     {"x": 21}),

    ("цикл — проверяет адреса переходов (самое хрупкое место)",
     "i = 0;\nwhile (i < 10) { i = i + 1; }",
     {"i": 10}),

    ("ветвление if/else с сравнением <=",
     "a = 5; b = 2;\nif (a <= b) y = 1; else y = 0;",
     {"a": 5, "b": 2, "y": 0}),

    ("равенство по разности, обе переменные записаны",
     "a = 4; b = 4;\nif (a == b) y = 1; else y = 2;",
     {"a": 4, "b": 4, "y": 1}),
]

# Негативные: компилятор обязан ОТКАЗАТЬ, а не скомпилировать мусор.
REJECTS = [
    ("константа вне восьмибитного типа", "y = 256;", "восьмибит"),
    ("деление не поддерживается генератором", "x = 10 / 2;", "деление"),
    ("пропущенная точка с запятой", "x = 1 y = 2;", "лексем"),
]


def data_region(gen, res):
    """Состояние памяти, которое имеет смысл сравнивать: область данных после кода."""
    return res["memory"][gen["code_len"]:gen["code_len"] + len(gen["data_rows"])]


def run():
    passed = failed = 0
    print("Эталонные тесты компилятора (занятие 2, блок 6):\n")

    for name, src, expected in TESTS:
        try:
            _, _, gen = compile_source(src)
            res = run_cpu8(gen["bytes"])
            if res["error"]:
                print(f"[ОШИБКА]  {name}: {res['error']}")
                failed += 1
                continue
            problems = []
            for var, want in expected.items():
                addr = gen["var_addrs"].get(var)
                if addr is None:
                    problems.append(f"переменная {var} не найдена в таблице имён")
                elif res["memory"][addr] != want:
                    problems.append(f"memory[{addr:02X}] ({var}) = {res['memory'][addr]}, ожидалось {want}")
            # переменные не должны лежать в области кода
            for var, addr in gen["var_addrs"].items():
                if addr < gen["code_len"]:
                    problems.append(f"переменная {var} по адресу {addr:02X} лежит в области кода — затирает программу")
            if problems:
                print(f"[ПАДЕНИЕ] {name}: {'; '.join(problems)}")
                failed += 1
            else:
                print(f"[ok]      {name}  ({gen['code_len']} байт кода, {res['steps']} шагов)")
                passed += 1
        except (ParseError, GenError) as e:
            print(f"[ОШИБКА]  {name}: {type(e).__name__}: {e}")
            failed += 1

    print("\nНегативные тесты (компилятор обязан отказаться):")
    for name, src, marker in REJECTS:
        try:
            compile_source(src)
            print(f"[ПАДЕНИЕ] {name}: ожидался отказ, а программа скомпилировалась")
            failed += 1
        except (ParseError, GenError) as e:
            if marker.lower() in str(e).lower():
                print(f"[ok]      {name}: отказ — {e}")
                passed += 1
            else:
                print(f"[ПАДЕНИЕ] {name}: отказ не по теме — {e}")
                failed += 1

    print(f"\nпройдено {passed}, провалено {failed}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(run())
