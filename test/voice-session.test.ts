import { describe, expect, it } from 'vitest';
import { step, type VoiceEvent, type VoiceMode } from '../src/renderer/voice/session';

const MODES: VoiceMode[] = ['off', 'ready', 'listening', 'transcribing', 'speaking'];

describe('voice step', () => {
  it('walks the spec path', () => {
    let m: VoiceMode = 'off';
    for (const [ev, to] of [['start', 'ready'], ['heard', 'listening'], ['stop', 'transcribing'], ['text', 'ready'], ['reply', 'speaking'], ['spoke', 'ready']] as const) {
      m = step(m, ev);
      expect(m).toBe(to);
    }
  });
  it('esc cancels a recording; esc-esc leaves; a lone esc stays ready', () => {
    expect(step('listening', 'esc')).toBe('ready');
    expect(step('transcribing', 'esc')).toBe('ready'); // (F3: Esc cancels a transcription too; its text is dropped by the flow)
    expect(step('ready', 'esc')).toBe('ready');
    expect(step('ready', 'esc-esc')).toBe('off');
  });
  it('stop ends speech; start again toggles off', () => {
    expect(step('speaking', 'stop')).toBe('ready');
    expect(step('ready', 'start')).toBe('off');
  });
  it('esc stops speech', () => expect(step('speaking', 'esc')).toBe('ready'));
  it('switch-off, window-hidden and worker-crashed land in off from every mode', () => {
    for (const m of MODES) for (const ev of ['switch-off', 'window-hidden', 'worker-crashed'] as const) expect(step(m, ev)).toBe('off');
  });
  it('nonsense stays put and never throws', () => {
    expect(step('off', 'heard')).toBe('off');
    expect(step('transcribing', 'heard')).toBe('transcribing');
    expect(step('listening', 'spoke')).toBe('listening');
    expect(step('ready', 'bogus' as VoiceEvent)).toBe('ready');
    expect(step('bogus' as VoiceMode, 'start')).toBe('bogus');
  });
});
