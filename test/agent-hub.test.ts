import { describe, expect, it } from 'vitest';
import { AgentHub } from '../src/core/agent/hub';
import { ConfigStore, DEFAULT_CONFIG } from '../src/shared/config';
import { Emitter } from '../src/shared/util';

/** Only the hub's choice of engine is under test, so the two heavy engines are stood in for. */
function engine(name: string) {
  return { events: new Emitter(), busy: false, thread: { items: () => [] }, status: () => ({ engine: name }), cancel() {}, approve: () => false, send: () => ({ turnId: name }), dispose: async () => {} };
}
function hub(o: { engine: 'auto' | 'api' | 'claude-code'; apiEnabled: boolean; apiReady: boolean; claudeReady: boolean }) {
  const config = { get: () => ({ ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, engine: o.engine } }) } as unknown as ConfigStore;
  return new AgentHub(engine('api') as never, engine('claude-code') as never, config, { api: () => o.apiReady, claudeCode: () => o.claudeReady, apiEnabled: () => o.apiEnabled });
}

describe('AgentHub: Jaffer runs on a Claude subscription (the API-key engine is switched off)', () => {
  it('always uses the Claude Code login, whatever the config says and even if an API key is around', () => {
    for (const engine of ['auto', 'api', 'claude-code'] as const) {
      const h = hub({ engine, apiEnabled: false, apiReady: true, claudeReady: true });
      expect(h.kind()).toBe('claude-code');
      expect(h.status()).toMatchObject({ engine: 'claude-code', engines: { api: false, claudeCode: true } });
    }
  });

  it('stays on Claude Code when Claude Code is missing too (the panel then says what to install, not "add a key")', () => {
    expect(hub({ engine: 'auto', apiEnabled: false, apiReady: true, claudeReady: false }).kind()).toBe('claude-code');
  });

  it('keeps the old choice available when the API engine is switched on (used by tests, and for later)', () => {
    expect(hub({ engine: 'auto', apiEnabled: true, apiReady: true, claudeReady: true }).kind()).toBe('api');
    expect(hub({ engine: 'auto', apiEnabled: true, apiReady: false, claudeReady: true }).kind()).toBe('claude-code');
    expect(hub({ engine: 'claude-code', apiEnabled: true, apiReady: true, claudeReady: true }).kind()).toBe('claude-code');
    expect(hub({ engine: 'api', apiEnabled: true, apiReady: false, claudeReady: true }).kind()).toBe('api');
  });
});
