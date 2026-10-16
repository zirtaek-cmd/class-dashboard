// 시간표 확인 창의 판정 로직 (DOM 없음, 브라우저·node 공용).
// 기준 시간표(PDF에서 변환한 교사별 시간표)와 나이스 시간표를 비교해
// 교사별 실제 시간표를 만들고, 교체 후보를 찾는다.
// 우선순위: data/makeup-timetable.json 보정 > 나이스 > 기준 시간표.

// PDF 과목명 → 나이스 과목명 (8/10~10/16 나이스 실데이터 대조로 확정)
export const NEIS_NAME = {
  "가정": "기술·가정", "기술": "기술·가정",
  "과학A": "과학", "과학B": "과학",
  "국어A": "국어",
  "수학A": "수학", "수학B": "수학",
  "영어A": "영어", "영어B": "영어",
  "체육A": "체육", "체육B": "체육",
  "동아리": "동아리활동", "스클": "동아리활동",
  "인공": "인공지능과 생활",
  "진로": "진로와 직업",
  "창진": "진로활동",
};

// 교체 대상에서 빼는 수업 (교사 엑셀 매크로 규칙 + 스클·창진)
export const EXCLUDE_WORDS = ["주제", "진탐", "동아", "스포", "스클", "창진"];

export const DAYS = ["월", "화", "수", "목", "금"];

export function neisName(subj) {
  return NEIS_NAME[subj] ?? subj;
}

export function isExcludedSubject(subj) {
  return EXCLUDE_WORDS.some((w) => subj.includes(w));
}

// "303" ↔ "3-3"
export function clsToClassId(cls) {
  return `${cls[0]}-${Number(cls.slice(1))}`;
}

