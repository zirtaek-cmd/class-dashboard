import { db, auth } from "../firebase-config.js";
import { initializeApp, getApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  onSnapshot,
  collection,
  query,
  orderBy,
  deleteDoc,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// 관리자 페이지 iframe 미리보기 안에서 실행 중이면, 부모 창(admin)의
// Google 로그인 세션과 sessionStorage를 공유하지 않도록 별도 이름의
// 보조 Firebase 앱 인스턴스를 만들어 그 인스턴스의 auth/db를 사용한다.
// 단독 탭(칠판)에서 열릴 때는 지금까지와 동일하게 기본 인스턴스를 쓴다.
const isEmbedded = window.self !== window.top;
let activeDb = db;
let activeAuth = auth;
if (isEmbedded) {
  const previewApp = initializeApp(getApp().options, "preview-" + Date.now());
  activeAuth = getAuth(previewApp);
  activeDb = getFirestore(previewApp);
}

const NEIS_KEY = "df0637bd4e434069b21d160875ff44bd";
const ATPT_OFCDC_SC_CODE = "Q10";
const SD_SCHUL_CODE = "8552013";
const OWM_KEY = "0ffabe6cd62ba95ab50a32e4f6e9872f";
const WEATHER_QUERY = "Gwangyang,KR";

const CLASS_ID_KEY = "classId";
const WEATHER_CACHE_KEY = "weatherCache";
const WEATHER_CACHE_MS = 60 * 60 * 1000;

const WEEKDAY_KO_FULL = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];
function todayWeekdayKo() {
  return WEEKDAY_KO_FULL[new Date().getDay()];
}

let regularTimetableCache = null;
async function loadRegularTimetable() {
  if (regularTimetableCache) return regularTimetableCache;
  try {
    const res = await fetch("../data/regular-timetable.json");
    regularTimetableCache = await res.json();
  } catch (err) {
    regularTimetableCache = {};
  }
  return regularTimetableCache;
}

// 보강/시간표 변경 데이터: { "YYYY-MM-DD": { "학년-반": { "교시": "과목" } } }
// 해당 날짜·반·교시에 값이 있으면 NEIS 실시간 데이터보다 우선해서 그 과목으로 표시한다.
// 표에 없는 나머지 교시는 그대로 NEIS 데이터를 사용한다.
let makeupTimetableCache = null;
async function loadMakeupTimetable() {
  if (makeupTimetableCache) return makeupTimetableCache;
  try {
    const res = await fetch("../data/makeup-timetable.json");
    makeupTimetableCache = await res.json();
  } catch (err) {
    makeupTimetableCache = {};
  }
  return makeupTimetableCache;
}

function getUrlClassId() {
  return new URLSearchParams(location.search).get("classId");
}

function getStoredClassId() {
  return localStorage.getItem(CLASS_ID_KEY);
}

function setStoredClassId(classId) {
  localStorage.setItem(CLASS_ID_KEY, classId);
}

function clearStoredClassId() {
  localStorage.removeItem(CLASS_ID_KEY);
}

function todayYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function todayIso() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function weekRangeYmd() {
  const now = new Date();
  const mondayOffset = now.getDay() === 0 ? -6 : 1 - now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() + mondayOffset);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = (d) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return { from: fmt(monday), to: fmt(sunday) };
}

function showClassSelectScreen() {
  document.getElementById("class-select-screen").hidden = false;
  document.getElementById("dashboard").hidden = true;
}

function showDashboard() {
  document.getElementById("class-select-screen").hidden = true;
  document.getElementById("dashboard").hidden = false;
}

function initClassSelect() {
  document.querySelectorAll(".class-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      setStoredClassId(btn.dataset.classId);
      enterDashboard(btn.dataset.classId);
    });
  });
  document.getElementById("change-class-btn").addEventListener("click", () => {
    clearStoredClassId();
    showClassSelectScreen();
  });
}

