# 기술 설계

Updated: 2026-08-09

설치·실행·API 요약은 [루트 README](../README.md)에 있다. 이 문서는 **왜 그렇게
만들었는지**와 데이터 계약을 다룬다.

## 1. 원칙

1. 자동 추출은 사실이 아니라 후보다. 모든 항목은 `suggested`로 들어오고 검수를 거친다.
2. 모든 주장은 원문 문자 offset으로 되짚을 수 있어야 한다. 근거를 만들 수 없는 항목은
   응답과 병합에서 제외한다.
3. 스포일러 판정은 뷰 필터가 아니라 질의 원시연산이다. 판정 코드는 저장소에 한 벌만 둔다.
4. 오탐보다 누락을 택한다. 근거가 약한 후보를 만들어 놓고 검수로 지우게 하지 않는다.
5. LLM은 선택 채널이다. Ollama가 없어도 앱은 규칙 분석으로 완전히 동작한다.

## 2. 모듈 경계

```text
src/core/     ← 런타임 공용. DOM·네트워크·전역 상태 없음 (ESM)
   ↑
src/analyzer.js   규칙 분석과 LLM 결과 병합 (ESM)
   ↑                    ↑
src/app/  브라우저      mcp/  읽기 전용 어댑터 (ESM)
                        ↑
src/server/  Ollama 파이프라인·외부 가져오기 (CommonJS)
```

모듈 종류는 디렉터리별 `package.json`이 명시한다 — `src/`와 `mcp/`는 `"type": "module"`,
`src/server/`는 `"type": "commonjs"`다. 루트 `server.js`도 CommonJS다. Node의 구문
자동 감지에 기대지 않는다.

의존 방향은 한쪽이다. `src/core/`는 자기들끼리와 `src/config.js`(상태값 상수)만
import하고 위쪽을 참조하지 않는다. `src/app/`과 `mcp/`는 `src/core/`와 `analyzer.js`를
쓴다. **`mcp/`에는 한국어 사전·정규식·엔티티 판정을 두지 않는다** — 규칙이 두 벌이 되면
화면과 에이전트의 답이 갈라진다. `tests/mcp_tools.test.mjs`가 이 규칙을 검사한다.

`app/` 안에는 순환 import가 있다(`views.js` ↔ 뷰 모듈, `utils.js` → `views.js`).
`renderAll`이 함수 선언이라 호이스팅되고 로드 시점에 호출하지 않으므로 안전하다.
빌드 단계도 린터도 없으므로 `tests/module_wiring.test.mjs`가 import 누락을 잡는다.

## 3. 분석 파이프라인

### 규칙 분석 (기본, 브라우저)

1. 공백·줄바꿈 정규화 (`src/core/text.js`, 멱등)
2. 빈 줄 기준 `Segment` 생성. 긴 문단은 문장 경계를 우선해 1,000자 이하로 분할
3. `Scene` 구성 — 챕터를 알면(EPUB) 실제 경계, 모르면 최대 12개 균등 분할
4. seed 사전으로 인물·장소 추출 → `Mention` 앵커링
5. 문장별 사건 유형과 참여 인물·장소 판정
6. 인물 상태와 관계 계산, 시간 구간 부여, 제약 감사

### 상세 분석 (선택, Ollama 4B~7B)

장면 단위 map-reduce다. 원문 길이 제한이 없고 컨텍스트 절단이 일어나지 않는다.

| 단계 | 내용 |
| --- | --- |
| 분할 | 문장 경계 우선, 목표 1,000자(`DEFAULT_TARGET_CHARS`). 청크가 60개를 넘으면 목표를 키워 호출 수를 제한한다 |
| map | 청크마다 2회 호출 — (a) 인물·장소, (b) 사건 프레임·상태 변화 |
| 롤링 cast | 앞 청크까지 확인된 인물을 다음 프롬프트에 전달. 2개 청크 이상 등장했거나 규칙 채널과 합의한 인물만 편입한다 |
| reduce | 이름 정규화 dedupe, 별칭 누적, evidence가 그 청크 원문에 실제 있는지 검증(불일치 시 confidence 강등) |
| 관계 pass | 원문 대신 병합된 cast·사건 요약으로 1회 호출. 화이트리스트 밖 관계는 버린다 |
| 병합 | 브라우저가 동적 seed를 만들어 규칙 분석을 다시 돌리고, **원문 mention과 연결되는 객체만** 병합한다 |

