# Novel IF Reader Open Source Stack Design

Updated: 2026-06-14

## 1. 목적

Novel IF Reader는 소설 원문을 입력하면 인물, 장소, 사건, 인물 상태 변화를 추출하고, 독서 진행 위치에 맞춰 타임라인과 공간/관계 그래프를 보여주는 소설 분석 웹 앱이다.

이 문서는 다음 오픈소스 계열을 참고해 앱을 설계하기 위한 계획서다.

- 엔진 참고: BookNLP
- 검수 워크플로 참고: INCEpTION, brat, doccano
- 시각화 참고: nodegoat, Palladio, TimelineJS

핵심 방향은 자동 추출 결과를 그대로 믿는 분석기가 아니라, 원문 근거를 가진 추출 결과를 만들고 사용자가 검수해 품질을 높이는 human-in-the-loop 분석 도구다.

이 문서는 `doc/plan.md`의 제품 목표를 현재 구현 가능한 MVP 구조로 구체화한다. 세부 객체와 UI 컴포넌트 계약은 `doc/component.md`를 따른다.

## 2. 참고 프로젝트별 적용 범위

### 2.1 BookNLP

BookNLP는 장문 서사 텍스트에 특화된 NLP 파이프라인이다. 다음 기능을 설계 기준으로 삼는다.

- 인물명과 별칭 클러스터링
- 인물/장소/조직 등 엔티티 추출
- 공지시와 지칭 표현 처리
- 발화자 추정
- 사건 태깅
- 인물별 행동, 소유물, 수식어, 상태 정보 산출
- 원문 token/offset 기반 결과 파일 생성

현재 앱에는 BookNLP를 직접 내장하기보다 BookNLP식 출력 모델을 참고한 `analysis model`을 먼저 정의한다. 한국어 소설 분석에서는 BookNLP가 영어 중심이라는 제약이 있으므로, 분석 엔진은 교체 가능한 adapter 구조로 둔다.

초기 엔진 후보:

- 현재 규칙 기반 엔진
- 한국어 형태소 분석기 기반 엔진
- LLM 기반 구조화 추출 엔진
- 향후 영어 텍스트용 BookNLP adapter

### 2.2 INCEpTION

INCEpTION은 annotation project, layer, recommender, curator workflow가 강점이다. 다음 개념을 참고한다.

- 문서 단위 프로젝트 관리
- annotation layer 분리
- 자동 추천과 사람 검수 분리
- 다중 annotator 결과 비교
- 최종 curated annotation 생성

Novel IF Reader에서는 전체 기능을 그대로 구현하지 않고, 단일 사용자 중심의 간소화된 검수 모델로 시작한다.

적용 항목:

- 자동 추출 결과를 `suggested` 상태로 저장
- 사용자가 확인하면 `confirmed`
- 사용자가 수정하면 `edited`
- 사용자가 제거하면 `rejected`
- 최종 내보내기는 `confirmed`와 `edited` 중심

### 2.3 brat

brat은 텍스트 위에 엔티티와 관계를 직접 표시하고 수정하는 annotation UI가 강점이다.

적용 항목:

- 원문 문단/문장 위에 인물, 장소, 사건 span 표시
- 인물-사건, 사건-장소, 인물-인물 관계를 시각적으로 확인
- 각 추출 결과가 어떤 원문 구간에서 나왔는지 offset으로 연결
- 검수 화면에서 원문과 annotation을 분리하지 않음

현재 앱의 검수 탭은 brat식 inline review 영역으로 발전시킨다.

### 2.4 doccano

doccano는 범용 텍스트 annotation 도구로, 프로젝트 생성, 데이터 업로드, 라벨 정의, annotation, export 흐름이 간단하다.

적용 항목:

- 텍스트 업로드/샘플 로드
- 라벨셋 관리
- JSONL/CSV/Markdown export
- 작업 단위 progress 표시
- 간단한 협업 확장 가능성

MVP에서는 복잡한 계정/협업 기능 없이 doccano식 단순 workflow만 차용한다.

### 2.5 nodegoat

nodegoat은 인문학 데이터의 객체, 관계, 시간, 공간을 함께 다루는 데이터 관리/시각화 환경이다.

적용 항목:

- 인물, 장소, 사건을 독립 객체로 관리
- 객체 간 관계를 edge로 관리
- 시간 순서와 공간 이동을 동시에 표현
- 필터 가능한 관계망

