# 로컬 Ollama LLM 분석 파이프라인 개선 계획

- 기준일: 2026-07-05
- 상태: **Phase 0~3 구현 완료** (2026-07-05). 아래 원문 계획은 유지하고,
  구현 결과·검증 상태는 이 표에서 관리한다.
- 선행 참고: nara 프로젝트군에서 검증된 로컬 LLM·하이브리드 검색·계약 테스트 패턴

## 구현 상태 (2026-07-05)

| 단계 | 상태 | 구현 위치 | 검증 |
| --- | --- | --- | --- |
| Phase 0 (오류 계약·health·계측·fixture 테스트) | 완료 | `src/server/ollama_client.js`, `GET /api/ollama/health` | `tests/ollama_client.test.mjs`, `tests/ollama_merge.test.mjs` |
| Phase 1 (장면 map-reduce·SSE·structured outputs·단발 보존) | 완료 | `src/server/pipeline.js`, `src/server/prompts.js`, `server.js`, `src/app/controller.js` | `tests/scene_pipeline.test.mjs`, `tests/server_api.test.mjs` |
| Phase 2 (상태 segment 앵커·관계 pass·합의 confidence) | 완료 | `pipeline.js` (state_changes.segment_indexes, relations pass, EntityMerger 합의) | `tests/scene_pipeline.test.mjs` |
| Phase 3 (디스크 캐시·골든 평가·문서화) | 완료 | `src/server/cache.js`, `scripts/eval_extraction.mjs`, README/doc 갱신 | `tests/cache.test.mjs`, `tests/server_api.test.mjs`(캐시 hit/force) |
| Phase 2-3 별칭 해소 LLM pass | 보류(계획대로 선택 항목) | — | — |
| Phase 3-3 실모델 비교 실행 | **보류: 로컬 Ollama 필요** | `scripts/eval_extraction.mjs --live {model}` 준비됨 | 실행 환경에서 수행 |

모든 자동 테스트(40건)는 LLM 없이 통과한다. 실제 Ollama가 있는 환경에서는
`node scripts/eval_extraction.mjs --live qwen3.5:4b`로 모델별 품질 비교를
재현할 수 있다.

## 1. 결론 요약

**현재 구조로도 로컬 Ollama(4B~7B)로 더 효과적인 구현이 가능하다.**
단, 모델을 키우는 방향이 아니라 **호출 구조를 바꾸는 방향**이어야 한다.

핵심 판단:

1. 현재 최대 병목은 모델 성능이 아니라 **컨텍스트 초과로 인한 프롬프트 절단**이다.
   이 제한은 내장 샘플이 아니라 **업로드되는 모든 TXT에 적용되는 서버 코드
   경로의 속성**이다. `buildOllamaPrompt()`는 어떤 입력이든 원문 22,000자 클립 +
   전처리 JSON ≤12,000자 + 지시문·스키마 ≈2,300자를 `num_ctx: 8192` 토큰으로
   보내므로(한국어 ≈0.7~1.5 토큰/자) 모델이 실제로 보는 본문은 대략
   5,000~8,000자에 그친다. 한국어 단편은 통상 10,000~30,000자(원고지 50~150매)
   이므로 **전형적인 업로드 단편은 대부분 절단된다.** 「날개」(22,721자)는
   측정 가능한 대표 사례일 뿐이다.
   특히 업로드 문서(`custom`)는 내장 샘플과 달리 정적 seed가 없어 LLM 경로가
   품질을 좌우하므로, 이 제한은 업로드 시나리오에서 가장 치명적이다.
   `num_ctx` 확대는 부분 해법에 그친다: 로컬 KV 캐시 부담, 소형 모델의
   장문 품질 저하, 그리고 업로드 길이에 상한이 없다는 점 때문에
   **길이 독립적인 장면 단위 분할만이 구조적 해법이다.**
2. 한 번의 호출로 인물·장소·사건 사전·상태·5W1H 프레임·관계·상태 변화를 모두
   요구하는 단발 프롬프트는 4B급 모델에게 과부하다. **장면(Scene) 단위로 쪼개고
   작업별로 좁힌 다단계 추출(map-reduce)**이 같은 모델로 더 정확하다.
