# Novel IF Reader 기술 설계 문서

Updated: 2026-07-04

이 문서는 현재 저장소에 구현된 구조와 동작을 설명한다. 설치와 실행 방법은 루트의 [`README.md`](../README.md)를 기준으로 하며, 이 문서는 분석 파이프라인·데이터 계약·화면 상태·제약 사항을 다룬다.

## 1. 제품 범위

Novel IF Reader는 한국어 소설 원문을 문단 단위로 분석해 다음 정보를 제공하는 로컬 웹 애플리케이션이다.

- 인물, 장소, 사건과 원문 근거
- 인물별 심리·신체 상태와 알려진 사실
- 인물-사건-장소 관계 그래프
- 독서 진행 위치까지의 사건 타임라인
- 자동 추출 결과의 검수·수정·제외
- 분석 결과의 구조화 출력

핵심 원칙은 다음과 같다.

1. 자동 추출 결과는 확정 사실이 아니라 `suggested` 상태의 후보로 취급한다.
2. 객체와 사건은 원문 segment 및 문자 offset으로 근거를 추적한다.
3. 스포일러 차단 상태에서는 현재 독서 위치 이후의 객체와 사건을 렌더링·출력하지 않는다.
4. 외부 문서는 오탐을 줄이기 위해 보수적으로 분석하고, 누락은 검수 화면에서 보완한다.

## 2. 현재 구현 상태

### 구현됨

- 이상 「날개」, 김동인 「감자」 내장 샘플
- TXT 업로드와 원문 직접 편집
- 빠른 분석(브라우저 규칙 기반)
- Ollama 4B~7B 모델을 이용한 **분석 청크 단위 map-reduce 추출 파이프라인**
  (길이 제한 없음, structured outputs, 롤링 cast, evidence 검증, 관계 pass)
- SSE 진행 스트림과 장면 진행률 표시
- 분석 결과 디스크 캐시(`cache/`)와 `force` 재생성
- `GET /api/ollama/health` 진단과 구조화 오류 계약
- Python/`kiwipiepy` 형태소 전처리와 정규식 fallback
- Reader, 관계 지도, 사건 타임라인, 인물 상태 화면
- `/check` 검수 화면
- 브라우저 `localStorage` 스냅샷
- JSON, CSV, Markdown, TimelineJS, Graph JSON 출력
- Node 내장 테스트 러너 기반 회귀 테스트 (분석기·클라이언트·파이프라인·서버 API)
- 골든셋 precision/recall 평가 스크립트 (`scripts/eval_extraction.mjs`)

### 구현되지 않음

- 데이터베이스와 서버 영속 저장
- 사용자 계정, 권한, 협업 검수
- 의미 기반 장면 경계 모델
- 완전한 한국어 공지시·대명사 해소
- 인물·장소 병합/분리 전용 UI
- 실제 지도 좌표 자동 연결
- 내보내기 파일 다운로드

## 3. 런타임 구조

```text
Browser
  index.html
      │
      ▼
  src/app/controller.js ───────────────┐
      │                                │ optional
      ├─ src/analyzer.js               ▼
      ├─ src/app/editing.js       Express server.js
      └─ src/app/view/*                 │
                                       ├─ scripts/korean_morph.py
                                       └─ Ollama HTTP API
```

- 프론트엔드는 빌드 단계가 없는 Vanilla JavaScript ES modules 구조다.
- `server.js`는 CommonJS 기반 Express 프로세스로 정적 파일과 Ollama 중계 API를 제공한다.
- 빠른 분석은 브라우저에서 완료되며 서버나 Ollama가 없어도 동작한다.
- 상세 분석에서만 원문이 로컬 Express API를 거쳐 Python 전처리와 Ollama로 전달된다.
- 데이터베이스는 없으며 서버는 분석 결과를 보관하지 않는다.

## 4. 디렉터리와 책임