let weatherIntervalId = null;
let unsubscribeNoticeFns = [];
let unsubscribeCalls = null;
let unsubscribeBoardFns = [];

function enterDashboard(classId) {
  showDashboard();
  fetchMeal();
  fetchSchedule();
  fetchTimetable(classId);
  fetchWeather();
  if (weatherIntervalId) clearInterval(weatherIntervalId);
  weatherIntervalId = setInterval(fetchWeather, WEATHER_CACHE_MS);
  startDateTimeClock();
  signInAnonymously(activeAuth).catch(() => {});
  unsubscribeNoticeFns.forEach((fn) => fn());
  unsubscribeNoticeFns = subscribeNotice(classId);
  if (unsubscribeCalls) unsubscribeCalls();
  unsubscribeCalls = subscribeCalls(classId);
  unsubscribeBoardFns.forEach((fn) => fn());
  unsubscribeBoardFns = subscribeBoard(classId);
}

async function fetchMeal() {
  const container = document.querySelector("#meal .content");
  try {
    const url = `https://open.neis.go.kr/hub/mealServiceDietInfo?KEY=${NEIS_KEY}&Type=json&ATPT_OFCDC_SC_CODE=${ATPT_OFCDC_SC_CODE}&SD_SCHUL_CODE=${SD_SCHUL_CODE}&MLSV_YMD=${todayYmd()}`;
    const res = await fetch(url);
    const data = await res.json();
    const rows = data?.mealServiceDietInfo?.[1]?.row;
    if (!rows || rows.length === 0) {
      container.textContent = "오늘 급식 정보가 없습니다.";
      return;
    }
    container.innerHTML = rows[0].DDISH_NM.split(/<br\s*\/?>/i)
      .map((line) => `<div>${line.replace(/\([^)]*\)/g, "").trim()}</div>`)
      .join("");
  } catch (err) {
    container.textContent = "급식 정보를 불러오지 못했습니다.";
  }
}

async function fetchSchedule() {
  const container = document.querySelector("#timetable-calendar .calendar-half .content");
  try {
    const { from, to } = weekRangeYmd();
    const url = `https://open.neis.go.kr/hub/SchoolSchedule?KEY=${NEIS_KEY}&Type=json&ATPT_OFCDC_SC_CODE=${ATPT_OFCDC_SC_CODE}&SD_SCHUL_CODE=${SD_SCHUL_CODE}&AA_FROM_YMD=${from}&AA_TO_YMD=${to}`;
    const res = await fetch(url);
    const data = await res.json();
    const rows = data?.SchoolSchedule?.[1]?.row;
    if (!rows || rows.length === 0) {
      container.textContent = "이번 주 학사일정이 없습니다.";
      return;
    }
    container.innerHTML = rows
      .map((row) => `<div>${row.AA_YMD.slice(4, 6)}/${row.AA_YMD.slice(6, 8)} ${row.EVENT_NM}</div>`)
      .join("");
  } catch (err) {
    container.textContent = "학사일정을 불러오지 못했습니다.";
  }
}

// 나이스는 기술과 가정을 "기술·가정" 한 이름으로 주므로, 정규 시간표(기술/가정 구분)로 어느 쪽인지 추정한다.
// ① 정규 시간표의 기술·가정 칸이면 그 과목 ② 옮겨 온 칸이면 이번 주에 빠진 기술·가정 칸의 과목
// ③ 그래도 모르면 그 반 정규 시간표에 더 많은 과목. (8/18~10/19 실제 시간표 채점 225칸 중 222칸 맞음,
// 틀린 3칸은 기술·가정 선생님끼리 바꾼 날이라 나이스로는 알 수 없음)
const TECH_HOME = "기술·가정";
const TECH_HOME_KINDS = ["기술", "가정"];
let weekTimetableCache = { key: null, rows: null };

