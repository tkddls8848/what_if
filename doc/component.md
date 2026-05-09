# Novel IF — 핵심 컴포넌트 구현 계획

작성일: 2026-05-09  
수정일: 2026-05-09 (「날개」 전문 분석 반영)  
대상 파일: `app.js`, `index.html`, `styles.css`  
테스트 작품: 이상, 「날개」 (1936년 9월 『조광』)  
원문 위치: `texts/wings.txt`

---

## 0. 설계 원칙

| 작업 | 방식 | 이유 |
|------|------|------|
| 인물 외양·성격 파싱 | **Ollama 로컬 LLM** | 텍스트 해석 정확, API 키 불필요, 프라이버시 |
| 이벤트 사회상 컨텍스트 | **Wikipedia fetch** | 출처 명확한 외부 사실 (LLM 환각 방지) |
| 장소 허구/실제 분류 | **Ollama 로컬 LLM** | 단서 기반 판단 |
| 장소 실제 좌표 | **Nominatim** (선택) | 실제 지명에만, 허구 장소는 불필요 |
| 인물·장소·이벤트 1차 추출 | **규칙 기반** (현재 app.js) | 빠름, 오프라인, fallback |

핵심 원칙:
1. **시점 누적**: 독서 위치 N에서는 P001~PN까지의 정보만 노출 (스포일러 방지)
2. **다이나믹 인물**: 이벤트 발생 시 인물 외양·성격 변화를 누적 기록 (`dynamic_traits`)
3. **다층 장소**: 실제 지명(경성역, 미쓰꼬시) + 허구 공간(33번지 내방·아내방) 병행
4. **사회상 보강**: 이벤트 단위로 1936년 경성 컨텍스트 자동 fetch

---

## 1. 「날개」 분석 결과 (Seed Data)

### 1-1. 작품 메타데이터

```jsonc
{
  "work_id": "W001",
  "title": "날개",
  "author": "이상 (李箱, 본명 김해경, 1910-1937)",
  "publication_year": 1936,
  "publication_month": 9,
  "publication_journal": "조광(朝光)",
  "era": "일제강점기 경성",
  "genre": "모더니즘 단편소설",
  "narrative_pov": "1인칭 주인공 시점",
  "narrator_age": 26,
  "story_setting_year": 1936,
  "story_setting_season": "5월",
  "key_symbols": [
    "박제", "날개", "은화 50전", "5원 지폐",
    "벙어리(저금통)", "아스피린", "아달린",
    "정오 사이렌", "33번지", "미쓰꼬시 옥상", "금붕어"
  ],
  "structural_arcs": [
    "A1 자기 인식 프롤로그",
    "A2 33번지의 일상",
    "A3 돈의 발견과 벙어리",
    "A4 첫 외출과 자정 위반",
    "A5 두 번째 외출과 화해",
    "A6 비 오는 날의 외출",
    "A7 감기와 약(아스피린)",
    "A8 아달린 발견과 산으로의 도피",
    "A9 미쓰꼬시 옥상의 정오"
  ]
}
```

### 1-2. 인물 시드 (Characters)

5명 (실제 등장 인물 + 익명 다수):

| ID | 이름 | 역할 | 첫 등장 (Arc) | 의미 |
|----|------|------|--------------|------|
| C001 | **나** | 1인칭 화자, 26세 | A1 | 무기력 → 깨달음 → 비상 욕망 |
| C002 | **아내 (연심)** | 배우자, 직업 불명 | A2 | 통제자, 후반에 발악 |
| C003 | **내객** | 아내의 손님들 (서너 사람) | A3 | 아내의 직업 의문의 단서 |
| C004 | **낯선 남자** | 결말부의 특정 남자 | A4 / A9 | 결말 파국의 촉매 |
| C005 | **18가구 사람들** | 33번지 동거 여인들 | A2 | 배경, 화자 사회 단절 표현 |

**C001 — 나** (전체 시드 예시):

```jsonc
{
  "character_id": "C001",
  "canonical_name": "나",
  "aliases": ["나", "나는", "내", "내가", "나를", "나의", "내게"],
  "role": "화자",

  "appearance": {
    "text": "안색이 창백, 영양 부족으로 야윔, 골덴 양복 한 벌과 하이넥 스웨터, 빛이 검은 옷",
    "traits": ["창백", "야윔", "검은 의복", "수염 자람"],
    "evidence_segment_ids": ["P049", "P062", "P133"],
    "last_updated_by_event": "E055"
  },
  "personality": {
    "traits": ["무기력", "사색적", "자의식 강함", "의존적", "관찰자적", "야맹증"],
    "evidence_segment_ids": ["P001", "P019", "P032", "P068"],
    "last_updated_by_event": "E077"
  },
  "initial_mental_state": "정체",
  "first_appearance_segment_id": "P001",

  "dynamic_traits": [
    { "trait_key": "mental_state", "value": "호기심", "changed_by_event_id": "E023", "segment_id": "P052", "previous_value": "정체" },
    { "trait_key": "mental_state", "value": "외부 지향", "changed_by_event_id": "E026", "segment_id": "P069", "previous_value": "호기심" },
    { "trait_key": "mental_state", "value": "쾌감 발견", "changed_by_event_id": "E033", "segment_id": "P088", "previous_value": "외부 지향" },
    { "trait_key": "mental_state", "value": "충격", "changed_by_event_id": "E058", "segment_id": "P135", "previous_value": "정체(약물)" },
    { "trait_key": "mental_state", "value": "비상 욕망", "changed_by_event_id": "E076", "segment_id": "P163", "previous_value": "절망" }
  ]
}
```

