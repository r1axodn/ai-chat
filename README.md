# AI 공용방

초대 링크 + 입장 암호로 **사람과 AI가 한 방에 모이는 실시간 채팅 웹앱**입니다.
라이트 톤 메신저 UI(iPhone 390px 기준, 데스크톱은 가운데 정렬 프레임)로 만들었고,
정적 파일만으로 돌아가서 GitHub Pages 루트에 그대로 올릴 수 있습니다.

```
.
├─ index.html                화면 (채팅 / 입장 / 방 관리 / 초대 / 검색 / AI 추가)
├─ styles.css                라이트 톤 메신저 스타일 (#F7F8FA · 흰 헤더 · 흰/연파랑 말풍선)
├─ app.js                    화면 흐름·이벤트 (모든 렌더링은 textContent)
├─ crypto.js                 Web Crypto: 초대 토큰(AES-GCM), 입장 암호(PBKDF2-SHA256), 메시지 암호화
├─ store.js                  저장소 어댑터 (로컬 데모 / Supabase)
├─ gemini.js                 Gemini 응답 엔진 (데모 · 내 키 · 서버 함수)
├─ config.js                 Supabase URL·공개 키 (채워져 있으면 바로 실시간, 비우면 데모)
├─ supabase/schema.sql       squad_* 테이블 · RLS · RPC · Realtime 설정
└─ supabase/functions/gemini-chat/index.ts   Gemini 프록시 Edge Function
```

> 검증용 스크립트(`test/`)와 미리보기 이미지(`preview-*.png`)는 이 저장소에 올리지 않습니다(`.gitignore`).

---

## 1. 바로 켜 보기 (로컬 데모)

```bash
python3 -m http.server 8000
# 브라우저에서 http://localhost:8000
```

- `config.js` 가 비어 있으면 **로컬 데모**로 열립니다. 첫 방문에 예시 방(AI 공용방 · Taewoo/Pickle/Instinct/Claude)이 자동으로 만들어집니다.
- 지금 저장된 `config.js` 에는 공개 URL 과 publishable 키가 들어 있어, 그대로 열면 처음부터 **Supabase 실시간** 모드입니다. 데모로 보려면 `config.js` 값을 비우거나 **[방 관리(≡) → 연결 → 비우기]** 를 누르세요.
- 대화 · 멤버 · 프로필 사진 · 초대 · 메시지가 전부 `localStorage` 에 남아 **새로고침·브라우저 재시작 후에도 그대로 복원**됩니다.
- 지우는 방법은 하나뿐입니다: **방 관리(≡) → 방 → 데모 데이터 초기화**. 그 뒤로는 자동 생성되지 않습니다.

> `file://` 로 열면 Web Crypto(`crypto.subtle`)가 막혀 동작하지 않습니다. `http://localhost` 나 https 주소로 여세요.

## 2. 실시간 모드로 바꾸기 (Supabase)

### 2-1. 스키마 실행 — 한 번만

1. Supabase 대시보드 → **SQL Editor** 열기 (이미 쓰는 프로젝트가 있으면 그대로 써도 됩니다)
2. [`supabase/schema.sql`](supabase/schema.sql) 전체를 붙여넣고 **RUN**
3. 마지막 결과가 `squad_rooms_ok … realtime_ok = true` 면 성공

모든 객체가 `squad_` 접두사라 기존 테이블과 충돌하지 않습니다. 다시 실행해도 안전합니다.

### 2-2. 앱에 연결

- **방 관리(≡) → 연결** 에 `https://<프로젝트>.supabase.co` 와 **publishable(또는 anon) 키**를 넣고 저장 → 새로고침
- 주소 끝에 `/` 를 붙여도(`https://<프로젝트>.supabase.co/`) 저장할 때 자동으로 떼어 냅니다.
- 또는 `config.js` 의 `supabaseUrl` / `supabaseKey` 를 채워 두면 처음부터 실시간 모드로 열립니다. (현재 저장된 값: `friday-hud`·`cubetimer` 와 같은 프로젝트의 공개 URL·publishable 키)
- **service_role 키는 절대 넣지 마세요.** 브라우저에 노출되는 키입니다(앱이 저장을 거부합니다).

### 2-3. Gemini 연결 (선택)

| 모드 | 동작 | 키 위치 |
| --- | --- | --- |
| **데모** | API 호출 없이 예시 문장으로 응답 | 없음 |
| **내 키** | 브라우저 → Google Gemini REST 직접 호출 | 그 탭의 `sessionStorage` 에만 (코드·localStorage·DB 저장 없음) |
| **서버 함수** | 브라우저 → Supabase Edge Function → Gemini | 함수 환경변수 `GEMINI_API_KEY` 에만 |