async function loadWeekTimetable(classId) {
  const { from, to } = weekRangeYmd();
  const key = `${classId}|${from}`;
  if (weekTimetableCache.key === key) return weekTimetableCache.rows;
  const [grade, classNm] = classId.split("-");
  const url = `https://open.neis.go.kr/hub/misTimetable?KEY=${NEIS_KEY}&Type=json&pSize=100&ATPT_OFCDC_SC_CODE=${ATPT_OFCDC_SC_CODE}&SD_SCHUL_CODE=${SD_SCHUL_CODE}&GRADE=${grade}&CLASS_NM=${classNm}&TI_FROM_YMD=${from}&TI_TO_YMD=${to}`;
  const res = await fetch(url);
  const data = await res.json();
  const rows = data?.misTimetable?.[1]?.row || [];
  weekTimetableCache = { key, rows };
  return rows;
}

async function guessTechHome(classId, period, regularTimetable, makeupTimetable) {
  const regularForClass = regularTimetable[classId] || {};
  const regularHere = ((regularForClass[todayWeekdayKo()] || {})[String(period)] ?? "").trim();
  if (TECH_HOME_KINDS.includes(regularHere)) return regularHere;

  const count = { 기술: 0, 가정: 0 };
  Object.values(regularForClass).forEach((byPer) =>
    Object.values(byPer).forEach((subj) => {
      if (subj in count) count[subj]++;
    })
  );
  const majority = count.기술 >= count.가정 ? "기술" : "가정";
  if (!count.기술 || !count.가정) return count.기술 || count.가정 ? majority : TECH_HOME;

  try {
    const rows = await loadWeekTimetable(classId);
    const byDay = {};
    rows.forEach((row) => {
      (byDay[row.ALL_TI_YMD] ??= {})[row.PERIO] = (row.ITRT_CNTNT ?? "").trim();
    });
    const missing = new Set();
    Object.entries(byDay).forEach(([ymd, byPer]) => {
      const iso = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
      const makeup = (makeupTimetable[iso] || {})[classId] || {};
      const weekday = WEEKDAY_KO_FULL[new Date(`${iso}T00:00:00`).getDay()];
      Object.entries(regularForClass[weekday] || {}).forEach(([per, subj]) => {
        if (!TECH_HOME_KINDS.includes(subj)) return;
        const actual = (makeup[per] ?? "").trim() || byPer[per] || "";
        if (actual !== TECH_HOME && !TECH_HOME_KINDS.includes(actual)) missing.add(subj);
      });
    });
    if (missing.size === 1) return [...missing][0];
  } catch (err) {
    // 주간 시간표를 못 받으면 ③으로 추정
  }
  return majority;
}

async function fetchTimetable(classId) {
  const container = document.querySelector("#timetable-calendar .timetable-half .content");
  try {
    const [grade, classNm] = classId.split("-");
    const url = `https://open.neis.go.kr/hub/misTimetable?KEY=${NEIS_KEY}&Type=json&ATPT_OFCDC_SC_CODE=${ATPT_OFCDC_SC_CODE}&SD_SCHUL_CODE=${SD_SCHUL_CODE}&GRADE=${grade}&CLASS_NM=${classNm}&ALL_TI_YMD=${todayYmd()}`;
    const res = await fetch(url);
    const data = await res.json();
    const rows = data?.misTimetable?.[1]?.row || [];
    const byPeriod = {};
    rows.forEach((row) => {
      byPeriod[row.PERIO] = row.ITRT_CNTNT;
    });

    const regularTimetable = await loadRegularTimetable();
    const regularForToday = (regularTimetable[classId] || {})[todayWeekdayKo()] || {};

    const makeupTimetable = await loadMakeupTimetable();
    const makeupForToday = (makeupTimetable[todayIso()] || {})[classId] || {};

    const subjects = {};
    for (let period = 1; period <= 7; period++) {
      const neisSubject = (byPeriod[period] ?? "").trim();
      const makeupSubject = (makeupForToday[String(period)] ?? "").trim();
      let subject = makeupSubject || neisSubject;
      if (subject === TECH_HOME) {
        subject = await guessTechHome(classId, period, regularTimetable, makeupTimetable);
      }
      subjects[period] = subject;
    }

    container.innerHTML = Array.from({ length: 7 }, (_, i) => i + 1)
      .map((period) => {
        const subject = subjects[period];
        const regularSubject = (regularForToday[String(period)] ?? "").trim();
        const changed = subject && regularSubject && subject !== regularSubject;
        const style = changed ? ' style="color:#ff4d4f;font-weight:600;"' : "";
        return `<div>${period}교시 <span${style}>${subject}</span></div>`;
      })
      .join("");
  } catch (err) {
    container.textContent = "시간표를 불러오지 못했습니다.";
  }
}

