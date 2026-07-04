import json
import re
import sys
from collections import Counter, defaultdict


CHARACTER_PARTICLES = ("에게서는", "한테서는", "에게서", "한테서", "께서는", "께서", "에게", "한테", "은", "는", "이", "가", "을", "를", "와", "과", "도", "의")
CHARACTER_SUBJECT_PARTICLES = {"에게서는", "한테서는", "에게서", "한테서", "께서는", "께서", "에게", "한테", "은", "는", "이", "가", "와", "과"}
LOCATION_PARTICLES = ("에서부터", "으로부터", "에서는", "에서도", "까지", "부터", "에서", "으로", "에는", "에도", "에", "로", "을", "를", "은", "는", "이", "가", "와", "과", "의", "도")
LOCATIVE_PARTICLES = {"에서부터", "으로부터", "에서는", "에서도", "까지", "부터", "에서", "으로", "에는", "에도", "에", "로"}
HUMAN_NAMES = {
    "나", "너", "우리", "그녀", "그분", "이분", "저분", "마나님", "아내", "남편", "어머니", "아버지", "엄마", "아빠",
    "할머니", "할아버지", "형", "누나", "언니", "오빠", "동생", "아들", "딸", "부처", "부부", "장인", "장모", "선생",
    "선생님", "사장", "사장님", "감독", "의사", "경찰", "주인", "손님", "서방", "영감", "색시", "신부", "신랑",
    "아이", "소년", "소녀", "여자", "남자", "여인", "여편네", "사내", "노인", "청년", "아가씨", "아주머니", "아저씨",
}
NON_PERSON_NAMES = {
    "모양", "조밥", "마음", "생각", "생활", "시간", "오늘", "어제", "내일", "얼굴", "머리", "소리", "웃음", "그림자",
    "세상", "신용", "동정", "돈벌이", "품삯", "비결", "사흘", "가을", "바구니", "활극", "원문", "사건", "장소", "상태",
    "송충이", "송충", "빈민굴", "방안", "대문", "거리", "집", "길", "사람", "그것", "이것", "저것", "무엇", "어디", "누구",
}
LOCATION_EXACT_NAMES = {"방", "집", "거리", "길", "옥상", "시장", "골목", "마당", "학교", "병원", "정거장", "백화점", "도시", "마을", "강", "산", "바다", "숲", "밭", "부엌", "창고", "가게", "주막", "다방", "호텔", "여관", "궁", "성", "빈민굴", "묘지"}
LOCATION_STOP_NAMES = {"불길", "시집", "계집", "고집", "편집", "모집", "수집", "징역", "기억", "능력", "세력", "매력", "가능성", "특성", "여성", "남성", "방송", "서방"}
LOCATION_SUFFIX_RE = re.compile(r"(정거장|백화점|공동묘지|빈민굴|옥상|시장|골목|마당|학교|병원|도시|마을|바다|부엌|창고|가게|주막|다방|호텔|여관|묘지|거리|방|집|길|문|역|강|산|숲|밭|궁|성)$")
PERSON_ACTION_RE = re.compile(r"(말하|말했|대답|묻|물었|부르|불렀|가(?:고|서|며|려|았다|겠)|오(?:고|며|았다|겠)|나가|들어오|돌아오|걷|앉|일어나|웃|울|보(?:고|았|며)|먹|마시|주(?:고|었)|받|만나|생각하|느끼|죽|살|일하|잠들|깨)")
MOVEMENT_RE = re.compile(r"(가(?:고|서|며|다가|았다)|오(?:고|며|다가|았다)|나가|들어오|돌아오|걷|건너|지나|따라|오르|내리|도착|떠나)")
STATE_RE = re.compile(
    r"(불안|무서|두려|겁|초조|떨|울|슬프|괴로|외로|피곤|아프|지쳤|허약|놀라|분노|화|미워|싫|기뻐|행복|안심|결심|깨달|생각|느꼈|보았|기억)"
)
EVENT_RE = re.compile(
    r"(가|갔|나가|들어오|돌아오|만나|말|묻|대답|보다|보았|생각|느끼|싸우|다투|죽|울|깨닫|알았|기다|떠나|찾아|앉|눕)"
)