Novel IF Reader에서는 nodegoat의 연구 데이터 모델링 관점을 참고해 analysis result를 단순 배열이 아니라 graph-ready dataset으로 설계한다.

단, 현재 화면의 Map에서는 사건을 node로 표시하지 않는다. 사건은 Timeline과 Inspector에서 설명 데이터로 보여주고, Map에서는 인물-인물 또는 인물-장소 edge의 근거로만 사용한다.

### 2.6 Palladio

Palladio는 인문학 데이터 시각화에서 filter, facet, graph, map, timeline 탐색이 강점이다.

적용 항목:

- 인물별 필터
- 장소별 필터
- 사건 유형별 필터
- 독서 위치 범위 필터
- 선택한 객체와 관련된 원문 근거 표시

Palladio식 탐색성은 분석 결과를 읽는 화면의 핵심 UX로 둔다.

### 2.7 TimelineJS

TimelineJS는 사건을 시간 순서로 보여주는 스토리텔링 타임라인의 표준적인 UI 패턴을 제공한다.

적용 항목:

- 사건 카드 중심 타임라인
- 사건별 제목, 요약, 원문 근거, 관련 인물/장소
- 진행 위치 slider와 연동
- 사건 유형별 색상/아이콘 구분

Novel IF Reader의 Timeline 탭은 TimelineJS식 스토리 카드 구조를 참고하되, 소설 내부 순서를 시간축으로 사용한다.

## 3. 핵심 제품 원칙

### 3.1 스포일러 차단

분석 결과는 독서 진행 위치를 넘어서 노출되지 않아야 한다.

- `reader_position` 이하의 문단/문장/사건만 표시
- 미래 사건에 기반한 인물 상태 추론 금지
- 미래에 확정되는 별칭/정체성은 별도 처리
- export 시 전체/현재 위치 기준 export를 분리

### 3.2 원문 근거 우선

모든 추출 결과는 원문 근거를 가져야 한다.

- character mention offset
- location mention offset
- event sentence offset
- state change source segment
- confidence score
- extraction method

근거 없는 추정은 UI에서 낮은 신뢰도 또는 수동 입력으로 표시한다.

### 3.3 자동 추출과 검수의 분리

엔진 출력은 확정 데이터가 아니라 제안 데이터다.

상태값:

- `suggested`: 자동 추출됨
- `confirmed`: 사용자가 확인함
- `edited`: 사용자가 수정함
- `rejected`: 사용자가 제외함
- `manual`: 사용자가 직접 추가함

### 3.4 엔진 교체 가능성

분석 엔진은 UI와 직접 결합하지 않는다.

공통 interface:

```js
async function analyzeNovel(input) {
  return {
    document,
    segments,
    scenes,
    mentions,
    characters,
    locations,
    events,
    states,
    relations,
    diagnostics
  };
}
```

초기에는 브라우저 내 규칙 기반 엔진을 유지하고, 이후 서버 기반 엔진을 추가한다.

## 4. 데이터 모델

현재 구현 계약은 `doc/component.md`의 스키마를 따른다. `doc/plan.md`의 초기 모델은 다음처럼 매핑한다.

| plan.md 초안 | 현재 구현 스키마 | 비고 |
| --- | --- | --- |
| `Work` | `Document` | 작품/원문 단위 |
| `work_id` | `document_id` | 명칭 통일 |
| `order` | `index` | Segment/Scene의 1-based 순서 |
| `start_char`, `end_char` | `char_start`, `char_end` | 원문 offset |
| `Location.canonical_name` | `Location.name` | 인물은 `canonical_name`, 장소는 `name` |
| `event_type` | `type` | 이벤트 타입 |
| `evidence_segment_ids` | `segment_id`, `source_span`, `mentions`, `source_event_ids` | 근거 표현을 offset 중심으로 확장 |
| `reader_visible_after_segment_id` | `segment_id` + reader position selector | 표시 가능 범위는 selector에서 계산 |
| `Edge` | `Relation` | 그래프-ready 관계 레코드 |

`source_url`, `source_accessed_at`, `copyright_note`, `raw_text_hash`, `certainty`, `uncertainty_note`는 MVP 필수 필드는 아니지만 후속 저장/검수 단계에서 보강할 수 있는 확장 필드로 둔다.

### 4.1 Document

```json
{
  "document_id": "doc_001",
  "title": "날개",
  "language": "ko",
  "source": "texts/wings.txt",
  "created_at": "2026-06-14T00:00:00Z"
}
```

### 4.2 Segment

