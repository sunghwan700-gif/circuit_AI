# Vercel 설정 (선생님용 — 최소 단계)

채팅 오류 **「An error occurred with your deployment」** 는 대부분 **Vercel에 API 키가 없을 때** 납니다.

## 방법 A — Cursor 터미널 (가장 빠름)

1. [Vercel → Settings → Tokens](https://vercel.com/account/tokens) 에서 토큰 하나 만들기 (이름 아무거나)
2. Cursor 아래 **터미널**에 아래 두 줄만 실행 (토큰 부분만 본인 것으로 바꿈):

```powershell
cd "c:\Users\user\Documents\GitHub\circuit_AI"
$env:VERCEL_TOKEN="여기에_붙여넣기"
npm run vercel:env
node scripts/trigger-vercel-deploy.mjs
```

3. 1~2분 뒤 사이트에서 채팅 다시 시도

## 방법 B — GitHub (Vercel 화면을 못 쓸 때)

1. GitHub 저장소 → **Settings → Secrets and variables → Actions → New repository secret**
2. 아래 이름으로 `.env`에 있는 값과 **같은 내용**을 각각 등록:
   - `VERCEL_TOKEN` (Vercel에서 발급)
   - `GEMINI_API_KEY`
   - `SUBMISSIONS_STUDENT_TOKEN`
   - `SUBMISSIONS_TEACHER_PASSWORD`
   - `VITE_SUBMISSIONS_STUDENT_TOKEN` (학생 토큰과 동일)
3. **Actions** 탭 → **Sync Vercel env** → **Run workflow**

## 제출(학생 업로드)까지 쓰려면

Vercel 프로젝트 → **Storage → KV** 연결 (한 번만)

---

코드는 `main` 브랜치에 push 되면 Vercel이 자동으로 다시 빌드합니다. **환경 변수만** 위 방법으로 넣어 주면 됩니다.
