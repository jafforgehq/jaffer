/**
 * Voice mode's decisions without signals or DOM (the controller wires them to the window; `flow.test.ts`-style unit tests drive this with a fake
 * engine). Spec "Voice mode", "Speaking". Owns the mode (through `step`), the double-Esc timing, the serialised engine start/stop and the speech of a
 * finished turn: working -> idle in the voice-start pane reads the reply (`reply`), keeps its prose (`speakable`) and plays it in chunks
 * (`chunkForSpeech`: a short first chunk for an early first sound). Nothing here is written anywhere; text lives for the call.
 * Task 8 (recording, dictation) extends this: `send('heard' | 'stop' | 'text')` already move the mode, and the engine's `transcribe` is in `Engine`.
 */
import { chunkForSpeech, speakable } from '../../shared/voice-text';
import { step, type VoiceEvent, type VoiceMode } from './session';

export interface Engine {
  startEngine(): Promise<void>;
  stopEngine(): void;
  speak(text: string, speed: number): Promise<void>;
  stopSpeaking(): void;
}
export interface FlowDeps {
  engine: Engine;
  /** The daemon's `claude.reply` for a session: the reply text, or null (switch off, no reply, any failure). */
  reply(session: string): Promise<string | null>;
  speed(): number;
  /** A plain sentence for the person (a toast). */
  say(message: string): void;
  onMode(mode: VoiceMode): void;
  onPreparing(on: boolean): void;
  now(): number;
}
export interface Observed { id: string; state: string; cutShort?: boolean }

/** A second Esc within this many ms of a first one, in `ready`, leaves voice mode. */
export const ESC_ESC_MS = 1500;

export function createFlow(d: FlowDeps) {
  let mode: VoiceMode = 'off';
  let gen = 0; // bumped by every start and every end: a start that finds it moved gives up quietly
  let speechGen = 0; // bumped by anything that must cut a reply short (a new turn, Esc, leaving)
  let run: Promise<void> = Promise.resolve(); // the last engine start; a new start waits for it to settle (no stale start is joined or clobbered)
  let ready: Promise<boolean> = Promise.resolve(false); // whether the current start succeeded
  let lastEsc = -Infinity;
  let last: Observed | null = null;

  const cur = (): VoiceMode => mode; // (TypeScript cannot see `send` or an await change it)
  const send = (ev: VoiceEvent): VoiceMode => {
    const next = step(mode, ev);
    if (next !== mode) { mode = next; d.onMode(mode); }
    return mode;
  };
  /** Ends voice mode from any state (the events that end it, or a failed start): the engine stops, a speech in flight is dropped. */
  const end = (ev: 'start' | 'esc-esc' | 'switch-off' | 'window-hidden' | 'worker-crashed' = 'switch-off') => {
    if (mode === 'off') return;
    gen++; speechGen++; lastEsc = -Infinity;
    send(ev);
    if (cur() !== 'off') { mode = 'off'; d.onMode(mode); }
    d.onPreparing(false);
    d.engine.stopEngine();
  };

  async function toggle(): Promise<void> {
    if (mode !== 'off') return end('start');
    send('start');
    d.onPreparing(true);
    const my = ++gen;
    const prev = run;
    const mine: Promise<boolean> = (async () => {
      await prev.catch(() => {}); // the old run must settle first: after stopEngine() a start called too early joins the old, failing one
      if (my !== gen) return false;
      try { await d.engine.startEngine(); } catch {
        if (my === gen) { d.say('Voice could not start. Check Settings → Privacy and permissions.'); end('worker-crashed'); }
        return false;
      }
      if (my !== gen) return false;
      d.onPreparing(false);
      return true;
    })();
    ready = mine;
    run = mine.then(() => {});
    await mine;
  }

  /** Esc as the controller saw it (only while voice is on and no dialog owns the key). */
  function esc(): void {
    if (mode === 'off') return;
    if (mode === 'speaking') { stopSpeech('esc'); return; }
    if (mode !== 'ready') { send('esc'); lastEsc = -Infinity; return; }
    const t = d.now();
    if (t - lastEsc <= ESC_ESC_MS) end('esc-esc');
    else lastEsc = t;
  }

  /** The Stop button: stops a speech; otherwise it leaves voice mode. */
  function stopButton(): void { if (mode === 'speaking') stopSpeech('stop'); else end('start'); }

  // A stop during a chunk takes effect after the sentence in flight: the engine's speak() resolves when its audio ends or stopSpeaking() runs,
  // and stopSpeaking() cuts what is playing but the worker may finish the sentence it is synthesising.
  function stopSpeech(ev: 'esc' | 'stop'): void {
    speechGen++;
    d.engine.stopSpeaking();
    send(ev);
  }

  async function speakReply(session: string): Promise<void> {
    const tok = ++speechGen;
    if (!(await ready) || tok !== speechGen || mode !== 'ready') return;
    let text: string | null = null;
    try { text = await d.reply(session); } catch { /* nothing to read */ }
    if (!text || tok !== speechGen || mode !== 'ready') return;
    const chunks = chunkForSpeech(speakable(text));
    if (!chunks.length) return; // code only: say nothing, show nothing
    send('reply');
    for (const c of chunks) {
      if (tok !== speechGen) return;
      try { await d.engine.speak(c, d.speed()); } catch (e) {
        if (tok === speechGen && e === 'unavailable') { d.say('Voice stopped working. Turn it on again with /voice.'); end('worker-crashed'); }
        break; // (one failed sentence: the rest is dropped)
      }
    }
    if (tok === speechGen && cur() === 'speaking') send('spoke');
  }

  /** Called with the start pane's Claude each time it changes (null: none). Working -> idle reads the reply; a new turn cuts a speech. */
  function observe(now: Observed | null): void {
    const was = last;
    last = now ? { ...now } : null;
    if (mode === 'off' || !now) return;
    if (was?.state === 'working' && now.state === 'idle' && !now.cutShort) void speakReply(now.id);
    else if (was?.state !== 'working' && now.state === 'working') {
      speechGen++; // (also a reply still being fetched)
      if (mode === 'speaking') { d.engine.stopSpeaking(); send('stop'); }
    }
  }

  return { mode: () => mode, toggle, esc, stopButton, end, observe, send };
}
