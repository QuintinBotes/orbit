/**
 * Text cut for a one-line view (an outcome, a gate reason, a finding in a list). The full text lives in the report;
 * the line must never end mid-word, because the clipped end is often the part that says what is wrong.
 */

/**
 * `text` unchanged when it fits in `max` characters; otherwise its whitespace collapsed and cut at the last word that
 * fits, followed by "...". A single token longer than `max` is cut where it must be.
 */
export function clipAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const room = Math.max(1, max - 3);
  // The cut is clean when the next character starts a new word; otherwise back up to the previous word end.
  let end = flat[room] === ' ' ? room : flat.lastIndexOf(' ', room);
  if (end <= 0) end = room;
  return `${flat.slice(0, end).replace(/[\s,;:]+$/, '')}...`;
}
