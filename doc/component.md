# Novel IF Reader Component and Schema Definition

Updated: 2026-06-14

This document defines the app objects, events, derived views, and UI components used to implement `doc/open_source_stack_design.md`.

The current app is a browser-first MVP. It uses a rule-based Korean adapter, but all output should follow the same schema so the analyzer can later be replaced by a BookNLP-style, Korean NLP, LLM, or server-side adapter.

The app can also call a local Ollama adapter through `server.js`. This path is optional and intended for small local models in the 4b-7b range. Recommended defaults are `qwen3.5:4b`, `gemma4:e4b`, `gemma3:4b`, and `qwen3:4b`. In Ollama mode, the model first creates a document-local seed lexicon for characters, locations, event types, mental/emotional states, and physical states. The app then recalculates mentions, events, states, relations, and browser filter options from that dynamic seed lexicon. Ollama output is treated as suggested data and merged only when source evidence can be tied back to the document text.

## 1. Design Principles

### 1.1 Source Evidence First

Every extracted object should be traceable to source text.

Required evidence fields:

- `segment_id`
- `char_start`
- `char_end`
- `source_span` for events
- `mentions` for characters and locations
- `source_event_ids` for character states

### 1.2 Human-in-the-loop Review

Analyzer output is not final data. Each extracted item has a review status.

Allowed statuses:

- `suggested`: automatically extracted
- `confirmed`: user accepted
- `edited`: user changed
- `rejected`: user removed
- `manual`: user created

Rejected items should be excluded from normal Reader, Map, Timeline, Characters, and scoped Export views.

### 1.3 Spoiler-safe Scope

Most views are scoped by `state.currentSegment`.

- Reader shows the active segment.
- Map shows only current-segment connected entities.
- Timeline shows events up to the current segment.
- Characters show character state as of the current segment.
- Export can produce current-scope or full-document data.

### 1.4 UI Depends on Schema

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

## 2. Core Data Objects

### 2.1 Document

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

### 2.2 Segment

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

### 2.3 Scene

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

### 2.4 Mention

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

### 2.5 Character

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

### 2.6 Location

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

### 2.7 Event

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

### 2.8 Character State

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

### 2.9 Relation

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

## 3. Derived View Models

### 3.1 Reader Active Segment

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

### 3.2 Map Projection

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

### 3.3 Inspector Event Panel

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

### 3.4 Characters Card

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

### 3.5 Timeline Card

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

### 3.6 Review View

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

## 4. Export Formats

### 4.1 JSON

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

### 4.2 CSV

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

### 4.3 Markdown

Human-readable summary:

- document title
- scope
- characters
- locations
- events

### 4.4 TimelineJS

TimelineJS-compatible event structure.

### 4.5 Graph JSON

Node/edge export for external graph tools.

Note: Graph export may include event nodes because it reflects the full schema relations. The on-screen Map intentionally hides event nodes and uses event summaries in Inspector.

## 5. Current Implementation Files

### 5.1 `app.js`

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

### 5.2 `index.html`

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

### 5.3 `styles.css`

Styling:

- modern analysis-tool layout
- one-row character cards
- active segment card
- graph and inspector surfaces
- review source highlighting
- responsive layout

### 5.4 `server.js`

Express static server and local analyzer proxy.

Responsibilities:

- serve app files and bundled sample texts
- `POST /api/analyze/ollama`
- proxy local Ollama requests to `http://127.0.0.1:11434`
- reject model tags outside the 4b-7b range
- expose installed 4b-7b completion models through `GET /api/ollama/models`
- return structured JSON containing `characters`, `locations`, `event_types`, `mental_states`, `physical_states`, and `events` for schema merge in `app.js`

## 6. Adjustment From Old Component Plan

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

## 7. Recommended Next Component Work

### P0

- Keep the current schema stable.
- Split analyzer logic from UI rendering into separate modules.
- Add `analysis_schema.md` or JSON Schema tests.
- Add import/export roundtrip checks.

### P1

- Add source span editing in Review.
- Add alias merge/split workflow.
- Add relation editing for events.
- Add confidence-based review queue sorting controls.

### P2

- Add server `POST /api/analyze`.
- Add persistent document storage.
- Add Korean NLP or LLM adapter.
- Add optional social context enrichment.
- Add optional real-world geocoding for public locations.
