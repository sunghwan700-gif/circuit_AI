# Vercel 배포 가이드

## 폴더 구조 (변경 후)

```
circuit_AI/
├── api/                          # Vercel Serverless Functions (URL: /api/*)
│   ├── openai/
│   │   ├── chat.js               # POST /api/openai/chat (Gemini SSE → NDJSON 스트리밍)
│   │   └── chat/
│   │       ├── job.js            # (레거시, 미사용)
│   │       └── background.js     # (레거시, 미사용)
│   ├── submissions/
│   │   ├── index.js              # GET·POST /api/submissions
│   │   └── [id]/
│   │       ├── index.js → [id].js
│   │       └── status.js         # GET /api/submissions/:id/status
│   └── auth/teacher/login.js     # POST /api/auth/teacher/login
├── server/                       # 공용 비즈니스 로직 (배포·로컬 공유)
│   ├── gemini-chat-core.mjs
│   ├── ai-chat-jobs.mjs
│   ├── process-ai-chat-job.mjs
│   ├── submissions-handler.mjs
│   ├── submissions-store.mjs
│   └── kv-store.mjs
├── netlify/                      # (레거시) Netlify Functions — 이전 호스트용
├── src/                          # Vite 프론트엔드
├── vercel.json
└── vite.config.js
```

## Vercel 대시보드 설정

1. GitHub 저장소 연결 → Import
2. Framework: **Vite** (또는 `vercel.json` 자동 인식)
3. **Storage → KV** 데이터베이스 생성 후 프로젝트에 연결  
   (`KV_REST_API_URL`, `KV_REST_API_TOKEN` 자동 주입)
4. **Environment Variables** (Production + Preview):

| 변수 | 설명 |
|------|------|
| `GEMINI_API_KEY` | Google AI Studio API 키 |
| `GEMINI_CHAT_MODEL` | `gemini-2.5-pro` |
| `SUBMISSIONS_STUDENT_TOKEN` | 학생 제출 Bearer 토큰 |
| `SUBMISSIONS_TEACHER_PASSWORD` | 교사 로그인 비밀번호 |
| `VITE_SUBMISSIONS_STUDENT_TOKEN` | 빌드에 포함(학생용, 위와 동일 값) |

`vercel.json`의 `build.env`에 `VITE_*` 일부가 이미 들어 있습니다.

## 로컬 개발

```bash
npm install
npm run dev          # Vite만: AI는 미들웨어, 제출은 sync-server(8787)
npm run dev:vercel   # Vercel Dev: 배포와 동일 /api 라우트
```

## Netlify에서 이전 시

- DNS를 Vercel 프로젝트로 변경
- Netlify 환경 변수를 Vercel에 동일하게 복사
- **KV**로 Blobs 대체 — 기존 Netlify Blobs 데이터는 수동 이전 필요

## AI 채팅 (스트리밍)

- **Gemini `streamGenerateContent`** → 서버가 NDJSON(`status` / `chunk` / `ping` / `done`)으로 전달
- 클라이언트는 `/api/openai/chat` 한 경로만 사용 (백그라운드 폴링 없음)
- `api/openai/chat.js` **maxDuration: 300초** (Pro 플랜 권장)

| 경로 | maxDuration |
|------|-------------|
| `/api/openai/chat` | 300초 |
| `/api/submissions/*` | 30초 |

Hobby 플랜은 함수 시간이 짧을 수 있어 Pro 분석에는 **Vercel Pro** 를 권장합니다.
