export const DEFAULT_SAMPLE_ID = "wings";
export const CUSTOM_SAMPLE_ID = "custom";
export const DEFAULT_OLLAMA_MODEL = "qwen3.5:4b";
export const OLLAMA_MODEL_PRIORITY = ["qwen3.5:4b", "gemma4:e4b", "gemma3:4b", "qwen3:4b"];
export const SAMPLE_TEXTS = [
  {
    id: "wings",
    title: "날개",
    author: "이상",
    year: "1936",
    url: "texts/wings.txt",
    source_url: "https://www.davincimap.co.kr/davBase/Source/davSource.jsp?Job=Body&SourID=SOUR001427",
    rights: "public-domain-candidate"
  },
  {
    id: "gamja",
    title: "감자",
    author: "김동인",
    year: "1925",
    url: "texts/gamja.txt",
    source_url: "https://ko.wikisource.org/wiki/%EA%B0%90%EC%9E%90",
    rights: "public-domain-old-70"
  }
];
export const SNAPSHOT_KEY = "novel-if-reader:snapshot";

export const STATUS = {
  SUGGESTED: "suggested",
  CONFIRMED: "confirmed",
  EDITED: "edited",
  REJECTED: "rejected",
  MANUAL: "manual"
};

export const EVENT_LABELS = {
  appearance: "등장",
  movement: "이동",
  conversation: "대화",
  perception: "인식",
  conflict: "갈등",
  realization: "깨달음",
  stasis: "정체",
  symbolic: "상징",
  background: "배경"
};

export const STATUS_LABELS = {
  suggested: "제안",
  confirmed: "확정",
  edited: "수정",
  rejected: "제외",
  manual: "수동"
};

export const CHARACTER_SEEDS = [
  {
    canonical_name: "나",
    aliases: ["나는", "내가", "나를", "나에게", "나의", "내 방", "내 아내"],
    role: "화자",
    description: "소설의 1인칭 화자. 방 안에 머물며 아내와 세계를 관찰한다."
  },
  {
    canonical_name: "아내",
    aliases: ["아내", "내 아내"],
    role: "배우자",
    description: "화자와 함께 33번지에 사는 인물. 외출과 내객을 통해 사건을 만든다."
  },
  {
    canonical_name: "내객",
    aliases: ["내객", "손님", "서너 사람", "방문객"],
    role: "방문자",
    description: "아내를 찾아오는 익명의 방문자들."
  },
  {
    canonical_name: "18가구 사람들",
    aliases: ["18 가구", "18가구", "그들", "여인네", "젊은 여인"],
    role: "주변 인물",
    description: "33번지에 함께 사는 주변 인물 집단."
  },
  {
    canonical_name: "남자",
    aliases: ["남자", "그 남자", "어떤 남자"],
    role: "남성 인물",
    description: "원문에서 남성으로 지칭되는 인물 후보."
  }
];

export const LOCATION_SEEDS = [
  {
    name: "33번지",
    aliases: ["33번지", "33 번지"],
    type: "residential",
    description: "18가구가 함께 사는 중심 공간.",
    narrative_coords: { x: 490, y: 310 }
  },
  {
    name: "내 방",
    aliases: ["내 방", "윗방", "침침한 방", "방안"],
    type: "interior",
    description: "화자가 주로 머무는 방. 스포일러 차단 상태 계산의 중심 공간.",
    parent: "33번지",
    narrative_coords: { x: 315, y: 350 }
  },
  {
    name: "아내 방",
    aliases: ["아내 방", "아내의 방", "아랫방", "볕드는 방"],
    type: "interior",
    description: "아내의 화장대와 물건들이 있는 공간.",
    parent: "33번지",
    narrative_coords: { x: 500, y: 410 }
  },
  {
    name: "대문",
    aliases: ["대문", "문간", "미닫이"],
    type: "threshold",
    description: "33번지 안팎을 잇는 통로.",
    parent: "33번지",
    narrative_coords: { x: 650, y: 320 }
  },
  {
    name: "거리",
    aliases: ["거리", "한길", "길", "밖"],
    type: "exterior",
    description: "방과 33번지 바깥의 세계.",
    narrative_coords: { x: 735, y: 500 }
  },
  {
    name: "미쓰코시 옥상",
    aliases: ["미쓰코시", "미쓰코시 옥상", "옥상"],
    type: "public",
    description: "도시적 상승과 전환을 암시하는 장소.",
    narrative_coords: { x: 770, y: 150 }
  },
  {
    name: "경성역",
    aliases: ["경성역", "역"],
    type: "public",
    description: "이동과 도시 공간을 암시하는 장소.",
    narrative_coords: { x: 810, y: 390 }
  }
];