```text
novel_if/
├─ index.html
├─ styles.css
├─ server.js
├─ src/
│  ├─ config.js
│  ├─ analyzer.js
│  └─ app/
│     ├─ controller.js
│     ├─ context.js
│     ├─ editing.js
│     ├─ utils.js
│     ├─ views.js
│     └─ view/
│        ├─ router.js
│        ├─ selectors.js
│        ├─ reader.js
│        ├─ map.js
│        ├─ timeline.js
│        ├─ characters.js
│        ├─ review.js
│        └─ export.js
├─ scripts/
│  └─ korean_morph.py
├─ texts/
│  ├─ wings.txt
│  └─ gamja.txt
└─ tests/
   ├─ analyzer.test.mjs
   └─ fixtures/
```

| 파일 | 책임 |
|---|---|
| `src/config.js` | 샘플 메타데이터, 상태값, 사건·상태 사전, 내장 작품 seed |
| `src/analyzer.js` | segment·scene 생성, 엔티티·사건 추출, Ollama 병합, 상태·관계 계산 |
| `src/app/controller.js` | 초기화, 입력 이벤트, 분석 모드 선택, 스냅샷, 라우팅 연결 |
| `src/app/context.js` | 단일 UI 상태와 DOM 참조 |
| `src/app/editing.js` | 검수 상태 변경, 필드 편집, 수동 사건 추가 |
| `src/app/view/selectors.js` | 독서 범위·필터·상태에 따른 표시 데이터 계산 |
| `server.js` | 정적 서버, Ollama 모델 조회와 분석 요청 |
| `scripts/korean_morph.py` | Kiwi 또는 정규식을 이용한 한국어 후보 전처리 |

## 5. 실행 설정

### 필수

- Node.js 18 이상
- npm

### 선택

- Ollama: 상세 분석 사용 시 필요
- Python 3: 상세 분석용 한국어 전처리 시 사용
- `kiwipiepy`: Python 형태소 분석 품질 향상

### 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `3000` | Express 서버 포트 |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama API 기준 주소 |
| `PYTHON` | `python` | 형태소 worker 실행 파일 |

Python 실행 또는 `kiwipiepy` import가 실패하면 Node/Python 정규식 fallback으로 전환된다. 이 실패는 빠른 분석을 중단하지 않는다.

## 6. 입력 유형과 분석 모드

### 입력 유형

| 유형 | `sample_id` | seed |
|---|---|---|
| 「날개」 | `wings` | 작품별 정적 인물·장소 seed |
| 「감자」 | `gamja` | 작품별 정적 인물·장소 seed |
| 업로드 TXT | `custom` | 원문에서 생성한 동적 seed |

업로드 파일명에서 문서 제목을 만들며, 업로드 원문은 서버에 저장하지 않는다.

### 빠른 분석 (기본)

기본 모드다. `analyzeNovel()`이 브라우저에서 동기적으로 실행된다.

1. 줄바꿈과 공백을 정규화한다.
2. 빈 줄을 기본 경계로 `Segment`를 만들되, 긴 문단은 문장 경계를 우선해 약 1,000자 단위로 나눈다.
3. segment를 최대 12개 그룹으로 균등 분할해 화면 탐색용 임시 `Scene`을 만든다.
4. 내장 seed 또는 외부 문서용 동적 seed로 인물·장소를 추출한다.
5. 원문 문자 범위와 연결된 `Mention`을 생성한다.
6. 문장별 사건 유형과 참여 인물·장소를 계산한다.
7. mention을 이용해 사건 연결을 보정한다.
8. 인물 상태와 관계를 다시 계산한다.

### 상세 분석 (로컬 AI)

`상세 분석 (로컬 AI)` 또는 `상세 분석 새로 실행`을 선택하면 다음 순서로 실행된다.

1. 브라우저가 `POST /api/analyze/ollama`(SSE)로 원문과 모델명을 보낸다.
2. 서버가 캐시(`sha256(text+model+mode+prompt_version)`)를 조회한다.
   `상세 분석 새로 실행`은 `force`로 캐시를 우회한다.
3. 서버가 원문을 문장 경계를 우선한 분석 청크(기본 약 1,000자)로 나눈다. 원문 길이
   제한이 없으며, 각 호출의 프롬프트는 `num_ctx`의 60% 이하로 예산을 검사한다.
4. 분석 청크마다 두 번의 소형 호출을 한다 — (a) 인물·장소 추출, (b) 사건 프레임과
   상태 변화 추출. Ollama structured outputs(JSON Schema `format`)로 응답
   구조를 디코딩 수준에서 강제하고, 파싱 실패는 1회 재시도한다.