function ymdToIso(ymd) {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

function slotKey(ymd, per) {
  return `${ymd}|${per}`;
}

// 학사일정 행 → 날짜별 상태. holiday > exam > (나이스 없음) nodata > normal
export function buildDayStatus(weekYmds, scheduleRows, neisRows) {
  const hasNeis = new Set(neisRows.map((r) => r.ALL_TI_YMD));
  const status = {};
  weekYmds.forEach((ymd) => {
    const events = scheduleRows.filter((r) => r.AA_YMD === ymd);
    const holiday = events.find((r) => r.SBTR_DD_SC_NM === "공휴일" || r.SBTR_DD_SC_NM === "휴업일");
    const exam = events.find((r) => /고사|시험/.test(r.EVENT_NM));
    if (holiday) status[ymd] = { type: "holiday", label: holiday.EVENT_NM };
    else if (exam) status[ymd] = { type: "exam", label: exam.EVENT_NM };
    else if (!hasNeis.has(ymd)) status[ymd] = { type: "nodata", label: "나이스 미등록" };
    else status[ymd] = { type: "normal", label: "" };
  });
  return status;
}

// 반·날짜·교시의 실제 과목 (보정 > 나이스). 없으면 undefined
function makeActualLookup(neisRows, makeup) {
  const neis = new Map();
  neisRows.forEach((r) => {
    neis.set(`${r.GRADE}0${r.CLASS_NM}|${r.ALL_TI_YMD}|${r.PERIO}`, (r.ITRT_CNTNT || "").trim());
  });
  return (cls, ymd, per) => {
    const fix = makeup?.[ymdToIso(ymd)]?.[clsToClassId(cls)]?.[per];
    if (fix) return neisName(fix.trim());
    return neis.get(`${cls}|${ymd}|${per}`);
  };
}

// 교사별 실제 시간표 계산.
// 반환: { [teacherName]: { [ymd|per]: cell[] } }
//   cell.state: kept | gone | moved-in | added | base (시험·휴일·나이스 미등록일)
//   cell.cls, cell.subj(기준 시간표 과목명), cell.neis(gone일 때 나이스 과목),
//   cell.from / cell.to (짝지어진 원래/옮겨 간 칸), cell.ambiguous(후보 교사 목록)
// 겸임·강사(restricted) 수업은 고정이라 변동이 없다: 항상 유지로 두고 교체 주인 후보에서도 뺀다.
export function computeWeek(base, weekYmds, neisRows, makeup, dayStatus) {
  const actual = makeActualLookup(neisRows, makeup);
  const result = {};
  const put = (name, ymd, per, cell) => {
    const key = slotKey(ymd, per);
    ((result[name] ??= {})[key] ??= []).push(cell);
  };

  // 반·요일교시 → 기준 시간표의 수업 주인
  const ownerByClassSlot = new Map();
  base.teachers.forEach((t) => {
    Object.entries(t.lessons).forEach(([slot, l]) => {
      ownerByClassSlot.set(`${l.cls}|${slot}`, { teacher: t, subj: l.subj });
    });
  });

  // 1) 기준 수업마다 유지/사라짐 판정
  const gone = new Map(); // `${cls}|${neisSubj}` → [{teacher, cell}]
  base.teachers.forEach((t) => {
    Object.entries(t.lessons).forEach(([slot, l]) => {
      const ymd = weekYmds[DAYS.indexOf(slot[0])];
      const per = slot.slice(1);
      if (dayStatus[ymd].type !== "normal") {
        put(t.name, ymd, per, { state: "base", cls: l.cls, subj: l.subj });
        return;
      }
      const a = actual(l.cls, ymd, per);
      if (t.restricted || a === neisName(l.subj)) {
        put(t.name, ymd, per, { state: "kept", cls: l.cls, subj: l.subj });
        return;
      }
      const cell = { state: "gone", cls: l.cls, subj: l.subj, neis: a ?? "", ymd, per };
      put(t.name, ymd, per, cell);
      const k = `${l.cls}|${neisName(l.subj)}`;
      (gone.get(k) ?? gone.set(k, []).get(k)).push({ teacher: t, cell });
    });
  });

  // 2) 반별로 원래와 다른 과목이 들어온 칸 → 그 과목 교사의 수업이 옮겨 온 곳
  const classes = [...new Set(base.teachers.flatMap((t) => Object.values(t.lessons).map((l) => l.cls)))];
  const appeared = new Map(); // `${cls}|${neisSubj}` → [{ymd, per}]
  classes.forEach((cls) => {
    weekYmds.forEach((ymd, di) => {
      if (dayStatus[ymd].type !== "normal") return;
      for (let p = 1; p <= 7; p++) {
        const per = String(p);
        const a = actual(cls, ymd, per);
        if (!a) continue;
        const owner = ownerByClassSlot.get(`${cls}|${DAYS[di]}${per}`);
        if (owner && (owner.teacher.restricted || neisName(owner.subj) === a)) continue;
        const k = `${cls}|${a}`;
        (appeared.get(k) ?? appeared.set(k, []).get(k)).push({ ymd, per });
      }
    });
  });

  appeared.forEach((slots, k) => {
    const [cls, subj] = k.split("|");
    // 이 반에서 이 나이스 과목을 가르치는 교사(기준 시간표)
    const teachers = base.teachers.filter((t) =>
      !t.restricted && Object.values(t.lessons).some((l) => l.cls === cls && neisName(l.subj) === subj)
    );
    if (teachers.length === 0) return; // 행사·자습 등 주인 없는 칸
    const goneList = gone.get(k) ?? [];
    const goneTeachers = [...new Set(goneList.map((g) => g.teacher))];
    // 주인 = 그 주에 이 반에서 같은 과목 수업이 사라진 교사. 없으면 보강(추가됨).
    // 후보가 둘 이상이면(기술/가정, 분반 A/B 등) 판단 불가로 표시한다.
    slots.forEach(({ ymd, per }) => {
      // 한 교사가 같은 시간에 두 반에 들어갈 수 없으므로 그 시간에 이미 수업이 있는 교사는 뺀다
      const free = (t) => !activeLesson(result, t.name, ymd, per);
      const freeGone = goneTeachers.filter(free);
      const freeAll = teachers.filter(free);
      const owners = freeGone.length ? freeGone : freeAll.length ? freeAll : goneTeachers.length ? goneTeachers : teachers;
      const ambiguous = owners.length > 1 ? owners.map((t) => t.name) : null;
      owners.forEach((t) => {
        const lesson = Object.values(t.lessons).find((l) => l.cls === cls && neisName(l.subj) === subj);
        const match = ambiguous ? null : goneList.find((g) => g.teacher === t && !g.cell.to);
        const cell = {
          state: match || (ambiguous && goneTeachers.some((g) => owners.includes(g))) ? "moved-in" : "added",
          cls, subj: lesson.subj, ymd, per, ambiguous,
        };
        if (match) {
          match.cell.to = { ymd, per };
          cell.from = { ymd: match.cell.ymd, per: match.cell.per };
        }
        put(t.name, ymd, per, cell);
      });
    });
  });

  return result;
}

// 그 칸에 수업이 있는지 (사라진 수업은 빈 시간으로 본다)
export function isBusy(week, name, ymd, per) {
  return (week[name]?.[slotKey(ymd, per)] ?? []).some((c) => c.state !== "gone");
}

// 그날 최대 연속 수업 시간 수. add/remove로 교체 후 상태를 미리 계산한다.
export function maxConsecutive(week, name, ymd, add = null, remove = null) {
  let best = 0;
  let run = 0;
  for (let p = 1; p <= 7; p++) {
    const per = String(p);
    let busy = isBusy(week, name, ymd, per);
    if (remove && remove.ymd === ymd && remove.per === per) busy = false;
    if (add && add.ymd === ymd && add.per === per) busy = true;
    run = busy ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

// 실제로 그 칸에서 하는 수업 (사라진 것·판단 불가 제외)
export function activeLesson(week, name, ymd, per) {
  return (week[name]?.[slotKey(ymd, per)] ?? [])
    .find((c) => (c.state === "kept" || c.state === "moved-in" || c.state === "added") && !c.ambiguous);
}

// 교체 후보 찾기 (교사 엑셀 매크로 규칙을 그 주 실제 시간표로 적용)
// 반환: { reason } (선택 불가) 또는 { candidates: [{teacher, ymd, per, cls, subj}] }
export function findSwapCandidates(base, week, dayStatus, me, ymd1, per1, todayYmd) {
  const mine = activeLesson(week, me, ymd1, per1);
  if (!mine) return { reason: "이 칸에는 실제로 하는 수업이 없습니다." };
  if (dayStatus[ymd1].type !== "normal") return { reason: `${dayStatus[ymd1].label} 날은 교체할 수 없습니다.` };
  if (ymd1 < todayYmd) return { reason: "지난 수업은 교체할 수 없습니다." };
  if (isExcludedSubject(mine.subj)) return { reason: `${mine.subj} 수업은 교체 대상이 아닙니다.` };

  const candidates = [];
  base.teachers.forEach((t) => {
    if (t.name === me || t.restricted) return;
    Object.entries(week[t.name] ?? {}).forEach(([key, cells]) => {
      const [ymd2, per2] = key.split("|");
      if (ymd2 === ymd1 && per2 === per1) return;
      if (ymd2 < todayYmd || dayStatus[ymd2].type !== "normal") return;
      const theirs = cells.find((c) => (c.state === "kept" || c.state === "moved-in" || c.state === "added") && !c.ambiguous);
      if (!theirs || theirs.cls !== mine.cls || isExcludedSubject(theirs.subj)) return;
      if (isBusy(week, t.name, ymd1, per1)) return;
      if (isBusy(week, me, ymd2, per2)) return;
      // 상대가 교체로 그날 몇 시간 연강이 되는지 (상대 부담 확인용)
      const add = { ymd: ymd1, per: per1 };
      const remove = { ymd: ymd2, per: per2 };
      const runAfter = maxConsecutive(week, t.name, ymd1, add, remove);
      const runBefore = maxConsecutive(week, t.name, ymd1);
      candidates.push({ teacher: t.name, ymd: ymd2, per: per2, cls: theirs.cls, subj: theirs.subj, runAfter, runBefore });
    });
  });
  candidates.sort((a, b) => (a.ymd + a.per).localeCompare(b.ymd + b.per) || a.teacher.localeCompare(b.teacher));
  return { lesson: mine, candidates };
}
