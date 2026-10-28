const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

export function terms(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase();
  const words = new Set<string>();
  for (const part of segmenter.segment(normalized)) {
    if (part.isWordLike) words.add(part.segment);
  }
  for (const match of normalized.matchAll(/[a-z0-9_]+/g)) words.add(match[0]);
  for (const match of normalized.matchAll(/[\p{Script=Han}]+/gu)) {
    const chars = [...match[0]];
    chars.forEach(c => words.add(c));
    for (let i = 0; i < chars.length - 1; i++) words.add(chars[i] + chars[i + 1]);
  }
  return [...words].filter(w => /^[\p{L}\p{N}_]+$/u.test(w));
}
export function indexText(text: string) { return terms(text).join(' '); }
export function matchQuery(text: string) {
  return terms(text).slice(0, 64).map(t => `"${t}"`).join(' OR ');
}