3. 기존 설계의 강점 — mention 앵커링 병합(원문에서 확인 안 되는 항목 배제),
   `suggested → confirmed/edited/rejected` 검수 워크플로, evidence·confidence 계약 —
   은 그대로 유지한다. LLM은 이 게이트 앞의 후보 생성기로만 쓴다.

## 2. 현재 구현 진단

### 2.1 강점 (유지)

| 항목 | 평가 |
| --- | --- |
| mention 앵커링 병합 (`applyOllamaPayload`) | LLM 환각을 원문 근거로 걸러내는 올바른 게이트. 파이프라인을 바꿔도 최종 관문으로 유지 |
| 데이터 계약 (segments/mentions/characters/events/states/relations + status/confidence/method) | 시점별 표시·검수·출력이 모두 이 계약 위에 있음. LLM 개선은 이 계약을 바꾸지 않고 채우는 방식이어야 함 |
| 규칙 분석 독립성 | Ollama 없이도 동작. LLM은 선택 채널이라는 원칙 유지 |
| 검수 화면과 상태 워크플로 | 자동 추출을 확정 사실로 취급하지 않는 원칙. LLM 결과도 동일하게 `suggested`로 진입 |
| 회귀 테스트 (엔티티 경계) | 규칙 분석기 오탐 방지 기준선 확보 |

### 2.2 약점 (개선 대상)

| # | 문제 | 근거 | 영향 |
| --- | --- | --- | --- |
| W1 | **프롬프트가 컨텍스트를 3배 이상 초과** | 원문 22,000자 클립 + 전처리 12,000자 + 지시문, `num_ctx 8192` | Ollama는 초과분을 조용히 절단 → 모델이 실제로 본 텍스트를 알 수 없음. 「날개」 기준 대부분 유실 |
| W2 | 단발 거대 프롬프트 (7종 출력을 한 JSON에) | `buildOllamaPrompt()` 반환 스키마 | 4B 모델의 스키마 이탈·항목 누락·JSON 파손 확률 급증 |
| W3 | 서버 fetch에 timeout·오류 계약 없음 | `server.js`의 `fetch(OLLAMA_URL...)` — AbortController 없음, 오류는 `String(error.message)` 그대로 | 긴 생성 시 무한 대기 가능, 클라이언트가 원인 구분 불가 |
| W4 | JSON 파싱 단일 시도 | `JSON.parse(payload.response \|\| "{}")` | 부분 파손 응답 전체 폐기. Ollama structured outputs(스키마 강제) 미사용 |
| W5 | 진행 상황·부분 결과 없음 | 단일 블로킹 호출 | 전체 소설 분석 동안 UI 무응답, 실패 시 전부 재시도 |
| W6 | 캐시·영속 없음 | 서버 무상태 | 같은 원문 재분석마다 전체 LLM 비용 반복 |
| W7 | LLM 병합 로직 자동 테스트 없음 | `tests/`에 규칙 분석 테스트만 존재 | `applyOllamaPayload`·seed 역추출 회귀 불가, 모델·프롬프트 교체 시 품질 비교 불가 |
| W8 | 시점별 상태가 LLM과 느슨하게 연결 | 상태는 규칙 누적 + 전역 `state_hints` 우선 | 장면 단위 상태 변화(이 앱의 차별점)를 LLM이 직접 채우지 못함 |

## 3. nara에서 검증된 패턴 → what_if 적용 매핑

이 세션에서 nara 프로젝트군에 구현·테스트 완료한 패턴 중 이식 가치가 있는 것:

| nara에서 검증된 것 | what_if 적용 |
| --- | --- |
| Combiner `llm.py`: timeout·연결 실패·HTTP 오류를 짧은 구조화 오류(`{ok, error_code, message}`)로 변환, 503 구분 | `server.js` Ollama 중계에 AbortController timeout + 동일 오류 계약. stack trace·원문 예외 미노출 |
| Search `/health` diagnostics (무엇이 없는지 진단) | `GET /api/ollama/health`: 서버 도달성·허용 모델 존재·Python/kiwi 가용성을 항목별 boolean으로 → UI가 "LLM 모드 불가 원인"을 표시 |
| 하이브리드 2채널 + 채널 근거(`match_channels`) + RRF | 규칙 채널과 LLM 채널의 엔티티를 정규화 이름 키로 병합하고 `method`(이미 존재)로 출처 표시. 순위 융합은 불필요하지만 "두 채널 합의 = confidence 상향" 규칙은 채택 |
| Combiner 응답 길이 예산 + `truncated` 플래그 | 청크 크기를 토큰 예산으로 관리, 응답의 `prompt_eval_count`로 실제 소비 토큰을 진단에 기록 |
| fixture 기반 계약 테스트 (LLM·네트워크 없이 실행) | 실제 Ollama 응답을 fixture로 녹화 → `applyOllamaPayload`·병합·정규화를 node:test로 회귀. fetch는 주입 가능하게 분리 |
| 라이브 E2E 스크립트 (fixture 데이터로 실서비스 기동 검증) | `scripts/e2e_ollama.mjs`: Ollama 기동 상태에서 「감자」 축약본으로 전체 파이프라인 1회 검증 |
| Search build 진행 보고 (`/build/status` 4단계) + SSE 스트리밍(Combiner) | 장면 단위 파이프라인 진행률을 SSE로 브라우저에 push → 진행 바·부분 결과 표시 |
| 관계 edge 계약: evidence·confidence·review_status 필수, 미검수 구분 | 이미 동일 철학. LLM 관계 출력에 evidence 인용·confidence enum(`explicit/inferred/weak`)을 계속 강제하고 스키마 검증 추가 |

## 4. 목표 아키텍처: 장면 단위 map-reduce 파이프라인

```text
브라우저                     Express 서버                         Ollama
   │  POST /api/analyze/ollama   │
   │  (SSE 구독)                 │
   │                             ├─ 0. 캐시 조회 (text+model+버전 해시)
   │                             ├─ 1. 세그먼트/장면 분할 (기존 로직 재사용)
   │  ◄─ progress: scene 1/8     ├─ 2. [map] 장면별 소형 호출
   │                             │     2a. 인물·장소 추출 (좁은 스키마)
   │                             │     2b. 사건 프레임 + 상태 변화
   │                             │     ※ 롤링 cast 목록을 다음 장면에 전달
   │  ◄─ progress: scene k/8     ├─ 3. [reduce] 서버 병합
   │                             │     이름 정규화 dedupe, 별칭 통합,
   │                             │     segment 앵커 부여, evidence 검증
   │                             ├─ 4. (선택) 관계 pass: 원문 대신
   │                             │     압축된 cast+사건 목록으로 1회 호출
   │  ◄─ result: 최종 JSON       └─ 5. 캐시 저장
   │
   └─ 기존 applyOllamaPayload / mention 앵커링 병합 (변경 없음)
```

### 설계 원칙

1. **한 호출 = 한 작업 = 한 장면.** 청크 크기는 원문 1,500~2,500자로 시작해
   `prompt_eval_count`를 보고 조정한다. 지시문·스키마·cast 목록 포함
   총 프롬프트가 num_ctx의 60% 이하가 되도록 예산을 코드로 검사한다.
2. **롤링 cast 전달.** 각 장면 호출에 "지금까지 확인된 인물(정규명+별칭)" 압축
   목록을 넣어 대명사·재등장 인물의 연속성을 확보한다. (요약 전달은 2단계 후보)
3. **구조화 출력 강제.** Ollama structured outputs(`format`에 JSON Schema 전달)로
   장면별 좁은 스키마를 디코딩 수준에서 강제한다. 미지원 구버전은 기존
   `format: "json"` + 파싱 실패 시 1회 재시도로 fallback.
4. **관계는 원문이 아니라 추출물 위에서.** 관계 pass 입력은 병합된 cast·사건
   프레임 목록(압축 JSON)이므로 전체 소설이어도 컨텍스트 안에 들어간다.
5. **최종 관문은 기존 병합.** 파이프라인 출력은 지금과 같은 payload 형태로
   `applyOllamaPayload`에 전달한다. 데이터 계약·검수 화면·출력 형식 변경 없음.
6. **장면 결과는 segment 범위와 함께 반환**하므로 mention 앵커링이 문서 전체가
   아닌 해당 범위에서만 수행된다 → 동명이인·중복 앵커 오류 감소, 시점별
   상태 변화(W8)가 장면 단위로 직접 채워진다.

## 5. 단계별 실행 계획

### Phase 0 — 계측·안전장치·테스트 기반 (선행, 소규모)

작업:

1. Ollama 호출에 AbortController timeout(환경변수, 기본 120s)과 구조화 오류
   계약(`{ok:false, error_code, message}` — `CONNECTION_FAILED/TIMEOUT/BAD_RESPONSE/UPSTREAM_ERROR`) 적용.
2. `GET /api/ollama/health` 추가: 도달성, 허용 모델 목록, Python/kiwi 가용성.
3. 응답의 `prompt_eval_count`/`eval_count`를 로그·진단에 기록 —
   **W1 절단을 수치로 확인하는 것이 이 Phase의 핵심 산출물.**
4. 서버 Ollama 로직을 `src/server/ollama.js`(가칭)로 분리하고 fetch 주입 가능하게
   만들어 node:test 단위 테스트 작성. 실제 응답 2종(정상/파손)을 fixture로 녹화.
5. `applyOllamaPayload`·`buildDynamicSeedLexicon` fixture 회귀 테스트 추가 (W7).

완료 기준:

- Ollama 미기동/timeout/파손 JSON이 각각 구분된 오류로 클라이언트에 도착한다.
- 「날개」 단발 프롬프트의 실제 소비 토큰과 절단 여부가 진단 로그로 확인된다.
- LLM 없이 `npm test`로 병합 로직 회귀가 돈다.

### Phase 1 — 장면 단위 map 추출 (핵심)

작업:

1. 서버에서 세그먼트/장면 분할을 수행(브라우저 분할 로직과 동일 규칙)하고
   장면별 추출 호출 2종(엔티티 / 사건·상태)을 순차 실행.
2. 롤링 cast 목록 전달, 장면별 좁은 JSON Schema로 structured outputs 적용.
3. 토큰 예산 검사기: 프롬프트 구성 시점에 예산 초과면 청크를 더 쪼갠다.
4. reduce 병합기: 이름 정규화 dedupe(기존 `normalizeEntityNameKey` 재사용),
   별칭 누적, evidence가 해당 장면 원문에 실제 존재하는지 서버에서 검증.
5. SSE 진행 스트림(`progress`, `scene_result`, `done`, `error` 이벤트).
   브라우저는 진행 바 표시, 완료 시 기존 병합 경로 실행.
6. 기존 단발 경로는 `?mode=single` 등으로 당분간 보존(품질 비교용).

완료 기준:

- 「날개」 전문(22,721자)이 절단 없이 전 장면 분석된다.
- 「감자」에서 단발 대비 인물·장소 recall이 같거나 높고, 회귀 테스트의
  오탐 금지 목록(`모양`, `조밥`, `불길` 등)을 LLM 병합 후에도 통과한다.
- 장면별 부분 실패가 전체 실패로 번지지 않는다(실패 장면은 규칙 분석만 사용,
  진단에 기록).

### Phase 2 — 시점별 상태·관계 품질

작업:

1. 장면별 상태 변화 출력(before/after: 위치·심리·신체·지식)을 해당 장면
   segment 범위에 앵커해 `CharacterState` 타임라인을 직접 채운다.
   규칙 누적 상태는 LLM 상태가 없는 구간의 보간으로 유지.
2. 관계 pass: 병합된 cast + 사건 프레임 목록(압축)으로 1회 호출,
   허용 관계 스키마(기존 프롬프트의 화이트리스트) + evidence 인용 강제.
3. 별칭 해소 pass(선택): cast 목록과 대표 mention 문맥으로 병합 후보 제안 →
   `suggested` 상태로 검수 화면에 노출 (자동 확정 금지).
4. 두 채널 합의 규칙: 규칙 분석과 LLM이 같은 엔티티를 낸 경우 confidence 상향,
   LLM 단독 항목은 `inferred` 이하로 유지.

완료 기준:

- 인물 상태 화면에서 장면 경계마다 상태 변화 근거(evidence)가 표시된다.
- 관계 edge 전부가 evidence·confidence·status를 갖고, 미검수 관계가 구분된다.
- 상태·관계 출력이 스포일러 차단 범위 계산과 일관된다.

### Phase 3 — 캐시·평가·운영

작업:

1. 서버 디스크 캐시: `hash(text + model + prompt_version)` → 결과 JSON.
   "LLM Seed 재생성"은 캐시 무시. 캐시 디렉터리는 Git 제외.