**C002 — 아내 (연심)**:

```jsonc
{
  "character_id": "C002",
  "canonical_name": "아내",
  "aliases": ["아내", "아내가", "아내는", "그녀"],
  "real_name": "연심",
  "role": "배우자",
  "appearance": {
    "text": "33번지에서 가장 작고 아름다운 여인, 화려한 치마저고리, 진솔 버선",
    "traits": ["작고 아름다움", "화려한 옷차림", "화장대 소유"],
    "evidence_segment_ids": ["P017", "P028", "P046"]
  },
  "personality": {
    "traits": ["통제적", "신비", "정중함", "내객 응대"],
    "evidence_segment_ids": ["P040", "P082", "P102"]
  },
  "dynamic_traits": [
    { "trait_key": "stance_to_narrator", "value": "거리 유지", "segment_id": "P017" },
    { "trait_key": "stance_to_narrator", "value": "노기", "changed_by_event_id": "E032", "segment_id": "P082" },
    { "trait_key": "stance_to_narrator", "value": "관용", "changed_by_event_id": "E034", "segment_id": "P088" },
    { "trait_key": "stance_to_narrator", "value": "호의", "changed_by_event_id": "E044", "segment_id": "P102" },
    { "trait_key": "stance_to_narrator", "value": "음모(아달린)", "changed_by_event_id": "E054", "segment_id": "P126" },
    { "trait_key": "stance_to_narrator", "value": "발악", "changed_by_event_id": "E067", "segment_id": "P150" }
  ]
}
```

### 1-3. 장소 시드 (Locations)

8곳, 실제/허구가 명확히 구분됨:

| ID | 이름 | 유형 | 실제/허구 | 좌표 | 첫 등장 |
|----|------|------|---------|------|--------|
| L001 | **33번지** | residential | 부분 허구 (구조는 사실) | — | A2 |
| L002 | **내 방 (윗방)** | interior | 허구 | — | A2 |
| L003 | **아내 방 (아랫방)** | interior | 허구 | — | A2 |
| L004 | **변소** | interior | 허구 | — | A3 (E024) |
| L005 | **경성 거리** | exterior | 실제 | 경성 도심부 | A4 |
| L006 | **경성역 티이루움** | public | 실제 | 37.5550, 126.9707 | A6 |
| L007 | **산** | symbolic | 모호 | — | A8 |
| L008 | **미쓰꼬시 옥상** | symbolic/public | 실제 | 37.5605, 126.9819 | A9 |

**L008 — 미쓰꼬시 옥상** (실제 좌표 + 사회상 보강 예시):

```jsonc
{
  "location_id": "L008",
  "canonical_name": "미쓰꼬시 옥상",
  "aliases": ["미쓰꼬시", "미쓰꼬시 옥상", "옥상"],
  "type": "symbolic",
  "is_fictional": false,
  "real_world_candidate": "미쓰코시 백화점 경성지점 (현 신세계백화점 본점)",
  "real_coords": { "lat": 37.5605, "lng": 126.9819 },
  "geocode_source": "manual",
  "era": "1930-1945",
  "symbolic_meaning": "근대 소비문화의 정점에서 화자가 비상을 욕망하는 결말 공간",
  "narrative_coords": { "x": 720, "y": 120 },
  "evidence_segment_ids": ["P153", "P156", "P162"],
  "first_appearance_segment_id": "P153",
  "social_context_keywords": [
    "미쓰코시 백화점 경성",
    "1930년대 경성 백화점",
    "일제강점기 근대 소비문화"
  ]
}
```

**L002 — 내 방** (허구·심리 공간 예시):

```jsonc
{
  "location_id": "L002",
  "canonical_name": "내 방",
  "aliases": ["내 방", "윗방", "이 방"],
  "type": "interior",
  "is_fictional": true,
  "parent_location_id": "L001",
  "narrative_coords": { "x": 280, "y": 320 },
  "real_coords": null,
  "symbolic_meaning": "해 안 드는 화자의 고립 공간, 자아의 폐쇄",
  "evidence_segment_ids": ["P019", "P022", "P031"],
  "first_appearance_segment_id": "P019"
}
```

### 1-4. 이벤트 타임라인 (Events)

9개 Arc, 핵심 이벤트 30개를 우선 추적. (전체 75+개는 분석 시 자동 추출)

**Arc A1 — 자기 인식 프롤로그 (P001-P011)**

| ID | seg | type | summary | 의미 |
|----|-----|------|---------|------|
| E001 | P001 | symbolic | 박제가 되어버린 천재 자기 인식 | 작품 전체의 핵심 메타포 |
| E002 | P002 | perception | 위트와 패러독스 - 상식의 병 | 화자의 의식 위치 |
| E003 | P003 | perception | 여인과 생활을 설계 | 아내의 존재 예고 |

**Arc A2 — 33번지의 일상 (P012-P035)**

| ID | seg | type | summary | 의미 |
|----|-----|------|---------|------|
| E005 | P012 | background | 33번지 18가구 환경 묘사 (유곽 같은 구조) | 공간 도입 |
| E007 | P019 | stasis | 화자가 내 방에 만족하며 게으르게 지냄 | 초기 상태 |
| E008 | P024 | movement | 아내 외출 시 화자가 아랫방으로 건너감 | 첫 공간 이동 |
| E011 | P026 | perception | 화장품 향기로 아내의 체취 연상 | 감각 의존 |

