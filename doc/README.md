# Novel IF Reader 통합 설계 문서

이 문서는 기존 `doc/` 하위의 개별 문서(`open_source_stack_design.md`, `component.md`, `plan.md`, `task.md`)를 하나로 통합한 것이다. 각 Part는 원본 문서에 대응한다.

## 목차

1. [Part 1 — 오픈소스 스택 설계 (Open Source Stack Design)](#part-1--오픈소스-스택-설계-open-source-stack-design)
2. [Part 2 — 컴포넌트·스키마 정의 (Component & Schema Definition)](#part-2--컴포넌트스키마-정의-component--schema-definition)
3. [Part 3 — 기획·실행 계획 (Planning Document, 「날개」 기준)](#part-3--기획실행-계획-planning-document-날개-기준)
4. [Part 4 — 미해결 과제 메모 (Open Issues)](#part-4--미해결-과제-메모-open-issues)

---

## Part 1 — 오픈소스 스택 설계 (Open Source Stack Design)

> 원본 파일: `doc/open_source_stack_design.md`

### Novel IF Reader Open Source Stack Design

Updated: 2026-06-14

#### 1. 목적

Novel IF Reader는 소설 원문을 입력하면 인물, 장소, 사건, 인물 상태 변화를 추출하고, 독서 진행 위치에 맞춰 타임라인과 공간/관계 그래프를 보여주는 소설 분석 웹 앱이다.

이 문서는 다음 오픈소스 계열을 참고해 앱을 설계하기 위한 계획서다.

- 엔진 참고: BookNLP
- 검수 워크플로 참고: INCEpTION, brat, doccano
- 시각화 참고: nodegoat, Palladio, TimelineJS

핵심 방향은 자동 추출 결과를 그대로 믿는 분석기가 아니라, 원문 근거를 가진 추출 결과를 만들고 사용자가 검수해 품질을 높이는 human-in-the-loop 분석 도구다.

이 문서는 `doc/plan.md`의 제품 목표를 현재 구현 가능한 MVP 구조로 구체화한다. 세부 객체와 UI 컴포넌트 계약은 `doc/component.md`를 따른다.

#### 2. 참고 프로젝트별 적용 범위

##### 2.1 BookNLP

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

##### 2.1.1 업로드 문서용 동적 분석 계약

`날개`, `감자` 같은 내장 샘플은 작품별 고정 seed를 사용할 수 있다. 하지만 사용자가 TXT로 업로드한 임의 단편은 고정 seed에 의존하면 안 된다. 업로드 문서는 다음 순서로 동적 분석을 수행한다.

1. LLM adapter가 원문에서 작품별 `characters`, `locations`, `event_types`, `mental_states`, `physical_states`, `events`를 구조화 JSON으로 추출한다.
2. LLM이 추출한 `characters`와 `locations`는 동적 seed lexicon으로 사용한다.
3. LLM 사건 후보의 `characters`, `locations` 값도 seed처럼 승격한다. 즉 characters 배열에 없더라도 events 안에 등장한 인물/장소명은 실제 Character/Location 엔티티 후보가 된다.
4. 이벤트의 `characters`, `locations`는 실제 엔티티 ID로 해석된다. 이름이 정확히 일치하지 않으면 alias, 조사 제거형, 띄어쓰기 제거형, 부분 포함 관계로 매칭한다.
5. 이벤트 근거 문장에 인물/장소명이 직접 없더라도 같은 근거 문단의 mention을 이벤트에 연결한다. 이 후처리로 인물-사건, 사건-장소, 인물-장소 관계 edge를 만든다.
6. 인물 상태는 샘플 전용 고정 키워드가 아니라 업로드 문서의 `mental_states`, `physical_states`와 LLM 이벤트의 `character_states`를 우선 사용한다. LLM 상태 힌트가 없을 때만 브라우저 동적 seed 또는 규칙 fallback을 사용한다.
7. 모든 결과는 `suggested` 상태로 시작하며 `/check` 검수 화면에서 확정, 수정, 제외한다.

LLM 이벤트는 다음 확장 필드를 지원한다.

```json
{
  "type": "conflict",
  "summary": "인물이 위협을 느끼고 물러선다.",
  "characters": ["복녀"],
  "locations": ["채마 밭"],
  "character_states": [
    {
      "character": "복녀",
      "mental_state": "불안",
      "physical_state": "긴장 상태",
      "evidence": "원문에서 그대로 찾을 수 있는 짧은 구절"
    }
  ],
  "evidence": "원문에서 그대로 찾을 수 있는 짧은 구절",
  "confidence": 0.7
}
```

이 계약의 목적은 업로드 문서에서도 관계지도와 인물상태가 공란으로 남지 않게 하는 것이다. 타임라인 이벤트만 생성되고 엔티티/관계/상태로 연결되지 않는 출력은 불완전한 분석 결과로 본다.

##### 2.2 INCEpTION

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

##### 2.3 brat

brat은 텍스트 위에 엔티티와 관계를 직접 표시하고 수정하는 annotation UI가 강점이다.

적용 항목:

- 원문 문단/문장 위에 인물, 장소, 사건 span 표시
- 인물-사건, 사건-장소, 인물-인물 관계를 시각적으로 확인
- 각 추출 결과가 어떤 원문 구간에서 나왔는지 offset으로 연결
- 검수 화면에서 원문과 annotation을 분리하지 않음

현재 앱의 `/check` 검수 화면은 brat식 inline review 영역으로 발전시킨다.

##### 2.4 doccano

doccano는 범용 텍스트 annotation 도구로, 프로젝트 생성, 데이터 업로드, 라벨 정의, annotation, export 흐름이 간단하다.

적용 항목:

- 텍스트 업로드/샘플 로드
- 라벨셋 관리
- JSONL/CSV/Markdown export
- 작업 단위 progress 표시
- 간단한 협업 확장 가능성

MVP에서는 복잡한 계정/협업 기능 없이 doccano식 단순 workflow만 차용한다.

##### 2.5 nodegoat

nodegoat은 인문학 데이터의 객체, 관계, 시간, 공간을 함께 다루는 데이터 관리/시각화 환경이다.

적용 항목:

- 인물, 장소, 사건을 독립 객체로 관리
- 객체 간 관계를 edge로 관리
- 시간 순서와 공간 이동을 동시에 표현
- 필터 가능한 관계망

Novel IF Reader에서는 nodegoat의 연구 데이터 모델링 관점을 참고해 analysis result를 단순 배열이 아니라 graph-ready dataset으로 설계한다.

단, 현재 화면의 Map에서는 사건을 node로 표시하지 않는다. 사건은 Timeline과 Inspector에서 설명 데이터로 보여주고, Map에서는 인물-인물 또는 인물-장소 edge의 근거로만 사용한다.

##### 2.6 Palladio

Palladio는 인문학 데이터 시각화에서 filter, facet, graph, map, timeline 탐색이 강점이다.

적용 항목:

- 인물별 필터
- 장소별 필터
- 사건 유형별 필터
- 독서 위치 범위 필터
- 선택한 객체와 관련된 원문 근거 표시

Palladio식 탐색성은 분석 결과를 읽는 화면의 핵심 UX로 둔다.

##### 2.7 TimelineJS

TimelineJS는 사건을 시간 순서로 보여주는 스토리텔링 타임라인의 표준적인 UI 패턴을 제공한다.

적용 항목:

- 사건 카드 중심 타임라인
- 사건별 제목, 요약, 원문 근거, 관련 인물/장소
- 진행 위치 slider와 연동
- 사건 유형별 색상/아이콘 구분

Novel IF Reader의 Timeline 탭은 TimelineJS식 스토리 카드 구조를 참고하되, 소설 내부 순서를 시간축으로 사용한다.

#### 3. 핵심 제품 원칙

##### 3.1 스포일러 차단

분석 결과는 독서 진행 위치를 넘어서 노출되지 않아야 한다.

- `reader_position` 이하의 문단/문장/사건만 표시
- 미래 사건에 기반한 인물 상태 추론 금지
- 미래에 확정되는 별칭/정체성은 별도 처리
- export 시 전체/현재 위치 기준 export를 분리

##### 3.2 원문 근거 우선

모든 추출 결과는 원문 근거를 가져야 한다.

- character mention offset
- location mention offset
- event sentence offset
- state change source segment
- confidence score
- extraction method

근거 없는 추정은 UI에서 낮은 신뢰도 또는 수동 입력으로 표시한다.

##### 3.3 자동 추출과 검수의 분리

엔진 출력은 확정 데이터가 아니라 제안 데이터다.

상태값:

- `suggested`: 자동 추출됨
- `confirmed`: 사용자가 확인함
- `edited`: 사용자가 수정함
- `rejected`: 사용자가 제외함
- `manual`: 사용자가 직접 추가함

##### 3.4 엔진 교체 가능성

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

#### 4. 데이터 모델

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

##### 4.1 Document

```json
{
  "document_id": "doc_001",
  "title": "날개",
  "language": "ko",
  "source": "texts/wings.txt",
  "created_at": "2026-06-14T00:00:00Z"
}
```

##### 4.2 Segment

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

##### 4.2.1 Scene

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

##### 4.2.2 Mention

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

##### 4.3 Character

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

##### 4.4 Location

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

##### 4.5 Event

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

##### 4.6 Character State

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

##### 4.7 Relation

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

#### 5. 시스템 구조

##### 5.1 Frontend

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

##### 5.2 Backend

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

##### 5.3 Engine Layer

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

##### 5.4 Storage

MVP:

- 브라우저 메모리
- JSON export/import

1차 저장:

- localStorage 또는 IndexedDB
- document snapshot 저장

2차 저장:

- SQLite
- project/document/annotation table

#### 6. 주요 화면 설계

##### 6.1 Reader

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

##### 6.2 Map

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

##### 6.3 Timeline

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

##### 6.4 Characters

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

##### 6.5 검수 관리자 페이지

목적:

- 자동 추출 결과를 사람이 검수하고 수정한다.

참고:

- INCEpTION의 curated annotation
- brat의 inline annotation
- doccano의 단순 annotation workflow

기능:

- `/check` 경로에서 홈 분석 화면과 분리해 표시
- 전체/제안/확정/수정/제외 상태 요약
- 원문 span highlight
- 인물/장소/사건 후보 목록
- confirm/edit/reject
- 수동 추가
- alias merge/split
- event relation 수정
- confidence 낮은 항목 우선 표시

UI 표기는 `검수`를 우선 사용한다. 코드나 외부 참고 문서에서 Review라는 용어를 설명할 수는 있지만, 제품 개념은 검수 워크플로다.

##### 6.6 Export

목적:

- 분석 결과를 외부 연구/개발 도구에서 재사용할 수 있게 내보낸다.

형식:

- JSON
- CSV
- Markdown
- graph JSON
- TimelineJS compatible JSON

#### 7. 구현 단계

##### Phase 0. 현재 MVP 정리

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

##### Phase 1. BookNLP식 엔진 인터페이스

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

##### Phase 2. 검수 워크플로

목표:

- 자동 추출 결과를 사용자가 확인, 수정, 거절할 수 있게 한다.

작업:

- annotation status 추가
- `/check` 검수 관리자 페이지 재설계
- inline span highlight
- low confidence queue
- merge/split alias 기능
- 수정 내역 반영 후 graph/timeline rebuild

완료 기준:

- 사용자가 자동 추출된 인물/장소/사건을 확정 또는 제거할 수 있다.
- 수정된 결과가 export에 반영된다.

##### Phase 3. 시각화 고도화

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

##### Phase 4. 서버 기반 분석

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

##### Phase 5. 한국어 소설 분석 강화

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

#### 8. 우선순위

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

#### 9. 리스크와 대응

##### 9.1 BookNLP의 언어 제약

BookNLP는 영어 소설 분석에 강하다. 한국어 소설 분석에는 직접 적용이 어렵다.

대응:

- BookNLP를 구현체가 아니라 출력 모델과 파이프라인 참고 자료로 사용
- 한국어 엔진 adapter 별도 설계
- 영어 텍스트 분석 기능은 optional adapter로 분리

##### 9.2 자동 추출 품질

문학 텍스트는 은유, 생략, 비명시적 지칭이 많아 자동 추출 오류가 많을 수 있다.

대응:

- confidence 표시
- 원문 근거 표시
- 검수 workflow 우선 구현
- 확정 데이터와 제안 데이터 분리

##### 9.3 스포일러 차단 오류

미래 문단의 정보가 현재 상태에 섞이면 앱의 핵심 가치가 훼손된다.

대응:

- 모든 entity/state/event에 segment index 저장
- 현재 위치 이하 데이터만 계산하는 selector 사용
- export에도 scope 옵션 추가

##### 9.4 UI 복잡도 증가

annotation, graph, timeline이 동시에 커지면 앱이 복잡해진다.

대응:

- Reader, 검수, Visualization을 명확히 분리
- MVP에서는 단일 문서/단일 사용자만 지원
- 기능별 module boundary 유지

#### 10. 추천 다음 작업

1. 현재 `app.js`에서 분석 엔진과 UI 렌더링 코드를 분리한다.
2. `analysis_schema.md`를 추가해 document, segment, mention, character, location, event, state, relation schema를 고정한다.
3. `/check` 검수 페이지의 데이터를 `suggested`, `confirmed`, `edited`, `rejected`, `manual` 상태로 관리한다.
4. 모든 추출 결과에 원문 offset과 source segment를 붙인다.
5. TimelineJS compatible JSON export를 추가한다.

#### 11. 참고 링크

- BookNLP: https://github.com/booknlp/booknlp
- CATMA: https://github.com/forTEXT/catma
- INCEpTION: https://inception-project.github.io/
- brat: https://github.com/nlplab/brat
- doccano: https://github.com/doccano/doccano
- nodegoat: https://github.com/nodegoat/nodegoat
- Palladio: https://github.com/humanitiesplusdesign/palladio
- TimelineJS: https://github.com/NUKnightLab/TimelineJS3


---

## Part 2 — 컴포넌트·스키마 정의 (Component & Schema Definition)

> 원본 파일: `doc/component.md`

### Novel IF Reader Component and Schema Definition

Updated: 2026-06-14

This document defines the app objects, events, derived views, and UI components used to implement `doc/open_source_stack_design.md`.

The current app is a browser-first MVP. It uses a rule-based Korean adapter, but all output should follow the same schema so the analyzer can later be replaced by a BookNLP-style, Korean NLP, LLM, or server-side adapter.

The app can also call a local Ollama adapter through `server.js`. This path is optional and intended for small local models in the 4b-7b range. Recommended defaults are `qwen3.5:4b`, `gemma4:e4b`, `gemma3:4b`, and `qwen3:4b`. In Ollama mode, the model first creates a document-local seed lexicon for characters, locations, event types, mental/emotional states, and physical states. The app then recalculates mentions, events, states, relations, and browser filter options from that dynamic seed lexicon. Ollama output is treated as suggested data and merged only when source evidence can be tied back to the document text.

#### 1. Design Principles

##### 1.1 Source Evidence First

Every extracted object should be traceable to source text.

Required evidence fields:

- `segment_id`
- `char_start`
- `char_end`
- `source_span` for events
- `mentions` for characters and locations
- `source_event_ids` for character states

##### 1.2 Human-in-the-loop Review

Analyzer output is not final data. Each extracted item has a review status.

Allowed statuses:

- `suggested`: automatically extracted
- `confirmed`: user accepted
- `edited`: user changed
- `rejected`: user removed
- `manual`: user created

Rejected items should be excluded from normal Reader, Map, Timeline, Characters, and scoped Export views.

##### 1.3 Spoiler-safe Scope

Most views are scoped by `state.currentSegment`.

- Reader shows the active segment.
- Map shows only current-segment connected entities.
- Timeline shows events up to the current segment.
- Characters show character state as of the current segment.
- Export can produce current-scope or full-document data.

##### 1.4 UI Depends on Schema

The UI should read the analysis schema rather than engine-specific internals. The core interface is:

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

#### 2. Core Data Objects

##### 2.1 Document

Represents one source text.

```json
{
  "document_id": "doc_001",
  "title": "날개",
  "author": "이상",
  "publication_year": "1936",
  "language": "ko",
  "source": "texts/wings.txt",
  "source_url": "https://www.davincimap.co.kr/davBase/Source/davSource.jsp?Job=Body&SourID=SOUR001427",
  "rights": "public-domain-candidate",
  "created_at": "2026-06-14T00:00:00.000Z"
}
```

Field notes:

- `document_id`: stable id inside one analysis result
- `author`: optional author display and export metadata
- `publication_year`: optional original publication year
- `language`: ISO-style language code
- `source`: file path, upload marker, URL, or `"manual"`
- `source_url`: optional canonical source URL for bundled samples
- `rights`: optional rights note such as `"public-domain-old-70"` or `"user-provided"`
- `created_at`: analysis creation time

##### 2.2 Segment

Reader-position unit. Current MVP uses paragraphs as segments.

```json
{
  "segment_id": "seg_001",
  "document_id": "doc_001",
  "index": 1,
  "scene_id": "scene_001",
  "text": "paragraph text",
  "char_start": 0,
  "char_end": 120
}
```

Rules:

- `index` is 1-based.
- `char_start` and `char_end` are offsets in normalized document text.
- All spoiler filtering should use `index` or `segment_id`.

##### 2.3 Scene

Coarse grouping of segments for navigation, density bars, and summaries.

```json
{
  "scene_id": "scene_001",
  "document_id": "doc_001",
  "index": 1,
  "title": "Scene 1",
  "start_segment_id": "seg_001",
  "end_segment_id": "seg_010",
  "summary": "scene summary"
}
```

Current MVP creates scenes automatically by segment count. Future engines may provide semantic scenes.

##### 2.4 Mention

Text span where a character or location appears.

```json
{
  "mention_id": "mention_001",
  "entity_type": "character",
  "entity_id": "char_001",
  "text": "나는",
  "segment_id": "seg_001",
  "char_start": 0,
  "char_end": 2,
  "status": "suggested",
  "confidence": 0.86,
  "method": "seed-lexicon"
}
```

Allowed `entity_type`:

- `character`
- `location`

Mention IDs must be globally unique across character and location mentions.

##### 2.5 Character

Narrative actor or candidate actor.

```json
{
  "character_id": "char_001",
  "canonical_name": "나",
  "aliases": ["나는", "내가", "나를", "나에게"],
  "mentions": ["mention_001"],
  "first_segment_id": "seg_001",
  "description": "소설의 1인칭 화자.",
  "role": "화자",
  "status": "suggested",
  "confidence": 0.88,
  "method": "seed-lexicon"
}
```

Optional future fields:

```json
{
  "appearance": {
    "text": "",
    "traits": [],
    "evidence_mention_ids": []
  },
  "personality": {
    "traits": [],
    "evidence_mention_ids": []
  }
}
```

Current Characters tab derives state timeline, relations, spatial path, and density from `states`, `events`, and `mentions`.

##### 2.6 Location

Narrative or real-world place.

```json
{
  "location_id": "loc_001",
  "name": "내 방",
  "aliases": ["내 방", "윗방", "침침한 방"],
  "mentions": ["mention_010"],
  "first_segment_id": "seg_003",
  "type": "interior",
  "parent_name": "33번지",
  "parent_location_id": "loc_000",
  "description": "화자가 주로 머무는 방.",
  "narrative_coords": { "x": 315, "y": 350 },
  "status": "suggested",
  "confidence": 0.86,
  "method": "seed-lexicon"
}
```

Allowed `type` values:

- `residential`
- `interior`
- `threshold`
- `exterior`
- `public`
- `symbolic`
- `inferred`

Optional future fields:

```json
{
  "is_fictional": true,
  "real_world_candidate": "",
  "real_coords": null,
  "geocode_source": "",
  "symbolic_meaning": ""
}
```

##### 2.7 Event

Sentence-level narrative event. Events are shown in Timeline and Inspector. In Map, events are not nodes; they are converted into edge explanations.

```json
{
  "event_id": "event_001",
  "document_id": "doc_001",
  "type": "movement",
  "summary": "화자가 방으로 이동한다.",
  "segment_id": "seg_004",
  "scene_id": "scene_001",
  "sentence_index": 2,
  "characters": ["char_001"],
  "locations": ["loc_001"],
  "source_span": {
    "char_start": 330,
    "char_end": 380
  },
  "status": "suggested",
  "confidence": 0.68,
  "method": "event-lexicon"
}
```

Allowed event types:

- `appearance`
- `movement`
- `conversation`
- `perception`
- `conflict`
- `realization`
- `stasis`
- `symbolic`
- `background`

Future optional fields:

```json
{
  "certainty": "explicit",
  "social_context": {
    "summary": "",
    "source_url": "",
    "source_type": "",
    "fetched_at": ""
  }
}
```

##### 2.8 Character State

Snapshot of what is known about a character at a segment.

```json
{
  "state_id": "state_001",
  "character_id": "char_001",
  "segment_id": "seg_004",
  "location_id": "loc_001",
  "mental_state": "불안",
  "physical_state": "피로",
  "known_facts": ["방 안에 있음"],
  "source_event_ids": ["event_001"],
  "status": "suggested"
}
```

Rules:

- State is cumulative and spoiler-scoped.
- Characters tab uses the latest visible state per character.
- State timeline is derived by compacting repeated states.

##### 2.9 Relation

Graph-ready relationship record. This is exported as graph data, but the Map view uses a stricter current-segment projection.

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

Allowed relation types:

- `participates_in`: character to event
- `appears_in`: character to location
- `takes_place_at`: event to location

Map-only derived relation types:

- `event_between`: character to character, derived from events with at least two characters
- `event_at`: character to location, derived from events with character and location

#### 3. Derived View Models

##### 3.1 Reader Active Segment

Reader no longer lists all segments. It shows the active segment only.

Derived from:

- `segments[currentSegment - 1]`
- visible events in the same `segment_id`

Displayed fields:

- `segment_id`
- `scene_id`
- full segment text
- event count
- character tags
- location tags

The source textarea selects the active segment range using `char_start` and `char_end`.

##### 3.2 Map Projection

Map does not show event nodes.

Inputs:

- events in the current segment only
- status filter
- event type filter
- optional entity filter

Map nodes:

- characters
- locations

Map edges:

- `event_between`
- `event_at`

Events are displayed in the Inspector panel, not on graph edges.

##### 3.3 Inspector Event Panel

Inspector has a current event explanation area.

When no node is selected:

- show all current-segment events that connect at least one character or location

When a character or location is selected:

- show only events connected to that selected entity

Displayed fields:

- event type
- related characters
- related locations
- summary
- source quote

##### 3.4 Characters Card

One row per character.

Base card:

- name
- role
- review status
- confidence
- description
- current location
- current mental state
- current physical state
- appearance density
- known facts
- `현재 위치에서 강조` button

Expanded view:

- state timeline
- relation changes
- spatial path
- alias edit
- quick review buttons
- recent events

##### 3.5 Timeline Card

Timeline remains event-first.

Displayed fields:

- event id
- segment position
- event type
- review status
- related character chips
- related location chips
- summary
- source quote

##### 3.6 Review View

Review is the curation workspace.

Sections:

- Source evidence: highlighted active segment
- Review list: low-confidence and filtered items

Actions:

- confirm
- edit
- reject
- add manual event
- rebuild derived state and relation data

#### 4. Export Formats

##### 4.1 JSON

Scoped analysis payload:

```json
{
  "document": {},
  "scope": {},
  "segments": [],
  "scenes": [],
  "mentions": [],
  "characters": [],
  "locations": [],
  "events": [],
  "states": [],
  "relations": [],
  "diagnostics": {}
}
```

##### 4.2 CSV

Event-oriented export columns:

- `event_id`
- `segment_id`
- `type`
- `status`
- `confidence`
- `characters`
- `locations`
- `summary`
- `source`

##### 4.3 Markdown

Human-readable summary:

- document title
- scope
- characters
- locations
- events

##### 4.4 TimelineJS

TimelineJS-compatible event structure.

##### 4.5 Graph JSON

Node/edge export for external graph tools.

Note: Graph export may include event nodes because it reflects the full schema relations. The on-screen Map intentionally hides event nodes and uses event summaries in Inspector.

#### 5. Current Implementation Files

##### 5.1 `app.js`

Responsibilities:

- bundled sample selection
- user text file upload
- analysis schema construction
- rule-based extraction
- Ollama dynamic seed lexicon extraction
- review status updates
- derived view helpers
- Reader, Map, Timeline, Characters, Review, Export rendering

Key functions:

- `analyzeNovel(input)`
- `buildSegments(text, documentId)`
- `extractCharacters(segments)`
- `extractLocations(segments)`
- `extractEvents(segments, characters, locations, documentId)`
- `buildCharacterStates(analysis)`
- `buildRelations(analysis)`
- `selectMapEvents()`
- `buildMapEdges(events)`
- `renderReader()`
- `renderGraph()`
- `renderInspector()`
- `renderTimeline()`
- `renderCharacters()`
- `renderReview()`
- `renderExport()`

##### 5.2 `index.html`

Static shell:

- topbar
- Reader pane
- analysis tabs
- filterbar
- Map
- Timeline
- Characters
- Review
- Export

##### 5.3 `styles.css`

Styling:

- modern analysis-tool layout
- one-row character cards
- active segment card
- graph and inspector surfaces
- review source highlighting
- responsive layout

##### 5.4 `server.js`

Express static server and local analyzer proxy.

Responsibilities:

- serve app files and bundled sample texts
- `POST /api/analyze/ollama`
- proxy local Ollama requests to `http://127.0.0.1:11434`
- reject model tags outside the 4b-7b range
- expose installed 4b-7b completion models through `GET /api/ollama/models`
- return structured JSON containing `characters`, `locations`, `event_types`, `mental_states`, `physical_states`, and `events` for schema merge in `app.js`

#### 6. Adjustment From Old Component Plan

The old component plan used an older schema:

- `work_id`
- `canonical_name` for locations
- `event_type`
- `evidence_segment_ids`
- `reader_visible_after_segment_id`
- `dynamic_traits`
- direct Ollama/Wikipedia steps in the core plan

The current implementation uses the open-source-stack schema:

- `document_id`
- location `name`
- event `type`
- `segment_id`
- `source_span`
- `mentions`
- `states`
- `relations`
- review `status`
- `confidence`

Therefore the old schema should not be used as the implementation contract. Ollama, Wikipedia, geocoding, and external NLP should be treated as future analyzer adapters that return the same schema defined in this document.

#### 7. Recommended Next Component Work

##### P0

- Keep the current schema stable.
- Split analyzer logic from UI rendering into separate modules.
- Add `analysis_schema.md` or JSON Schema tests.
- Add import/export roundtrip checks.

##### P1

- Add source span editing in Review.
- Add alias merge/split workflow.
- Add relation editing for events.
- Add confidence-based review queue sorting controls.

##### P2

- Add server `POST /api/analyze`.
- Add persistent document storage.
- Add Korean NLP or LLM adapter.
- Add optional social context enrichment.
- Add optional real-world geocoding for public locations.


---

## Part 3 — 기획·실행 계획 (Planning Document, 「날개」 기준)

> 원본 파일: `doc/plan.md`

소설 시점·인물·사건 지형 시각화 테스트 작업물 계획문서
대상 테스트 작품: 이상, 「날개」
작성일: 2026-05-09
형식: TXT 기획/실행 문서

### 1. 문서 목적

이 문서는 소설을 읽는 중 특정 시점까지의 인물, 사건, 장소, 이동, 심리 상태를
시각화하는 테스트 작업물의 제작 계획이다.

초기 테스트 대상은 이상(李箱)의 단편소설 「날개」로 한다. 「날개」는 분량이 짧고
공개 원문 접근이 비교적 쉬우며, 사건의 외적 이동보다 화자의 의식·공간 감각·자기
인식이 중요하기 때문에, 단순한 줄거리 추출을 넘어 '시점별 해석 상태'를 검증하기에
적합하다.

본 계획은 다음 아이디어에서 출발한다.

- 독자가 소설을 읽다가 특정 키를 누르면 현재 읽은 지점까지의 지도, 인물 상태,
  이동 경로, 타임라인을 볼 수 있다.
- AI가 현재까지의 텍스트를 분석해 지명, 등장인물, 대사, 이동 경로, 사건 순서를
  추출한다.
- 결과물은 단순 요약이 아니라 독서 흐름을 방해하지 않는 보조 레이어로 제공한다.
- 장기적으로는 개인 설정집, 세계관 노트, 인물 관계도, 장면 일러스트, 스탯/능력치
  정리 기능까지 확장 가능하다.

참고 아이디어:
- https://svrforum.com/software/3098884


### 2. 벤치마킹 요약

현재 시장에는 이 아이디어와 완전히 같은 서비스는 드물다. 다만 인접 사례는 있다.
벤치마킹 방향은 네 부류로 나눈다.

#### 2.1 World Anvil

성격:
- 세계관 구축, RPG 캠페인 관리, 소설 기획 도구
- 위키형 문서, 인터랙티브 지도, 역사 타임라인, 인물/가문/설정 관리 제공

벤치마킹 포인트:
- '소설 본문'보다 '세계관 데이터베이스' 중심이다.
- 지도, 타임라인, 인물 문서가 서로 연결되는 구조가 강점이다.
- 사용자가 수동으로 정리한 설정을 오래 축적하기 좋다.

적용 아이디어:
- 추출된 장소/인물/사건을 별도 엔티티 카드로 저장한다.
- 엔티티 간 링크를 자동 생성하되, 사용자가 편집할 수 있게 한다.
- 테스트 단계부터 “자동 추출 결과 = 확정 데이터”로 보지 않고 “수정 가능한 개인 설정집”으로 다룬다.

참고:
- https://www.worldanvil.com/
- https://www.worldanvil.com/learn/timelines/timelines


#### 2.2 Plottr

성격:
- 작가용 소설 플래닝 도구
- 시각적 타임라인, 캐릭터 시트, 장소/노트, 시리즈 바이블, 장면 매핑 제공

벤치마킹 포인트:
- 작가가 쓰기 전에 구조화하는 도구에 가깝다.
- 타임라인과 캐릭터 시트를 쉽게 편집하는 UX가 강점이다.
- 시리즈 단위로 인물·장소·설정을 재사용할 수 있다.

적용 아이디어:
- 독자용 서비스라도 “작가용 편집 UX”를 일부 차용한다.
- 자동 분석 결과를 표/카드/타임라인에서 빠르게 고칠 수 있어야 한다.
- 장면 단위, 인물 단위, 장소 단위 필터를 MVP에 넣는다.

참고:
- https://plottr.com/


#### 2.3 Campfire

성격:
- 작가용 세계관/소설 기획 도구
- 캐릭터, 지도, 노트, 설정, 스토리 아웃라인 등 모듈형 구성

벤치마킹 포인트:
- 여러 정보 패널을 사용자가 배치·수정하는 모듈형 UI가 강점이다.
- 지도에서 아이콘을 클릭하면 관련 설정/노트로 이동하는 구조가 있다.

적용 아이디어:
- 독서 화면 우측 또는 오버레이에 “패널형 시각화”를 둔다.
- 같은 데이터를 지도, 타임라인, 인물 카드, 장면 카드로 동시에 보여준다.
- 초반에는 지도보다 “패널 간 연결성”을 우선한다.

참고:
- https://www.campfirewriting.com/interactive-maps


#### 2.4 IFMapper

성격:
- 인터랙티브 픽션 게임의 공간 구조를 방/경로 형태로 그리는 매핑 도구
- 텍스트 기반 모험 게임에서 현재 위치와 연결 경로를 이해하기 위한 도구

벤치마킹 포인트:
- 지리 지도보다 “서사적 공간 그래프”에 가깝다.
- 텍스트 묘사 기반 위치 이동을 노드와 엣지로 단순화한다.
- 실제 지도가 없어도 공간 관계를 표현할 수 있다.

적용 아이디어:
- 「날개」처럼 현실 지명이 적고 심리적 공간이 중요한 작품에는 위도/경도 지도보다
  공간 노드 그래프가 적합하다.
- 방, 아내의 방, 거리, 다방/거리, 백화점 옥상 같은 식으로 공간을 노드화한다.
- 이동은 선으로 표현하되, 확실한 이동과 추정 이동을 시각적으로 구분한다.

참고:
- https://ggarra13.github.io/ifmapper/en/start.html


#### 2.5 Narrative Maps Visualization Tool, NMVT

성격:
- 여러 문서에서 사건과 서사선을 추출해 연결 관계를 시각화하는 연구/분석형 도구
- 사건 간 연결성, 스토리라인, 설명 가능한 AI 분석을 강조

벤치마킹 포인트:
- 단일 소설보다는 대규모 문서 컬렉션 분석에 가깝다.
- 사건을 그래프 구조로 보고, 사건 간 관계와 서사선을 추출한다.
- 탐색형 분석과 특정 사건 연결 분석을 모두 지원한다.

적용 아이디어:
- MVP에서는 복잡한 문서 클러스터링까지 가지 않는다.
- 대신 “사건 노드 + 근거 문장 + 시점 범위 + 관련 인물/장소” 구조를 차용한다.
- AI 추출 결과에는 반드시 근거 문장과 신뢰도를 붙인다.

참고:
- https://www.sciencedirect.com/science/article/pii/S2352711025003437


### 3. 벤치마킹 결론: 빠르게 완성도를 높이는 방향

완전히 새로운 UI를 처음부터 만들기보다, 검증된 구조를 조합한다.

핵심 결론:
1. 지도부터 만들지 않는다.
   - 「날개」는 공간보다 화자의 인식 변화가 중요하다.
   - 초기에는 “공간 그래프 + 타임라인 + 인물 상태 카드”가 더 적합하다.

2. 자동 추출 결과를 반드시 수정 가능하게 한다.
   - 소설 분석은 모호성이 크다.
   - 특히 「날개」는 아내, 나, 방, 외출, 약, 돈, 잠, 백화점 등의 의미가 단순 사실이 아니다.
   - “AI가 추출 → 사용자가 검토 → 수정본 저장” 구조가 필요하다.

3. 지도는 두 단계로 나눈다.
   - 1단계: 서사 공간 그래프
   - 2단계: 실제 지명 지도 또는 가상 지도
   - 현실 좌표가 없는 작품에도 대응할 수 있게 한다.

4. MVP는 “읽은 지점까지”의 상태를 보여주는 것에 집중한다.
   - 전체 줄거리를 미리 노출하면 독서 보조 기능이 아니라 스포일러 기능이 된다.
   - 독서 위치 기준으로 엔티티와 사건을 누적 계산한다.

5. 데이터 구조를 먼저 안정화한다.
   - UI보다 중요한 것은 장면, 인물, 장소, 사건, 근거 문장, 신뢰도, 시점 범위의 스키마다.
   - 이 데이터만 안정되면 지도/타임라인/관계망은 나중에 교체 가능하다.


### 4. 테스트 대상: 이상 「날개」

선정 이유:
- 짧은 단편이라 전체 파이프라인 테스트 비용이 낮다.
- 등장인물이 적어 인물 추출과 관계 추적을 검증하기 쉽다.
- 공간은 제한적이지만 상징성이 강해 “지리 지도”와 “심리적 공간”의 차이를 검증할 수 있다.
- 사건은 많지 않지만 화자의 인식 변화가 뚜렷해 시점별 상태 변화 테스트에 적합하다.
- 공개 원문 접근성이 높다.

주의:
- 원문 판본마다 띄어쓰기, 표기, 문단 구분이 다를 수 있다.
- 테스트 데이터셋에는 기준 판본 URL, 수집일, 문단 ID를 함께 저장한다.
- 서비스 공개 시 원문 재배포 여부와 이용 조건을 별도 확인한다.

추천 기준 원문 후보:
- 다빈치맵 원문/전문 보기: https://www.davincimap.co.kr/davBase/Source/davSource.jsp?Job=Body&SourID=SOUR001427
- 한국민족문화대백과사전 작품 정보: https://encykorea.aks.ac.kr/Article/E0011736


### 5. 목표 사용자

1차 사용자:
- 소설을 읽으며 인물, 장소, 사건을 빠르게 정리하고 싶은 독자
- 고전/장편/판타지/무협/SF 독자
- 작품 분석을 해야 하는 학생, 연구자, 독서 모임 참여자

2차 사용자:
- 작가, 웹소설 작가, 시나리오 작가
- 자신이 쓴 원고의 사건 흐름, 인물 동선, 설정 오류를 점검하고 싶은 창작자
- 장편 시리즈의 세계관 설정집을 자동 생성하고 싶은 사용자


### 6. 핵심 사용 시나리오

시나리오 A: 독서 중 즉시 확인
1. 사용자가 소설을 읽는다.
2. 특정 위치에서 M 키 또는 지도 버튼을 누른다.
3. 현재 문단까지의 정보만 기반으로 오버레이가 열린다.
4. 오버레이에는 다음 정보가 표시된다.
   - 현재까지 등장한 인물
   - 현재까지 확인된 공간
   - 현재까지 발생한 주요 사건
   - 화자의 위치 또는 심리적 위치
   - 인물 간 관계 변화
   - 사건 타임라인

시나리오 B: 장면 단위 분석
1. 사용자가 장면 목록을 연다.
2. 각 장면의 요약, 등장인물, 장소, 사건, 감정 톤을 확인한다.
3. 특정 장면을 클릭하면 원문 근거 문장으로 이동한다.

시나리오 C: 분석 결과 수정
1. AI가 “방”과 “아내의 방”을 하나로 묶었다.
2. 사용자가 두 공간을 분리한다.
3. 이후 시각화는 수정된 구조를 기준으로 다시 계산된다.

시나리오 D: 교육/연구용 내보내기
1. 전체 작품 분석을 완료한다.
2. 인물표, 사건표, 공간표, 타임라인을 CSV/JSON/Markdown으로 내보낸다.
3. 작품 분석 보고서나 수업 자료로 활용한다.


### 7. MVP 범위

MVP 목표:
- 이상 「날개」 전문을 입력하면 장면 단위로 분할한다.
- 각 장면에서 인물, 장소, 사건, 심리 상태, 근거 문장을 추출한다.
- 독서 위치별로 누적 상태를 계산한다.
- 오버레이에서 공간 그래프, 사건 타임라인, 인물 상태 카드를 보여준다.
- 사용자가 AI 추출 결과를 수정할 수 있다.

MVP 포함 기능:
1. 텍스트 입력/불러오기
2. 문단 및 장면 분할
3. 인물 추출
4. 장소/공간 추출
5. 사건 추출
6. 시점별 누적 상태 계산
7. 공간 그래프
8. 사건 타임라인
9. 인물 상태 카드
10. 원문 근거 문장 표시
11. 수동 수정
12. JSON 내보내기

MVP 제외 기능:
1. 자동 장면 일러스트 생성
2. 인물 일러스트 생성
3. 음향/영상 연출
4. 웹소설 플랫폼 연동
5. 다중 작품 비교
6. 계정/동기화/협업
7. 대규모 추천 시스템
8. 실제 지리 좌표 자동 매핑


### 8. 데이터 모델 초안

8.1 Work
- work_id
- title
- author
- publication_year
- source_url
- source_accessed_at
- copyright_note
- raw_text_hash

8.2 Segment
- segment_id
- work_id
- order
- start_char
- end_char
- text
- scene_id
- spoiler_level

8.3 Scene
- scene_id
- work_id
- order
- title
- summary
- start_segment_id
- end_segment_id
- dominant_location_id
- narrator_state
- confidence

8.4 Character
- character_id
- work_id
- canonical_name
- aliases
- description
- first_appearance_segment_id
- role
- confidence

예시:
- C001: 나 / 화자
- C002: 아내
- C003: 손님 또는 아내의 남자들
- C004: 거리의 군중/타인

8.5 Location
- location_id
- work_id
- canonical_name
- aliases
- type
- description
- real_world_candidate
- parent_location_id
- confidence

예시:
- L001: 나의 방
- L002: 아내의 방
- L003: 거리
- L004: 다방/외출지
- L005: 미츠코시 백화점 옥상 또는 백화점 공간

8.6 Event
- event_id
- work_id
- scene_id
- order
- event_type
- summary
- characters
- locations
- evidence_segment_ids
- certainty
- reader_visible_after_segment_id

이벤트 타입 예시:
- appearance
- movement
- conversation
- perception
- memory
- conflict
- realization
- symbolic_event

8.7 CharacterState
- state_id
- character_id
- segment_id
- physical_location_id
- mental_state
- relation_changes
- known_facts
- uncertainty_note

8.8 Edge
- edge_id
- source_type
- source_id
- target_type
- target_id
- relation_type
- evidence_segment_ids
- certainty

관계 타입 예시:
- located_in
- moves_to
- speaks_to
- depends_on
- controls
- avoids
- suspects
- remembers
- symbolizes


### 9. 「날개」 테스트용 장면 분할 초안

아래 분할은 초기 가설이며, 원문 기준으로 재조정한다.

S01. 도입부: 박제가 되어 버린 천재
- 핵심: 화자의 자기 인식, 날개 상징의 예고
- 시각화: 화자 상태 카드 중심

S02. 방 안의 생활
- 핵심: 화자의 무기력, 아내와 분리된 공간 구조
- 시각화: 나의 방 / 아내의 방 공간 그래프

S03. 아내의 방과 손님들
- 핵심: 화자가 아내의 생활을 관찰하지만 완전히 이해하지 못함
- 시각화: 인물 관계의 불균형, 정보 비대칭

S04. 돈, 잠, 약, 통제
- 핵심: 아내가 화자를 통제하거나 관리하는 정황
- 시각화: 사건 타임라인과 화자 상태 변화

S05. 외출
- 핵심: 내부 공간에서 외부 공간으로 이동
- 시각화: 방 → 거리 → 외출지 이동 경로

S06. 반복되는 귀환과 인식 변화
- 핵심: 외출 후 다시 방으로 돌아오며 자기 인식이 흔들림
- 시각화: 반복 이벤트, 감정/각성도 그래프

S07. 백화점 또는 도시 공간
- 핵심: 도시적 공간, 고도, 군중, 근대성
- 시각화: 실제 지명 후보 또는 상징 공간 노드

S08. 결말: 날개야 다시 돋아라
- 핵심: 회복 욕망, 탈출 욕망, 상징적 각성
- 시각화: 화자 상태 카드와 상징 이벤트 강조


### 10. UI 설계

10.1 기본 독서 화면
- 중앙: 원문 텍스트
- 우측: 접을 수 있는 미니 패널
- 단축키:
  - M: 지도/공간 그래프 열기
  - T: 타임라인 열기
  - C: 인물 카드 열기
  - E: 현재 장면의 사건 목록 열기
  - S: 스포일러 보호 토글

10.2 오버레이 구성
- 상단: 현재 읽은 위치
- 좌측: 공간 그래프
- 중앙: 사건 타임라인
- 우측: 인물 상태 카드
- 하단: 원문 근거 문장

10.3 공간 그래프
- 노드: 장소 또는 심리적 공간
- 엣지: 이동, 관찰, 상상, 회상
- 선 스타일:
  - 실선: 원문 근거가 명확한 이동
  - 점선: 추정 이동
  - 흐린 선: 상징적/심리적 연결

10.4 인물 카드
각 인물 카드에 표시:
- 이름
- 별칭
- 현재까지의 역할
- 마지막 등장 위치
- 화자와의 관계
- 상태 변화
- 근거 문장
- AI 신뢰도
- 사용자가 수정한 항목 표시

10.5 타임라인
각 사건에 표시:
- 사건 요약
- 발생 장면
- 관련 인물
- 관련 장소
- 근거 문장
- 해석 유형: 사실 / 추정 / 상징 / 심리


### 11. 기술 구조

11.1 권장 구조
- Frontend: React 또는 Next.js
- Visualization:
  - 공간 그래프: Cytoscape.js 또는 React Flow
  - 타임라인: vis-timeline 또는 자체 컴포넌트
  - 표/편집: TanStack Table
- Backend:
  - Python FastAPI 또는 Node.js
- NLP/LLM:
  - 초기: LLM API 기반 추출
  - 대안: 로컬 모델 + 규칙 기반 보정
- Storage:
  - MVP: SQLite + JSON 파일
  - 이후: PostgreSQL

11.2 처리 파이프라인
1. 원문 수집
2. 정규화
3. 문단 분할
4. 장면 분할
5. 엔티티 추출
6. 사건 추출
7. 인물 상태 추적
8. 공간 그래프 생성
9. 타임라인 생성
10. 사용자 수정 반영
11. 재계산
12. 내보내기

11.3 LLM 프롬프트 출력 형식
모든 추출 결과는 JSON으로 고정한다.

예시:
{
  "scene_id": "S02",
  "summary": "화자는 방 안에서 무기력하게 지내며 아내의 공간과 분리되어 있다.",
  "characters": [
    {
      "name": "나",
      "role": "화자",
      "evidence": ["..."],
      "confidence": 0.91
    },
    {
      "name": "아내",
      "role": "화자의 아내",
      "evidence": ["..."],
      "confidence": 0.88
    }
  ],
  "locations": [
    {
      "name": "나의 방",
      "type": "interior",
      "evidence": ["..."],
      "confidence": 0.85
    }
  ],
  "events": [
    {
      "type": "perception",
      "summary": "화자가 자신의 생활 상태를 진술한다.",
      "characters": ["나"],
      "locations": ["나의 방"],
      "certainty": "explicit",
      "evidence": ["..."]
    }
  ]
}


### 12. 평가 기준

정량 평가:
- 인물 추출 정확도
- 장소 추출 정확도
- 사건 추출 정확도
- 장면 분할 적절성
- 근거 문장 연결률
- 사용자 수정 횟수
- 독서 위치별 스포일러 누출 여부

정성 평가:
- 독서 흐름을 방해하지 않는가
- “현재까지 알고 있는 정보”만 보여주는가
- 모호한 해석을 단정하지 않는가
- 지도가 작품 이해에 실제로 도움이 되는가
- 인물/사건 시각화가 단순 요약보다 나은가

테스트 질문:
1. 사용자는 현재 화자가 어디에 있다고 느끼는가?
2. 사용자는 아내와 화자의 관계를 더 잘 이해하는가?
3. 공간 그래프가 실제 지도가 아니라도 도움이 되는가?
4. 결말 전까지 결말의 상징을 과도하게 노출하지 않는가?
5. AI가 틀린 결과를 사용자가 쉽게 고칠 수 있는가?


### 13. 빠른 제작 일정

Day 1: 원문 확보 및 데이터 정규화
- 기준 원문 선택
- 문단 ID 부여
- 텍스트 해시 저장
- 장면 분할 초안 작성

Day 2: 추출 스키마와 LLM 프롬프트 작성
- 인물, 장소, 사건 JSON 스키마 확정
- 장면별 추출 테스트
- 근거 문장 포함 여부 검증

Day 3: 기본 시각화 구현
- 공간 그래프
- 사건 타임라인
- 인물 카드
- 원문 근거 보기

Day 4: 독서 위치별 누적 상태 구현
- 특정 문단까지의 정보만 표시
- 스포일러 차단
- 현재 위치 기준 필터링

Day 5: 수정 UX 구현
- 인물명 병합/분리
- 장소명 병합/분리
- 사건 삭제/수정
- 수정 후 그래프 재생성

Day 6: 「날개」 전체 테스트
- 전체 파이프라인 실행
- 오류 유형 기록
- 시각화 품질 점검

Day 7: 데모 정리
- 샘플 화면 캡처
- 데이터셋 내보내기
- README 작성
- 다음 작품 테스트 계획 수립


### 14. 우선순위

P0: 반드시 구현
- 원문 입력
- 문단/장면 분할
- 인물/장소/사건 추출
- 근거 문장 연결
- 공간 그래프
- 타임라인
- 인물 카드
- 독서 위치별 스포일러 차단

P1: 완성도 향상
- 수동 수정
- 신뢰도 표시
- 추정/명시/상징 구분
- JSON/CSV 내보내기
- 장면별 감정 톤

P2: 후속 확장
- 실제 지도 연동
- 장면 일러스트 생성
- 인물 이미지 생성
- 작가용 원고 분석 모드
- 여러 작품 비교
- 계정 기반 개인 설정집


### 15. 리스크와 대응

리스크 1: AI가 모호한 해석을 사실처럼 표시
대응:
- 모든 결과에 근거 문장과 신뢰도를 표시한다.
- 사실/추정/상징/심리 항목을 구분한다.
- 사용자가 결과를 수정할 수 있게 한다.

리스크 2: 지도 기능이 작품과 맞지 않음
대응:
- 실제 지도보다 공간 그래프를 먼저 구현한다.
- 현실 지명 작품과 비현실/심리 공간 작품을 분리 대응한다.

리스크 3: 스포일러 발생
대응:
- reader_visible_after_segment_id를 둔다.
- 현재 읽은 위치 이후의 정보는 계산하더라도 표시하지 않는다.
- 전체 분석 모드와 독서 모드를 분리한다.

리스크 4: 원문 저작권/이용 조건 문제
대응:
- 공개 원문이라도 출처와 이용 조건을 확인한다.
- 테스트 내부용 데이터와 공개 배포 데이터를 분리한다.
- 사용자가 직접 텍스트를 업로드하는 BYOT(Bring Your Own Text) 방식도 제공한다.

리스크 5: 사용자가 수정하기 어렵다
대응:
- 그래프에서 직접 수정하기보다 우선 표/카드 기반 편집을 제공한다.
- 병합/분리/이름 변경/근거 문장 수정만 먼저 제공한다.


### 16. 추천 MVP 화면 구성

화면 1: Reader
- 원문 텍스트
- 현재 문단 진행률
- M/T/C/E 단축키 안내

화면 2: Map Overlay
- 공간 노드 그래프
- 현재까지 확인된 이동
- 확실/추정/상징 연결 구분

화면 3: Timeline Overlay
- 장면별 사건 카드
- 사건 유형 필터
- 근거 문장 클릭 이동

화면 4: Character Panel
- 나
- 아내
- 손님/타인
- 인물별 상태 변화

화면 5: Review/Edit
- AI 추출 결과 표
- 병합/분리/수정
- 재계산 버튼

화면 6: Export
- JSON
- CSV
- Markdown summary


### 17. 테스트 데이터 예시 구조

파일 구조:
wings-test/
  raw/
    wings_source.txt
    source_meta.json
  processed/
    segments.json
    scenes.json
    characters.json
    locations.json
    events.json
    states.json
    graph.json
  app/
    demo_config.json
  export/
    wings_analysis.md
    wings_analysis.csv

source_meta.json 예시:
{
  "title": "날개",
  "author": "이상",
  "source_url": "https://www.davincimap.co.kr/davBase/Source/davSource.jsp?Job=Body&SourID=SOUR001427",
  "accessed_at": "2026-05-09",
  "notes": "테스트용 기준 원문. 서비스 공개 전 이용 조건 재확인 필요."
}


### 18. 다음 테스트 작품 후보

「날개」 이후에는 성격이 다른 작품을 추가해 범용성을 검증한다.

1. 김유정, 「동백꽃」
- 인물 적음
- 사건 선명
- 공간과 관계가 비교적 명확

2. 현진건, 「운수 좋은 날」
- 도시 공간
- 시간 흐름 선명
- 반전 구조가 있어 스포일러 제어 검증 가능

3. 이효석, 「메밀꽃 필 무렵」
- 이동 경로와 장소성이 중요
- 실제 지리 지도 테스트에 적합

4. 판타지/무협 공개 웹소설 샘플
- 가상 지명과 세계관 지도 테스트에 적합
- 단, 저작권/이용 허락 필요


### 19. 최종 산출물 정의

1차 데모 산출물:
- 웹 기반 리더 화면
- M 키 지도/공간 그래프 오버레이
- 타임라인 오버레이
- 인물 상태 카드
- 「날개」 분석 JSON
- 수정 가능한 엔티티 테이블
- README 및 테스트 리포트

완성 기준:
- 「날개」 전체를 장면 단위로 탐색할 수 있다.
- 특정 문단까지 읽은 상태에서 이후 사건이 노출되지 않는다.
- 인물/장소/사건마다 근거 문장이 있다.
- 사용자가 최소한 인물명, 장소명, 사건 요약을 수정할 수 있다.
- 공간 그래프와 타임라인이 동일한 데이터에서 생성된다.


### 20. 한 줄 제품 정의

“읽는 지점까지의 소설 세계를 지도, 타임라인, 인물 상태로 즉시 펼쳐 보여주는
스포일러 안전형 인터랙티브 북 리더.”

### 끝


---

## Part 4 — 미해결 과제 메모 (Open Issues)

> 원본 파일: `doc/task.md`

- 인물 감정어, 장소, 이벤트, 감정 등에 대한 분류를 Seed Lexicon으로 정적으로 정의 되어 있는데 임의의 단편소설에 대해서도 분석하려면 동적으로 분석하고 브라우저에도 동적으로 요소를 추적하고 매핑할 수 있게 해줘야 한다.
- 심리상태 및 신체상태가 미정이 뜨는 건 LLM 기반 Seed Lexicon 동적 생성 및 브라우저 표현을 못하고 있는거로 보인다.
- 헤더 버튼이 모두 무슨 기능을 하는지 명칭이 애매하고 역할이 중복된 부분도 있다.

---
