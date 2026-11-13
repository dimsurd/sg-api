import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3000,http://localhost:3001')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  isProd: process.env.NODE_ENV === 'production',
  jwtTtlSeconds: 60 * 60 * 12, // 12h session
  timezone: 'Asia/Jakarta',
  /**
   * Optional AI class advisor. Any OpenAI-compatible chat-completions endpoint
   * works; the feature is hidden when LLM_API_KEY is empty.
   */
  llm: {
    baseUrl: (process.env.LLM_BASE_URL ?? '').replace(/\/+$/, ''),
    apiKey: process.env.LLM_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? '',
    /** Provider-specific request fields as JSON, e.g. {"chat_template_kwargs":{"enable_thinking":false}}. */
    extraBody: parseJsonObject('LLM_EXTRA_BODY'),
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 30_000),
  },
} as const;

function parseJsonObject(name: string): Record<string, unknown> {
  const raw = process.env[name];
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    /* fall through */
  }
  throw new Error(`${name} must be a JSON object`);
}
