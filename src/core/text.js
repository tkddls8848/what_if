/**
 * @module core/text
 *
 * 원문 정규화. `analyzer.js`의 BOUNDARY NOTE가 예고한 "공유가 필요해지면 만들 DOM-free
 * text 모듈"이다. EPUB 입력이 챕터별 문자 offset을 계산하려면 분석기와 **완전히 같은**
 * 정규화를 써야 하므로, 두 벌로 두면 offset이 한 글자씩 어긋난다.
 *
 * `normalizeSourceText`는 멱등이다: 정규화된 조각들을 `\n\n`으로 이어 붙인 결과를
 * 다시 정규화해도 값이 변하지 않는다. EPUB 챕터 offset 계산이 이 성질에 의존한다.
 */

export function normalizeSourceText(text) {
  return String(text || "")
    .replace(/\r\n/gu, "\n")
    .replace(/\t/gu, " ")
    .replace(/[  ]+/gu, " ")
    .trim();
}

export const PARAGRAPH_SEPARATOR = "\n\n";
