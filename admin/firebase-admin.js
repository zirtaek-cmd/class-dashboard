import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  initializeAuth,
  browserLocalPersistence,
  browserSessionPersistence,
  browserPopupRedirectResolver,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { firebaseConfig } from "../firebase-options.js";

// 관리자·시간표 확인 전용 Firebase 앱. 이름을 따로 두어 칠판(display)의 익명 로그인과 저장소가 겹치지 않게 한다.
// 교무수첩 앱에서 연 브라우저(?keep=1)는 로그인을 유지한다. 한 번 그렇게 열리면 그 브라우저는 기억하고, 로그아웃하면 해제.
// 그 밖에는 창을 닫으면 로그아웃(교실 공용 PC 대비). 저장소를 하나만 지정해 탭끼리 로그인을 옮겨 가며 지우지 않게 한다.
const KEEP_LOGIN_KEY = "admin-keep-login";
let keepLogin = false;
try {
  if (new URLSearchParams(location.search).has("keep")) localStorage.setItem(KEEP_LOGIN_KEY, "1");
  keepLogin = localStorage.getItem(KEEP_LOGIN_KEY) === "1";
} catch (err) {}

const app = initializeApp(firebaseConfig, "admin");

export const db = getFirestore(app);
export const auth = initializeAuth(app, {
  persistence: keepLogin ? browserLocalPersistence : browserSessionPersistence,
  popupRedirectResolver: browserPopupRedirectResolver,
});

export function forgetKeepLogin() {
  try { localStorage.removeItem(KEEP_LOGIN_KEY); } catch (err) {}
}