async function fetchWeather() {
  const container = document.querySelector("#weather-time .weather-half");
  try {
    const cached = JSON.parse(localStorage.getItem(WEATHER_CACHE_KEY) || "null");
    if (cached && cached.data?.main && Date.now() - cached.fetchedAt < WEATHER_CACHE_MS) {
      renderWeather(container, cached.data);
      return;
    }
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(WEATHER_QUERY)}&appid=${OWM_KEY}&units=metric&lang=kr`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok || !data.main) throw new Error("weather API error");
    localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), data }));
    renderWeather(container, data);
  } catch (err) {
    container.textContent = "날씨 정보를 불러오지 못했습니다.";
  }
}

const WEATHER_ICONS = {
  Clear:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
  Clouds:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.4 2A4 4 0 0 0 6.5 19h11z"/></svg>',
  Rain:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 14a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.4 2A4 4 0 0 0 5.5 14h11z"/><path d="M8 18v2M12 18v2M16 18v2"/></svg>',
  Thunderstorm:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 12a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.4 2A4 4 0 0 0 5.5 12h11z"/><path d="M11 14l-2 4h3l-2 4"/></svg>',
  Snow:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 12a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.4 2A4 4 0 0 0 5.5 12h11z"/><path d="M8 17v.01M12 18v.01M16 17v.01"/></svg>',
  Mist:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 8h18M5 12h14M3 16h18M7 20h10"/></svg>',
};
const WEATHER_ICON_ALIASES = {
  Drizzle: "Rain",
  Smoke: "Mist",
  Haze: "Mist",
  Dust: "Mist",
  Fog: "Mist",
  Sand: "Mist",
  Ash: "Mist",
  Squall: "Mist",
};

function weatherIconSvg(main) {
  const key = WEATHER_ICONS[main] ? main : WEATHER_ICON_ALIASES[main];
  return WEATHER_ICONS[key] || WEATHER_ICONS.Clouds;
}

const WEATHER_MAIN_KO = {
  Clear: "맑음",
  Clouds: "흐림",
  Rain: "비",
  Drizzle: "이슬비",
  Thunderstorm: "뇌우",
  Snow: "눈",
  Mist: "안개",
  Fog: "안개",
  Haze: "안개",
  Smoke: "안개",
  Dust: "황사",
  Sand: "황사",
  Squall: "돌풍",
};

function weatherMainKo(main) {
  return WEATHER_MAIN_KO[main] || "흐림";
}

function renderWeather(container, data) {
  const temp = Math.round(data.main.temp);
  const main = data.weather?.[0]?.main;
  const label = weatherMainKo(main);
  container.innerHTML = `<div class="weather-icon">${weatherIconSvg(main)}</div><div class="weather-text"><div>${temp}°C</div><div>${label}</div></div>`;
}

const WEEKDAYS_KO = ["일", "월", "화", "수", "목", "금", "토"];
let dateTimeIntervalId = null;

function renderDateTime() {
  const timeEl = document.querySelector("#weather-time .datetime-time");
  const dateEl = document.querySelector("#weather-time .datetime-date");
  if (!timeEl || !dateEl) return;
  const now = new Date();
  const ampm = now.getHours() < 12 ? "오전" : "오후";
  const hour12 = now.getHours() % 12 || 12;
  const minutes = String(now.getMinutes()).padStart(2, "0");
  timeEl.textContent = `${ampm} ${hour12}:${minutes}`;
  dateEl.textContent = `${now.getMonth() + 1}월 ${now.getDate()}일 ${WEEKDAYS_KO[now.getDay()]}요일`;
}

function startDateTimeClock() {
  renderDateTime();
  if (dateTimeIntervalId) clearInterval(dateTimeIntervalId);
  dateTimeIntervalId = setInterval(renderDateTime, 15000);
}

// ── 공지사항 (목록형 + NEW 표시) ──
const NOTICE_SCOPE_ORDER = ["all", "grade", "class"];

// 등록된 날짜가 오늘이면 NEW로 표시한다. 몇 시간이 지났는지가 아니라
// "자정을 넘겼는가"만 기준으로 삼아서, 자정이 지나면 정확히 몇 시간이든
// 상관없이 즉시 사라진다.
function isNoticeNew(timestamp) {
  const ms = timestamp?.toMillis?.();
  if (!ms) return false;
  return new Date(ms).toDateString() === new Date().toDateString();
}

// 공지 속 주소(https://…, www.…)는 눌러서 새 탭으로 열 수 있게 링크로 바꾼다.
// 끝에 붙은 마침표·쉼표·닫는 괄호와 바로 이어 쓴 한글("…com에서")은 주소에서 뺀다.
const NOTICE_URL_RE = /(https?:\/\/|www\.)[^\s<>"\u3131-\u318E\uAC00-\uD7A3]+/g;

function appendLinkedText(el, text) {
  let last = 0;
  for (const m of text.matchAll(NOTICE_URL_RE)) {
    const url = m[0].replace(/[.,!?;:)\]}'"]+$/, "");
    el.append(text.slice(last, m.index));
    const a = document.createElement("a");
    a.className = "notice-link";
    a.href = url.startsWith("www.") ? `https://${url}` : url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = url;
    el.appendChild(a);
    last = m.index + url.length;
  }
  el.append(text.slice(last));
}

