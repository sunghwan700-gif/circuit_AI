const body = {
  messages: [
    {
      role: 'user',
      content:
        '아래 제출만 보고 교사가 학생에게 보낼 짧은 피드백 초안(2~3문장)을 써 주세요.\n\n학습자: 테스트\nSWOT: S=배선 정리 | W=속도',
    },
  ],
  contextDescription: '교사용 개별 피드백 초안',
  stream: true,
  skipRefine: true,
  aiTask: 'teacher-draft',
  hasImages: false,
  preferFlash: true,
}

const res = await fetch('https://aicircuit.vercel.app/api/openai/chat', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/x-ndjson',
  },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(55_000),
})

console.log('status', res.status, res.headers.get('content-type'))
const text = await res.text()
console.log(text.slice(0, 2000))