**Arc A3 — 돈의 발견과 벙어리 (P036-P068)**

| ID | seg | type | summary | 의미 |
|----|-----|------|---------|------|
| E017 | P039 | perception | 아내의 직업이 무엇인가 의문 | 의문 제기 |
| E019 | P040 | background | 아내가 50전 은화를 머리맡에 놓음 | 돈의 등장 |
| E020 | P041 | background | 아내가 금고형 벙어리(저금통)를 사다 줌 | 통제 장치 |
| **E023** | **P052** | **realization** | **내객들이 돈 놓고 가는 것을 깨달음** | ⭐ 1차 깨달음 |
| **E024** | **P060** | **conflict** | **화자가 벙어리를 변소에 버림** | ⭐ 첫 반항 |

**Arc A4 — 첫 외출과 자정 위반 (P069-P088)**

| ID | seg | type | summary | 의미 |
|----|-----|------|---------|------|
| **E026** | **P069** | **movement** | **화자의 첫 밤 외출 (5원 들고)** | ⭐ 외부 진입 |
| **E028** | **P072** | **conflict** | **자정 전 귀가, 아내와 낯선 남자 마주침** | ⭐ 자정 위반 |
| E032 | P082 | conflict | 아내가 노기로 화자를 흔들어 깨움 | 처벌 |
| **E033** | **P088** | **realization** | **화자가 5원을 아내에게 쥐어줌** | ⭐ 쾌감 발견 |
| **E034** | **P089** | **realization** | **처음으로 아내 방에서 잠** | ⭐ 관계 변화 |

**Arc A5 — 두 번째 외출과 화해 (P089-P107)**

| ID | seg | type | summary | 의미 |
|----|-----|------|---------|------|
| E038 | P094 | realization | 5원 쾌감의 비밀을 깨달음 | 2차 깨달음 |
| E039 | P097 | movement | 두 번째 외출 (포켓 속 2원) | 자발적 외출 |
| **E041** | **P099** | **perception** | **경성역 시계로 자정 확인 후 귀가** | ⭐ 시간 통제 |
| E043 | P099 | realization | 2원 줌, 두 번째로 아내 방에서 잠 | 패턴화 |
| **E044** | **P102** | **conversation** | **아내가 처음으로 화자를 자기 방으로 부름** | ⭐ 관계 역전 |

**Arc A6 — 비 오는 날의 외출 (P108-P124)**

| ID | seg | type | summary | 의미 |
|----|-----|------|---------|------|
| E048 | P112 | conversation | 아내가 "오늘은 늦게 와도 좋다" | 시간 연장 허락 |
| **E050** | **P116** | **movement** | **경성역 일이등 대합실 티이루움에서 커피** | ⭐ 새 공간 발견 |
| E052 | P123 | conflict | 자정 전 비 맞고 귀가, 내객 봄 | 두 번째 위반 |
| **E053** | **P124** | **stasis** | **의식 잃음, 감기** | ⭐ 무력화 시작 |

**Arc A7 — 감기와 약 (P125-P132)**

| ID | seg | type | summary | 의미 |
|----|-----|------|---------|------|
| **E054** | **P126** | **background** | **아내가 아스피린(이라며)을 줌** | ⭐ 음모의 시작 |
| E055 | P128 | stasis | 한 달 동안 약 먹고 잠만 잠 | 의식 상실기 |

**Arc A8 — 아달린 발견과 산 (P133-P146)**

| ID | seg | type | summary | 의미 |
|----|-----|------|---------|------|
| E056 | P133 | perception | 화자가 거울로 자란 머리/수염 봄 | 시간 자각 |
| **E057** | **P134** | **perception** | **아내 이름 "연심이" 부름** | ⭐ 인격화 |
| **E058** | **P135** | **realization** | **아달린갑 발견** | ⭐ 핵심 깨달음 |
| **E060** | **P138** | **movement** | **화자가 산으로 도피** | ⭐ 첫 능동 도피 |
| **E061** | **P140** | **symbolic** | **벤치에서 아달린 6개 한꺼번에 먹고 잠듦** | ⭐ 자기 파괴 |

**Arc A9 — 결말 (P147-P167)**

| ID | seg | type | summary | 의미 |
|----|-----|------|---------|------|
| E065 | P146 | movement | 집으로 돌아감 | 마지막 귀가 |
| **E066** | **P147** | **conflict** | **아내와 다른 남자의 모습을 봄** | ⭐ 결정적 폭로 |
| **E067** | **P150** | **conflict** | **아내의 발악 (도둑질/계집질 의심)** | ⭐ 관계 종결 |
| E068 | P150 | movement | 화자가 돈 놓고 도주 | 마지막 분리 |
| **E070** | **P153** | **movement** | **미쓰꼬시 옥상에 있음을 깨달음** | ⭐ 결말 공간 |
| E071 | P154 | perception | 26년 인생 회고 | 자기 총체 |
| E072 | P156 | symbolic | 금붕어를 들여다봄 | 갇힌 자아 |
| **E075** | **P162** | **symbolic** | **정오 사이렌이 울림** | ⭐ 시간의 정점 |
| **E076** | **P163** | **symbolic** | **겨드랑이 간지러움, 인공의 날개 자각** | ⭐ 비상 자각 |
| **E077** | **P165** | **realization** | **"날개야 다시 돋아라"** | ⭐⭐ 결말 외침 |