```json
{
  "segment_id": "seg_001",
  "document_id": "doc_001",
  "index": 1,
  "scene_id": "scene_001",
  "text": "...",
  "char_start": 0,
  "char_end": 120
}
```

### 4.2.1 Scene

```json
{
  "scene_id": "scene_001",
  "document_id": "doc_001",
  "index": 1,
  "title": "Scene 1",
  "start_segment_id": "seg_001",
  "end_segment_id": "seg_010",
  "summary": ""
}
```

### 4.2.2 Mention

```json
{
  "mention_id": "mention_001",
  "entity_type": "character",
  "entity_id": "char_001",
  "text": "나",
  "segment_id": "seg_001",
  "char_start": 0,
  "char_end": 1,
  "status": "suggested",
  "confidence": 0.86
}
```

### 4.3 Character

```json
{
  "character_id": "char_001",
  "canonical_name": "나",
  "aliases": ["나", "내"],
  "mentions": ["mention_001"],
  "first_segment_id": "seg_001",
  "description": "",
  "status": "suggested",
  "confidence": 0.82
}
```

### 4.4 Location

```json
{
  "location_id": "loc_001",
  "name": "방",
  "aliases": ["방", "내 방"],
  "mentions": ["mention_010"],
  "first_segment_id": "seg_003",
  "status": "suggested",
  "confidence": 0.76
}
```

### 4.5 Event

```json
{
  "event_id": "event_001",
  "type": "movement",
  "summary": "화자가 방 안에 머문다.",
  "segment_id": "seg_004",
  "sentence_index": 2,
  "characters": ["char_001"],
  "locations": ["loc_001"],
  "source_span": {
    "char_start": 330,
    "char_end": 380
  },
  "status": "suggested",
  "confidence": 0.68
}
```

Map 화면에서 Event는 node가 아니다. Event는 Timeline 카드, 검수 대상, Inspector 설명 데이터, Relation/Map edge의 근거로 사용한다.

### 4.6 Character State

```json
{
  "state_id": "state_001",
  "character_id": "char_001",
  "segment_id": "seg_004",
  "location_id": "loc_001",
  "mental_state": "불안",
  "physical_state": "",
  "known_facts": ["방 안에 있음"],
  "source_event_ids": ["event_001"],
  "status": "suggested"
}
```

### 4.7 Relation

```json
{
  "relation_id": "rel_001",
  "source_type": "character",
  "source_id": "char_001",
  "target_type": "location",
  "target_id": "loc_001",
  "relation_type": "appears_in",
  "event_ids": ["event_001"],
  "segment_ids": ["seg_004"],
  "weight": 1,
  "status": "suggested"
}
```

## 5. 시스템 구조

### 5.1 Frontend

역할:

- 텍스트 입력/로드
- 독서 위치 slider
- 분석 결과 표시
- annotation 검수
- export

초기 구현:

- vanilla HTML/CSS/JS 유지
- 데이터 모델 분리
- 분석 엔진 모듈화
- UI renderer 모듈화

확장 시:

- React/Vue/Svelte 중 하나로 이전 가능
- annotation span editor 분리
- graph/timeline 컴포넌트 분리

### 5.2 Backend

현재 backend는 정적 파일 제공 수준이다.

1차 확장:

- `POST /api/analyze`
- `GET /api/documents/:id`
- `PUT /api/annotations/:id`
- `GET /api/export/:documentId`

2차 확장:

- 분석 작업 queue
- 긴 소설 처리용 chunking
- 프로젝트 저장소
- 사용자별 검수 기록

### 5.3 Engine Layer

엔진은 세 단계로 분리한다.

1. Preprocess
   - normalize
   - paragraph split
   - sentence split
   - offset 계산

2. Extract
   - characters
   - locations
   - events
   - relations
   - states

3. Postprocess
   - alias merge
   - duplicate removal
   - confidence scoring
   - spoiler-safe state timeline 생성

### 5.4 Storage

MVP:

- 브라우저 메모리
- JSON export/import

1차 저장:

- localStorage 또는 IndexedDB
- document snapshot 저장

2차 저장:

- SQLite
- project/document/annotation table

## 6. 주요 화면 설계

### 6.1 Reader

목적:

- 원문을 읽고 현재 독서 위치를 조절한다.

기능:

- 원문 textarea
- 현재 활성 segment 카드
- 독서 위치 slider
- 스포일러 차단 toggle
- 현재 위치 기준 통계
- 활성 segment의 인물/장소/event 요약
- 원문 textarea에서 활성 segment 범위 하이라이트