`temperature: 0.1`, `num_ctx: 8192`, 프롬프트는 `num_ctx`의 60% 이하로 예산을 검사한다.
구조화 출력(JSON Schema)으로 디코딩을 강제하고 파싱 실패는 1회 재시도한다. 청크 일부가
실패해도 전체가 실패하지 않고 `scenes_failed`에 기록된다. 진행 상황은 SSE `progress`로
보낸다. 결과는 `hash(text + model + prompt_version)`로 디스크 캐시된다.

프롬프트 버전은 `scene-v2`이며 캐시 키에 포함된다.

## 4. 별칭 매칭 — 단일 규칙

`analyzer.js`의 `aliasPattern()` 한 곳만 별칭을 원문에서 찾는다. mention 채널,
사건 채널, LLM 병합 채널이 모두 이 함수를 쓴다.

- 앞: 한글로 시작하는 별칭은 한글 뒤에 붙어 있으면 안 된다(단어 내부 매칭 금지).
- 뒤: 한글로 끝나는 별칭은 **조사 하나까지만** 허용하고 그 뒤는 한글이 아니어야 한다.
  `복녀도`는 인정하고 `복녀들`은 거부한다. `나가서`의 `나`+`가`도 뒤에 `서`가 있어 거부된다.

조사 허용과 뒤 경계 확인은 둘 다 필요하다. 경계만 보면 조사 결합형을 통째로 놓치고,
조사만 허용하면 활용형을 잡는다. 예전에는 세 채널이 서로 다른 규칙을 써서 같은 문장에
다른 답을 냈고, 그 불일치가 그대로 `actor` 제약 위반으로 쌓였다.

엔티티 경계 판정 기준(외부 문서용):

- 인물: `아내`, `남편`, `마나님`, `선생` 같은 명시적 사람 지칭어를 우선한다. 일반 이름
  후보는 반복 출현 + 주격·화제 조사 + 사람 행위 문맥이 함께 있어야 한다.
- 장소: 공백 없는 핵심 명사만. 처소 조사·이동 동사 문맥을 근거로 쓴다.
  `불길`, `시집`, `징역`처럼 장소 접미사와 철자가 겹치는 일반어는 제외한다.
- 오탐 금지 목록: `모양`, `조밥`, `마음`, `얼굴`, `머리`, `소리`, `활극`, `바구니`,
  `불길`, `징역`, `들어가게`. `tests/analyzer.test.mjs`가 지킨다.

## 5. 데이터 계약

```text
analysis
├─ document, segments[], scenes[], mentions[]
├─ characters[], locations[], events[], states[], relations[]
├─ annotations[]     # 시대 주석. 앵커는 원문, 내용은 외부 링크
├─ branches[]        # what-if 생성물. 없을 수 있다
├─ dynamic_lexicon
└─ diagnostics       # engine, seed_lexicon, warnings, counts, audit
```

| 객체 | 필드 |
| --- | --- |
| `Document` | `document_id`, `sample_id`, `title`, `author`, `publication_year`, `language`, `source`, `source_url`, `rights`, `created_at` |
| `Segment` | `segment_id`, `document_id`, `index`, `scene_id`, `text`, `char_start`, `char_end` |
| `Scene` | `scene_id`, `document_id`, `index`, `title`, `start_segment_id`, `end_segment_id`, `summary`, (EPUB) `source_ref` |
| `Mention` | `mention_id`, `entity_type`, `entity_id`, `text`, `segment_id`, `char_start`, `char_end`, `status`, `confidence`, `method` |
| `Character` | `character_id`, `canonical_name`, `aliases`, `mentions`, `first_segment_id`, `description`, `role`, `status`, `confidence`, `method`, `valid_from`, `valid_to` |
| `Location` | `location_id`, `name`, `aliases`, `mentions`, `first_segment_id`, `type`, `parent_name`, `parent_location_id`, `description`, `narrative_coords`, `status`, `confidence`, `method`, `valid_from`, `valid_to` |
| `Event` | `event_id`, `document_id`, `type`, `summary`, `segment_id`, `scene_id`, `sentence_index`, `characters`, `locations`, `source_span`, `status`, `confidence`, `method` |
| `CharacterState` | `state_id`, `character_id`, `segment_id`, `location_id`, `mental_state`, `physical_state`, `known_facts`, `source_event_ids`, `status`, `valid_from`, `valid_to`, `invalidated_by` |
| `Annotation` | `annotation_id`, `document_id`, `term`, `category`, `era`, `segment_id`, `text`, `char_start`, `char_end`, `references[{label,url,source}]`, `note`, `status`, `confidence`, `method`, `valid_from`, `valid_to` |
| `Relation` | `relation_id`, `source_type`, `source_id`, `target_type`, `target_id`, `relation_type`, `event_ids`, `segment_ids`, `weight`, `status`, `valid_from`, `valid_to`, `invalidated_by` |

