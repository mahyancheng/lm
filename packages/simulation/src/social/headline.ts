/**
 * @frontier/simulation — social/headline.ts
 *
 * A headline from a body of text, deterministically.
 *
 * Two places need it: the public-record projection, which titles a post with
 * its own words, and the social engine, which turns a post that moves market
 * belief into a stored disclosure and needs a title for it. Both used to write
 * "so-and-so posted on the fast feed: announce" — a byline restated as a title,
 * with a raw intent token — so the rule lives here once and neither does.
 */

/** The longest a post's own words run as its headline before a word-boundary cut. */
export const POST_HEADLINE_MAX = 80;

/**
 * A text's headline is its own words.
 *
 * The first sentence when it is short enough; failing that the first clause,
 * when a clause boundary falls between thirty and `max` characters; failing
 * that the first `max` characters cut at a word boundary. A trailing full stop
 * is dropped the way a headline drops it; a question or an exclamation keeps
 * its mark.
 */
export function headlineFromText(text: string, max = POST_HEADLINE_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return 'Untitled';

  // A sentence ends at . ! or ? followed by a space or the end — so "$2.5B"
  // and "v3.1" never end one, and a closing quote or bracket rides along.
  const sentence = /^(.*?[.!?]["')\]]*)(?=\s|$)/.exec(flat)?.[1] ?? flat;
  if (sentence.length <= max) return dropFullStop(sentence);

  // The first clause, when it is long enough to mean something on its own.
  let cut = -1;
  for (const boundary of [', ', '; ', ': ', ' — ', ' – ', ' - ']) {
    const at = sentence.indexOf(boundary);
    if (at >= 30 && at <= max && (cut === -1 || at < cut)) cut = at;
  }
  if (cut !== -1) return sentence.slice(0, cut).trim();

  return clipHeadline(sentence, max);
}

function dropFullStop(sentence: string): string {
  return sentence.endsWith('.') && !sentence.endsWith('..') ? sentence.slice(0, -1) : sentence;
}

/**
 * Cut a headline to `max` characters at a word boundary, marking the cut with an
 * ellipsis. A headline already short enough is returned as it is.
 */
export function clipHeadline(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat.length === 0 ? 'Untitled' : flat;
  const room = max - 1;
  const space = flat.lastIndexOf(' ', room);
  const cut = space >= Math.floor(room / 2) ? space : room;
  return `${flat.slice(0, cut).replace(/[,;:\-–—\s]+$/, '')}…`;
}