Reader는 전체 segment를 모두 나열하지 않는다. 현재 독서 위치에 해당하는 segment만 표시하고, 해당 `char_start`부터 `char_end`까지 원문 위치를 선택/하이라이트한다.

### 6.2 Map

목적:

- 현재 독서 위치의 인물, 장소 연결 관계를 공간/관계 그래프로 보여준다.

참고:

- nodegoat의 object-relation model
- Palladio의 graph exploration

기능:

- 인물 node
- 장소 node
- 현재 segment에서 연결점이 있는 node만 표시
- 사건에서 파생한 인물-인물 edge
- 사건에서 파생한 인물-장소 edge
- 선택 node 상세 Inspector
- Inspector의 관련 사건 설명과 원문 근거 표시
- 필터

Map은 누적 그래프가 아니다. 독서 위치가 바뀌면 해당 segment에서 관계가 있는 인물/장소 node만 동적으로 재계산해 표시한다. 연결점이 없는 node는 그 시점의 Map에 표시하지 않는다.

사건은 그래프 node로 만들지 않는다. 사건 summary, 유형, 관련 인물/장소, 원문 근거는 오른쪽 Inspector 패널의 이벤트 영역에 표시한다.

### 6.3 Timeline

목적:

- 사건을 소설 내부 순서대로 보여준다.

참고:

- TimelineJS의 event card 구조

기능:

- 사건 카드
- 사건 유형 필터
- 관련 인물/장소 chip
- 원문 근거 접기/펼치기
- 독서 위치와 동기화

### 6.4 Characters

목적:

- 인물별 현재 상태와 변화 이력을 보여준다.

기능:

- 한 줄에 하나씩 표시되는 인물 카드
- 별칭
- 첫 등장 위치
- 현재 장소
- 현재 심리/신체 상태
- 알려진 사실
- 상태 변화 timeline
- 등장 밀도
- 관계 변화
- 공간 경로
- 별칭 편집
- 빠른 검수 버튼
- `현재 위치에서 강조` 버튼

인물 카드의 `현재 위치에서 강조`는 독서 위치를 이동시키지 않는다. 현재 Reader 위치 기준의 Map/Inspector에서 해당 인물을 선택하고, 현재 segment에 연결 사건이 있으면 그 관계와 사건 설명을 강조한다.

### 6.5 검수

목적:

- 자동 추출 결과를 사람이 검수하고 수정한다.

참고:

- INCEpTION의 curated annotation
- brat의 inline annotation
- doccano의 단순 annotation workflow

기능:

- 원문 span highlight
- 인물/장소/사건 후보 목록
- confirm/edit/reject
- 수동 추가
- alias merge/split
- event relation 수정
- confidence 낮은 항목 우선 표시

UI 표기는 `검수`를 우선 사용한다. 코드나 외부 참고 문서에서 Review라는 용어를 설명할 수는 있지만, 제품 개념은 검수 워크플로다.

### 6.6 Export

목적:

- 분석 결과를 외부 연구/개발 도구에서 재사용할 수 있게 내보낸다.

형식:

- JSON
- CSV
- Markdown
- graph JSON
- TimelineJS compatible JSON

## 7. 구현 단계

### Phase 0. 현재 MVP 정리

목표:

- 현재 규칙 기반 앱을 안정화하고 데이터 모델을 명확히 한다.

작업:

- 분석 결과 schema 정리
- `analyzeNovel` 출력 구조 고정
- export format 정리
- reader position 기준 filtering 검증
- README 인코딩/문서 정리

완료 기준:

- 같은 입력은 같은 JSON schema를 생성한다.
- UI는 schema에만 의존한다.

### Phase 1. BookNLP식 엔진 인터페이스

목표:

- 현재 규칙 기반 분석기를 교체 가능한 엔진으로 분리한다.

작업:

- `engine/ruleBasedAnalyzer.js` 분리
- `engine/types.js` 또는 schema 문서 추가
- mention/span/offset 도입
- confidence score 도입
- diagnostics 출력

완료 기준:

- UI는 `analyzeNovel()` interface만 호출한다.
- 엔진 교체 시 UI 수정이 최소화된다.

### Phase 2. 검수 워크플로

목표:

- 자동 추출 결과를 사용자가 확인, 수정, 거절할 수 있게 한다.

작업:

- annotation status 추가
- 검수 탭 재설계
- inline span highlight
- low confidence queue
- merge/split alias 기능
- 수정 내역 반영 후 graph/timeline rebuild

