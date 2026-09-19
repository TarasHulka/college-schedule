#!/usr/bin/env python3
"""
Парсер розкладу занять коледжу з PDF (експорт Excel -> PDF) у JSON.

Проходить по всіх PDF у вхідній папці (кількість файлів довільна), витягує
таблиці через pdfplumber, і генерує:
  - data/lessons.json    — плаский нормалізований список занять (лише
    номер_пари, без конкретного часу — щоб зміна дзвінків не вимагала
    перегенерації розкладу)
  - data/groups.json     — відповідність "назва групи" -> "відділення"
  - data/pair_times.json — розклад дзвінків: номер_пари -> {початок, кінець}
    (найчастіше значення з PDF для цього номера пари)

Структура таблиці на сторінці (виявлена емпірично, підтверджена на 7 файлах):
  - Рядок 0: назви груп у комірках "Група NN XXX", по одній на кожен "блок".
  - Рядок 1: підзаголовки "Предмет"/"Викладач"/"Каб."(або "Ауд.").
  - Дані з рядка 2.
  - Один "блок" групи має колонки: [День?] Пара, Год., далі 3 або 6 колонок
    полів (Предмет[,Предмет_Б], Викладач[,Викладач_Б], Каб.[,Каб._Б]) —
    6 колонок, якщо десь у цьому блоці трапляється розділення на підгрупи.
  - Колонка "День" (вертикальний текст, символи у зворотному порядку) є
    лише в деяких блоках (як правило в першому на сторінці); якщо блок
    свою колонку дня не має — використовується "спільний" день, який
    визначається по першому блоку сторінки.
  - Чисельник/знаменник: два послідовних рядки з однаковим номером пари
    (другий рядок має порожні Пара/Год, бо об'єднані по вертикалі).
  - Підгрупи А/Б: два фізичні набори колонок (предмет/викладач/каб) в
    ОДНОМУ рядку. Позначка "(А)"/"(Б)" в тексті предмета має пріоритет
    над позицією колонки (в реальних даних вона іноді "плаває" між
    колонками від тижня до тижня — і чисельник, і знаменник можуть мати
    свою підгрупу).

Дані вводяться людиною в Excel і можуть містити помилки/неоднорідності
(регістр в назві відділення, дивні значення на кшталт "3\n-1" в колонці
пари) — парсер намагається якнайкраще впоратись з такими випадками, а не
падати.
"""
import argparse
import json
import re
import sys
from collections import OrderedDict
from pathlib import Path

import pdfplumber

CANONICAL_DAYS = ["Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця"]
SUBGROUP_SUFFIX_RE = re.compile(r"\(([АБ])\)\s*$")


def clean(value):
    """Прибирає переноси рядків і зайві пробіли з тексту комірки."""
    if value is None:
        return ""
    return re.sub(r"\s+", " ", value.replace("\n", " ")).strip()


def decode_day(raw):
    """Вертикальний текст дня тижня записаний символами в зворотному порядку.

    В деяких файлах pdfplumber видає кожен символ здвоєним (наприклад
    "КК\\nОО\\nЛЛ..." замість "К\\nО\\nЛ...", схоже на артефакт рендерингу
    конкретного PDF) — тому пробуємо і як є, і зі "склеєними" парами
    однакових символів."""
    if not raw:
        return None
    stripped = raw.replace("\n", "")
    candidates = [stripped, re.sub(r"(.)\1", r"\1", stripped)]
    for candidate in candidates:
        decoded = candidate[::-1].strip()
        for day in CANONICAL_DAYS:
            if decoded.casefold() == day.casefold():
                return day
    return None  # не день тижня (напр. заголовок "Дні") або нерозпізнаний текст


def first_int(raw):
    if not raw:
        return None
    m = re.search(r"\d+", raw)
    return int(m.group()) if m else None


def split_time_parts(raw_cells):
    """Збирає всі непорожні шматки часу з (можливо кількох) рядків шару
    та повертає (час_початку, час_кінця). Захищає від випадків, коли
    складач розклад помилково розбив "9:25\\n10:45" на два різні рядки."""
    parts = []
    for cell in raw_cells:
        if not cell:
            continue
        for piece in cell.split("\n"):
            piece = piece.strip()
            if piece:
                parts.append(piece)
    start = parts[0] if len(parts) >= 1 else ""
    end = parts[1] if len(parts) >= 2 else ""
    return start, end


def extract_subgroup(subject_raw):
    """Повертає (назва_предмету_без_суфікса, підгрупа_або_None)."""
    cleaned = clean(subject_raw)
    m = SUBGROUP_SUFFIX_RE.search(cleaned)
    if not m:
        return cleaned, None
    subgroup = m.group(1)
    subject = SUBGROUP_SUFFIX_RE.sub("", cleaned).strip()
    return subject, subgroup


