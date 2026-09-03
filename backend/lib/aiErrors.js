// Converts an Anthropic SDK error into a short, user-facing message instead of
// leaking the raw provider JSON blob to the frontend.
function friendlyAiError(err) {
  if (err?.status === 429) {
    return 'The AI service hit its rate limit (too many requests or too much document content in the last minute). Wait about a minute and try again.';
  }
  if (err?.status === 529 || err?.status === 503) {
    return 'The AI service is temporarily overloaded. Please try again in a moment.';
  }
  if (err?.status === 401 || err?.status === 403) {
    return 'The AI service refused the request. The API key may be missing, expired, or out of credit.';
  }

  // A 400 is the request being wrong — too many pages, a file type the API will not take, a
  // document larger than one request holds. The provider explains it in a nested JSON envelope, and
  // returning err.message put that envelope on the screen: a user was shown
  // `400 {"type":"error","error":{...}}` where a sentence belonged. The sentence inside is written
  // for a developer but it is at least a sentence, so it is dug out and passed on.
  const stated = err?.error?.error?.message || err?.error?.message;
  if (typeof stated === 'string' && stated.trim()) return capitalise(stated.trim());

  const message = String(err?.message || '');
  if (/^\d{3}\s*\{/.test(message)) {
    // Raw envelope with nothing parsed out of it. Better a vague sentence than a wall of JSON.
    return 'The AI service could not accept that request. If a file was attached, it may be too '
      + 'large or in a format the service will not read.';
  }
  return message || 'Something went wrong talking to the AI service.';
}

const capitalise = s => s.charAt(0).toUpperCase() + s.slice(1);

module.exports = { friendlyAiError };
