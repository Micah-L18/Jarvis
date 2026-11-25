// What the caption line shows of Jarvis's words: the most recent couple of lines, split into what
// has been spoken (or is being spoken) and what is still to come.
const MAX = 260;

/**
 * @param text the reply so far
 * @param spoken characters of it spoken or being spoken; null when not following a voice (all lit)
 * @param from where the piece being spoken starts; the window never cuts it off
 * @returns {{ lead: string, lit: string, dim: string, trail: string }} lead/trail are '…' when cut
 */
export function captionParts(text, spoken = null, from = 0, max = MAX) {
  const n = text.length;
  const upTo = spoken == null ? n : Math.max(0, Math.min(n, spoken));
  let start = 0;
  if (n > max) {
    const space = text.indexOf(' ', n - max);
    start = space < 0 ? n - max : space;
  }
  let end = n;
  const at = Math.max(0, Math.min(from, upTo));
  if (spoken != null && at < start) { // the voice is further back than the newest text: stay with the voice
    start = at;
    end = text.lastIndexOf(' ', start + max);
    if (end <= upTo) end = Math.min(n, start + max);
  }
  const lit = text.slice(start, Math.max(start, upTo));
  const dim = text.slice(Math.max(start, upTo), end);
  const lead = start > 0 ? (/^\s/.test(text.slice(start)) ? '…' : '… ') : '';
  return { lead, lit, dim, trail: end < n ? '…' : '' };
}
