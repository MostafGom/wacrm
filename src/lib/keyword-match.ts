// Keyword matching shared by automations and flows.

/** Letter, digit or underscore in any script — the "inside a word" test. */
const WORD_CHAR = '[\\p{L}\\p{N}_]'

/**
 * Whole-word keyword test, behind `match_type: 'word'` (issue #409 — a
 * one-letter keyword under `contains` fires on every message containing
 * that letter, e.g. "k" on "thanks").
 *
 * Deliberately NOT `\b`, which is defined against `[A-Za-z0-9_]` and so
 * breaks two cases that matter for WhatsApp traffic:
 *
 *   - A keyword carrying punctuation: `/\bhi!\b/` demands a word character
 *     after the "!", so it never matches "say hi!".
 *   - Any non-Latin script: every character of "안녕" is a non-word
 *     character to `\b`, so `/\b안녕\b/` matches nothing at all.
 *
 * Unicode-aware lookarounds handle both. Note this really is word-based:
 * it won't find "안녕" inside "안녕하세요", because a language that doesn't
 * delimit words with spaces has no word edge there. That's what `contains`
 * is for, and it stays the default.
 *
 * Shared by the automation `keyword_match` trigger and flow keyword triggers.
 */
export function matchesWholeWord(
  text: string,
  keyword: string,
  caseSensitive = false,
): boolean {
  if (!keyword) return false
  // The keyword is account-supplied free text, so metacharacters have to
  // be literal — otherwise "(" is an unterminated group and RegExp throws.
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `(?<!${WORD_CHAR})${escaped}(?!${WORD_CHAR})`,
    caseSensitive ? 'u' : 'iu',
  )
  return pattern.test(text)
}