def main():
    payload = json.load(sys.stdin)
    text = normalize(payload.get("text", ""))
    try:
        from kiwipiepy import Kiwi

        context = build_kiwi_context(text, Kiwi())
    except Exception as exc:
        context = build_regex_context(text, warning=str(exc))
    json.dump(context, sys.stdout, ensure_ascii=False)


def normalize(text):
    return (
        str(text or "")
        .replace("\r\n", "\n")
        .replace("\t", " ")
        .replace("\u00a0", " ")
        .strip()
    )


def build_segments(text):
    parts = [part.strip() for part in re.split(r"\n\s*\n", text) if part.strip()]
    segments = []
    cursor = 0
    for index, part in enumerate(parts, start=1):
        start = text.find(part, cursor)
        end = start + len(part)
        cursor = end
        segments.append(
            {
                "id": f"seg_{index:03d}",
                "index": index,
                "char_start": start,
                "char_end": end,
                "text": part[:260],
                "full_text": part,
            }
        )
    return segments


def split_particle(word, particles):
    for particle in particles:
        if len(word) > len(particle) and word.endswith(particle):
            return word[: -len(particle)], particle
    return word, ""


def is_human_reference(name):
    return name in HUMAN_NAMES or bool(re.search(r"(님|씨|서방|부인|아내|남편|어머니|아버지|할머니|할아버지|선생|사장|감독|의사|경찰|주인|손님|영감|색시|신부|신랑|아이|소년|소녀|여인|여편네|사내|노인|청년|아가씨|아주머니|아저씨|사람들|여인들|인들|녀)$", name))


def following_clause(text, end, limit=64):
    return re.split(r"[.!?…。！？\n]", text[end : end + limit], maxsplit=1)[0]


def location_evidence(name, suffix, particle, following):
    if name in LOCATION_STOP_NAMES or is_human_reference(name) or re.search(r"[어아]가게$", name):
        return False
    if particle in LOCATIVE_PARTICLES:
        return True
    if re.match(r"\s*(밖|안|앞|뒤|옆|근처)(?:\s|$)", following):
        return True
    if particle in {"을", "를"} and MOVEMENT_RE.search(following):
        return True
    if name in LOCATION_EXACT_NAMES:
        return False
    prefix_length = len(name) - len(suffix)
    if suffix in {"길", "문", "역", "방", "집"}:
        return prefix_length >= 2
    if suffix in {"강", "산", "숲", "밭", "궁", "성"}:
        return False
    return prefix_length >= 1


def build_kiwi_context(text, kiwi):
    segments = build_segments(text)
    character_counts = defaultdict(lambda: {"surfaces": Counter(), "segment_ids": set()})
    location_counts = defaultdict(lambda: {"surfaces": Counter(), "segment_ids": set()})
    state_counts = defaultdict(lambda: {"surfaces": Counter(), "segment_ids": set()})
    event_sentences = []

    for segment in segments:
      segment_id = segment["id"]
      segment_text = segment["full_text"]
      collect_regex_candidates(segment_text, segment_id, character_counts, location_counts, state_counts)
      try:
          sentences = kiwi.split_into_sents(segment_text, return_tokens=True)
      except Exception:
          sentences = []

      for sentence in sentences:
          sentence_text = getattr(sentence, "text", "")
          tokens = getattr(sentence, "tokens", None) or []
          if EVENT_RE.search(sentence_text) or STATE_RE.search(sentence_text):
              event_sentences.append(
                  {
                      "segment_id": segment_id,
                      "text": sentence_text[:220],
                      "state_cues": sorted(set(STATE_RE.findall(sentence_text)))[:8],
                  }
              )

          for token in tokens:
              form = getattr(token, "form", "")
              tag = getattr(token, "tag", "")
              if not form:
                  continue
              if tag in {"NNP", "NP"} and len(form) >= 2:
                  location_match = LOCATION_SUFFIX_RE.search(form)
                  target = location_counts if location_match and form not in LOCATION_STOP_NAMES else character_counts
                  bucket = target[form]
                  bucket["surfaces"][form] += 1
                  bucket["segment_ids"].add(segment_id)
              if tag in {"VA", "VV"} and STATE_RE.search(form):
                  bucket = state_counts[form]
                  bucket["surfaces"][form] += 1
                  bucket["segment_ids"].add(segment_id)

    return {
        "analyzer": "kiwipiepy",
        "segments": compact_segments(segments),
        "candidate_characters": compact_counts(character_counts, 50),
        "candidate_locations": compact_counts(location_counts, 35),
        "candidate_state_words": compact_counts(state_counts, 50),
        "candidate_event_sentences": event_sentences[:80],
    }