상태값: `suggested`(자동 제안) · `confirmed`(확정) · `edited`(수정) · `rejected`(제외) ·
`manual`(직접 생성). `active` 필터는 저장값이 아니라 "`rejected`가 아님"을 뜻한다.

사건 유형: `appearance`, `movement`, `conversation`, `perception`, `conflict`,
`realization`, `stasis`, `symbolic`, `background`.

규칙 채널이 만드는 관계는 `participates_in`(character→event), `appears_in`
(character→location), `takes_place_at`(event→location) 셋뿐이다. 인물 간 관계
(`knows`, `family_of`, `enemy_of` 등)는 계약과 LLM 화이트리스트에는 있지만 규칙으로는
만들지 않는다 — 근거 없이 만드느니 비운다.

## 6. 서사 시간 (`src/core/asof.js`)

시간 좌표는 segment id가 아니라 **segment index(1부터인 정수)**다. 구간 비교가 가능해야
하고, 나중에 EPUB 챕터나 CFI로 재사상할 수 있어야 한다. `0`은 좌표 없음이며 어떤
시점에도 보이지 않는다. `valid_to: null`은 열린 구간이다.

술어 두 개를 구분한다. 이 구분이 모듈의 핵심이다.

| 술어 | 정의 | 쓰임 |
| --- | --- | --- |
| KNOWN(t) | `valid_from <= t` | 독자가 읽어서 **알게 된** 사실. 스포일러 범위 |
| TRUE(t) | `valid_from <= t <= valid_to` | 그 시점에 **여전히 유효한** 사실. 현재 상태 조회 |

퇴장한 인물이나 끝난 관계도 KNOWN으로 남는다. 이미 읽었기 때문이다.

같은 인물의 다음 상태 레코드가 이전 구간을 닫고, 그 레코드를 만든 사건이
`invalidated_by`가 된다. 이전 상태를 지우지 않으므로 "왜 바뀌었는가"를 사건 하나로
되짚을 수 있다. 규칙 채널은 인물·장소·관계의 `valid_to`를 채우지 않는다 — 원문에서
퇴장·단절을 근거 있게 판정할 방법이 없다. 필드는 계약으로 존재하며 검수·LLM이 채운다.

**판정은 `asOf()` 한 곳에만 있다.** `src/app/utils.js`의 `isVisibleSegmentId`도 `isKnownAt()`에
위임하고, `src/app/view/selectors.js`는 `asOf()` 결과에 표시 필터만 얹는다.
`index <= currentSegment` 비교를 다른 곳에 다시 쓰면 판정이 두 벌이 되고, 어긋난 지점이
곧 누출이다. `/check` 경로는 검수 대상 전체를 봐야 하므로 시점 제한을 끈다.

## 7. 제약 감사 (`src/core/audit.js`)

`diagnostics.audit = { counts, violations[] }`, violation은
`{ code, severity, target_type, target_id, segment_index, message }`다.