CHARACTER_SEEDS.forEach((seed) => {
  seed.sampleIds = ["wings"];
});

LOCATION_SEEDS.forEach((seed) => {
  seed.sampleIds = ["wings"];
});

CHARACTER_SEEDS.push(
  {
    canonical_name: "복녀",
    aliases: ["복녀", "복네"],
    role: "주인공",
    description: "김동인 「감자」의 중심 인물.",
    sampleIds: ["gamja"]
  },
  {
    canonical_name: "복녀의 남편",
    aliases: ["남편", "그의 남편", "복녀의 남편", "새서방", "영감"],
    role: "배우자",
    description: "복녀의 남편. 게으름과 빈곤이 사건 전개의 배경이 된다.",
    sampleIds: ["gamja"]
  },
  {
    canonical_name: "왕 서방",
    aliases: ["왕 서방", "왕서방"],
    role: "중심 갈등 인물",
    description: "채마 밭의 중국인 주인. 후반 갈등의 핵심 인물.",
    sampleIds: ["gamja"]
  },
  {
    canonical_name: "감독",
    aliases: ["감독"],
    role: "노동 현장 인물",
    description: "송충이 잡이 노동 장면에서 복녀의 변화를 촉발하는 인물.",
    sampleIds: ["gamja"]
  },
  {
    canonical_name: "동네 여편네들",
    aliases: ["여편네", "여편네들", "빈민굴 여인들", "곁집 여편네"],
    role: "주변 인물",
    description: "칠성문 밖 빈민굴의 주변 여성 인물 집단.",
    sampleIds: ["gamja"]
  }
);

LOCATION_SEEDS.push(
  {
    name: "칠성문 밖 빈민굴",
    aliases: ["칠성문 밖", "빈민굴", "칠성문 밖 빈민굴"],
    type: "residential",
    description: "복녀 부처가 밀려와 살게 되는 중심 공간.",
    narrative_coords: { x: 460, y: 350 },
    sampleIds: ["gamja"]
  },
  {
    name: "평양 성 안",
    aliases: ["평양 성 안", "평양"],
    type: "public",
    description: "복녀 부처가 막벌이를 위해 들어간 도시 공간.",
    narrative_coords: { x: 300, y: 270 },
    sampleIds: ["gamja"]
  },
  {
    name: "기자묘 솔밭",
    aliases: ["기자묘", "기자묘 솔밭", "솔밭"],
    type: "exterior",
    description: "송충이 잡이 노동이 이루어지는 장소.",
    narrative_coords: { x: 620, y: 250 },
    sampleIds: ["gamja"]
  },
  {
    name: "채마 밭",
    aliases: ["채마 밭", "밭고랑", "밭 가운데"],
    type: "exterior",
    description: "감자 도둑질과 왕 서방 관련 사건이 벌어지는 장소.",
    narrative_coords: { x: 640, y: 430 },
    sampleIds: ["gamja"]
  },
  {
    name: "왕 서방의 집",
    aliases: ["왕 서방의 집", "왕 서방네", "왕서방의 집"],
    type: "interior",
    description: "후반부 갈등과 결말이 발생하는 장소.",
    parent: "채마 밭",
    narrative_coords: { x: 760, y: 370 },
    sampleIds: ["gamja"]
  },
  {
    name: "공동묘지",
    aliases: ["공동묘지", "무덤"],
    type: "public",
    description: "결말에서 복녀의 죽음이 처리되는 장소.",
    narrative_coords: { x: 790, y: 520 },
    sampleIds: ["gamja"]
  }
);

