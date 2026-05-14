## Submissions sync server (배포용)

이 서버는 학습자의 제출을 저장하고, 교사 대시보드에서 조회/피드백/삭제를 가능하게 합니다.

### 실행

```bash
npm run sync-server
```

기본 포트는 `8787`입니다. 바꾸려면 `PORT` 환경변수를 설정하세요.

### 권한(권장 설정)

#### 1) 학생 토큰 (제출만)

- **서버**: `SUBMISSIONS_STUDENT_TOKEN`
- **프런트**: `VITE_SUBMISSIONS_STUDENT_TOKEN`

학생은 `POST /api/submissions`만 가능합니다. 서버가 **항상 새 제출 id를 발급**하므로 다른 학생 데이터를 덮어쓸 수 없습니다.

#### 2) 교사 로그인(세션 토큰 발급)

- **서버**: `SUBMISSIONS_TEACHER_PASSWORD`
- **프런트**: 별도 설정 필요 없음(교사 로그인 화면에서 비밀번호 입력)

교사가 로그인하면 서버가 세션 토큰을 발급하고, 이후 교사 API 요청은 그 토큰으로 보호됩니다.

#### 3) 다중 교사 + 담당 학과 제한(권장)

서버에 `SUBMISSIONS_TEACHERS_JSON`을 설정하면 교사 계정을 여러 개로 만들고, 담당 학과별로 접근을 제한할 수 있습니다.

예시:

```bash
SUBMISSIONS_TEACHERS_JSON='[
  { "id": "t1", "password": "pw1", "depts": ["전기과"] },
  { "id": "t2", "password": "pw2", "depts": ["철도전기과","전기과"] },
  { "id": "admin", "password": "pw3", "depts": ["*"] }
]'
```

- `depts`에 `"*"`가 있으면 전체 접근
- 교사 토큰(세션)로 `GET/PATCH/DELETE` 시 서버가 제출의 `student.dept`를 보고 담당 학과만 허용합니다.

### API 요약

- `POST /api/auth/teacher/login` → `{ token, expiresAt, teacherId, depts }`
- `POST /api/submissions` (학생/교사 가능, 학생은 새 id 발급)
- `GET /api/submissions` (교사만, 담당 학과 필터 적용)
- `PATCH /api/submissions/:id` (교사만, 담당 학과만)
- `DELETE /api/submissions/:id` (교사만, 담당 학과만)

### Netlify (별도 Node 서버 없이)

이 저장소는 Netlify에 올릴 때 `netlify/functions/submissions-sync.mjs`와 Blobs로 위 API와 동일한 동작을 제공합니다. `netlify.toml`의 `VITE_SUBMISSIONS_SAME_ORIGIN`이 켜져 있으면 프런트는 `window.location.origin` 기준으로 `/api/submissions` 등을 호출합니다.

Netlify **Site → Environment variables**에 `SUBMISSIONS_STUDENT_TOKEN`, `SUBMISSIONS_TEACHER_PASSWORD`(또는 `SUBMISSIONS_TEACHERS_JSON`)을 넣고, 빌드용으로 `VITE_SUBMISSIONS_STUDENT_TOKEN`을 학생 토큰과 **동일 값**으로 설정한 뒤 재배포하세요. 토큰을 비우면 개발 편의와 동일하게 제한이 없어 공개 사이트에는 부적합합니다.

로컬에서 Netlify와 동일하게(리다이렉트·Functions·Blobs) 돌려보려면 `npm run dev:netlify` 를 사용하세요. `netlify.toml`의 `[dev]`가 Vite(5173)를 띄우고, 브라우저는 보통 `http://localhost:8888` 로 접속합니다. 처음에는 `npx netlify login`과 `npx netlify link`로 배포 사이트와 연결하는 것이 좋습니다.