⭐ 표시는 인물 동적 변화나 사회상 fetch가 트리거되는 핵심 이벤트.

### 1-5. 인물 동적 변화 추적 표

화자 상태가 핵심 이벤트마다 어떻게 변하는지를 시점 누적으로 표현:

```
독서 위치 P001-P051   →  상태: 정체, 무기력, 자기 비하
                         성격 태그: [무기력, 사색적, 의존적]

독서 위치 P052 (E023) →  상태 변화: → 호기심
                         새 태그: [호기심] 추가

독서 위치 P060 (E024) →  상태 변화: → 작은 반항
                         새 태그: [반항] 추가

독서 위치 P069 (E026) →  상태 변화: → 외부 지향
                         물리 위치: 내 방 → 거리

독서 위치 P088 (E033) →  상태 변화: → 쾌감 발견
                         물리 위치: 거리 → 아내 방 (첫!)
                         관계 변화: 아내와 거리 ↓

독서 위치 P102 (E044) →  상태 변화: → 가족화
                         관계 변화: 아내가 처음 나를 부름

독서 위치 P124 (E053) →  상태 변화: → 무력화
                         외양 변화: 감기, 야윔 심화

독서 위치 P135 (E058) →  상태 변화: → 충격, 의심
                         성격 변화: [의존적] 약화 → [의심] 추가

독서 위치 P150 (E067) →  상태 변화: → 절망
                         관계 변화: 아내와 결별

독서 위치 P163 (E076) →  상태 변화: → 비상 욕망 (각성)
                         새 태그: [각성] [날고 싶음] 추가

독서 위치 P167 (E077) →  최종 상태: 비상의 외침
```

---

## 2. 타임라인 기반 인터랙티브 플로우

### 2-1. 독서 위치 → 시각화 동기화

```
사용자 동작 (슬라이더 / 문단 클릭 / 타임라인 이벤트 클릭)
   ↓
state.currentSegment 갱신
   ↓
render() 호출
   ├─ renderReader()      현재 문단 강조
   ├─ renderGraph()       이미 등장한 장소만 노드로 표시
   ├─ renderTimeline()    이미 발생한 이벤트만 카드로 나열
   ├─ renderCharacters()  각 인물의 currentSegment 시점 상태 카드
   └─ renderEvidence()    근거 문장 패널
```

### 2-2. 시점별 노출 알고리즘

각 엔티티는 `first_appearance_segment_id` (인물·장소) 또는 `reader_visible_after_segment_id` (이벤트)를 가짐.  
필터 조건: `segment.order ≤ state.currentSegment` (스포일러 모드 ON일 때)

```javascript
function visibleLocations() {
  return state.locations.filter(loc => {
    const firstSeg = loc.evidence_segment_ids?.[0];
    return firstSeg && isVisibleAfter(firstSeg);
  });
}

function visibleCharacters() {
  return state.characters.filter(c => isVisibleAfter(c.first_appearance_segment_id));
}

function visibleEvents() {
  return state.events.filter(e => isVisibleAfter(e.reader_visible_after_segment_id));
}
```

### 2-3. 인물 상태 카드 — 시점별 다이나믹 갱신

```javascript
function characterStateAt(character, segmentOrder) {
  // 해당 segmentOrder까지 적용된 동적 변화만 누적
  const applied = character.dynamic_traits.filter(
    dt => segmentOrderById(dt.segment_id) <= segmentOrder
  );

  // 시점 누적 결과 계산
  const traitsAtTime = [...character.personality.traits];
  let mentalState = character.initial_mental_state;
  let stance = "";

  applied.forEach(dt => {
    if (dt.trait_key === "mental_state") mentalState = dt.value;
    if (dt.trait_key === "stance_to_narrator") stance = dt.value;
    if (dt.trait_key === "add_trait") traitsAtTime.push(dt.value);
    if (dt.trait_key === "remove_trait") {
      const idx = traitsAtTime.indexOf(dt.value);
      if (idx >= 0) traitsAtTime.splice(idx, 1);
    }
  });

  return { mentalState, stance, traits: traitsAtTime, applied };
}
```

### 2-4. 사용자 인터랙션 시나리오

| 시나리오 | 동작 | 결과 |
|---------|------|------|
| 슬라이더 이동 | 독서 위치 N으로 점프 | 모든 패널 즉시 갱신 |
| 문단 클릭 | 해당 문단 = currentSegment | 슬라이더 위치 이동 + 갱신 |
| 타임라인 이벤트 클릭 | 이벤트 근거 문단으로 점프 | 원문 스크롤 + 강조 |
| 인물 카드 클릭 | 그 인물의 다음 동적 변화 시점으로 점프 | 변화 직전 vs 직후 비교 가능 |
| 지도 노드 클릭 | 그 장소의 첫 등장 문단으로 점프 | + 사회상 패널 노출 |
| 지도 엣지 클릭 | 해당 이동 이벤트 강조 | 타임라인에서 해당 이벤트 하이라이트 |

### 2-5. 동적 노드 표시 의사코드