서버 함수 배포:

```bash
supabase functions deploy gemini-chat --project-ref <프로젝트ref>
supabase secrets set GEMINI_API_KEY=AIza... --project-ref <프로젝트ref>
```

- 모델: **`gemini-3.8-flash` 가 기본**이고 `gemini-3.6-flash` / `gemini-3.5-flash-lite` / `gemini-3.1-flash-lite`, 구형 호환용으로 `gemini-2.5-flash` / `gemini-2.5-flash-lite` 를 고를 수 있습니다. 목록에 없는 모델은 **[모델 → 직접 입력…]** 에 모델 코드를 넣으면 그대로 씁니다.
- 예전에 기본값(2.5 Flash)이 저장된 브라우저는 처음 열 때 **한 번만** 새 기본값으로 자동 이전되고, 그 뒤에 직접 고른 구형 모델은 그대로 유지됩니다.
- `gemini-2.5-flash`·`gemini-2.5-pro` 는 이미 신규 키에서 막혀 있고(2026-12-01 부터는 `gemini-3.5-flash-lite`·`gemini-3.8-flash` 로 자동 연결), 그대로 부르면 *This model … is no longer available to new users* 오류가 납니다. 그래서 기본값을 3.8 Flash 로 두었습니다.
- Gemini 3 계열은 `temperature` 대신 `generationConfig.thinkingConfig.thinkingLevel: 'low'` 를 쓰고, 생각 토큰이 출력 한도에 포함되므로 `maxOutputTokens` 를 1024 로 잡습니다. (구형 2.5 계열은 기존처럼 temperature·topP, 220 토큰)
- 실사용은 **서버 함수 모드**를 권장합니다. 키가 브라우저로 나가지 않고, 함수가 요청 크기·모델·호출량(분당 30회)을 제한합니다.
- Gemini 무료 등급 안에서 쓰면 비용은 0원이고, 초과하면 Google Cloud 결제가 필요합니다.

## 3. 초대 링크 · 암호 설계

방장이 [초대 링크]를 누르면 **라벨 · 입장 암호 · 만료 시간 · 사용 인원**을 정해 링크를 만듭니다.

```
https://<주소>/?invite=s1.<tokenId>.<wrapKey>
```

| 값 | 정체 | 어디에 있나 |
| --- | --- | --- |
| `tokenId` (24바이트 난수) | 초대 식별자 | 링크에만. DB 에는 SHA-256 해시만 |
| `wrapKey` (32바이트 난수) | 방 열쇠를 감싸는 키 | **링크에만.** 서버에 절대 저장 안 함 |
| 방 열쇠 (32바이트) | 메시지 암복호화 | AES-GCM(wrapKey)로 감싼 `wrapped_key` 만 DB |
| 입장 암호 | 2차 잠금장치 | PBKDF2-SHA256(salt, 15만 회) 해시만 DB |

- **링크만으로는 못 들어옵니다.** 암호를 통과해야 서버(RPC)가 감싼 방 열쇠를 돌려주고, 그때 비로소 링크의 `wrapKey` 로 방 열쇠를 풉니다.
- **암호만으로도 못 들어옵니다.** `wrapped_key` 는 암호 통과 전에는 응답에 포함되지 않습니다.
- DB 를 통째로 읽어도 방 열쇠와 메시지 평문은 나오지 않습니다(본문도 방 열쇠로 AES-GCM 암호화).
- 암호 5회 연속 실패 → **15분 잠금**(서버가 `fail_count` / `locked_until` 관리), 성공하면 초기화.
- 방장은 언제든 **초대 폐기(Revoke)** 와 **참여자 내보내기(Kick)** 를 할 수 있고, 폐기된 링크는 즉시 막힙니다.

## 4. 보안 정리

| 항목 | 처리 |
| --- | --- |
| XSS | 사용자 입력(메시지·이름·역할·라벨)은 전부 `textContent` 로만 렌더링. `app.js` 에 `innerHTML` 없음 |
| 프로필 사진 | `image/png·jpeg·webp` 만, 2MB 제한, 캔버스로 160×160 리사이즈 후 data URL 저장. `<img src>` 는 `data:image/(png|jpeg|webp)` 만 허용 |
| DB 접근 | 테이블 직접 쓰기 금지. 모든 쓰기는 `SECURITY DEFINER` RPC + 토큰(방장/멤버) 검증 |
| 읽기 범위 | `squad_members` 는 프로필 컬럼만, `squad_messages` 는 암호문만 공개(Realtime 구독용). 방·초대 테이블은 anon 접근 불가 |
| 키 | Gemini 키는 코드·localStorage·DB 어디에도 저장하지 않음. service_role 키는 앱이 거부 |
| 개인정보 | 코드·DB·스키마에 이름/학교/전화번호 같은 값 없음. 공개 저장소에 올려도 안전 |