5. 앞 청크까지 확인된 인물 목록(롤링 cast)을 다음 청크 프롬프트에 전달해
   재등장 인물의 이름 연속성을 유지한다. cast에는 2개 청크 이상 등장했거나
   규칙 채널(정규식 후보)과 합의된 인물만 편입한다.
6. 서버가 청크 결과를 병합한다 — 이름 정규화 dedupe, 별칭 누적, evidence가
   해당 청크 원문에 실제 존재하는지 검증(불일치 시 confidence 강등),
   2개 청크 이상 등장·규칙 합의 인물은 confidence 상향.
7. 관계 pass: 원문 대신 병합된 cast·사건 프레임 요약을 입력으로 1회 호출하고,
   허용 관계 화이트리스트 밖의 관계를 버린다.
8. 청크별 진행(`progress`)이 SSE로 브라우저에 전달되어 버튼에 표시된다.
   일부 청크 실패는 진단(`scenes_failed`)에 기록될 뿐 전체 실패로 번지지 않는다.
9. 브라우저는 최종 payload로 동적 seed를 만들고 규칙 분석을 실행한 뒤,
   Ollama 객체가 실제 원문 mention과 연결될 때만 병합한다 (기존과 동일).
10. 동적 seed에서 인물 mention을 하나도 찾지 못하면 규칙 분석으로 재실행한다.

상태 변화(`state_changes`)는 추출된 분석 청크의 segment 번호(`segment_indexes`)와
함께 반환되어 시점별 인물 상태 표시의 근거가 된다.

`scene-v2`부터 분석 청크 목표 크기는 1,000자다. 이전 `scene-v1` 캐시는
프롬프트 버전이 캐시 키에 포함되므로 자동으로 재사용되지 않는다. 응답 진단의
`target_chars`는 요청한 청크 목표 크기, `scenes_total`은 실제 분석 청크 수다.
분석 청크가 60개를 넘는 장문은 목표 크기를 단계적으로 늘려 호출 수를 제한한다.
정상 실행의 모델 호출 수는 기본적으로 `청크 수 × 2 + 관계 pass 1회`이므로,
기존 2,000자 분할보다 처리 시간은 늘지만 청크 내부 사건 압축과 누락 가능성은 줄어든다.

허용 모델은 태그 또는 모델 정보에서 4B~7B로 판별되는 completion 모델이다.
요청 옵션은 `temperature: 0.1`, `num_ctx: 8192`이다. `mode: "single"`로 기존
단발 프롬프트(원문 22,000자 클립 + 형태소 전처리 컨텍스트)를 비교용으로 호출할
수 있으며, 이 모드는 긴 원문에서 절단 위험이 있어 진단(`truncation_risk`)으로
보고된다.

서버 구현: `src/server/ollama_client.js`(HTTP·오류 계약), `src/server/prompts.js`
(프롬프트·JSON Schema·토큰 예산), `src/server/pipeline.js`(장면 분할·병합),
`src/server/cache.js`(디스크 캐시), `src/server/morph.js`(전처리).

## 7. 외부 문서 엔티티 경계 규칙

외부 문서는 정적 작품 사전이 없으므로 일반 명사·수식어·조사를 객체로 오인하기 쉽다. 현재 분석기는 정확도를 우선해 다음 규칙을 적용한다.

### 인물

- 공백 없는 한국어 어절에서 조사를 분리한다.
- `아내`, `남편`, `마나님`, `선생`, `감독`, `서방` 같은 명시적 사람 지칭어를 우선한다.
- 일반 이름 후보는 반복 출현, 주격·화제 조사, 사람 행위 문맥이 함께 있어야 한다.
- 장소 접미사나 일반 추상 명사로 판단되는 이름은 제외한다.
- `모양`, `조밥`, `마음`, `얼굴`, `머리`, `소리` 등의 오탐 후보를 차단한다.

### 장소