```
for location in state.locations:
    firstSeg = location.evidence_segment_ids[0]
    if not firstSeg:
        skip  # 증거 없으면 표시 안 함
    if segmentOrder(firstSeg) > currentSegment:
        skip  # 아직 등장 전

    # 시각 분기
    if location.is_fictional:
        render as circle node at location.narrative_coords
        color: 황토
    else:
        if location.real_coords:
            render as pin icon at location.real_coords (지도 레이어)
            color: 파랑
        else:
            render as circle node at location.narrative_coords
            tooltip: location.real_world_candidate

    if location.location_id == latestVisibleLocationId():
        add pulse animation

for edge in state.edges:
    if both endpoints visible:
        render edge with style by certainty
        if edge.event_type == "movement":
            add order number label (1, 2, 3, ...)
```

---

## 3. 데이터 구조 확장 (Schema)

### 3-1. Character 확장 — 동적 변화 누적 구조

기존 `description` 단일 필드를 `appearance` / `personality` / `dynamic_traits`로 분리.

```jsonc
{
  "character_id": "C001",
  "canonical_name": "나",
  "aliases": [...],
  "role": "화자",

  "appearance": {
    "text": "외양 한 문장",
    "traits": ["키워드1", "키워드2"],
    "evidence_segment_ids": ["P049"],
    "last_updated_by_event": "E055"
  },
  "personality": {
    "traits": ["성격 키워드"],
    "evidence_segment_ids": [...],
    "last_updated_by_event": "E077"
  },
  "initial_mental_state": "정체",
  "dynamic_traits": [
    {
      "trait_key": "mental_state",       // mental_state, add_trait, remove_trait, stance_to_narrator, appearance_change
      "value": "호기심",
      "previous_value": "정체",
      "changed_by_event_id": "E023",
      "segment_id": "P052"
    }
  ],

  "first_appearance_segment_id": "P001",
  "confidence": 0.95
}
```

### 3-2. Location 확장 — 실제/허구 분리 + 좌표

```jsonc
{
  "location_id": "L008",
  "canonical_name": "미쓰꼬시 옥상",
  "aliases": [...],
  "type": "symbolic",

  "is_fictional": false,
  "real_world_candidate": "미쓰코시 백화점 경성지점",
  "real_coords": { "lat": 37.5605, "lng": 126.9819 },
  "geocode_source": "manual",
  "era": "1930-1945",

  "narrative_coords": { "x": 720, "y": 120 },
  "symbolic_meaning": "근대 소비문화의 정점에서의 비상 욕망",

  "evidence_segment_ids": ["P153", "P156", "P162"],
  "first_appearance_segment_id": "P153"
}
```

### 3-3. Event + Social Context 확장

```jsonc
{
  "event_id": "E075",
  "scene_id": "S09",
  "event_type": "symbolic",
  "summary": "정오 사이렌이 울림",
  "characters": ["나"],
  "locations": ["미쓰꼬시 옥상"],
  "certainty": "explicit",
  "evidence_segment_ids": ["P162"],
  "reader_visible_after_segment_id": "P162",

  "social_context": {
    "era": "1930s",
    "region": "경성",
    "summary": "1930년대 일제강점기 경성에서 정오 사이렌은 표준시 통보·노동 시각 통제 수단이었다...",
    "source_url": "https://ko.wikipedia.org/wiki/...",
    "source_type": "wikipedia",
    "fetched_at": "2026-05-09",
    "keywords_used": ["정오 사이렌 1930년대 경성"]
  },

  "triggers_dynamic_change": [
    { "character_id": "C001", "trait_key": "mental_state", "to": "비상 욕망" }
  ]
}
```

---

## 4. Ollama 연동 — 인물 외양·성격 파싱

### 4-1. API 기본 구조

```
엔드포인트: http://localhost:11434/api/chat
권장 모델: llama3, qwen2.5 (한국어는 EEVE-Korean, exaone 권장)
출력: JSON 강제 (format: "json")
```

```javascript
async function callOllama(prompt, model = "qwen2.5") {
  try {
    const res = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model, format: "json", stream: false,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await res.json();
    return JSON.parse(data.message.content);
  } catch (err) {
    console.warn("Ollama 미연결, 규칙 기반으로 fallback", err);
    return null;
  }
}
```

### 4-2. 「날개」 인물 파싱 프롬프트

```javascript
function buildCharacterProfilePrompt(character, evidenceTexts) {
  return `다음은 1936년 이상의 단편소설 「날개」의 일부 문단이다.
인물 "${character.canonical_name}"에 대한 정보를 추출하라.

=== 원문 ===
${evidenceTexts.slice(0, 5).join("\n\n")}

=== 지시 ===
근거가 있는 정보만 작성하라. 없으면 빈 배열/빈 문자열.

{
  "appearance": {
    "text": "외양 묘사 한 문장 (30자 이내)",
    "traits": ["외양 키워드 1-3개"],
    "evidence": "근거 구절 (20자 이내)"
  },
  "personality": {
    "traits": ["성격 키워드 1-5개"],
    "evidence": "근거 구절 (20자 이내)"
  },
  "initial_mental_state": "첫 등장 시 심리 한 단어",
  "role_inference": "화자/대립자/조력자/주변인 중 하나"
}`;
}
```

**기대 출력 (C001 — 나):**

```json
{
  "appearance": {
    "text": "야위고 창백한 의복은 모두 검은 26세 남성",
    "traits": ["창백", "야윔", "검은 의복"],
    "evidence": "안색이 여지없이 창백"
  },
  "personality": {
    "traits": ["무기력", "사색적", "자의식 강함", "의존적"],
    "evidence": "게으른 동물처럼 게으른"
  },
  "initial_mental_state": "정체",
  "role_inference": "화자"
}
```

