import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** A minimal Anthropic Messages API stand-in that streams server-sent events, to exercise the real SDK. */
export interface MockRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

type Reply = { kind: 'text'; text: string; thinking?: string } | { kind: 'tool'; id: string; name: string; input: unknown; text?: string } | { kind: 'error'; status: number; message: string } | { kind: 'refusal' };

export class MockAnthropic {
  requests: MockRequest[] = [];
  private server: http.Server;
  private replies: Reply[] = [];
  url = '';

  constructor() {
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        let body: any = {};
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          /* ignore */
        }
        this.requests.push({ path: req.url ?? '', headers: req.headers, body });
        if (req.url?.includes('/v1/models')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-5-5', type: 'model', display_name: 'x', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'a', last_id: 'a' }));
          return;
        }
        const reply = this.replies.shift() ?? ({ kind: 'text', text: 'ok' } as Reply);
        if (reply.kind === 'error') {
          res.writeHead(reply.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: reply.status === 401 ? 'authentication_error' : 'invalid_request_error', message: reply.message } }));
          return;
        }
        if (!body.stream) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(this.message(reply, body)));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const sse = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        const msg = this.message(reply, body);
        sse('message_start', { type: 'message_start', message: { ...msg, content: [], stop_reason: null, usage: { ...msg.usage, output_tokens: 1 } } });
        let idx = 0;
        for (const block of msg.content as any[]) {
          if (block.type === 'text') {
            sse('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
            for (const chunk of chunks(block.text)) sse('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: chunk } });
          } else if (block.type === 'thinking') {
            sse('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '', signature: '' } });
            sse('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: block.thinking } });
            sse('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'signature_delta', signature: 'sig-abc' } });
          } else if (block.type === 'tool_use') {
            sse('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
            const json = JSON.stringify(block.input);
            for (const chunk of chunks(json, 7)) sse('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: chunk } });
          }
          sse('content_block_stop', { type: 'content_block_stop', index: idx });
          idx++;
        }
        sse('message_delta', { type: 'message_delta', delta: { stop_reason: msg.stop_reason, stop_sequence: null, ...(msg.stop_details ? { stop_details: msg.stop_details } : {}) }, usage: { output_tokens: msg.usage.output_tokens } });
        sse('message_stop', { type: 'message_stop' });
        res.end();
      });
    });
  }

  private message(reply: Reply, body: any): any {
    const base = { id: 'msg_mock', type: 'message', role: 'assistant', model: body.model ?? 'claude-sonnet-5-5', stop_sequence: null, usage: { input_tokens: 120, output_tokens: 33, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 } };
    if (reply.kind === 'text') return { ...base, content: [...(reply.thinking ? [{ type: 'thinking', thinking: reply.thinking }] : []), { type: 'text', text: reply.text }], stop_reason: 'end_turn' };
    if (reply.kind === 'tool') return { ...base, content: [...(reply.text ? [{ type: 'text', text: reply.text }] : []), { type: 'tool_use', id: reply.id, name: reply.name, input: reply.input }], stop_reason: 'tool_use' };
    return { ...base, content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'x' } };
  }

  reset(): this {
    this.replies = [];
    return this;
  }

  queue(...r: Reply[]): this {
    this.replies.push(...r);
    return this;
  }

  async listen(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  close(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }
}

function chunks(s: string, n = 5): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out.length ? out : [''];
}