def normalize_department(raw):
    return clean(raw).lower().capitalize()


def find_department(page_text):
    """Шукає рядок з назвою відділення в шапці сторінки.

    Деякі файли мають ще один рядок із словом "відділення" в підписі
    директора (напр. "груп економічного відділення _____ Ганна ШЕМЕЛЮК") —
    відсіюємо такі рядки (є підкреслення чи цифри) і, якщо кандидатів
    декілька, беремо останній: справжня назва відділення завжди йде
    безпосередньо перед таблицею груп."""
    candidates = []
    for line in page_text.split("\n")[:10]:
        lower = line.lower()
        if "відділення" not in lower:
            continue
        if "_" in line or any(ch.isdigit() for ch in line):
            continue
        candidates.append(line)
    if not candidates:
        return None
    return normalize_department(candidates[-1])


def detect_blocks(row0, data_rows, total_cols):
    """Знаходить усі блоки груп у першому рядку таблиці сторінки.

    Повертає список dict: group_name, group_col, para_col, time_col,
    day_col (або None), block_start.

    Колонку дня визначаємо не по тексту заголовка (він ненадійний — символи
    вертикального напису іноді переставлені місцями, а на деяких сторінках
    заголовок дня взагалі губиться при витягуванні таблиці), а по тому, чи
    декодується ХОЧ ОДНА комірка кандидатської колонки в даних як день тижня.
    """
    blocks = []
    for idx, cell in enumerate(row0):
        if cell and cell.strip().startswith("Група"):
            group_name = re.sub(r"^Група\s+", "", cell.strip())
            group_col = idx
            para_col = group_col - 2
            time_col = group_col - 1
            day_candidate = group_col - 3
            day_col = None
            if day_candidate >= 0 and any(
                decode_day(r[day_candidate] if day_candidate < len(r) else None) is not None
                for r in data_rows
            ):
                day_col = day_candidate
            block_start = day_col if day_col is not None else para_col
            if para_col < 0 or time_col < 0:
                print(f"  [!] пропускаю блок '{group_name}': некоректні індекси колонок", file=sys.stderr)
                continue
            blocks.append({
                "group_name": group_name,
                "group_col": group_col,
                "para_col": para_col,
                "time_col": time_col,
                "day_col": day_col,
                "block_start": block_start,
            })
    blocks.sort(key=lambda b: b["block_start"])
    for i, b in enumerate(blocks):
        next_start = blocks[i + 1]["block_start"] if i + 1 < len(blocks) else total_cols
        b["remaining_width"] = next_start - b["group_col"]
    return blocks


