/**
 * Fuzzy matching for the command palette.
 *
 * Its own module for two reasons: it is pure logic that is worth testing without
 * a renderer, and keeping it out of the palette component is what lets that file
 * export nothing but a component — otherwise every edit to the matcher forces a
 * full page reload instead of a hot update.
 */

function mergeRanges(ranges) {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged = [sorted[0]];
  for (const [start, end] of sorted.slice(1)) {
    const tail = merged[merged.length - 1];
    if (start <= tail[1]) tail[1] = Math.max(tail[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/**
 * Subsequence match with the bonuses that make results feel ranked rather than
 * merely filtered: consecutive characters, word starts and exact case all score
 * higher, and earlier matches beat later ones. Returns the matched character
 * ranges as well, because showing *why* a row matched is what separates a search
 * box from a search feature.
 *
 * Returns null when the query is not a subsequence at all.
 */
export function fuzzyMatch(text, query) {
  if (!query) return { score: 0, ranges: [] };

  const haystack = text.toLowerCase();
  const needle = query.toLowerCase().replace(/\s+/g, '');
  if (!needle) return { score: 0, ranges: [] };

  const ranges = [];
  let score = 0;
  let cursor = 0;
  let previous = -2;

  for (let index = 0; index < needle.length; index += 1) {
    const char = needle[index];
    const found = haystack.indexOf(char, cursor);
    if (found === -1) return null;

    if (found === previous + 1) score += 6;
    if (found === 0) score += 10;
    else if (/[\s\-_/.·]/.test(haystack[found - 1])) score += 8;
    if (text[found] === char) score += 1;
    score += Math.max(0, 3 - found * 0.05);

    ranges.push([found, found + 1]);
    previous = found;
    cursor = found + 1;
  }

  return { score: score - haystack.length * 0.02, ranges: mergeRanges(ranges) };
}
