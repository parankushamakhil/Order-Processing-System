/**
 * Error envelopes built by the saga (presentOrder, settlement) cannot know the
 * request id, so it is stamped on at the HTTP boundary. Doing it here keeps the
 * business layer free of HTTP concerns while guaranteeing that every error body
 * carries the same correlation id as the logs.
 */
export function attachRequestId(body, requestId) {
  if (body && typeof body === 'object' && body.error && !body.error.requestId) {
    return { ...body, error: { ...body.error, requestId } };
  }
  return body;
}
