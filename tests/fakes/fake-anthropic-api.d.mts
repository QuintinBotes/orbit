export interface FakeStep {
  text?: string;
  tool?: string;
  input?: Record<string, unknown>;
  structured?: unknown;
  status?: number;
  error?: { type: string; message: string };
  delayMs?: number;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

export interface FakeRequest {
  url: string;
  main?: boolean;
  model?: string;
  tools?: string[];
  stream?: boolean;
  nMessages?: number;
  toolResults?: unknown[];
  apiKey?: 'set' | 'unset';
  authorization?: 'set' | 'unset';
  step?: number | null;
  unhandled?: boolean;
}

export interface FakeAnthropicApi {
  port: number;
  url: string;
  requests: FakeRequest[];
  mainRequests(): FakeRequest[];
  setSteps(steps: FakeStep[]): void;
  close(): Promise<void>;
}

export function startFakeAnthropicApi(options?: { steps?: FakeStep[]; port?: number }): Promise<FakeAnthropicApi>;
