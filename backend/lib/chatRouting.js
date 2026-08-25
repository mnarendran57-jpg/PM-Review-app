// Which model answers a question.
//
// The obvious design is a small model that reads the question and picks. It was considered and not
// taken, for one reason: a routing mistake is invisible. Everywhere else in this application a
// wrong answer is caught — the arithmetic does not tie, a finding cites no clause, a transcription
// disagrees with the page it came from. A chat answer has none of that. If a question that needed
// the careful model is handed to the fast one, the user simply gets a worse answer and never learns
// they did, and neither do we.
//
// So the decision is made from things that can actually be observed, for nothing and instantly:
// whether a document is attached, how much conversation has accumulated, and whether the question
// is a lookup or a judgement. Each signal is a fact rather than a guess, the whole thing is a pure
// function that can be tested without an API call, and the answer carries a badge saying which
// model wrote it — so when the routing is wrong the user can see that it was, and say so.
//
// The escape hatch is a button, not a cleverer heuristic. Nothing here can decide to spend Opus
// money on somebody's behalf.

const TIERS = {
  fast: {
    key: 'fast',
    model: 'claude-haiku-4-5-20251001',
    label: 'Fast',
    blurb: 'Quick answer',
  },
  careful: {
    key: 'careful',
    model: 'claude-sonnet-4-5',
    label: 'Careful',
    blurb: 'Read and reasoned',
  },
  // Never chosen automatically. See chooseTier — this is reachable only when the person asking
  // presses the button, which is the whole point: a run of hard questions cannot quietly cost five
  // times what it looks like it should.
  deep: {
    key: 'deep',
    model: 'claude-opus-4-6',
    label: 'Deep',
    blurb: 'Asked for explicitly',
  },
};

// Past this much accumulated conversation, the question is no longer standalone: answering it means
// holding several earlier turns in mind at once, which is the thing the careful model is for.
const LONG_CONVERSATION_CHARS = 4000;

// A lookup is short. Anything longer is carrying context, constraints or a scenario, and the length
// itself is the signal.
const LOOKUP_MAX_CHARS = 220;

// Phrasings that ask what something IS. These are the questions where the fast model is genuinely
// as good — a definition is recall, not judgement.
const LOOKUP_WORDING = [
  /\bwhat (is|are|does|do)\b/i,
  /\bwhat'?s\b/i,
  /\bdefine\b/i,
  /\bdefinition of\b/i,
  /\bmeaning of\b/i,
  /\bstands? for\b/i,
  /\babbreviation\b/i,
  /\bacronym\b/i,
  /\bdifference between\b/i,
];

// Phrasings that ask for judgement, and override the lookup test however short the question is.
// "Should we?" is four words and is not a lookup.
const JUDGEMENT_WORDING = [
  /\bshould (i|we|they|it)\b/i,
  /\bis (it|this|that) (ok|okay|acceptable|reasonable|fair|correct|right|compliant)\b/i,
  /\bwhy\b/i,
  /\breview\b/i,
  /\bcompare\b/i,
  /\banalyse\b|\banalyze\b/i,
  /\bdraft\b/i,
  /\bwrite (me |us |a |an )/i,
  /\brecommend\b/i,
  /\badvise\b/i,
  /\brisk\b/i,
  /\bnegotiat/i,
  /\bdispute\b/i,
  /\bclaim\b/i,
];

const matches = (patterns, text) => patterns.some(re => re.test(text));

function looksLikeLookup(question) {
  const text = String(question || '').trim();
  if (!text || text.length > LOOKUP_MAX_CHARS) return false;
  if (matches(JUDGEMENT_WORDING, text)) return false;
  // More than one question in one message is a conversation, not a lookup.
  if ((text.match(/\?/g) || []).length > 1) return false;
  return matches(LOOKUP_WORDING, text);
}

// Returns the tier and, just as importantly, why — the reason is shown to the user next to the
// answer, so the routing is something they can argue with rather than something that happens to
// them.
function chooseTier({
  question = '',
  attachmentCount = 0,
  projectDocumentCount = 0,
  historyChars = 0,
  forceDeep = false,
} = {}) {
  if (forceDeep) {
    return { ...TIERS.deep, reason: 'You asked for a deeper answer.' };
  }
  if (attachmentCount > 0) {
    return {
      ...TIERS.careful,
      reason: `Reading ${attachmentCount === 1 ? 'a file' : `${attachmentCount} files`} you attached.`,
    };
  }
  if (projectDocumentCount > 0) {
    return { ...TIERS.careful, reason: 'Answering from the project documents.' };
  }
  if (historyChars > LONG_CONVERSATION_CHARS) {
    return { ...TIERS.careful, reason: 'Keeping track of a long conversation.' };
  }
  if (looksLikeLookup(question)) {
    return { ...TIERS.fast, reason: 'A short factual question.' };
  }
  return { ...TIERS.careful, reason: 'Needs some judgement.' };
}

module.exports = {
  TIERS, chooseTier, looksLikeLookup,
  LONG_CONVERSATION_CHARS, LOOKUP_MAX_CHARS,
};
