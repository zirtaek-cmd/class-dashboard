"""교사별 주간시간표 PDF → 시간표 확인 창 업로드용 JSON 변환기.

사용법: python3 tools/timetable_pdf_to_json.py <주간시간표.pdf> <출력.json>

- PDF 1행=요일, 2행=교시, 3행부터 교사(A열 "이름(시수)"), 칸은 "반\n과목" 형식이다.
- 출력 JSON은 교사 실명이 들어가므로 저장소(공개)에 커밋하지 말 것.
  admin/timetable.html의 [기본 시간표 올리기]로 Firestore(교사 전용)에 올린다.
"""
import json
import re
import sys

import pdfplumber


def convert(pdf_path):
    with pdfplumber.open(pdf_path) as pdf:
        table = pdf.pages[0].extract_tables()[0]

    day_row, period_row = table[0], table[1]
    slots = []
    day = None
    for col in range(1, len(period_row)):
        if day_row[col]:
            day = day_row[col].strip()
        slots.append(f"{day}{period_row[col].strip()}")

    teachers = []
    for row in table[2:]:
        label = (row[0] or "").replace("\n", "").strip()
        if not label:
            continue
        name = re.sub(r"\(.*$", "", label).strip()
        lessons = {}
        for slot, cell in zip(slots, row[1:]):
            if not cell or not cell.strip():
                continue
            parts = [p.strip() for p in cell.split("\n") if p.strip()]
            lessons[slot] = {"cls": parts[0][:3], "subj": "".join(parts[1:])}
        teachers.append({
            "name": name,
            "label": label,
            "restricted": bool(re.search(r"겸임|강사", label)),
            "lessons": lessons,
        })
    return {"slots": slots, "teachers": teachers}


if __name__ == "__main__":
    src, out = sys.argv[1], sys.argv[2]
    data = convert(src)
    data["source"] = src.rsplit("/", 1)[-1]
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print(f"{len(data['teachers'])}명, {len(data['slots'])}칸 → {out}")
