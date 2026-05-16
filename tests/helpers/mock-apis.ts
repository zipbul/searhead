/**
 * Mock external servers for testing.
 *
 * - Mock embedding API (/embeddings endpoint, OpenAI-compatible shape)
 * - Mock Ollama /api/chat server. setOllamaHandler(mode) selects the
 *   canned response: default / multi / empty / fail / bad-json /
 *   language:XX.
 */

interface MockEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
}

/** Create a deterministic fake embedding (384-dim, based on text hash) */
function fakeEmbedding(text: string): number[] {
  const vec = new Array(384).fill(0);
  for (let i = 0; i < text.length && i < 384; i++) {
    vec[i] = (text.charCodeAt(i) % 100) / 100;
  }
  return vec;
}

let embeddingServer: ReturnType<typeof Bun.serve> | null = null;

/** Start mock embedding API server */
function startMockEmbeddingServer(port = 19876) {
  embeddingServer = Bun.serve({
    port,
    fetch(req) {
      if (req.method === 'POST' && new URL(req.url).pathname === '/embeddings') {
        return req.json().then((body: { input: string | string[] }) => {
          const inputs = Array.isArray(body.input) ? body.input : [body.input];
          const response: MockEmbeddingResponse = {
            data: inputs.map((text, index) => ({
              embedding: fakeEmbedding(text),
              index,
            })),
          };
          return Response.json(response);
        });
      }
      return new Response('Not Found', { status: 404 });
    },
  });
  return embeddingServer;
}

// ---- Mock Ollama /api/chat server ----
//
// The real Ollama returns `{message: {content: string}}`. We replicate
// that shape and let each integration test inject the canned response
// via `setOllamaHandler(...)`.

let ollamaServer: ReturnType<typeof Bun.serve> | null = null;
let ollamaHandler: string = 'default';

/** Select the canned response for subsequent /api/chat calls. */
function setOllamaHandler(mode: string | null) {
  ollamaHandler = mode ?? 'default';
}

interface OllamaChatRequest {
  messages?: Array<{ role: string; content: string }>;
}

function ollamaResponseFor(req: OllamaChatRequest): { status: number; body: unknown } {
  const userContent = req.messages?.find(m => m.role === 'user')?.content ?? '';
  const systemContent = req.messages?.find(m => m.role === 'system')?.content ?? '';

  const handler = ollamaHandler;

  if (handler === 'fail') {
    return { status: 500, body: { error: 'mock ollama: simulated failure' } };
  }
  if (handler === 'bad-json') {
    return { status: 200, body: { message: { content: 'this is not valid json {{{' } } };
  }

  // detectLanguage's system prompt says "Identify the ISO 639-1
  // language code". Match on that so any decompose prompt that also
  // references ISO 639-1 in the entry schema doesn't misroute.
  const isLanguageDetection = systemContent.trimStart().startsWith('Identify the ISO 639-1');
  if (isLanguageDetection || handler.startsWith('language:')) {
    const lang = handler.startsWith('language:') ? handler.slice(9) : 'en';
    return { status: 200, body: { message: { content: JSON.stringify(lang) } } };
  }

  if (handler === 'empty') {
    return { status: 200, body: { message: { content: JSON.stringify({ entries: [] }) } } };
  }

  if (handler === 'multi') {
    return {
      status: 200,
      body: {
        message: {
          content: JSON.stringify({
            entries: [
              { title: 'Entry 1', content: 'First topic', domain: ['tech'], tags: [], language: 'en', decayRate: 0.01 },
              { title: 'Entry 2', content: 'Second topic', domain: ['tech'], tags: [], language: 'en', decayRate: 0.02 },
            ],
          }),
        },
      },
    };
  }

  // Default: single-entry decomposition. Read userContent to keep
  // parity with the real-model behavior of echoing input relevance.
  void userContent;
  return {
    status: 200,
    body: {
      message: {
        content: JSON.stringify({
          entries: [
            {
              title: 'Test Entry',
              content: 'This is test content from LLM decomposition.',
              domain: ['testing'],
              tags: ['unit-test'],
              language: 'en',
              decayRate: 0.01,
            },
          ],
        }),
      },
    },
  };
}

function startMockOllamaServer(port = 11499) {
  ollamaServer = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === 'POST' && url.pathname === '/api/chat') {
        const body = (await req.json()) as OllamaChatRequest;
        const { status, body: payload } = ollamaResponseFor(body);
        return Response.json(payload, { status });
      }
      if (req.method === 'GET' && url.pathname === '/api/tags') {
        return Response.json({ models: [] });
      }
      return new Response('Not Found', { status: 404 });
    },
  });
  return ollamaServer;
}

/** Stop all mock servers */
function stopMockServers() {
  if (embeddingServer) {
    embeddingServer.stop();
    embeddingServer = null;
  }
  if (ollamaServer) {
    ollamaServer.stop();
    ollamaServer = null;
  }
}

export { startMockEmbeddingServer, setOllamaHandler, startMockOllamaServer, stopMockServers };
