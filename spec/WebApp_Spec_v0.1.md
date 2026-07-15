# 스마트칠판 학급 웹앱 — WebApp_Spec_v0.1

## 1. 개요
- **목적**: 각 반 스마트 칠판(안드로이드 크롬)에 상시 게시할 정보 대시보드 + 교사 호출 알림 시스템
- **대상 반**: 11개 반
- **호스팅**: GitHub Pages (정적) + Firebase Firestore (실시간 데이터)
- **비용**: 전 항목 무료 티어로 운영 (GitHub Pages / Firebase Spark / NEIS Open API / 기상청 공공API)

## 2. 구조 (방식 B: 단일 웹앱)

```
class-dashboard/
  display/
    index.html      ← 반 선택(최초 1회) + 대시보드 표시 화면
    app.js           ← 공통 로직 (NEIS 연동, 날씨 연동, Firestore 구독)
  admin/
    index.html       ← 교사 공용 관리자 페이지 (공지 작성 + 학생 호출)
  firebase-config.js  ← Firebase 프로젝트 연결 설정
```

- 각 반 칠판은 동일한 `display/index.html` URL 접속
- 최초 접속 시 반 선택 화면 표시 → 선택 값(`classId`, 예: "1-3")을 `localStorage`에 저장
- 이후 재접속 시 저장된 `classId`로 자동 진입 (반 선택 화면 생략)
- 화면 구석에 "반 변경" 버튼으로 재설정 가능

## 3. 화면 레이아웃 (3칼럼)

| 왼쪽 | 가운데 | 오른쪽 |
|---|---|---|
| 날씨 | 오늘의 공지사항 | 시간표 |
| 급식 | 호출 팝업 (하단, 평소 숨김) | 학사일정 |

- 가운데 칼럼: 담임 작성 정보(공지 + 호출)로 시선이 우선 가도록 배치
- 오른쪽 칼럼: 확인용 정적 정보(시간표/학사일정)
- **호출 발생 시 인터랙션 제한**: 미확인 호출이 있으면 화면 전체에 투명 오버레이가 깔려 다른 영역(시간표, 공지 등) 터치를 차단하고, 팝업 카드의 "확인" 버튼만 조작 가능. 확인 시 해당 카드만 닫히고 남은 미확인 호출이 있으면 오버레이 유지, 없으면 화면 정상 복귀

## 4. 데이터 소스

| 정보 | 출처 | 비고 |
|---|---|---|
| 급식 | NEIS Open API | 전교 공통, 캐싱 없이 매 로드 시 호출 |
| 학사일정 | NEIS Open API | 전교 공통 |
| 시간표 | NEIS Open API | `classId` 파라미터로 반별 분기 |
| 날씨 | 기상청 공공API 또는 OpenWeatherMap | 위치 고정, 1시간 주기 갱신 |
| 공지사항 | Firestore (`notices`) | 담임 작성, 당일만 표시 |
| 호출 | Firestore (`calls`) | 담임 작성, 확인 시까지 표시 |

## 5. Firestore 데이터 구조

```
notices/class1  { text: string, date: "YYYY-MM-DD" }
notices/class2  ...
...
notices/class11

calls/class1/queue/{autoId}  { memo: string, timestamp, date: "YYYY-MM-DD" }
calls/class2/queue/{autoId}  ...
...
calls/class11/queue/{autoId}
```

- **notices**: 반마다 문서 1개씩 고정(총 11개), 매번 덮어쓰는 구조 → 데이터 누적 없음
- **calls**: 반마다 서브컬렉션(`queue`)을 두어 **호출을 스택(여러 건 누적)으로 관리**
  - 호출 발생 시 `queue`에 새 문서 추가(자동 생성 ID)
  - display 페이지는 `queue`를 시간순으로 구독 → 미확인 호출이 여러 개면 카드 형태로 쌓여서 표시(최신이 위)
  - 확인(터치) 시 해당 문서만 삭제 → 쌓인 만큼만 존재, 확인되면 즉시 사라짐 → 장기적으로도 데이터 누적 없음
  - 자정 넘어 남아있는 미확인 호출(`date`가 오늘이 아님)은 display 페이지가 감지 시 자동 삭제(클라이언트에서 정리, 별도 서버 스케줄러 불필요)
- **공지 초기화 로직**: 서버 스케줄러 없이 "저장된 `date`가 오늘과 다르면 화면에서 숨김" 방식으로 클라이언트에서 판단 (무료 플랜 제약 회피)

## 6. 호출(Call) 플로우

1. 담임 선생님이 관리자 페이지에서 반 선택 → 메모 입력 → 전송
2. `calls/{classId}/queue`에 새 문서 추가 (`memo`, `timestamp`, `date`)
3. 해당 반 display 페이지가 `queue`를 실시간 구독(`onSnapshot`) 중 → 변경 감지 즉시 가운데 칼럼 하단에 팝업 카드로 추가 표시
4. 확인 전 추가 호출이 오면 **카드가 위로 쌓이는 스택 형태**로 표시 (최신 호출이 맨 위)
5. 칠판에서 각 카드의 "확인" 터치 → 해당 문서만 삭제 → 그 카드만 사라지고 나머지는 유지
6. 알림은 **소리 없이 화면 팝업으로만** 표시