export const EVENT_LEXICON = [
  { type: "movement", words: ["가다", "간다", "갔다", "돌아오", "외출", "나가", "들어오", "건너간", "올라", "내려", "찾아"] },
  { type: "conversation", words: ["말", "이야기", "묻", "대답", "소리", "불렀", "속삭", "농"] },
  { type: "perception", words: ["보다", "보는", "느낀", "생각", "알", "모르", "연상", "기억", "관찰"] },
  { type: "conflict", words: ["무서", "꾸지람", "싫", "불안", "미워", "갈등", "아프", "쓰라리", "피곤"] },
  { type: "realization", words: ["깨달", "알았다", "분명", "확실", "연구", "착수", "증거"] },
  { type: "stasis", words: ["눕", "잔다", "잠", "머물", "기다", "게으", "침침", "우울", "상태"] },
  { type: "symbolic", words: ["날개", "박제", "태양", "상징", "벙어리", "거울", "향기", "꽃", "돈"] }
];

export const MENTAL_STATE_LEXICON = [
  { state: "불안", words: ["불안", "무서", "두려", "겁", "꾸지람", "잠이 잘 오지", "초조", "떨"] },
  { state: "우울", words: ["우울", "침침", "피곤", "싫증", "허무", "슬프", "괴로", "쓸쓸", "외로"] },
  { state: "관찰", words: ["본다", "보는", "보았다", "연상", "생각", "연구", "관찰", "느낀", "기억"] },
  { state: "안일", words: ["편리", "안일", "좋았다", "즐거웠다", "행복", "평온", "안심"] },
  { state: "각성", words: ["날개", "깨달", "확실", "비약", "결심", "알았다", "분명"] },
  { state: "긴장", words: ["싸움", "갈등", "화", "분노", "미워", "의심", "놀라"] },
  { state: "욕망", words: ["원", "바라", "탐", "사랑", "그리", "기대"] }
];

export const VISUAL_DESCRIPTION_CATEGORIES = {
  appearance: "외형",
  clothing: "복식",
  space: "공간"
};

/**
 * 원문 묘사 절을 찾는 어휘 사전.
 *
 * `words`는 묘사 근거, `subject_terms`는 `복녀의 얼굴은`처럼 인물·장소가 소유격으로
 * 걸린 주어구를 확인할 때만 쓴다. 이 사전은 문장을 생성하지 않는다. 수집 결과는 항상
 * 원문의 절과 offset이며, 이미지 채널은 별도 검토 전까지 비워 둔다.
 */
export const VISUAL_DESCRIPTION_LEXICON = [
  {
    category: "appearance",
    entity_types: ["character"],
    words: [
      "아름답", "이뻐", "예쁘", "빤빤", "발갛", "빨갛", "하얗", "창백",
      "근심스러운", "노기", "웃음", "미소", "애수", "방그레", "찬란하였다",
      "작고", "크고", "길다란", "얇은", "살이었", "체취"
    ],
    subject_terms: ["얼굴", "눈", "눈초리", "입술", "머리", "수염", "몸", "몸뚱이", "동체", "피부", "표정", "웃음", "미소", "체취", "나이"]
  },
  {
    category: "clothing",
    entity_types: ["character"],
    words: ["옷을", "옷이", "옷은", "옷도", "옷과", "치마", "저고리", "양복", "스웨터", "내의다", "내의를", "내의는", "내의가", "고무신", "모자", "사루마다", "차림", "매무새", "입는다", "입고", "걸치", "벗어", "분이 하얗"],
    subject_terms: ["옷", "치마", "저고리", "양복", "스웨터", "내의", "고무신", "모자", "매무새", "차림", "화장"]
  },
  {
    category: "space",
    entity_types: ["location"],
    words: ["침침", "서늘", "따뜻", "밝", "볕", "해가", "화려", "소박", "벽", "천장", "바닥", "못이", "걸렸", "나뉘", "칸", "들창", "창", "기온", "체온", "아늑", "좁", "넓", "외따로", "일각", "지붕", "공기", "축축", "가지런히", "빛나", "무늬"],
    subject_terms: ["방", "기온", "벽", "천장", "바닥", "창", "들창", "문", "대문", "미닫이", "장지", "볕", "해", "지붕", "공기", "칸", "무늬"]
  }
];