| code | 판정 | 등급 |
| --- | --- | --- |
| `actor` | 사건 참여 인물의 mention이 그 단락에 없다 | error |
| `scope` | 근거 offset이 단락 범위 밖이거나 근거가 없다 | error |
| `polarity` | 부정 표현이 있는 문장에서 실제 행동 사건을 추출했다 | warn |
| `state` | 같은 시점에 모순된 상태 / 아직 등장하지 않은 장소를 현재 위치로 지목 | error |
| `temporal` | 구간이 뒤집히거나 겹치거나 인물 첫 등장보다 앞선다 | error |
| `reference` | 주석 앵커가 원문과 어긋나거나 출처 링크가 없거나 허용 밖 호스트다 | error |

감사는 **판정만 하고 고치지 않는다.** 자동 확정을 금지하는 것과 같은 이유다.
`asOf()`가 감사 결과도 시점으로 잘라내므로 아직 읽지 않은 구간의 위반은 보이지 않는다.
`warn`은 휴리스틱 의심이므로 원문을 보고 판단한다. 일괄 제외하면 안 된다.

## 7-1. 시대 주석 (`PERIOD_TERM_LEXICON`)

역사·문화 맥락은 정의상 원문에 없다. 그래서 1원칙("모든 주장은 원문 offset으로 되짚을 수
있어야 한다")을 지키려면 주석을 둘로 쪼개야 한다.

- **앵커**는 원문 span이다. 어디에 붙는지는 언제나 원문으로 되짚인다. `reference` 감사가
  앵커 문자열과 원문이 일치하는지 매번 확인한다.
- **내용**은 만들지 않는다. 외부 링크만 건다. 자동 채널은 `note`를 **언제나 빈 문자열로**
  두고, 사람이 `/check`에서 채우면 그 항목이 `edited`가 된다.

로컬 4B 모델이 쓴 역사 서술은 검증할 방법이 없고, 틀린 맥락은 없는 맥락보다 나쁘다.
그래서 이 채널만은 LLM을 쓰지 않는다 — 앱 전체에서 유일하게 "생성하지 않는 것"이 설계다.

용어 매칭은 별칭 단일 규칙(`aliasPattern()`)을 그대로 쓴다. 용어도 조사를 받으므로
(`경성역으로`) 여기서 규칙을 새로 쓰면 화면과 에이전트의 답이 갈라진다. 한 단락에서 같은
용어는 한 번만 단다.

주석도 서사 시간 위에 있다. 아직 읽지 않은 단락의 주석을 보여 주면 그 자체가 누출이다 —
「날개」의 `아달린`은 그 낱말이 나오는 순간이 곧 사건이다.

출처 링크는 `scripts/verify_references.mjs`가 실존·동음이의·리다이렉트를 확인한다.
사전에 항목을 추가하면 반드시 돌려라. 이 기능에서 깨진 링크는 유일하게 치명적인 결함이다.
네트워크가 없으면 실패가 아니라 건너뛴다.

## 8. what-if 분기 (`src/core/whatif.js`, `src/server/whatif.js`)

분기 시드는 `asOf(fork)` 스냅샷뿐이고 **분기 시점 이후의 원문·사건은 프롬프트에 들어가지
않는다.** 서버는 `seed.text`나 `seed.segments`가 있으면 400으로 거부한다. 모델에게
원작을 베낄 재료를 주지 않는 것이 유일하게 확실한 방법이며, 생성 후
`detectCanonLeak()`이 분기 이후 원문·사건 요약과 12자 이상 연속 일치하는지 다시 본다.

호출은 2단계다 — 대안 행동 제안, 그다음 선택별 전개. 한 호출 = 한 작업 원칙은 추출
파이프라인과 같다. 생성이므로 `temperature`는 0.1이 아니라 0.6이다. 같은 전제로 다시
돌리면 다른 전개가 나와야 하므로 **캐시하지 않는다.**

산문이 아니라 사건 프레임과 상태 변화만 만든다. 그래야 구조화 출력으로 강제할 수 있고
검증도 계약 검사로 가능하다. 결과는 `branches[]`에만 쌓이고 원작 컬렉션을 바꾸지 않는다.

| `branches[]` 필드 | 의미 |
| --- | --- |
| `branch_id` / `parent_branch_id` | 분기 id와 부모. 원작은 `canon` |
| `fork_segment` / `fork_event_id` | 갈라진 시점과 그 사건 |
| `premise` | 분기 전제 한 문장 |
| `events[]` | `origin: "generated"`, `status: "suggested"`. `segment_id`도 `source_span`도 없다 |
| `states[]` | 인물별 심리·신체·위치 변화와 이를 일으킨 사건 |
| `diagnostics.canon_leak[]` | 분기 이후 원작을 인용한 지점 |
| `diagnostics.unknown_characters[]` | 그 시점에 없어 제거된 이름 |
| `rubric` | 사람이 매긴 3점 채점(주제 일관성·상태 정합성·구조 완결성) |

품질은 자동 채점하지 않는다. 서사 품질은 계약 검사로 판정할 수 없다. 자동으로 알 수 있는
것(원작 인용, 미등장 인물, 행위자 없는 사건)만 `branchIssues()`가 잡는다.

## 9. 입력

| 입력 | seed | Scene |
| --- | --- | --- |
| 「날개」 / 「감자」 | 작품별 정적 seed | 균등 분할 |
| TXT 업로드 | 원문에서 만든 동적 seed | 균등 분할 |
| EPUB 업로드 | 동적 seed | **실제 챕터 경계** |
| 위키문헌 | 동적 seed | 균등 분할 |

EPUB 리더(`src/core/epub.js`)는 의존성이 없다. 표준 `DecompressionStream("deflate-raw")`로
ZIP을 풀고 OPF·XHTML을 직접 읽는다. 번들러 없이 npm 패키지를 브라우저에 넣으려면 빌드
단계가 생기고, 그러면 "빌드 없음"이라는 구조적 장점이 사라진다. ZIP64·암호화·이미지는
다루지 않고 본문 텍스트만 읽는다. EPUB CFI는 만들지 않는다 — XHTML DOM 경로를 재현하지
않으면 가짜 CFI가 되므로 `source_ref`에 spine 순번과 href만 남긴다(챕터 수준 위치 지정).

챕터 offset은 정규화된 최종 텍스트 기준이며, `normalizeSourceText`가 멱등이라 분석기가
다시 정규화해도 어긋나지 않는다. 사용자가 원문을 편집하면 offset이 밀리므로 컨트롤러가
챕터를 버리고 균등 분할로 되돌린다.

위키문헌 가져오기는 `*.wikisource.org` 호스트만 허용한다 — 임의 URL을 받으면 이 서버가
열린 프록시가 된다. 권리 표기는 자동 판정하지 않고 `unverified`로 기록하며, 이 값은
MCP의 원문 배포 게이트에 그대로 작용한다.

## 10. 화면

`/`와 `/check` 두 경로 모두 같은 `index.html`을 History API로 렌더링한다.

| 영역 | 내용 |
| --- | --- |
| Reader | 원문 입력·편집, segment 목록, 독서 위치 |
| 관계 지도 | 현재 segment의 인물·장소·사건 연결과 Inspector |
| 사건 흐름 | 현재 범위까지의 사건 |
| 인물 상태 | 상태 이력, 관계, 공간 궤적 |
| 분기 (what-if) | 분기점 선택, 전제 입력, 생성, 인용 경고, 루브릭 채점 |
| 내보내기 | 7종 형식 생성·복사·다운로드 |
| `/check` | 근거 강조, 신뢰도·위반 순 검수 목록, 상태 변경, 수동 사건 추가 |

스냅샷은 `localStorage`의 `novel-if-reader:snapshot`에 저장된다. 서버·다른 기기와
동기화되지 않으며 브라우저 데이터를 지우면 사라진다.

## 11. MCP 계약

`mcp/server.js`는 Express와 별개인 stdio 서버다. 분석하지 않고 `analyzer.js`·`core/`를
재사용한다. 라이브러리는 `NOVEL_IF_LIBRARY`(기본 `texts/`)의 `*.txt`이며, 같은 이름의
`*.meta.json`이 제목·저자·`rights`·`source_url`을 덮어쓴다. `document_id`는 파일 이름이고
`analyzeNovel`의 `sample.id`로 전달되므로 내장 샘플 id와 같으면 정적 seed가 적용된다.

1. 사실 조회 도구는 `as_of` 없이는 거부한다. 기본값이 곧 스포일러이므로 기본값을 두지
   않는다. `list_works`만 예외다.
2. 모든 사실에 `evidence`(원문 인용 + segment index), `confidence`, `status`, `method`가
   붙는다. 근거를 만들 수 없는 항목은 응답에서 제거된다.
3. 쓰기 도구가 없다. 확정·수정은 `/check`에서만 한다.
4. `rights`가 `public-domain`으로 시작하지 않으면 원문 단락 제공을 거부한다. 사실 조회와
   근거 인용은 계속 동작한다.
5. `annotations_as_of`는 **링크만** 돌려준다. 역사 서술을 생성하지 않는다.

리소스는 `novel://{document_id}/analysis/{as_of}`와 `novel://{document_id}/segment/{n}`,
프롬프트는 `spoiler-safe-question`과 `character-interview`다. 둘 다 현재 독서 위치를
고정하고 근거 없는 추측을 금지한다.

## 12. 테스트 지도

`npm test`는 Ollama·네트워크 없이 119건을 실행한다.

| 파일 | 무엇을 지키는가 |
| --- | --- |
| `analyzer.test.mjs` | 엔티티 경계, 조사 결합형 인정, 단어 내부 매칭 금지, 두 채널 합의(actor=0) |
| `asof.test.mjs` | 구간 부여, 단조성, 누출 없음, KNOWN/TRUE 구분, 무효화 이력 |
| `audit.test.mjs` | 제약 5축 탐지(정상 데이터에 위반을 주입해 검증) |
| `whatif.test.mjs` | 시드에 미래 없음, 생성물 격리, 원작 인용 검출, ink/Twee 참조 무결성 |
| `epub.test.mjs` | ZIP·OPF 파싱, 챕터 offset 유효성, 챕터 경계 Scene |
| `mcp_tools.test.mjs` | `as_of` 강제, 근거 동반, 권리 게이트, 어댑터 전용 규칙 |
| `mcp_server.test.mjs` | stdio 전송 위 도구·리소스·프롬프트 노출 |
| `scene_pipeline.test.mjs` | 청크 분할, 병합, 부분 실패, evidence 검증, 관계 화이트리스트 |
| `ollama_merge.test.mjs` | mention 앵커링 게이트, LLM 항목의 `suggested` 진입 |
| `server_api.test.mjs` | HTTP 계약, SSE, 캐시, what-if 프롬프트에 미래 없음 |
| `wikisource.test.mjs` | 호스트 제한, 구조화 오류 |
| `module_wiring.test.mjs` | import 없이 호출하는 함수 없음 |
| `asof_qa.test.mjs` | 시점 질의 평가셋 전체 통과와 누출 0 |
| `annotations.test.mjs` | 주석 앵커 무결성, 자동 채널이 서술을 안 만듦, 링크 허용 호스트, 시점 가림 |

평가는 두 축이다. `npm run eval`은 골든셋 precision/recall,
`npm run eval:qa`는 "그 시점에 답할 수 있는가 / 미래를 흘리지 않는가"를 잰다.
`npm run verify:refs`는 네트워크가 있을 때만 도는 별개 검사다 — 주석 링크의 실존을 본다.
외부 벤치마크 수치를 완료 기준으로 쓰지 않는다. 기준은 이 저장소의 골든셋이다.

## 13. 알려진 한계

- 대명사·생략 주어·동일 인물 병합은 해결되지 않았다. 「복녀의 남편」과 「남편」이 별개
  인물로 갈라지는 것이 대표 사례다.
- `polarity` 경고는 부정의 작용 범위를 보지 않는다. 「날개」에서 78건이 뜬다.
- Scene은 챕터를 모르는 입력에서 서사학적 판정이 아니라 탐색용 균등 분할이다.
- 상세 분석 품질과 시간은 모델·하드웨어·원문 길이에 따라 달라진다.
- 저장은 브라우저 전용이고 서버는 분석 결과를 보관하지 않는다.
- 개발·테스트는 Node v23.3에서 검증했다. EPUB 읽기가 `DecompressionStream("deflate-raw")`에
  의존하므로 구버전 Node에서는 EPUB 경로와 그 테스트가 동작하지 않을 수 있다.
