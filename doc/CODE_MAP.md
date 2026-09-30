# 기능별 코드 지도

처음에는 해당 행의 진입점만 읽고 `rg -n '정확한심볼' 경로`로 좁힌다.
과거 설계 문서 전체, 원문, fixture, lockfile을 탐색 시작점으로 읽지 않는다.

| 수정할 기능 | 진입점 → 구현 | 관련 테스트 |
| --- | --- | --- |
| 서버 시작·정적 자산 | `server.js` → `src/server/routes/pages.js` | `routes.test.mjs` |
| 비밀 / 일반 설정 | `src/server/env.js` / `src/server/settings.js`, `config/runtime.json` | `env.test.mjs`, `settings.test.mjs` |
| 제공처 구성·장부 | `src/server/clients.js` → `src/llm/` | `turn_api`, `fallback_client`, `budget_never_gates` |
| 턴 API·배경 전송 | `src/server/routes/play.js` → `src/server/turn.js`, `scene.js`, `director.js` | `turn_api`, `turn`, `scene`, `director` |
| 세계관·카드 검수 API | `src/server/routes/worlds.js` → `world_store.js`, `card_library.js` | `worlds_api`, `compile_card_api` |
| 카드 자동 생성 | `src/server/compile_card.js`, `fetch_source.js` | `compile_card`, `compile_card_api` |
| 원문 분석 API | `src/server/routes/analysis.js` → `pipeline.js`, `whatif.js`, `wikisource.js` | `server_api`, `scene_pipeline` |
| 플레이 화면 | `play.html` → `src/app/play/controller.js`, `status-view.js`, `styles.css` | `routes`, `play_library` + 브라우저 확인 |
| 서재·검수·기록 화면 | `library.html` → `src/app/library.js`, `play-store.js` | `compile_card_api`, `play_library` + 브라우저 확인 |
| 세션·분기·기억 | `src/core/session.js`, `memory.js`, `sim.js` | `session`, `memory`, `sim`, `play_library` |
| 캐릭터 카드·서술 프롬프트 | `src/core/card.js` | `card` |
| 분석 조립 / 공개 API | `src/analyzer.js` | `analyzer`, `ollama_merge` |
| 분석 사전·샘플 메타데이터 | `src/config.js` (서버 실행 설정과 별개) | `analyzer` |
| 후보 인물·장소·동적 사전 | `src/analysis/seeds.js` | `analyzer` |
| 인물·장소·mention·시대 주석 | `src/analysis/entities.js` | `analyzer`, `annotations` |
| 원문 묘사 | `src/analysis/descriptions.js` | `descriptions` |
| 사건·상태·관계 구성 | `src/analysis/events.js` | `analyzer`, `review_merge` |
| Ollama 결과 병합 | `src/analysis/payload.js` | `ollama_merge` |
| 단락·장면 분할 / 별칭 매칭 | `src/analysis/segments.js` / `helpers.js` | `analyzer`, `epub` |
| 스포일러 시점·감사 | `src/core/asof.js`, `audit.js` | `asof`, `asof_qa`, `audit` |
| 원문 분석 화면 | `src/app/controller.js` → `src/app/view/`, `analysis-client.js` (HTTP/SSE) | `module_wiring` + 브라우저 확인 |
| 분석기 스타일 | `styles.css` → `src/app/styles/{base,reader,views,review-export}.css` (순서 유지) | 브라우저 확인 |
| MCP | `mcp/server.js` → `tools.js` → `src/core/`, `src/analyzer.js` | `mcp_server`, `mcp_tools` |

테스트 이름은 `tests/<이름>.test.mjs`다. 변경 후 `npm test`를 실행한다.
기능별 공개 함수는 해당 모듈에 있으며 `src/analyzer.js`의 기존 공개 경로는 유지한다.
분석 모듈은 DOM·서버에 의존하지 않는다. API에서 core를 부를 때는 동적 import를 쓴다.

일반 설정은 `config/runtime.json`의 키만 허용하고 `config/runtime.local.json`은 Git에서
제외한다. `.env`는 네 자격증명 키만 허용하며 값을 출력하지 않는다. 두 파일 모두
HTTP 정적 제공 대상이 아니다. 일반 설정을 바꾸기 위해 LLM 어댑터를 읽을 필요는 없다.