def slots_for_block(block):
    """Повертає список (predmet_col, vykl_col, kab_col) для кожного слоту
    (1 слот = без підгруп, 2 слоти = з підгрупами А/Б)."""
    remaining = block["remaining_width"]
    slots_count = max(1, remaining // 3)
    gc = block["group_col"]
    slots = []
    for k in range(slots_count):
        predmet_col = gc + k
        vykl_col = gc + slots_count + k
        kab_col = gc + 2 * slots_count + k
        slots.append((predmet_col, vykl_col, kab_col))
    return slots


def parse_page(page, department_fallback, warnings_ctx, pair_time_stats):
    text = page.extract_text() or ""
    department = find_department(text) or department_fallback
    table = page.extract_table()
    if not table or len(table) < 2:
        return [], {}
    row0 = table[0]
    total_cols = len(row0)
    data_rows = table[2:]
    blocks = detect_blocks(row0, data_rows, total_cols)
    if not blocks:
        return [], {}

    group_departments = {b["group_name"]: department for b in blocks}

    lessons = []

    primary_day_col = None
    for b in blocks:
        if b["day_col"] is not None:
            primary_day_col = b["day_col"]
            break

    global_day = None
    # стан на блок: поточний накопичуваний юніт (список рядків) і день на його початку
    block_state = {
        id(b): {"unit_rows": [], "unit_day": None, "own_day": None}
        for b in blocks
    }

    def flush_unit(b, state):
        rows = state["unit_rows"]
        if not rows:
            return
        para_raw = rows[0][b["para_col"]]
        para_num = first_int(para_raw)
        if para_num is None:
            state["unit_rows"] = []
            return
        start_time, end_time = split_time_parts([r[b["time_col"]] for r in rows])
        if start_time and end_time:
            times_for_pair = pair_time_stats.setdefault(para_num, {})
            key = (start_time, end_time)
            times_for_pair[key] = times_for_pair.get(key, 0) + 1
        slots = slots_for_block(b)
        layers_count = len(rows)

        def week_for_layer(idx):
            if layers_count == 1:
                return "кожен"
            if layers_count == 2:
                return "чисельник" if idx == 0 else "знаменник"
            warnings_ctx.append(
                f"група {b['group_name']}: незвична кількість підрядків "
                f"({layers_count}) для пари {para_num} ({state['unit_day']})"
            )
            return "кожен"

        unit_entries = []  # (layer_idx, subject, subgroup, teacher, room)
        for layer_idx, r in enumerate(rows):
            layer_values = []
            for slot_idx, (predmet_col, vykl_col, kab_col) in enumerate(slots):
                subject, subgroup = extract_subgroup(r[predmet_col] if predmet_col < len(r) else None)
                if not subject:
                    layer_values.append(None)
                    continue
                teacher = clean(r[vykl_col]) if vykl_col < len(r) else ""
                room = clean(r[kab_col]) if kab_col < len(r) else ""
                layer_values.append((subject, subgroup, teacher, room))
            # позиційна підгрупа А/Б, якщо суфікс відсутній, але обидва слоти
            # в цьому шарі заповнені одночасно (справжній паралельний поділ)
            if len(slots) == 2 and layer_values[0] and layer_values[1]:
                for slot_idx in (0, 1):
                    subject, subgroup, teacher, room = layer_values[slot_idx]
                    if subgroup is None:
                        subgroup = "А" if slot_idx == 0 else "Б"
                        layer_values[slot_idx] = (subject, subgroup, teacher, room)
            for lv in layer_values:
                if lv is not None:
                    unit_entries.append((layer_idx, *lv))

        # чисельник/знаменник тієї самої пари іноді повторює предмет лише зі
        # зміненою підгрупою, не дублюючи викладача/аудиторію — підтягуємо їх
        # з іншого рядка того самого юніту з такою ж назвою предмета.
        by_subject = {}
        for _, subject, _, teacher, room in unit_entries:
            key = subject.casefold()
            if teacher and room:
                by_subject.setdefault(key, (teacher, room))
        filled_entries = []
        for layer_idx, subject, subgroup, teacher, room in unit_entries:
            if not (teacher and room):
                fallback = by_subject.get(subject.casefold())
                if fallback:
                    teacher = teacher or fallback[0]
                    room = room or fallback[1]
            filled_entries.append((layer_idx, subject, subgroup, teacher, room))

        for layer_idx, subject, subgroup, teacher, room in filled_entries:
            lessons.append({
                "група": b["group_name"],
                "день": state["unit_day"],
                "номер_пари": para_num,
                "тиждень": week_for_layer(layer_idx),
                "підгрупа": subgroup,
                "предмет": subject,
                "викладач": teacher,
                "аудиторія": room,
            })
        state["unit_rows"] = []

    for row in data_rows:
        if primary_day_col is not None:
            cell = row[primary_day_col] if primary_day_col < len(row) else None
            decoded = decode_day(cell)
            if decoded:
                global_day = decoded

        for b in blocks:
            state = block_state[id(b)]
            if b["day_col"] is not None:
                cell = row[b["day_col"]] if b["day_col"] < len(row) else None
                decoded = decode_day(cell)
                if decoded:
                    state["own_day"] = decoded

            effective_day = state["own_day"] if b["day_col"] is not None else global_day

            # день змінився, поки юніт лишався "відкритим" (нова денна секція
            # почалась з порожньої клітинки "Пара" для цього блоку) — закриваємо
            # незавершений юніт, інакше дані наступного дня приліпляться до
            # попередньої пари.
            if (
                state["unit_rows"]
                and effective_day is not None
                and state["unit_day"] is not None
                and effective_day != state["unit_day"]
            ):
                flush_unit(b, state)

            para_col = b["para_col"]
            para_raw = row[para_col] if para_col < len(row) else None

            if para_raw and str(para_raw).strip():
                flush_unit(b, state)
                state["unit_day"] = effective_day
                state["unit_rows"] = [row]
            elif state["unit_rows"]:
                state["unit_rows"].append(row)

    for b in blocks:
        flush_unit(b, block_state[id(b)])

    return lessons, group_departments


def parse_pdf(path, warnings_ctx, pair_time_stats):
    lessons = []
    departments = {}
    with pdfplumber.open(path) as pdf:
        for page_idx, page in enumerate(pdf.pages):
            try:
                page_lessons, page_departments = parse_page(page, None, warnings_ctx, pair_time_stats)
            except Exception as exc:  # noqa: BLE001
                warnings_ctx.append(f"{path.name} стор.{page_idx}: помилка парсингу — {exc}")
                continue
            lessons.extend(page_lessons)
            for group, dept in page_departments.items():
                if dept is None:
                    continue
                if group in departments and departments[group] != dept:
                    warnings_ctx.append(
                        f"конфлікт відділення для групи '{group}': "
                        f"'{departments[group]}' vs '{dept}' ({path.name} стор.{page_idx})"
                    )
                else:
                    departments[group] = dept
    return lessons, departments


def teacher_dedupe_key(name):
    """Ключ для об'єднання варіантів написання того самого викладача
    (напр. "Гулка Т.Б." і "Гулка Т.Б" — пропущена крапка в кінці)."""
    return re.sub(r"[.\s]", "", name).casefold()


def normalize_teacher_names(lessons):
    variants = {}  # dedupe_key -> Counter(варіант написання -> кількість)
    for l in lessons:
        name = l["викладач"]
        if not name:
            continue
        key = teacher_dedupe_key(name)
        variants.setdefault(key, {})
        variants[key][name] = variants[key].get(name, 0) + 1

    canonical = {}
    for key, counts in variants.items():
        # найчастіший варіант; за рівності — той, що закінчується крапкою (повніший запис)
        best = sorted(counts.items(), key=lambda kv: (-kv[1], not kv[0].endswith(".")))[0][0]
        canonical[key] = best

    for l in lessons:
        name = l["викладач"]
        if name:
            l["викладач"] = canonical[teacher_dedupe_key(name)]


def day_sort_key(day):
    try:
        return CANONICAL_DAYS.index(day)
    except ValueError:
        return len(CANONICAL_DAYS)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", default="PDF_Source", help="папка з PDF-файлами розкладу")
    parser.add_argument("--output-dir", default="data", help="папка для JSON-виводу")
    args = parser.parse_args()

    input_dir = Path(args.input_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    pdf_files = sorted(input_dir.glob("*.pdf"))
    if not pdf_files:
        print(f"Не знайдено PDF-файлів у {input_dir}", file=sys.stderr)
        sys.exit(1)

    all_lessons = []
    all_departments = {}
    warnings_ctx = []
    pair_time_stats = {}  # номер_пари -> {(початок, кінець): кількість}

    for pdf_path in pdf_files:
        print(f"Обробляю {pdf_path.name}...")
        lessons, departments = parse_pdf(pdf_path, warnings_ctx, pair_time_stats)
        all_lessons.extend(lessons)
        for group, dept in departments.items():
            if group in all_departments and all_departments[group] != dept:
                warnings_ctx.append(
                    f"конфлікт відділення для групи '{group}' між файлами: "
                    f"'{all_departments[group]}' vs '{dept}' ({pdf_path.name})"
                )
            else:
                all_departments[group] = dept

    normalize_teacher_names(all_lessons)
    all_lessons.sort(key=lambda l: (l["група"], day_sort_key(l["день"]), l["номер_пари"] or 0))

    groups_sorted = OrderedDict(sorted(all_departments.items()))

    # Час пар — окремо від занять (data/pair_times.json), щоб зміну дзвінків
    # можна було внести в одному місці, не перегенеровуючи розклад. Береться
    # найчастіше значення з PDF для кожного номера пари.
    pair_times = OrderedDict()
    for pair_num in sorted(pair_time_stats):
        counts = pair_time_stats[pair_num]
        (start, end), _ = max(counts.items(), key=lambda kv: kv[1])
        pair_times[str(pair_num)] = {"початок": start, "кінець": end}

    lessons_path = output_dir / "lessons.json"
    groups_path = output_dir / "groups.json"
    pair_times_path = output_dir / "pair_times.json"
    lessons_path.write_text(json.dumps(all_lessons, ensure_ascii=False, indent=2), encoding="utf-8")
    groups_path.write_text(json.dumps(groups_sorted, ensure_ascii=False, indent=2), encoding="utf-8")
    pair_times_path.write_text(json.dumps(pair_times, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\nЗанять: {len(all_lessons)}")
    print(f"Груп: {len(groups_sorted)}")
    teachers = sorted({l["викладач"] for l in all_lessons if l["викладач"]})
    print(f"Викладачів: {len(teachers)}")
    print(f"Записано у {lessons_path}, {groups_path} та {pair_times_path}")

    if warnings_ctx:
        print(f"\n[!] Попередження ({len(warnings_ctx)}):", file=sys.stderr)
        for w in warnings_ctx:
            print(f"  - {w}", file=sys.stderr)


if __name__ == "__main__":
    main()