export const PHYSICAL_STATE_LEXICON = [
  { state: "누워 있거나 잠든 상태", words: ["잠", "눕", "이불", "낮잠", "자고", "잔다", "졸"] },
  { state: "이동 중", words: ["외출", "나가", "돌아오", "걸", "뛰", "올라", "내려", "찾아", "떠나", "도착"] },
  { state: "피로", words: ["피곤", "아프", "쓰라리", "병", "앓", "기운", "지쳤", "허약"] },
  { state: "정지/체류", words: ["머물", "기다", "앉", "서 있", "가만", "방 안", "집에"] },
  { state: "위험/손상", words: ["피", "상처", "죽", "쓰러", "다치", "맞", "아픔"] }
];


/**
 * 시대 용어 사전 — 장면에 붙는 역사·문화 맥락의 **앵커와 출처**.
 *
 * 이 앱의 1원칙은 "모든 주장은 원문 offset으로 되짚을 수 있어야 한다"인데, 역사적
 * 맥락은 정의상 원문에 없다. 그래서 주석은 둘을 분리한다.
 *   - 앵커: 원문 span. 어디에 붙는지는 언제나 원문으로 되짚인다.
 *   - 출처: 외부 레퍼런스. **여기서 서술을 생성하지 않는다.**
 *
 * `note`를 자동으로 채우지 않는 것이 핵심이다. 4B 로컬 모델이 쓴 역사 서술은
 * 검증할 방법이 없고, 틀린 맥락은 없는 맥락보다 나쁘다. 링크만 걸고 판단은 독자에게
 * 넘긴다. 사람이 검수 화면에서 `note`를 채우면 그 항목은 `edited`가 된다.
 *
 * 모든 `url`은 `scripts/verify_references.mjs`로 실존을 확인한 것이다. 항목을 추가하면
 * 반드시 그 스크립트를 돌려라 — 깨진 링크는 이 기능에서 유일하게 치명적인 결함이다.
 * 리다이렉트는 최종 문서 제목으로 적는다(예: `아달린` → `카르브로말`).
 */
export const PERIOD_TERM_CATEGORIES = {
  modern_institution: "근대 시설",
  money: "돈이 움직이는 방식",
  class_reproduction: "계급 대물림",
  document: "제도가 도착하는 형식",
  mobility: "국경·검문·이동",
  erasure: "사라지는 것"
};

const KO_WIKI = (title) => ({
  label: title,
  url: `https://ko.wikipedia.org/wiki/${title.replace(/ /g, "_")}`,
  source: "ko.wikipedia.org"
});

