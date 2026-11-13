import { config } from '../config.js';
import { badGateway, serviceUnavailable } from './errors.js';

/**
 * Minimal client for any OpenAI-compatible `/chat/completions` endpoint.
 * The key never leaves the API; the frontends only talk to our routes.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export const llmEnabled = () => Boolean(config.llm.apiKey && config.llm.baseUrl && config.llm.model);

export async function chatJson(messages: ChatMessage[], opts: { maxTokens?: number } = {}): Promise<unknown> {
  if (!llmEnabled()) throw serviceUnavailable('The class advisor is not set up');

  let res: Response;
  try {
    res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llm.apiKey}` },
      body: JSON.stringify({
        model: config.llm.model,
        messages,
        max_tokens: opts.maxTokens ?? 800,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        ...config.llm.extraBody,
      }),
      signal: AbortSignal.timeout(config.llm.timeoutMs),
    });
  } catch (err) {
    console.error('[llm] request failed', err);
    throw badGateway('The class advisor is not responding. Please try again.');
  }
  if (!res.ok) {
    console.error('[llm] HTTP', res.status, (await res.text()).slice(0, 500));
    throw badGateway('The class advisor is not available right now. Please try again.');
  }

  const body = (await res.json()) as { choices?: { message?: { content?: string | null }; finish_reason?: string }[] };
  const content = body.choices?.[0]?.message?.content ?? '';
  const parsed = parseJsonLoose(content);
  if (parsed === undefined) {
    console.error('[llm] unparseable reply', body.choices?.[0]?.finish_reason, content.slice(0, 500));
    throw badGateway('The class advisor gave an unclear answer. Please try again.');
  }
  return parsed;
}

/** JSON mode isn't honoured by every server: strip think tags / code fences and take the outer object. */
function parseJsonLoose(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