def build_regex_context(text, warning=""):
    segments = build_segments(text)
    character_counts = defaultdict(lambda: {"surfaces": Counter(), "segment_ids": set()})
    location_counts = defaultdict(lambda: {"surfaces": Counter(), "segment_ids": set()})
    state_counts = defaultdict(lambda: {"surfaces": Counter(), "segment_ids": set()})
    event_sentences = []

    for segment in segments:
        segment_text = segment["full_text"]
        segment_id = segment["id"]
        collect_regex_candidates(segment_text, segment_id, character_counts, location_counts, state_counts)
        for sentence in split_sentences(segment_text):
            if EVENT_RE.search(sentence) or STATE_RE.search(sentence):
                event_sentences.append(
                    {
                        "segment_id": segment_id,
                        "text": sentence[:220],
                        "state_cues": sorted(set(STATE_RE.findall(sentence)))[:8],
                    }
                )

    return {
        "analyzer": "regex-fallback",
        "warning": warning,
        "segments": compact_segments(segments),
        "candidate_characters": compact_counts(character_counts, 50),
        "candidate_locations": compact_counts(location_counts, 35),
        "candidate_state_words": compact_counts(state_counts, 50),
        "candidate_event_sentences": event_sentences[:80],
    }


def collect_regex_candidates(text, segment_id, character_counts, location_counts, state_counts):
    for match in re.finditer(r"[가-힣]+", text):
        surface = match.group(0)
        base, particle = split_particle(surface, CHARACTER_PARTICLES)
        explicit_human = is_human_reference(base)
        actor_context = bool(PERSON_ACTION_RE.search(following_clause(text, match.end())))
        rejected = base in NON_PERSON_NAMES or LOCATION_SUFFIX_RE.search(base) or re.search(r"(없이|듯이|까지|부터|에서|으로|하고|하며|하게|적인|스럽게)$", base)
        if particle and (explicit_human or particle in CHARACTER_SUBJECT_PARTICLES) and (explicit_human or (2 <= len(base) <= 4 and actor_context and not rejected)):
            bucket = character_counts[base]
            bucket["surfaces"][surface] += 1
            bucket["segment_ids"].add(segment_id)

        location_base, location_particle = split_particle(surface, LOCATION_PARTICLES)
        location_match = LOCATION_SUFFIX_RE.search(location_base)
        if location_match and len(location_base) <= 14 and location_evidence(location_base, location_match.group(1), location_particle, following_clause(text, match.end())):
            bucket = location_counts[location_base]
            bucket["surfaces"][surface] += 1
            bucket["segment_ids"].add(segment_id)

    for match in STATE_RE.finditer(text):
        surface = match.group(0)
        bucket = state_counts[surface]
        bucket["surfaces"][surface] += 1
        bucket["segment_ids"].add(segment_id)


def split_sentences(text):
    return [item.strip() for item in re.findall(r"[^.!?。！？\n]+[.!?。！？…]*", text) if item.strip()]


def compact_segments(segments):
    return [
        {
            "id": item["id"],
            "index": item["index"],
            "text": item["text"],
        }
        for item in segments[:60]
    ]


def compact_counts(counts, limit):
    items = []
    for base, value in counts.items():
        if not base:
            continue
        items.append(
            {
                "base": base,
                "surfaces": [surface for surface, _ in value["surfaces"].most_common(10)],
                "count": sum(value["surfaces"].values()),
                "segment_ids": sorted(value["segment_ids"])[:12],
            }
        )
    items.sort(key=lambda item: item["count"], reverse=True)
    return items[:limit]


if __name__ == "__main__":
    main()
