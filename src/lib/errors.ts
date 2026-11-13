export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Please log in') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have access to this') =>
  new HttpError(403, 'forbidden', message);
export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (message: string, details?: unknown) =>
  new HttpError(409, 'conflict', message, details);
export const tooManyRequests = (message: string) => new HttpError(429, 'too_many_requests', message);
export const serviceUnavailable = (message: string) => new HttpError(503, 'unavailable', message);
export const badGateway = (message: string) => new HttpError(502, 'upstream_error', message);
