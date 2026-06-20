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
export const SNAPSHOT_KEY = "novel-if-reader:snapshot:v2";

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
    aliases: ["아내", "내 아내", "아내가", "아내는", "아내의", "아내에게"],
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
    aliases: ["복녀", "복네", "복녀는", "복녀가", "복녀의", "복녀를"],
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
    aliases: ["왕 서방", "왕서방", "왕 서방은", "왕 서방의"],
    role: "중심 갈등 인물",
    description: "채마 밭의 중국인 주인. 후반 갈등의 핵심 인물.",
    sampleIds: ["gamja"]
  },
  {
    canonical_name: "감독",
    aliases: ["감독", "감독은", "감독이"],
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

export const PHYSICAL_STATE_LEXICON = [
  { state: "누워 있거나 잠든 상태", words: ["잠", "눕", "이불", "낮잠", "자고", "잔다", "졸"] },
  { state: "이동 중", words: ["외출", "나가", "돌아오", "걸", "뛰", "올라", "내려", "찾아", "떠나", "도착"] },
  { state: "피로", words: ["피곤", "아프", "쓰라리", "병", "앓", "기운", "지쳤", "허약"] },
  { state: "정지/체류", words: ["머물", "기다", "앉", "서 있", "가만", "방 안", "집에"] },
  { state: "위험/손상", words: ["피", "상처", "죽", "쓰러", "다치", "맞", "아픔"] }
];