완료 기준:

- 사용자가 자동 추출된 인물/장소/사건을 확정 또는 제거할 수 있다.
- 수정된 결과가 export에 반영된다.

### Phase 3. 시각화 고도화

목표:

- nodegoat/Palladio/TimelineJS식 탐색성을 강화한다.

작업:

- graph data model 정리
- node/edge type별 스타일
- 선택 객체 상세 패널
- facet filter
- TimelineJS compatible export
- 사건 카드 개선
- Map의 current-segment projection 유지
- Inspector 이벤트 설명 영역 고도화

완료 기준:

- 인물, 장소, 사건 기준으로 결과를 필터링할 수 있다.
- 선택한 시각화 요소에서 원문 근거로 이동할 수 있다.

### Phase 4. 서버 기반 분석

목표:

- 긴 텍스트와 외부 NLP/LLM 엔진을 처리할 수 있게 한다.

작업:

- Express API 추가
- analysis job endpoint
- document storage
- backend analyzer adapter
- optional Python NLP worker 검토

완료 기준:

- 브라우저 UI에서 서버 분석을 호출할 수 있다.
- 분석 결과는 동일 schema로 반환된다.

### Phase 5. 한국어 소설 분석 강화

목표:

- 한국어 문학 텍스트에서 추출 품질을 높인다.

작업:

- 한국어 문장 분리 개선
- 조사 기반 인물 후보 추출 개선
- 장소 suffix lexicon 확장
- 발화문/화자 추정
- 상태 변화 rule set 확장
- LLM structured extraction 실험

완료 기준:

- 샘플 텍스트에서 인물/장소/사건 추출 recall과 precision을 수동 기준으로 평가할 수 있다.

## 8. 우선순위

높음:

- 데이터 schema 고정
- 분석 엔진 분리
- 원문 offset/근거 도입
- 검수 status 도입
- 스포일러 차단 filtering 검증

중간:

- inline annotation UI
- graph filter
- TimelineJS export
- local persistence

낮음:

- 다중 사용자 협업
- 계정/권한
- 대규모 corpus 관리
- 완전한 annotation platform 기능

## 9. 리스크와 대응

### 9.1 BookNLP의 언어 제약

BookNLP는 영어 소설 분석에 강하다. 한국어 소설 분석에는 직접 적용이 어렵다.

대응:

- BookNLP를 구현체가 아니라 출력 모델과 파이프라인 참고 자료로 사용
- 한국어 엔진 adapter 별도 설계
- 영어 텍스트 분석 기능은 optional adapter로 분리

### 9.2 자동 추출 품질

문학 텍스트는 은유, 생략, 비명시적 지칭이 많아 자동 추출 오류가 많을 수 있다.

대응:

- confidence 표시
- 원문 근거 표시
- 검수 workflow 우선 구현
- 확정 데이터와 제안 데이터 분리

### 9.3 스포일러 차단 오류

미래 문단의 정보가 현재 상태에 섞이면 앱의 핵심 가치가 훼손된다.

대응:

- 모든 entity/state/event에 segment index 저장
- 현재 위치 이하 데이터만 계산하는 selector 사용
- export에도 scope 옵션 추가

### 9.4 UI 복잡도 증가

annotation, graph, timeline이 동시에 커지면 앱이 복잡해진다.

대응:

- Reader, 검수, Visualization을 명확히 분리
- MVP에서는 단일 문서/단일 사용자만 지원
- 기능별 module boundary 유지

## 10. 추천 다음 작업

1. 현재 `app.js`에서 분석 엔진과 UI 렌더링 코드를 분리한다.
2. `analysis_schema.md`를 추가해 document, segment, mention, character, location, event, state, relation schema를 고정한다.
3. 검수 탭의 데이터를 `suggested`, `confirmed`, `edited`, `rejected`, `manual` 상태로 관리한다.
4. 모든 추출 결과에 원문 offset과 source segment를 붙인다.
5. TimelineJS compatible JSON export를 추가한다.

## 11. 참고 링크

- BookNLP: https://github.com/booknlp/booknlp
- CATMA: https://github.com/forTEXT/catma
- INCEpTION: https://inception-project.github.io/
- brat: https://github.com/nlplab/brat
- doccano: https://github.com/doccano/doccano
- nodegoat: https://github.com/nodegoat/nodegoat
- Palladio: https://github.com/humanitiesplusdesign/palladio
- TimelineJS: https://github.com/NUKnightLab/TimelineJS3