2. 골든 평가셋: 「날개」·「감자」의 확정(confirmed) 엔티티·사건 목록을 fixture로
   고정하고, 모델·프롬프트 버전별 precision/recall 리포트 스크립트 작성.
   (외부 벤치마크 수치를 완료 기준으로 쓰지 않는다 — 자체 fixture 기준)
3. 모델 비교 1회 실행: `qwen3.5:4b` vs `gemma4:e4b` vs 7B 1종, 같은 평가셋.
4. 문서화: 파이프라인 다이어그램, 오류 계약, 캐시·재생성 절차를 doc/README에 반영.

완료 기준:

- 같은 원문 재분석이 캐시로 즉시 반환된다.
- 모델 교체·프롬프트 수정 시 평가 스크립트 한 번으로 품질 회귀를 확인할 수 있다.

### 보류 (이번 범위 아님)

- 임베딩(Ollama `/api/embed`) 기반 인물 문맥 검색·별칭 유사도 — Phase 2 별칭
  pass가 부족할 때만 검토
- 분석 결과의 서버 영속(DB)·다중 문서 라이브러리
- MCP read-only 어댑터(nara_mcp 패턴 이식) — 외부 에이전트 소비 수요 확인 후
- 장편·다중 파일 지원, 실시간 협업 검수

## 6. 데이터 계약 영향

**변경 없음이 원칙.** 추가되는 것은 다음뿐이다.

- `diagnostics.ollama`에 파이프라인 메타 추가: `mode(single|scene)`, 장면 수,
  실패 장면, 소비 토큰 합계, 캐시 적중 여부
- (Phase 2) `CharacterState`에 `method: "ollama-scene:{model}"` 값 사용 —
  필드 자체는 기존 계약에 이미 존재

## 7. 테스트 전략

| 층 | 내용 | LLM 필요 |
| --- | --- | --- |
| 단위 | 토큰 예산 검사기, 청크 분할, 이름 정규화 병합, evidence 존재 검증 | 없음 |
| 계약 | fixture 응답(정상/파손/부분)에 대한 파싱·오류 변환·병합 | 없음 (fetch 주입) |
| 회귀 | 기존 엔티티 경계 테스트 + LLM 병합 후에도 오탐 금지 목록 유지 | 없음 |
| 평가 | 골든셋 precision/recall 리포트 (모델·프롬프트 버전 비교) | 로컬 Ollama |
| E2E | 「감자」 전문 1회: SSE 진행 → 병합 → 검수 화면 데이터 확인 | 로컬 Ollama |

## 8. 리스크와 대응

| 리스크 | 대응 |
| --- | --- |
| 장면 수만큼 호출 증가 → 전체 시간 증가 | 장면별 진행 표시 + 부분 결과 즉시 병합, 캐시, (로컬 자원 고려) 동시성 1~2 제한. 단발 모드가 절단으로 사실상 미동작이므로 순수 손실 아님 |
| 4B 모델의 스키마 이탈 | structured outputs로 디코딩 강제 + 작업별 좁은 스키마 + 파손 fixture 회귀 |
| 롤링 cast 오염(잘못된 인물이 계속 전파) | cast에는 2회 이상 등장 또는 규칙 채널 합의 인물만 편입, 나머지는 장면 로컬 후보로 유지 |
| 장면 경계가 실제 장면과 불일치 | 현재 균등 분할을 그대로 사용하되 겹침(overlap) 1문단 옵션. 의미 기반 장면 분할은 명시적 비목표 유지 |
| evidence 인용이 원문과 불일치(모델 변형 인용) | 서버에서 부분 문자열 검증, 실패 시 confidence 강등 + 앵커링 게이트가 최종 차단 |
| Ollama 버전별 structured outputs 미지원 | `format:"json"` fallback 경로 유지, health에서 서버 버전 노출 |

## 9. 성공 판정 (전체)

1. 「날개」 전문이 절단 없이 LLM 분석되고, 그 사실이 토큰 계측으로 증명된다.
2. LLM 미기동·실패 시에도 앱은 규칙 분석으로 완전 동작하며 원인이 UI에 표시된다.
3. LLM 병합 후에도 기존 오탐 회귀 테스트가 전부 통과한다.
4. 시점 슬라이더의 인물 상태가 장면 단위 LLM 근거(evidence)를 갖는다.
5. `npm test`가 LLM 없이 통과하고, 평가 스크립트가 모델 간 품질 비교를 재현한다.
