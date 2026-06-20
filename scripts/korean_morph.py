import json
import re
import sys
from collections import Counter, defaultdict


PARTICLE_RE = re.compile(
    r"(은|는|이|가|을|를|에게|와|과|도|의|으로|로|에서|에게서|께서|부터|까지|만|한테|한테서)$"
)
CHARACTER_RE = re.compile(
    r"([가-힣]{2,8})(?:은|는|이|가|을|를|에게|와|과|도|의|께서|에게서|한테|한테서)\b"
)
LOCATION_RE = re.compile(
    r"([가-힣A-Za-z0-9 ]{1,14}(?:방|집|거리|길|문|역|옥상|시장|골목|마당|학교|병원|정거장|백화점|도시|마을|강|산|바다|숲|들|밭|부엌|창고|가게|주막|다방|호텔|여관|궁|성))"
)
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


def strip_particle(value):
    return PARTICLE_RE.sub("", str(value or "").strip())


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
                  bucket = character_counts[strip_particle(form)]
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
    for match in CHARACTER_RE.finditer(text):
        surface = match.group(0)
        base = strip_particle(match.group(1))
        if 2 <= len(base) <= 8:
            bucket = character_counts[base]
            bucket["surfaces"][surface] += 1
            bucket["segment_ids"].add(segment_id)

    for match in LOCATION_RE.finditer(text):
        surface = match.group(0).strip()
        base = strip_particle(surface)
        if 2 <= len(base) <= 14:
            bucket = location_counts[base]
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
