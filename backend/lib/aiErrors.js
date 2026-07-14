// Converts an Anthropic SDK error into a short, user-facing message instead of
// leaking the raw provider JSON blob to the frontend.
function friendlyAiError(err) {
  if (err?.status === 429) {
    return 'The AI service hit its rate limit (too many requests or too much document content in the last minute). Wait about a minute and try again.';
  }
  if (err?.status === 529 || err?.status === 503) {
    return 'The AI service is temporarily overloaded. Please try again in a moment.';
  }
  return err.message;
}

module.exports = { friendlyAiError };