- 장소명 후보에는 공백을 허용하지 않아 앞 문장의 수식어가 포함되지 않게 한다.
- `집`, `길`, `문`, `역`, `시장`, `학교`, `빈민굴`, `묘지` 등의 핵심 명사를 찾는다.
- 처소 조사, 이동 동사 문맥 또는 장소성이 강한 합성어를 근거로 사용한다.
- `불길`, `시집`, `징역`, `가능성`, `들어가게`처럼 장소 접미사와 철자가 겹치는 일반어·활용형을 제외한다.
- 예를 들어 `마나님은 전찻길을 건너갔다`는 인물 `마나님`과 장소 `전찻길`로 분리한다.

### Mention 경계

- 별칭은 긴 표현부터 검사한다.
- 한글 단어 내부의 부분 문자열은 mention으로 인정하지 않는다.
- 동일 구간에서 겹치는 별칭은 가장 긴 mention 하나만 남긴다.
- seed 생성 후 별도의 광역 정규식 후보 패스를 실행하지 않는다.

이 규칙은 [`doc/tast.md`](tast.md)의 문제 사례와 `tests/analyzer.test.mjs`의 회귀 테스트로 관리한다.

## 8. 분석 데이터 계약

`analysis` 최상위 객체는 다음 컬렉션을 가진다.

```text
analysis
├─ document
├─ segments[]
├─ scenes[]
├─ mentions[]
├─ characters[]
├─ locations[]
├─ events[]
├─ states[]
├─ relations[]
├─ dynamic_lexicon
└─ diagnostics
```

### 주요 객체

| 객체 | 주요 필드 |
|---|---|
| `Document` | `document_id`, `sample_id`, `title`, `author`, `publication_year`, `language`, `source`, `source_url`, `rights`, `created_at` |
| `Segment` | `segment_id`, `document_id`, `index`, `scene_id`, `text`, `char_start`, `char_end` |
| `Scene` | `scene_id`, `index`, `start_segment_id`, `end_segment_id`, `summary` |
| `Mention` | `mention_id`, `entity_type`, `entity_id`, `text`, `segment_id`, `char_start`, `char_end`, `status`, `confidence`, `method` |
| `Character` | `character_id`, `canonical_name`, `aliases`, `mentions`, `first_segment_id`, `description`, `role`, `status`, `confidence`, `method` |
| `Location` | `location_id`, `name`, `aliases`, `mentions`, `first_segment_id`, `type`, `parent_location_id`, `narrative_coords`, `status`, `confidence`, `method` |
| `Event` | `event_id`, `type`, `summary`, `segment_id`, `scene_id`, `sentence_index`, `characters`, `locations`, `source_span`, `status`, `confidence`, `method` |
| `CharacterState` | `state_id`, `character_id`, `segment_id`, `location_id`, `mental_state`, `physical_state`, `known_facts`, `source_event_ids`, `status` |
| `Relation` | `relation_id`, `source_type`, `source_id`, `target_type`, `target_id`, `relation_type`, `event_ids`, `segment_ids`, `weight`, `status` |

### 상태값

| 상태 | 의미 |
|---|---|
| `suggested` | 자동 분석이 제안한 초기 상태 |
| `confirmed` | 사용자가 확정 |
| `edited` | 사용자가 수정 |
| `rejected` | 분석과 표시에서 제외 |
| `manual` | 사용자가 직접 생성 |

`active` 필터는 저장된 상태가 아니라 `rejected`가 아닌 항목을 뜻한다.

### 사건 유형

- `appearance`
- `movement`
- `conversation`
- `perception`
- `conflict`
- `realization`
- `stasis`
- `symbolic`
- `background`

### 자동 관계 유형

| source | relation | target |
|---|---|---|
| character | `participates_in` | event |
| character | `appears_in` | location |
| event | `takes_place_at` | location |

동일 관계가 여러 사건에서 반복되면 `weight`, `event_ids`, `segment_ids`를 누적한다.

## 9. 상태 계산

인물 상태는 segment 순서로 누적 계산된다.

- 인물 mention 또는 참여 사건이 있는 segment에서 상태 레코드를 만든다.
- 사건의 장소가 있으면 현재 장소를 갱신한다.
- Ollama `state_hints`가 있으면 해당 값을 우선한다.
- 그렇지 않으면 동적/정적 상태 사전과 사건 유형으로 심리·신체 상태를 추론한다.
- 최근 사건 요약 최대 5개를 `known_facts`로 유지한다.
- 확정적인 단서가 없으면 `상태 단서 부족`, `신체 단서 부족`으로 표시한다.