### 4-3. 이벤트 → 인물 변화 감지 프롬프트

```javascript
function buildTraitChangePrompt(character, event, segmentText) {
  return `소설 「날개」의 다음 장면이 인물 "${character.canonical_name}"의 상태를 바꾸는가?

=== 이벤트 ===
${event.summary}

=== 원문 ===
${segmentText}

=== 현재 상태 ===
심리: ${character.currentMentalState}
성격 태그: ${character.personality.traits.join(", ")}

JSON만 답하라.
{
  "changed": true|false,
  "mental_state_after": "변화 후 (없으면 현재값)",
  "new_traits": ["추가된 태그"],
  "removed_traits": ["제거된 태그"],
  "stance_to_narrator_change": "관계 변화 (없으면 '')",
  "reason": "변화 이유 한 문장 (원문 근거)"
}`;
}
```

### 4-4. 장소 분류 프롬프트

```javascript
function buildLocationClassifyPrompt(location, workMeta) {
  return `소설 「${workMeta.title}」 (${workMeta.author}, ${workMeta.publication_year})에 등장하는 장소 "${location.canonical_name}"를 분류하라.

=== 등장 원문 (요약) ===
${location.evidence.slice(0, 3).join(" / ")}

JSON만 답하라.
{
  "is_fictional": true|false,
  "real_world_candidate": "실제 후보 (허구면 빈 문자열)",
  "era": "시대 (예: 1930s, 현대, 불명)",
  "symbolic_meaning": "서사적/상징적 의미 한 문장",
  "location_type": "interior|exterior|public|symbolic|transit"
}`;
}
```

---

## 5. Wikipedia fetch — 「날개」 사회상 컨텍스트

### 5-1. 「날개」 핵심 키워드 사전

이벤트별로 사회상 fetch가 의미 있는 키워드 매핑:

| 이벤트 | 키워드 | Wikipedia 페이지 후보 |
|--------|--------|---------------------|
| E005 (33번지 환경) | "1930년대 경성 유곽" / "일제강점기 사창" | 사창가, 경성부 |
| E020 (벙어리 저금통) | "1930년대 저금통 벙어리" | 저금통, 일제강점기 화폐 |
| E026 (첫 외출 — 5원) | "1930년대 5원 가치" / "경성 화폐" | 조선은행권, 일제강점기 물가 |
| E041 (경성역 시계) | "경성역 1930년대" | 경성역, 서울역 |
| E050 (경성역 티이루움) | "경성역 일이등 대합실 티룸" | 경성역, 다방 (한국) |
| E054 (아스피린/아달린) | "아달린 1930년대 진정제" / "아스피린 일제강점기" | 아달린(Adalin), 아스피린 |
| E070 (미쓰꼬시 옥상) | "미쓰코시 백화점 경성" | 미쓰코시 백화점, 신세계백화점 |
| E075 (정오 사이렌) | "1930년대 경성 정오 사이렌" / "오포(午砲) 사이렌" | 오포, 표준시 |
| E001 (박제 - 메타포) | (fetch 대상 아님) | — |

### 5-2. 키워드 생성 함수 (「날개」 특화)

```javascript
function buildContextKeywords(event, work) {
  const decade = work.publication_year
    ? `${String(work.publication_year).slice(0, 3)}0년대`
    : "";

  const keywords = [];

  // 사회상 fetch 화이트리스트 (모든 이벤트가 아니라 핵심만)
  const FETCH_WORTHY_TYPES = ["movement", "conflict", "realization", "symbolic"];
  if (!FETCH_WORTHY_TYPES.includes(event.event_type)) return [];

  // 1) 장소 + 시대
  event.locations.forEach(loc => {
    if (decade) keywords.push(`${loc} ${decade}`);
    keywords.push(loc);
  });

  // 2) 이벤트 키워드 사전 (「날개」 특화 시드)
  const NALGAE_DICT = {
    "벙어리": ["1930년대 저금통", "조선은행권"],
    "5원": ["일제강점기 물가", "조선은행권"],
    "은화": ["일제강점기 화폐"],
    "아스피린": ["아스피린", "1930년대 의약품"],
    "아달린": ["아달린", "1930년대 진정제"],
    "사이렌": ["오포 사이렌", "일제강점기 표준시"],
    "경성역": ["경성역"],
    "미쓰꼬시": ["미쓰코시 백화점 경성"],
    "33번지": ["일제강점기 사창", "경성 유곽"]
  };
  Object.keys(NALGAE_DICT).forEach(token => {
    if (event.summary.includes(token) || event.evidence.some(e => e.includes(token))) {
      keywords.push(...NALGAE_DICT[token]);
    }
  });

  return [...new Set(keywords)].filter(Boolean);
}
```

### 5-3. fetch 함수

```javascript
async function fetchSocialContext(event, work) {
  const keywords = buildContextKeywords(event, work);
  if (!keywords.length) return null;

  for (const keyword of keywords) {
    const result = await searchWikipedia(keyword);
    if (result && result.extract.length > 80) {
      return {
        era: work.publication_year ? `${String(work.publication_year).slice(0, 3)}0s` : "",
        region: event.locations[0] || "경성",
        summary: result.extract.replace(/<[^>]+>/g, "").slice(0, 300),
        source_url: `https://ko.wikipedia.org/wiki/${encodeURIComponent(result.title)}`,
        source_type: "wikipedia",
        fetched_at: new Date().toISOString().slice(0, 10),
        keywords_used: [keyword]
      };
    }
  }
  return null;
}

