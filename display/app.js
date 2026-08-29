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

    container.innerHTML = Array.from({ length: 7 }, (_, i) => i + 1)
      .map((period) => {
        const subject = (byPeriod[period] ?? "").trim();
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

function renderWeather(container, data) {
  const temp = Math.round(data.main.temp);
  const main = data.weather?.[0]?.main;
  const desc = data.weather?.[0]?.description ?? "";
  container.innerHTML = `<div class="weather-icon">${weatherIconSvg(main)}</div><div class="weather-text"><div>${temp}°C</div><div>${desc}</div></div>`;
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

const NOTICE_SCOPE_ORDER = ["all", "grade", "class"];

function renderNotices(container, noticesByScope) {
  container.innerHTML = "";
  NOTICE_SCOPE_ORDER.forEach((scope) => {
    const data = noticesByScope[scope];
    if (!data || !data.text) return;
    const item = document.createElement("div");
    item.className = "notice-item";
    const label = document.createElement("span");
    label.className = "notice-scope";
    label.textContent =
      scope === "all" ? "[전체]" :
      scope === "grade" ? `[${data.gradeLabel}학년]` :
      `[${data.classLabel}반]`;
    item.appendChild(label);
    const text = document.createElement("span");
    text.className = "notice-text";
    text.textContent = data.text;
    item.appendChild(text);
    container.appendChild(item);
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

  return Object.entries(targets).map(([scope, targetId]) =>
    onSnapshot(doc(activeDb, "notices", targetId), (snap) => {
      const data = snap.data();
      noticesByScope[scope] = data ? { ...data, gradeLabel: grade, classLabel: classNo } : null;
      renderNotices(container, noticesByScope);
    })
  );
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

function scheduleMidnightReload() {
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 10, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  setTimeout(() => location.reload(), target - now);
}

function init() {
  initClassSelect();
  initBoardModal();
  scheduleMidnightReload();
  const classId = getUrlClassId() || getStoredClassId();
  if (classId) {
    enterDashboard(classId);
  } else {
    showClassSelectScreen();
  }
}

document.addEventListener("DOMContentLoaded", init);
