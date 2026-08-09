---
name: novel-eval
description: 추출 품질을 측정하거나 모델·프롬프트를 바꾼 뒤 회귀를 확인할 때 사용한다. "품질 어때?", "모델 바꿔서 비교해줘", "골든셋 평가 돌려줘", "프롬프트 고쳤는데 나빠졌나?" 같은 요청에 발동. 입력은 작품 id와 모델명(선택)이고, 산출물은 precision/recall 리포트와 회귀 판정이다.
---

# 추출 품질 평가

## 원칙

**외부 벤치마크 수치를 완료 기준으로 쓰지 않는다.** 기준은 이 저장소의 골든셋
(`tests/fixtures/golden/`)이다. 다른 논문·리더보드의 점수와 비교해 "좋다/나쁘다"를
말하지 않는다. 비교는 언제나 같은 골든셋 위에서 버전 간으로 한다.

## 절차

```powershell
# 1. 회귀 먼저. 여기서 깨지면 품질 논의는 의미가 없다.
npm.cmd test

# 2. 규칙 채널 + fixture LLM 채널 (Ollama 불필요)
node scripts/eval_extraction.mjs

# 3. 실제 모델 비교 (로컬 Ollama 필요)
node scripts/eval_extraction.mjs --live qwen3.5:4b

# 4. 시점 질의 정확도·누출 (LLM 불필요, 결정적)
node --no-warnings scripts/eval_asof_qa.mjs

# 5. 제약 위반 추이
node --no-warnings scripts/audit_report.mjs --json
```

## 무엇을 보고하는가

한 줄 요약 뒤에 표 하나. 다음 항목을 반드시 포함한다.

| 항목 | 왜 |
| --- | --- |
| 인물·장소·사건 precision / recall | 골든셋 대비 기본 지표 |
| 오탐 금지 목록 통과 여부 | 정확도 우선 원칙의 하한선. 하나라도 뚫리면 회귀 |
| as-of 누출 건수 | **0이 아니면 무조건 회귀.** 추출 지표가 올라도 상쇄되지 않는다 |
| `audit.error` 건수 | 계약 위반 추이. 지표가 올라도 이게 늘면 순이익이 아니다 |
| 실행 시간 / 모델 호출 수 | 로컬 실행 비용. scene 모드는 `청크×2 + 관계 1` |
| 캐시 hit 여부 | `hit`이면 바뀐 걸 측정하지 못한 것이다 |

## 판정 규칙

- **회귀**: 오탐 금지 목록이 뚫렸거나, precision이 이전 버전보다 떨어졌는데 recall
  상승으로 설명되지 않을 때. 되돌린다.
- **개선**: recall이 오르고 precision이 유지되며 `audit.error`가 늘지 않을 때.
- **판정 불가**: 캐시 hit, `scenes_failed`가 비어 있지 않음, Ollama 미기동.
  이 경우 "측정하지 못했다"고 말한다. 추정치를 내놓지 않는다.

## 골든셋 추가

새 작품을 평가에 넣으려면:

1. `texts/`에 원문 TXT를 넣는다(공개도메인만). 권리 표기가 다르면
   `<이름>.meta.json`에 `rights`를 적는다.
2. `/check`에서 인물·장소·사건을 **원문 근거를 보며** 확정한다.
3. 확정된 목록을 `tests/fixtures/golden/<이름>.golden.json`으로 저장한다.
4. `node scripts/eval_extraction.mjs`로 기준선을 기록한다.

골든셋은 사람이 확정한 것만 넣는다. 모델 출력을 그대로 정답으로 넣으면 그 뒤의
모든 측정이 무의미해진다.

## 관련

- 분석 실행: `novel-analyze`
- 검수 절차: `novel-review`
- 평가 스크립트: `scripts/eval_extraction.mjs`, `scripts/audit_report.mjs`