인물·장소·사건의 상태 변경이나 수동 사건 추가 후에는 states와 relations를 다시 계산한다.

## 10. 화면과 라우팅

### `/`

| 영역 | 동작 |
|---|---|
| Reader | 원문 입력, segment 목록, 독서 위치 변경 |
| 관계 지도 | 현재 segment의 인물·장소·사건 연결 표시 |
| Inspector | 선택 객체의 상태, 근거, 검수 버튼 표시 |
| 사건 흐름 | 현재 독서 범위까지 사건을 segment 순으로 표시 |
| 인물 상태 | 상태 이력, 관계, 공간 궤적, 등장 밀도 표시 |
| 내보내기 | 현재 scope의 분석 데이터를 형식별 텍스트로 생성 |

### `/check`

- 현재 segment 원문에서 mention과 사건 근거를 강조한다.
- 인물, 장소, 사건을 신뢰도 오름차순으로 표시한다.
- 인물명, 장소명, 사건 요약을 직접 편집한다.
- 항목을 `confirmed`, `edited`, `rejected`로 변경한다.
- 현재 segment에 `manual` 사건을 추가한다.
- 재계산 버튼은 현재 편집 결과로 states와 relations를 다시 만든다.

라우팅은 History API를 사용하며 두 경로 모두 같은 `index.html`을 렌더링한다.

## 11. 스포일러 범위와 필터

전역 UI 상태는 `src/app/context.js`의 `state` 객체가 보유한다.

```js
{
  currentSegment: 1,
  spoilerSafe: true,
  selected: null,
  exportFormat: "json",
  filters: {
    eventType: "all",
    status: "active",
    entity: "all"
  }
}
```

스포일러 차단이 켜져 있으면 다음 조건을 적용한다.

- visible segment: `segment.index <= currentSegment`
- map: 현재 segment의 사건만 사용
- timeline/review/export: visible segment까지만 사용
- character/location: 첫 등장 segment가 visible 범위에 있어야 함
- relation: visible segment를 하나 이상 근거로 가져야 함

스포일러 차단을 끄면 전체 문서를 scope로 사용한다. 사건 유형, 엔티티, 검수 상태 필터는 scope 계산 뒤 추가 적용된다.

## 12. 검수와 편집의 영향

- 이름 또는 설명 수정 시 `suggested` 항목은 `edited`로 바뀐다.
- 인물·장소 상태를 변경하면 연결된 mention 상태도 함께 바뀐다.
- `rejected` 객체와 사건은 상태·관계 재계산에서 제외된다.
- 사건 요약 수정은 해당 사건 객체에 즉시 반영된다.
- 수동 사건은 현재 segment와 source span을 사용하고 confidence `1`로 생성된다.
- 인물 별칭은 쉼표 구분 입력으로 편집한다.

현재 편집은 메모리에서 이루어진다. 유지하려면 **현재 결과 저장**으로 스냅샷을 저장해야 한다.

## 13. 저장

브라우저 스냅샷 키는 `novel-if-reader:snapshot:v2`다.

저장 항목:

- 전체 `analysis`
- 현재 원문
- 현재 sample ID
- 업로드 문서 메타데이터

저장 위치는 현재 브라우저의 `localStorage`이며 서버·다른 브라우저·다른 기기와 동기화되지 않는다.

## 14. 출력 형식

모든 출력은 현재 스포일러 scope와 상태 필터를 적용한다.

| 형식 | 내용 |
|---|---|
| JSON | scope가 적용된 전체 분석 객체 |
| CSV | 사건 ID, segment, 유형, 상태, 신뢰도, 참여 객체, 요약, 원문 근거 |
| Markdown | 문서 제목과 인물·장소·사건 요약 |
| TimelineJS | segment 순서를 날짜처럼 변환한 TimelineJS 호환 JSON |
| Graph JSON | character/location/event node와 relation edge |

현재 UI는 textarea에 결과를 표시하고 클립보드 복사만 제공한다.

## 15. 서버 API

### `GET /api/ollama/models`

