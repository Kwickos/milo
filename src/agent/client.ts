import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config';

// Client Anthropic partagé. baseURL optionnel → passerelle wire-compatible (ex. OpenRouter natif).
export const anthropic = new Anthropic({
  apiKey: env.ANTHROPIC_API_KEY,
  ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
});
