# Vercel 설정 (선생님용 — 최소 단계)

## 1. KV(제출 저장소) + 환경 변수 한 번에 (권장)

1. [Vercel → Settings → Tokens](https://vercel.com/account/tokens) 에서 토큰 **한 번** 발급
2. Cursor **터미널**에 붙여넣기:

```powershell
cd "c:\Users\user\Documents\GitHub\circuit_AI"
$env:VERCEL_TOKEN="여기에_토큰_붙여넣기"
npm run vercel:kv
npm run vercel:env
```

3. 끝나면 브라우저에서 확인:  
   https://aicircuit.vercel.app/api/ping  
   → `"kv": true` 이면 **교사 대시보드·제출**이 됩니다.

`npm run vercel:kv` 가 Redis를 만들고 프로젝트에 연결한 뒤 재배포까지 시도합니다.

---

## 2. KV만 수동으로 (토큰은 있지만 스크립트가 실패할 때)

1. [Vercel](https://vercel.com) → **aicircuit** 프로젝트  
2. **Storage** → **Create Database** → **Upstash for Redis** (또는 KV)  
3. 이름 아무거나 → **Create** → **Connect to Project** → **aicircuit** 선택  
4. **Deployments** → 최신 배포 → **Redeploy**

---

## 3. Upstash만 따로 (Vercel Storage 화면이 어려울 때)

1. https://console.upstash.com → 로그인 → **Create database** (Free)  
2. **REST API** 탭에서 URL·TOKEN 복사  
3. `.env` 에 추가:

```
KV_REST_API_URL=복사한_URL
KV_REST_API_TOKEN=복사한_TOKEN
```

4. 터미널:

```powershell
$env:VERCEL_TOKEN="Vercel_토큰"
npm run vercel:env
```

5. Vercel에서 **Redeploy**

---

## 채팅(AI)이 안 될 때

- `/api/ping` 에서 `"gemini": true` 인지 확인  
- `false` 이면 `.env` 의 `GEMINI_API_KEY` 를 `npm run vercel:env` 로 올리기

---

코드는 GitHub `main` 에 push 되면 Vercel이 자동 빌드합니다.