Ollama `/api/tags`를 조회하고 completion capability 및 4B~7B 조건을 만족하는 모델만 반환한다.

성공 응답:

```json
{
  "models": [
    {
      "name": "qwen3.5:4b",
      "parameter_size": "4B",
      "context_length": 8192,
      "installed": true,
      "allowed": true
    }
  ]
}
```

### `POST /api/analyze/ollama`

요청:

```json
{
  "text": "소설 원문",
  "model": "qwen3.5:4b"
}
```

응답:

```json
{
  "model": "qwen3.5:4b",
  "mode": "scene",
  "analysis": {
    "characters": [],
    "locations": [],
    "event_frames": [],
    "relationships": [],
    "state_changes": []
  },
  "diagnostics": {
    "prompt_version": "scene-v2",
    "target_chars": 1000,
    "scenes_total": 6,
    "scenes_failed": [],
    "cache": "miss"
  }
}
```

`scenes_total`과 `scenes_failed`의 `scene` 번호는 호환성을 위해 유지한 필드명이며,
여기서 scene은 화면의 `Scene`이 아니라 Ollama 분석 청크를 뜻한다. SSE의
`progress.scene`과 `progress.total`도 같은 분석 청크 번호와 전체 개수다.

빈 원문 또는 허용 범위 밖 모델은 `400`, Ollama 연결·응답·JSON 파싱 실패는 `502`를 반환한다. Express JSON 본문 제한은 2MB다.

## 16. 테스트

```powershell
npm.cmd test
```

현재 회귀 테스트는 다음을 검증한다.

- 한국어 인물과 장소 핵심 명사의 분리
- 형용사·부사·조사·일반 명사의 객체 오인 방지
- 공백이 포함된 문장 조각을 장소명으로 생성하지 않음
- 「감자」를 외부 TXT처럼 분석해도 주요 인물·장소가 유지됨
- 긴 단편과 단일 장문 문단이 1,000자 이하 분석 청크로 분할됨
- 청크별 추출 병합, 부분 실패, evidence 검증과 관계 화이트리스트

Python fallback은 동일 fixture를 `build_regex_context()`에 전달해 별도로 검증할 수 있다.

## 17. 알려진 제약과 설계 판단

### 정확도 우선 외부 문서 분석

일반 규칙만으로 한국어 고유명사와 보통명사를 완전히 분리할 수 없다. 현재 구현은 잘못된 객체를 대량 생성하는 것보다 단서가 약한 1회성 이름을 누락하는 쪽을 선택한다.

### 단순 장면 분할

Scene은 의미 변화가 아니라 약 1,000자 이하 segment 개수를 기준으로 최대 12개 그룹으로 나눈다. 사건 순서 탐색용 임시 단위이며 서사학적 장면 판정이 아니다. Ollama 진행률에 표시되는 분석 청크와 화면의 Scene은 서로 다른 단위다.

### 제한된 공지시 처리

대명사, 생략 주어, 별칭 군집, 동일 인물 병합은 완전하게 해결되지 않았다. LLM 관계와 원문 mention을 이용해 일부 보정하지만 검수가 필요하다.

### 로컬 LLM 의존성

Ollama 결과의 품질과 처리 시간은 모델·하드웨어·원문 길이에 따라 달라진다. 서버는 외부 지식을 조회하지 않으며 Ollama JSON도 원문 mention과 연결되지 않으면 객체로 병합하지 않는다.

### 브라우저 전용 저장

스냅샷은 데이터베이스가 아니며 브라우저 데이터 삭제 시 함께 사라진다.

## 18. 다음 우선순위

1. 외부 작품 fixture를 늘려 인물·장소 경계 규칙을 회귀 검증한다.
2. 인물·장소 병합/분리와 alias 이동을 지원하는 검수 UI를 추가한다.
3. 대명사·생략 주어를 기존 인물에 연결하는 한국어 공지시 단계를 분리한다.
4. Ollama seed에 대한 구조·근거 검증을 강화한다.
5. semantic scene 분할을 현재 단순 그룹 방식과 교체 가능한 adapter로 추가한다.
6. 파일 다운로드 또는 서버 저장이 필요해질 때 현재 analysis schema를 그대로 영속화한다.