async function searchWikipedia(keyword) {
  const searchUrl =
    `https://ko.wikipedia.org/w/api.php?action=query&list=search` +
    `&srsearch=${encodeURIComponent(keyword)}&format=json&origin=*`;
  const top = (await (await fetch(searchUrl)).json()).query?.search?.[0];
  if (!top) return null;

  const extractUrl =
    `https://ko.wikipedia.org/w/api.php?action=query&prop=extracts` +
    `&exintro=true&titles=${encodeURIComponent(top.title)}&format=json&origin=*`;
  const page = Object.values((await (await fetch(extractUrl)).json()).query.pages)[0];
  if (!page || page.missing) return null;
  return { title: page.title, extract: page.extract || "" };
}
```

### 5-4. Rate Limit 대응

Wikipedia API는 명시적 rate limit이 약하나, 「날개」 이벤트 75개를 한꺼번에 fetch하면 부담:

- **화이트리스트 우선**: `FETCH_WORTHY_TYPES`만 fetch (75개 → 약 25개)
- **순차 실행 + 200ms 간격**: 동시 요청 회피
- **결과 캐싱**: 같은 키워드 재요청 방지 (`Map<keyword, result>`)

---

## 6. 분석 파이프라인 (분석 버튼 클릭 시)

```
[Step 1] 규칙 기반 추출 (동기, 즉시)
  └─ extractCharacters() / extractLocations() / extractEvents()
     buildCharacterStates() / buildEdges()
  → state 저장 → render() 1차 표시

[Step 2] Ollama 인물 파싱 (비동기, 순차)
  └─ for each character:
       prompt = buildCharacterProfilePrompt(c, evidence)
       result = await callOllama(prompt)
       merge result → character.appearance / personality
  → renderCharacters() 재호출
  ※ Ollama 미연결 시 스킵 (graceful degradation)

[Step 3] Ollama 장소 분류 (비동기, 병렬)
  └─ for each location (Promise.all):
       prompt = buildLocationClassifyPrompt(loc, work)
       result = await callOllama(prompt)
       merge → location.is_fictional / symbolic_meaning
  → renderGraph() 재호출

[Step 4] Wikipedia 사회상 fetch (비동기, 순차 + 200ms)
  └─ for each event in FETCH_WORTHY_TYPES:
       ctx = await fetchSocialContext(event, work)
       event.social_context = ctx
       await sleep(200)
  → renderTimeline() 재호출

[Step 5] Ollama 인물 변화 추적 (비동기, 순차)
  └─ for each event with characters:
       for each character in event.characters:
         prompt = buildTraitChangePrompt(c, event, segText)
         result = await callOllama(prompt)
         if result.changed:
           character.dynamic_traits.push(...)
  → renderCharacters() 최종 재호출