function renderNotices(container, noticesByScope, labels) {
  container.innerHTML = "";

  const visibleScopes = NOTICE_SCOPE_ORDER.filter((scope) =>
    (noticesByScope[scope] || []).some((it) => it.text)
  );

  visibleScopes.forEach((scope, scopeIdx) => {
    const items = (noticesByScope[scope] || []).filter((it) => it.text);

    items.forEach((item, idx) => {
      const div = document.createElement("div");
      div.className = "notice-item";

      if (isNoticeNew(item.timestamp)) {
        const newTag = document.createElement("span");
        newTag.className = "notice-new";
        newTag.textContent = "NEW";
        div.appendChild(newTag);
      }

      if (idx === 0) {
        const label = document.createElement("span");
        label.className = "notice-scope";
        label.textContent =
          scope === "all" ? "[전체]" :
          scope === "grade" ? `[${labels.gradeLabel}학년]` :
          `[${labels.classLabel}반]`;
        div.appendChild(label);
      }

      const text = document.createElement("span");
      text.className = "notice-text";
      appendLinkedText(text, item.text);
      div.appendChild(text);

      container.appendChild(div);
    });

    // 마지막(반) 그룹을 제외하고, 실제로 공지가 있는 각 범위가 끝날 때마다 구분선을 넣는다
    if (scopeIdx < visibleScopes.length - 1) {
      const divider = document.createElement("div");
      divider.className = "notice-divider";
      container.appendChild(divider);
    }
  });
}