## 5. 대화가 사라지지 않게 (영속성)

- **Supabase 모드**: 모든 메시지가 `squad_messages` 에 저장되고, 새로고침·재접속 시 `room_id` 기준으로 시간순 전체를 다시 불러옵니다. 멤버 목록·프로필 사진도 함께 복원됩니다. Realtime 이 막힌 환경에서는 5초 폴링으로 자동 대체됩니다.
- **로컬 데모**: `localStorage` 키 하나(`squad.demo.v1`)에 방·멤버(사진 포함)·초대·메시지를 모두 저장합니다. 세션(내 신분·방 열쇠)은 `squad.sessions.v1`, AI 멤버 토큰은 `squad.aitokens.v1` 에 따로 둡니다. 브라우저를 닫았다 열어도 그대로입니다.
- 데모 탭은 `sessionStorage` 기준으로 자기 신분을 기억합니다. 그래서 **같은 브라우저에서 방장 탭 + 초대받은 탭을 동시에 열어** 실시간 동작을 시험할 수 있습니다.

## 6. 검증 결과

`test/run_tests.py` (Playwright, Chromium · iPhone 390×844 · DPR 2):

- 데모 방 자동 생성 · 시드 대화 4개 · 멤버 4명
- 메시지 전송 → AI 자동 응답(데모)
- **새로고침 후 대화·멤버 유지**
- 초대 링크 생성(라벨/암호/만료/인원) → 링크 `?invite=s1.…`
- 초대 링크로 새 탭 입장: 암호 오류 안내 → 정상 암호 → 프로필(사진 업로드·이름·AI 역할/프롬프트) → 입장
- 입장한 탭의 메시지가 방장 탭에 **실시간 반영**
- XSS 페이로드(`<img onerror>`)가 글자로만 표시되고 실행되지 않음
- 초대 폐기 후 링크 차단 / 암호 5회 실패 시 15분 잠금
- 데스크톱(1280×900) 가운데 프레임
- [방 관리 → 연결] 주소 끝 `/` 자동 제거 · `config.js` 에 공개 키만 있는지 확인
- 모델 기본값 `Gemini 3.8 Flash` · 요청 URL `…/v1beta/models/gemini-3.8-flash:generateContent` · Gemini 3 요청에 `thinkingConfig.thinkingLevel=low` 가 들어가고 temperature 는 빠지는지 (가짜 fetch 로 본문 검사)
- 콘솔 에러 0건

`test/live_tests.py` (로컬 흉내 Supabase 서버): 실시간 모드 입장 · 초대 · 서버 복원 · 암호문 저장 등 24개 확인 통과.

## 7. 알려진 한계

- **데모 모드의 초대 링크는 같은 브라우저(같은 프로필)에서만** 열립니다. 실제로 다른 사람과 공유하려면 Supabase 연결이 필요합니다.
- 방 열쇠는 브라우저에만 있습니다. 방장이 브라우저 저장소를 지우면 그 방의 지난 대화는 복호화할 수 없습니다(서버에도 평문이 없으므로). 중요하면 초대 링크를 백업해 두세요.
- "내 키" 모드는 브라우저에서 Google API 를 직접 부르는 테스트용입니다. 네트워크 정책이나 Google 쪽 CORS 로 막히면 "서버 함수" 모드를 쓰세요.
- AI 멤버는 스스로 24시간 깨어 있지 않습니다. 방을 연 브라우저가 그 AI의 대리로 응답합니다(초대받은 AI 탭이 스스로 답하는 방식도 동일하게 동작).

## 8. GitHub Pages 배포

- 사이트: <https://r1axodn.github.io/ai-chat/>
- 저장소: <https://github.com/r1axodn/ai-chat>
- 소스: `main` 브랜치 · 배포: `gh-pages` 브랜치 루트 (Pages 가 여기서 빌드합니다)

수정한 뒤 반영:

```bash
git add -A && git commit -m "..." && git push origin main
git push -f origin main:gh-pages   # 정적 배포 브랜치 동기화
```

푸시 후 1분 안에 Pages 가 다시 빌드됩니다. `config.js` 에 공개 URL·publishable 키가 들어 있어 배포 페이지도 **처음 방문부터 실시간 모드**로 열립니다.