```

진행 인디케이터: 상단 toolbar에 `1/5 규칙 추출 완료 → 2/5 인물 파싱 중...` 형태로 표기.

---

## 7. UI 변경 사항

### 7-1. 소설 지도 (실제/허구 시각 구분)

| 요소 | 실제 장소 | 허구 장소 |
|------|----------|----------|
| 노드 형태 | 지도 핀 아이콘 | 원형 |
| 노드 색상 | 파란 계열 (#4A90E2) | 황토 계열 (#C9A44C) |
| 좌표 | `real_coords` 변환 | `narrative_coords` 고정 |
| 툴팁 | 실제 주소 + 사회상 요약 | 상징적 의미 + 묘사 |

### 7-2. 인물 카드 (외양 / 성격 / 동적 변화)

```
┌─ [나] ─────────────── 95% ─┐
│ 역할: 화자                  │
│ ─ 외양 ─                    │
│ 야위고 창백, 검은 의복       │
│ 태그: [창백][야윔][검은 의복] │
│ ─ 성격 ─                    │
│ [무기력][사색적][자의식][의존]│
│ ─ 현재 상태 (P 088 시점) ─  │
│ 심리: 쾌감 발견              │
│ 위치: 아내 방 (첫!)          │
│ ─ 변화 이력 ─               │
│ • P052 정체 → 호기심 (E023) │
│ • P069 호기심 → 외부 (E026) │
│ • P088 외부 → 쾌감 (E033) ← │
└────────────────────────────┘
```

### 7-3. 이벤트 카드 (사회상 패널)

타임라인 카드 클릭 시 펼쳐지는 사회상 패널:

```
┌─ E075 [상징] [명시] ─────────┐
│ 정오 사이렌이 울림           │
│ 위치: 미쓰꼬시 옥상           │
│ ▼ 사회상 (Wikipedia)         │
│ 1930년대 경성에서 정오 사이렌 │
│ (오포)은 표준시 통보 수단...  │
│ → ko.wikipedia.org/wiki/오포 │
└────────────────────────────┘
```

### 7-4. Review 탭 신규 편집 항목

| 항목 | 필드 | 우선순위 |
|------|------|---------|
| 외양 묘사 | `character.appearance.text` | P0 |
| 성격 태그 | `character.personality.traits` | P0 |
| 동적 변화 추가/제거 | `character.dynamic_traits` | P1 |
| 허구/실제 토글 | `location.is_fictional` | P0 |
| 실제 좌표 입력 | `location.real_coords` | P1 |
| 상징적 의미 | `location.symbolic_meaning` | P1 |
| 사회상 요약 편집 | `event.social_context.summary` | P1 |
| 사회상 재조회 버튼 | `fetchSocialContext()` 재실행 | P1 |
| Ollama 재파싱 버튼 | `callOllama()` 재실행 | P1 |

---

## 8. 구현 우선순위

### P0 — 현재 스프린트 (즉시 적용 가능)

1. `Character` 구조에 `appearance` / `personality` / `dynamic_traits` 필드 추가
2. 「날개」 시드 데이터 (1-2, 1-3, 1-4 절)를 `app.js` 상수로 적용
3. `renderCharacters()` 에서 외양·성격·변화 이력 카드 렌더링 (7-2)
4. `Location` 구조에 `is_fictional` / `narrative_coords` / `real_coords` 추가
5. `renderGraph()` 에서 실제/허구 노드 시각 구분 (7-1)
6. `characterStateAt()` 함수로 시점별 상태 누적 계산 (2-3)

### P1 — 다음 스프린트 (외부 의존성 추가)

7. `callOllama()` 함수 + 4개 프롬프트 함수 구현
8. 분석 파이프라인 Step 2-3-5 통합 (graceful degradation)
9. `Event.social_context` 구조 추가
10. `fetchSocialContext()` + `searchWikipedia()` + 「날개」 키워드 사전
11. 분석 파이프라인 Step 4 통합 (200ms 순차)
12. 진행 인디케이터 UI (toolbar)
13. Review 탭 P1 편집 항목 (사회상, 좌표, 동적 변화)

### P2 — 후속 (선택적 확장)

14. Nominatim 자동 좌표 조회 (`is_fictional: false` 장소)
15. Leaflet.js 지도 레이어 (실제 좌표 있는 장소)
16. Ollama 모델 선택 UI
17. 다른 작품 (「동백꽃」, 「운수 좋은 날」) 시드 추가
18. 분석 결과 SQLite 저장 (페이지 새로고침 시 재사용)

---

## 9. 파일별 변경 범위

| 파일 | 변경 내용 |
|------|----------|
| `app.js` | <ul><li>「날개」 시드 상수 (`knownCharacters`, `locationSeeds`, `eventSeeds`) 확장</li><li>`callOllama()`, `fetchSocialContext()`, `searchWikipedia()` 함수</li><li>`buildCharacterProfilePrompt()`, `buildTraitChangePrompt()`, `buildLocationClassifyPrompt()`, `buildContextKeywords()`</li><li>`characterStateAt()` 시점별 누적 상태 계산</li><li>`extractCharacters/Locations/Events()` 결과 후처리 확장</li><li>`renderCharacters()` 외양·성격·변화 이력</li><li>`renderGraph()` 실제/허구 노드 시각 구분</li><li>`renderTimeline()` 사회상 패널</li><li>분석 파이프라인 5단계 + 진행 인디케이터</li></ul> |
| `index.html` | <ul><li>인물 카드 외양·성격 섹션</li><li>이벤트 카드 사회상 패널 (접기/펼치기)</li><li>분석 진행 인디케이터 (toolbar)</li><li>Review 탭 P1 편집 행</li></ul> |
| `styles.css` | <ul><li>실제 장소 노드(파랑 핀)·허구 장소 노드(황토 원형)</li><li>인물 카드 동적 변화 이력 스타일</li><li>사회상 패널 스타일</li><li>Ollama 로딩 / Wikipedia fetch 인디케이터</li></ul> |

---

## 10. 검증 체크리스트

P0 완료 후 다음을 확인:

- [ ] 독서 위치 P001에서 화자 카드만 표시, 다른 인물·장소 미노출
- [ ] P052 도달 시 화자 심리 "정체" → "호기심" 변화 표시
- [ ] P069 도달 시 "거리" 노드 + "내 방→거리" 엣지 등장
- [ ] P088 도달 시 "아내 방" 노드 강조 (현재 위치)
- [ ] P153 도달 시 "미쓰꼬시 옥상" 노드 등장 (실제 좌표 표시)
- [ ] P163-P167 도달 시 화자 [각성] 태그 추가, 비상 욕망 강조
- [ ] 슬라이더로 P001로 되돌리면 모든 변화가 초기 상태로 리셋

P1 완료 후 추가 확인:

- [ ] Ollama 미연결 시 P0 결과 그대로 동작 (오류 없음)
- [ ] Ollama 연결 시 인물 외양·성격 자동 보강
- [ ] E075 이벤트 카드 펼치면 "오포 사이렌" 사회상 노출
- [ ] E054 이벤트 카드에 "아달린" 위키 링크 노출
- [ ] Review 탭에서 사회상 요약 편집 → 즉시 카드에 반영

---

## 참고

- Ollama 로컬 API: https://github.com/ollama/ollama/blob/main/docs/api.md (`format: "json"` 모드)
- Wikipedia MediaWiki API: https://www.mediawiki.org/wiki/API:Main_page
- 한국어 Wikipedia base: `https://ko.wikipedia.org/w/api.php`
- Ink 엔진 (이벤트 드리븐 상태 추적 패턴): https://github.com/inkle/ink
- StoryMapJS (위치 기반 서사 표준): https://storymap.knightlab.com
- IFMapper (허구 공간 그래프): https://ggarra13.github.io/ifmapper
- Nominatim (실제 좌표 조회): https://nominatim.org
- 이상 「날개」 원문: `texts/wings.txt`