function subscribeNotice(classId) {
  const container = document.querySelector("#notice .content");
  const [grade, classNo] = classId.split("-");
  const targets = {
    class: classId,
    grade: `grade-${grade}`,
    all: "all",
  };
  const noticesByScope = {};

  return Object.entries(targets).map(([scope, targetId]) => {
    const itemsQuery = query(collection(activeDb, "notices", targetId, "items"), orderBy("timestamp", "desc"));
    return onSnapshot(itemsQuery, (snap) => {
      noticesByScope[scope] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderNotices(container, noticesByScope, { gradeLabel: grade, classLabel: classNo });
    });
  });
}

function subscribeCalls(classId) {
  const overlay = document.getElementById("call-overlay");
  const popupArea = document.getElementById("call-popup-area");
  const queueRef = collection(activeDb, "calls", classId, "queue");
  return onSnapshot(query(queueRef, orderBy("timestamp", "desc")), (snap) => {
    const staleDocs = [];
    const activeDocs = [];
    snap.docs.forEach((d) => {
      const data = d.data();
      if (data.date === todayIso()) {
        activeDocs.push({ id: d.id, ...data });
      } else {
        staleDocs.push(d.id);
      }
    });
    staleDocs.forEach((id) =>
      deleteDoc(doc(activeDb, "calls", classId, "queue", id)).catch(() => {})
    );

    overlay.hidden = activeDocs.length === 0;
    popupArea.hidden = activeDocs.length === 0;
    popupArea.innerHTML = "";
    activeDocs.forEach((call) => {
      const card = document.createElement("div");
      card.className = "call-card";
      const memoEl = document.createElement("div");
      memoEl.className = "call-memo";
      memoEl.textContent = call.memo;
      const confirmBtn = document.createElement("button");
      confirmBtn.className = "call-confirm-btn";
      confirmBtn.textContent = "확인";
      confirmBtn.addEventListener("click", () => {
        deleteDoc(doc(activeDb, "calls", classId, "queue", call.id)).catch(() => {});
      });
      card.append(memoEl, confirmBtn);
      popupArea.appendChild(card);
    });
  });
}

const BOARD_SCOPE_ORDER = ["all", "grade", "class"];

function boardScopeTag(scope, gradeLabel) {
  if (scope === "all") return "전체";
  if (scope === "grade") return `${gradeLabel}학년`;
  return null;
}

function renderBoard(container, postsByScope) {
  const merged = BOARD_SCOPE_ORDER.flatMap((scope) =>
    (postsByScope[scope] || []).map((post) => ({ ...post, scope }))
  ).sort((a, b) => (b.timestamp?.toMillis?.() ?? 0) - (a.timestamp?.toMillis?.() ?? 0));

  container.innerHTML = "";
  if (merged.length === 0) {
    const empty = document.createElement("div");
    empty.id = "board-empty";
    empty.textContent = "게시된 이미지가 없습니다.";
    container.appendChild(empty);
    return;
  }
  merged.forEach((post) => {
    const card = document.createElement("div");
    card.className = "board-card";
    const tag = boardScopeTag(post.scope, post.gradeLabel);
    card.innerHTML = `
      <div class="card-title">${tag ? `<span class="board-scope-tag">${tag}</span>` : ""}${post.title}</div>
      <img class="thumb" src="${post.imageData}" alt="${post.title}">
    `;
    card.addEventListener("click", () => openBoardModal(post));
    container.appendChild(card);
  });
}

function openBoardModal(post) {
  document.getElementById("board-modal-img").src = post.imageData;
  document.getElementById("board-modal-title").textContent = post.title;
  document.getElementById("board-modal-overlay").hidden = false;
}

function closeBoardModal() {
  document.getElementById("board-modal-overlay").hidden = true;
}

function initBoardModal() {
  document.getElementById("board-modal-close").addEventListener("click", closeBoardModal);
  document.getElementById("board-modal-overlay").addEventListener("click", (e) => {
    if (e.target.id === "board-modal-overlay") closeBoardModal();
  });
}

