#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mini — компилятор мини-языка (итог занятия 2): текст → байты TinyCPU-8 → выполнение.

Конвейер ровно тот, что студент собирает на занятии 2, границы модулей —
по решениям (Тема 2):

  текст → [лексер, занятие 1]      → токены
        → [парсер, занятие 2]      → AST  (рукописный спуск, левая рекурсия → цикл)
        → [генератор, занятие 2]   → байты TinyCPU-8 (PUSH/POP, адрес вперёд)
        → [эмулятор]               → состояние памяти  (порт эталонного tinycpu.py)

Использование:

  python3 mini_compile.py program.mini          # листинг для tinycpu-web + байты
  python3 mini_compile.py --run program.mini    # + выполнение на встроенном эмуляторе
  python3 mini_compile.py --listing program.mini  # только листинг (копировать в tinycpu-web)
  python3 mini_compile.py --bytes program.mini  # только байты (hex)
  cat program.mini | python3 mini_compile.py --run -   # с stdin

Код возврата: 0 — скомпилировано (и выполнено, если --run); 1 — ошибка
лексера/парсера/генератора (с позицией) или падение на эмуляторе.

Зачем не bison: ./mini-lang из занятия 3 — распознаватель, им и сравнивают
парсеры; генератор переиспользуется (см. README). Этот скрипт — рукописная
ветка конвейера, та самая, что студент пишет сам.
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from zanyatie2_parser_codegen import compile_source, run_cpu8, ParseError, GenError


def die(msg, code=1):
    print(msg, file=sys.stderr)
    sys.exit(code)


def plural(n, one, few, many):
    m10, m100 = n % 10, n % 100
    if m10 == 1 and m100 != 11:
        return one
    if 2 <= m10 <= 4 and (m100 < 12 or m100 > 14):
        return few
    return many


def main():
    ap = argparse.ArgumentParser(
        prog="mini_compile.py",
        description="компилятор мини-языка: лексер → парсер → генератор → эмулятор TinyCPU-8",
        epilog="эталоны листингов совпадают с веб-лабораторией побайтово (etalon-js.json)")
    ap.add_argument("source", help="файл программы на мини-языке, или - для stdin")
    ap.add_argument("--run", action="store_true", help="выполнить на встроенном эмуляторе")
    ap.add_argument("--listing", action="store_true", help="только листинг для tinycpu-web")
    ap.add_argument("--bytes", action="store_true", help="только байты (hex)")
    ap.add_argument("--strict-numbers", dest="strict", action="store_true", default=True,
                    help="12abc — ошибка лексера (по умолчанию)")
    ap.add_argument("--no-strict-numbers", dest="strict", action="store_false",
                    help="12abc — два токена (альтернативное решение занятия 1)")
    ap.add_argument("--comments", action="store_true", help="разрешить комментарии // и /* */ (домашка)")
    ap.add_argument("--max-steps", type=int, default=500000, help="лимит шагов эмулятора (защита от вечного цикла)")
    args = ap.parse_args()

    if args.source == "-":
        src = sys.stdin.read()
    else:
        try:
            with open(args.source, encoding="utf-8") as f:
                src = f.read()
        except OSError as e:
            die(f"не могу прочитать {args.source}: {e}")

    # 1–3: лексер → парсер → генератор (ошибки — с позицией, сюжет занятия 2)
    try:
        lx, ast, gen = compile_source(src, strict_numbers=args.strict, comments=args.comments)
    except ParseError as e:
        die(f"ошибка разбора: {e}")
    except GenError as e:
        die(f"ошибка генерации: {e}")

    for w in lx.errors:
        print(f"предупреждение лексера: {w[0]}:{w[1]} — {w[2]}", file=sys.stderr)
    for w in gen["warnings"]:
        print(f"предупреждение: {w}", file=sys.stderr)

    if args.bytes:
        print(" ".join(f"{b:02X}" for b in gen["bytes"]))
        return 0
    if args.listing:
        print(gen["listing"])
        return 0

    # 4: выполнение (если запрошено)
    res = None
    if args.run:
        res = run_cpu8(gen["bytes"], max_steps=args.max_steps)

    print(gen["listing"])
    print()
    print(f"байты ({len(gen['bytes'])}): " + " ".join(f"{b:02X}" for b in gen["bytes"]))
    if res is None:
        print("\n(для выполнения: --run; для запуска на своей машине: скопируйте листинг на tinycpu-web)")
        return 0
    if res["error"]:
        die(f"падение на эмуляторе: {res['error']}")
    print(f"\nвыполнено: halted за {res['steps']} {plural(res['steps'], 'шаг', 'шага', 'шагов')}"
          f" · A={res['a']} · PC={res['pc']:02X} · SP={res['sp']:02X}")
    vars_out = {n: res["memory"][a] for n, a in gen["var_addrs"].items()}
    if vars_out:
        print("переменные: " + ", ".join(f"{n}={v}" for n, v in vars_out.items()))
    else:
        print("переменных в программе нет")
    return 0


if __name__ == "__main__":
    sys.exit(main())