export const PERIOD_TERM_LEXICON = [
  // ── 「감자」(1925, 평양) ──────────────────────────────────────────────
  { term: "칠성문", aliases: ["칠성문"], category: "modern_institution", era: "일제강점기", references: [KO_WIKI("칠성문")] },
  { term: "기자묘", aliases: ["기자묘", "기자릉"], category: "modern_institution", era: "일제강점기", references: [KO_WIKI("기자릉")] },
  { term: "평양", aliases: ["평양"], category: "modern_institution", era: "일제강점기", references: [KO_WIKI("평양시")] },
  { term: "대동강", aliases: ["대동강"], category: "mobility", era: "일제강점기", references: [KO_WIKI("대동강")] },
  { term: "빈민굴", aliases: ["빈민굴"], category: "erasure", era: "일제강점기", references: [KO_WIKI("토막민"), KO_WIKI("슬럼")] },
  { term: "소작", aliases: ["소작", "소작인", "소작농"], category: "class_reproduction", era: "일제강점기", references: [KO_WIKI("소작인"), KO_WIKI("조선_토지_조사_사업")] },

  // ── 「날개」(1936, 경성) ─────────────────────────────────────────────
  { term: "경성역", aliases: ["경성역"], category: "modern_institution", era: "일제강점기", references: [KO_WIKI("서울역")] },
  { term: "미쓰코시", aliases: ["미쓰코시", "미쓰꼬시"], category: "modern_institution", era: "일제강점기", references: [KO_WIKI("미쓰코시")] },
  { term: "아달린", aliases: ["아달린"], category: "document", era: "일제강점기", references: [KO_WIKI("카르브로말")] },
  { term: "아스피린", aliases: ["아스피린"], category: "document", era: "일제강점기", references: [KO_WIKI("아스피린")] },
  { term: "유곽", aliases: ["유곽"], category: "class_reproduction", era: "일제강점기", references: [KO_WIKI("유곽")] },
  { term: "다방", aliases: ["다방", "끽다점"], category: "modern_institution", era: "일제강점기", references: [KO_WIKI("다방")] },

  // ── doc/README.md 제품 방향의 나머지 작품을 넣을 때를 위한 seed ──
  { term: "화신상회", aliases: ["화신상회", "화신백화점"], category: "modern_institution", era: "일제강점기", references: [KO_WIKI("화신백화점")] },
  { term: "인력거", aliases: ["인력거", "인력거꾼"], category: "erasure", era: "일제강점기", references: [KO_WIKI("인력거")] },
  { term: "전당포", aliases: ["전당포"], category: "money", era: "일제강점기", references: [KO_WIKI("전당포")] },
  { term: "조선은행", aliases: ["조선은행"], category: "money", era: "일제강점기", references: [KO_WIKI("조선은행")] },
  { term: "미두", aliases: ["미두", "미두장", "미두취인소"], category: "money", era: "일제강점기", references: [KO_WIKI("선물_(금융)")] },
  { term: "금광", aliases: ["금광", "금점"], category: "money", era: "일제강점기", references: [KO_WIKI("금광")] },
  { term: "족보", aliases: ["족보"], category: "document", era: "일제강점기", references: [KO_WIKI("족보"), KO_WIKI("조선의_신분제도")] },
  { term: "치안유지법", aliases: ["치안유지법"], category: "document", era: "일제강점기", references: [KO_WIKI("치안유지법")] },
  { term: "관부연락선", aliases: ["관부연락선", "연락선"], category: "mobility", era: "일제강점기", references: [KO_WIKI("관부연락선")] },
  { term: "경부선", aliases: ["경부선"], category: "mobility", era: "일제강점기", references: [KO_WIKI("경부선")] },
  { term: "간도", aliases: ["간도"], category: "mobility", era: "일제강점기", references: [KO_WIKI("간도"), KO_WIKI("만주")] },
  { term: "기생", aliases: ["기생", "권번"], category: "class_reproduction", era: "일제강점기", references: [KO_WIKI("기생"), KO_WIKI("권번")] },
  { term: "결핵", aliases: ["결핵", "폐병"], category: "document", era: "근대", references: [KO_WIKI("결핵")] },
  { term: "구로공단", aliases: ["구로공단"], category: "class_reproduction", era: "산업화", references: [KO_WIKI("구로공단"), KO_WIKI("산업체_부설학교")] },
  { term: "재개발", aliases: ["재개발", "철거"], category: "erasure", era: "산업화", references: [KO_WIKI("도시_재개발")] },
  { term: "이촌향도", aliases: ["이촌향도", "상경"], category: "erasure", era: "산업화", references: [KO_WIKI("이촌향도")] },
  { term: "금주법", aliases: ["금주법"], category: "money", era: "세계", references: [KO_WIKI("금주법")] },
  { term: "후미에", aliases: ["후미에"], category: "document", era: "세계", references: [KO_WIKI("후미에")] },
  { term: "도망노예법", aliases: ["도망노예법"], category: "document", era: "세계", references: [KO_WIKI("도망노예법"), KO_WIKI("노예제")] }
];