function subscribeBoard(classId) {
  const container = document.querySelector("#board .content");
  const grade = classId.split("-")[0];
  const targets = {
    class: classId,
    grade: `grade-${grade}`,
    all: "all",
  };
  const postsByScope = {};

  return Object.entries(targets).map(([scope, targetId]) => {
    const postsQuery = query(collection(activeDb, "boards", targetId, "posts"), orderBy("timestamp", "desc"));
    return onSnapshot(postsQuery, (snap) => {
      postsByScope[scope] = snap.docs.map((d) => ({ id: d.id, ...d.data(), gradeLabel: grade }));
      renderBoard(container, postsByScope);
    });
  });
}

// 칠판은 하루 종일 켜 두므로 5분마다 확인해서 날짜가 바뀌었거나 새 코드가 배포되면 새로고침하고,
// 정규·보정 시간표만 바뀌었으면 새로고침 없이 시간표 부분만 다시 그린다.
// (긴 setTimeout은 컴퓨터가 절전에 들어가면 밀려서 자정 새로고침이 안 될 수 있음)
// 처음 비교값은 브라우저 캐시(지금 실행 중인 파일과 같은 것)에서, 확인은 서버에 바뀌었는지 물어서 받는다.
// cache: "no-cache"는 안 바뀌었으면 내용 없이 응답받고(데이터 거의 안 씀), 바뀌었으면 받은 새 파일로 캐시도
// 갱신해서 새로고침 때 옛 app.js가 다시 쓰이지 않게 한다.
const UPDATE_CHECK_MS = 5 * 60 * 1000;
const CODE_FILES = ["index.html", "app.js"];
const DATA_FILES = ["../data/regular-timetable.json", "../data/makeup-timetable.json"];

async function readFiles(files, cache) {
  return Promise.all(files.map((f) => fetch(f, { cache }).then((res) => (res.ok ? res.text() : null))));
}

function anyChanged(before, now) {
  return now.some((text, i) => text !== null && before[i] !== null && text !== before[i]);
}

function scheduleAutoReload() {
  const loadedDay = todayIso();
  const loadedCode = readFiles(CODE_FILES, "default").catch(() => null);
  let loadedData = readFiles(DATA_FILES, "default").catch(() => null);
  setInterval(async () => {
    try {
      const modalOpen = !document.getElementById("board-modal-overlay").hidden;
      if (todayIso() !== loadedDay) {
        // 인터넷이 안 될 때 새로고침하면 오류 화면에 멈추므로, 서버에 닿을 때만 새로고침한다
        const res = await fetch("index.html", { cache: "no-cache" });
        if (res.ok && !modalOpen) location.reload();
        return;
      }
      const beforeCode = await loadedCode;
      const nowCode = await readFiles(CODE_FILES, "no-cache");
      if (beforeCode && anyChanged(beforeCode, nowCode)) {
        if (!modalOpen) location.reload();
        return;
      }
      const beforeData = await loadedData;
      const nowData = await readFiles(DATA_FILES, "no-cache");
      const classId = getUrlClassId() || getStoredClassId();
      const dashboardShown = !document.getElementById("dashboard").hidden;
      if (beforeData && anyChanged(beforeData, nowData) && classId && dashboardShown) {
        regularTimetableCache = null;
        makeupTimetableCache = null;
        loadedData = nowData;
        fetchTimetable(classId);
      }
    } catch (err) {
      // 인터넷이 잠깐 끊기면 다음 확인 때 다시 본다
    }
  }, UPDATE_CHECK_MS);
}

function init() {
  initClassSelect();
  initBoardModal();
  scheduleAutoReload();
  const classId = getUrlClassId() || getStoredClassId();
  if (classId) {
    enterDashboard(classId);
  } else {
    showClassSelectScreen();
  }
}

document.addEventListener("DOMContentLoaded", init);
