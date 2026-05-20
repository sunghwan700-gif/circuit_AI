# Vercel 배포 가이드

## 폴더 구조

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
│   ├── submissions-handler.mjs
│   ├── submissions-store.mjs
│   └── kv-store.mjs
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

환경 변수 자동 업로드: `docs/SETUP-VERCEL-한번에.md` 참고.

## 로컬 개발

```bash
npm install
npm run dev          # Vite: AI·제출 미들웨어, KV는 server/data/kv JSON
npm run dev:vercel   # Vercel Dev: 배포와 동일 /api 라우트
```

## AI 채팅 (스트리밍)

- **Gemini `streamGenerateContent`** → 서버가 NDJSON(`status` / `chunk` / `ping` / `done`)으로 전달
- 클라이언트는 `/api/openai/chat` 한 경로만 사용 (백그라운드 폴링 없음)

| 경로 | maxDuration (Hobby) |
|------|---------------------|
| `/api/openai/chat` | 60초 |
| `/api/submissions/*` | 30초 |

Pro 분석·긴 스트리밍에는 **Vercel Pro** 플랜과 `maxDuration` 상향을 권장합니다.