## 7. 인증 및 접근 통제

- **관리자 페이지**: Firebase Authentication + Google 로그인
- **도메인 제한**: `@ai.jne.kr` 계정만 로그인 허용 (외부인 차단)
- **학생 접근 방지**: 학생과 도메인이 동일하여 로그인 자체는 가능하지만, 관리자 페이지 URL은 학생에게 공유되지 않으므로 실질적 접근 경로 차단
- **권한 모델**: 로그인한 모든 교사는 11개 반 전체에 접근 가능 (반별 권한 분리 없음)
- 관리자 페이지에 `<meta name="robots" content="noindex">` 적용 (검색엔진 노출 방지)

## 8. Firestore 보안 규칙 (요지)

- `notices/{classId}` 문서:
  - **읽기**: 누구나 가능(display 페이지는 자기 `classId` 문서만 구독)
  - **쓰기**: 인증된 사용자(`@ai.jne.kr` 도메인 Google 로그인, 교사)만 가능
- `calls/{classId}/queue/{callId}` 문서:
  - **생성(쓰기)**: `@ai.jne.kr` 도메인 Google 로그인(교사)만 가능
  - **읽기**: 누구나 가능(display 페이지는 자기 `classId` 하위 `queue`만 구독)
  - **삭제(확인 처리)**: display 페이지가 백그라운드에서 **Firebase Anonymous Auth**로 자동 로그인 → 해당 익명 세션은 **자기 `classId` 큐의 문서 삭제만** 허용 (그 외 쓰기/타 반 접근 불가)
- 시간표/급식/날씨는 Firestore에 저장하지 않고 API 직접 호출 → 별도 보안 규칙 불필요

## 9. 개인정보 보호 원칙

- 호출/공지 메모에 포함되는 실명 등 개인정보는 **당일 한정, 최소 보관**
- 호출 완료 시 메모 내용 초기화 (이력 미보관)
- 별도 로그/히스토리 컬렉션 없음 → 유출 표면적 최소화

## 10. 운영 관련 유의사항

- 안드로이드 크롬 절전모드 대비: 자정 기준 자동 리로드 로직 필요 (공지/호출 날짜 초기화와도 자연스럽게 연동)
- 소리 알림 없음 → 화면 시각적 강조(팝업 오버레이/색상 강조)로만 처리
- 날씨 API는 기상청 공공API 대신 **OpenWeatherMap** 사용 권장 (기상청 API는 브라우저 직접 호출 시 CORS 이슈 발생 가능, OpenWeatherMap은 CORS 지원)
- **GitHub 저장소는 무료 플랜 특성상 Public(공개)**으로 운영됨 — 코드(관리자 페이지 구조 포함)는 누구나 열람 가능하나, 실제 기능은 Firebase 인증·규칙으로 보호되므로 코드 공개 자체는 기능적 위험이 낮음(인지 후 진행 확정)
- API 키(NEIS, OpenWeatherMap) 및 Firebase 설정값은 정적 사이트 구조상 클라이언트 코드에 노출됨 — NEIS/날씨 키는 공공 무료 API라 문제 없고, Firebase 설정값은 보안 규칙이 실제 방어선이므로 노출 자체는 정상 범주

## 11. 구현 단계 (Phase)

**Phase 1 — 계정·키 준비 (코딩 전 선행)**
1. NEIS Open API 인증키 발급/확인
2. OpenWeatherMap 무료 API 키 발급
3. Firebase 프로젝트 생성 → Firestore 활성화, Authentication에서 **Google 로그인** + **Anonymous 로그인** 둘 다 활성화
4. GitHub 저장소 생성(`class-dashboard`, Public)

**Phase 2 — display 정보 표시부 (Firestore 연동 전, 눈에 보이는 결과물부터)**
- 반 선택 화면 + `localStorage` 저장 로직
- NEIS 급식/학사일정/시간표 연동 및 3칼럼 레이아웃 배치
- 날씨(OpenWeatherMap) 연동

**Phase 3 — Firestore 연동 (공지·호출)**
- `notices`, `calls/queue` 구조 구현
- 보안 규칙 작성 및 적용(Google 로그인 vs Anonymous 권한 분리)
- display 페이지 Anonymous Auth 자동 로그인 처리

**Phase 4 — 관리자 페이지**
- Google 로그인(도메인 제한) 구현
- 반 선택 + 공지 작성 + 호출 전송 UI

**Phase 5 — 운영 안정화**
- 자정 자동 리로드 로직
- 스타일링(Pretendard, 모노크롬 베이스 등 기존 디자인 원칙 적용)

## 12. 남은 결정 필요 사항
- (없음 — 현재까지 모든 항목 확정)

---
*차기 단계: 이 스펙을 기반으로 Claude Code에서 폴더 구조 생성 및 초기 구현 착수 가능*
