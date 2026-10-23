/**
 * Voice mode's decisions without signals or DOM (the controller wires them to the window; `flow.test.ts`-style unit tests drive this with a fake
 * engine). Spec "Voice mode", "Speaking". Owns the mode (through `step`), the double-Esc timing, the serialised engine start/stop and the speech of a
 * finished turn: working -> idle in the voice-start pane reads the reply (`reply`), keeps its prose (`speakable`) and plays it in chunks
 * (`chunkForSpeech`: a short first chunk for an early first sound). Nothing here is written anywhere; text lives for the call.
 * Dictation (Task 8, `dictation` in the deps): the microphone opens only (a) when voice mode starts, once the engine is ready, if the start
 * pane's Claude is idle, and (b) once after each finished turn of that Claude, after its reply was spoken (or when there was nothing to
 * speak), while the mode is `ready`. Never while speaking or preparing, and never again after no speech, a cancel, noise, or a typed or
 * copied result until the next finished turn. A recording is `heard` (mic open) -> `stop` (transcribing) -> `text` (ready); Esc and every
 * end of voice abort it. The text is cleaned (`cleanDictation`); a command character first is copied; otherwise it is typed only when
 * `mayType` allows at that moment (after Whisper), into the start pane, without Enter; else copied with the reason.
 */
import { chunkForSpeech, speakable } from '../../shared/voice-text';
import { cleanDictation, mayType, startsLikeCommand } from '../../shared/voice-policy';
import { step, type VoiceEvent, type VoiceMode } from './session';

export interface Engine {
  startEngine(): Promise<void>;
  stopEngine(): void;
  speak(text: string, speed: number): Promise<void>;
  stopSpeaking(): void;
  /** Fires once per worker crash after startup (never for our own stopEngine, nor a failed start). */
  onCrash?(cb: () => void): void;
  /** Whisper's raw text for 16 kHz mono samples; rejects 'unavailable' when the engine ended. */
  transcribe(pcm16k: Float32Array): Promise<string>;
}
/** The microphone and the terminals, for dictation (the controller wires them; tests fake them). */
export interface Dictation {
  /** macOS's microphone access for the app, asked once per voice session before its first recording. */
  micAccess(): Promise<'granted' | 'denied'>;
  /** One recording: the samples, null (no speech, aborted), or a rejection 'mic-denied' / 'mic-missing'. */
  record(signal: AbortSignal): Promise<Float32Array | null>;
  /** `permissions.voice` as the window's config says now. */
  voiceOn(): boolean;
  /** The terminal that was focused when voice mode started. */
  startPane(): string | null;
  activePane(): string;
  /** That terminal's Claude state (the watcher's), undefined when none runs there. */
  claudeState(pane: string): string | undefined;
  /** Types the text into that terminal (the one typing call of dictation). */
  type(pane: string, text: string): void;
  /** Copies it to the clipboard with a toast that says why. */
  copy(text: string, why: string): void;
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
  /** Without it, voice mode only speaks. */
  dictation?: Dictation;
}
export interface Observed { id: string; state: string; cutShort?: boolean }

/** A second Esc within this many ms of a first one, in `ready`, leaves voice mode. */
export const ESC_ESC_MS = 1500;
/** A dictation typed less than this many ms ago holds the next one (copied instead): the one-shot lock of the typing rule. */
export const TYPE_LOCK_MS = 2000;
export const MIC_DENIED = 'Microphone access is off for Jaffer. Allow it in System Settings → Privacy & Security → Microphone.';
export const MIC_MISSING = 'Jaffer could not open a microphone. Check that one is connected.';
export const NO_CLAUDE = 'Start Claude Code in this terminal (⇧⌘C) and finish a turn, then voice listens.';
export const NOT_IDLE = 'Voice listens once Claude finishes this turn.';
export const COMMAND_COPIED = 'Starts with a command character, so Jaffer copied it instead of typing it.';

export function createFlow(d: FlowDeps) {
  let mode: VoiceMode = 'off';
  let gen = 0; // bumped by every start and every end: a start that finds it moved gives up quietly
  let speechGen = 0; // bumped by anything that must cut a reply short (a new turn, Esc, leaving)
  let run: Promise<void> = Promise.resolve(); // the last engine start; a new start waits for it to settle (no stale start is joined or clobbered)
  let ready: Promise<boolean> = Promise.resolve(false); // whether the current start succeeded
  let lastEsc = -Infinity;
  let last: Observed | null = null;
  let rec: AbortController | null = null; // the recording now open
  let micChecked = false; // macOS's access was asked in this voice session
  let typedAt = -Infinity; // the last dictation typed (the one-shot lock)

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
    closeMic();
    send(ev);
    if (cur() !== 'off') { mode = 'off'; d.onMode(mode); }
    d.onPreparing(false);
    d.engine.stopEngine();
  };

  async function toggle(): Promise<void> {
    if (mode !== 'off') return end('start');
    send('start');
    d.onPreparing(true);
    micChecked = false;
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
      if (d.dictation) { if (last?.state === 'idle') void listen(); else d.say(last && last.state !== 'ended' ? NOT_IDLE : NO_CLAUDE); }
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
    if (mode === 'listening') closeMic();
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
    if (tok !== speechGen || mode !== 'ready') return;
    const chunks = text ? chunkForSpeech(speakable(text)) : [];
    if (!chunks.length) return void listen(); // nothing to speak (code only, no reply): say nothing, show nothing, listen
    send('reply');
    for (const c of chunks) {
      if (tok !== speechGen) return;
      try { await d.engine.speak(c, d.speed()); } catch (e) {
        if (tok === speechGen && e === 'unavailable') { d.say('Voice stopped working. Turn it on again with /voice.'); end('worker-crashed'); }
        break; // (one failed sentence: the rest is dropped)
      }
    }
    if (tok === speechGen && cur() === 'speaking') { send('spoke'); void listen(); }
  }

  const closeMic = () => { rec?.abort(); rec = null; };

  /** One recording, its transcript and the text's fate (typed or copied). Only from `ready`; see the header for when it is called. */
  async function listen(): Promise<void> {
    const dz = d.dictation;
    if (!dz || mode !== 'ready' || rec) return;
    const my = gen;
    if (!micChecked) {
      const a = await dz.micAccess().catch(() => 'denied' as const);
      if (my !== gen || cur() !== 'ready') return;
      if (a !== 'granted') return d.say(MIC_DENIED);
      micChecked = true;
    }
    const pane = dz.activePane(); // the recording-start pane: the one that must still be focused at the moment of typing
    const ctl = (rec = new AbortController());
    send('heard');
    let pcm: Float32Array | null;
    try {
      pcm = await dz.record(ctl.signal);
    } catch (e) {
      if (rec === ctl) rec = null;
      if (my === gen && cur() === 'listening' && !ctl.signal.aborted) { send('esc'); d.say(e === 'mic-denied' ? MIC_DENIED : MIC_MISSING); }
      return;
    }
    if (rec === ctl) rec = null;
    if (my !== gen || cur() !== 'listening' || ctl.signal.aborted) return; // (cancelled, or voice ended: nothing more)
    if (!pcm) return void send('esc'); // 8 s without speech: back to ready, no retry
    send('stop');
    let raw: string;
    try { raw = await d.engine.transcribe(pcm); } catch {
      if (my === gen && cur() === 'transcribing') send('text'); // (a crash ends voice through onCrash; one failed call just drops the audio)
      return;
    }
    pcm = null; // (the audio is dropped)
    if (my !== gen || cur() !== 'transcribing') return; // voice ended meanwhile: nothing is typed or copied
    deliver(dz, raw, pane);
    send('text');
  }

  /** The typing rule, checked now (after Whisper): typed into the start pane with no Enter, or copied with the reason; noise does nothing. */
  function deliver(dz: Dictation, raw: string, recPane: string): void {
    const text = cleanDictation(raw);
    if (!text) return;
    if (startsLikeCommand(text)) return dz.copy(text, COMMAND_COPIED);
    const start = dz.startPane() ?? '';
    const active = dz.activePane();
    // condition 2 twice: the focus must be on the pane where voice started AND where this recording started
    const ok = mayType({ voiceOn: dz.voiceOn(), startPane: start, activePane: active === recPane ? active : '', claudeState: start ? dz.claudeState(start) : undefined, typing: d.now() - typedAt < TYPE_LOCK_MS });
    if (!ok.ok) return dz.copy(text, ok.why);
    typedAt = d.now();
    dz.type(start, text);
  }

  /** Called with the start pane's Claude each time it changes (null: none). Working -> idle reads the reply; a new turn cuts a speech. */
  function observe(now: Observed | null): void {
    const was = last;
    last = now ? { ...now } : null;
    if (mode === 'off' || !now) return;
    if (was && was.id !== now.id) return; // another session: a new one, not a turn of the same (never read its reply)
    if (was?.state === 'working' && now.state === 'idle' && !now.cutShort) void speakReply(now.id);
    else if (was?.state !== 'working' && now.state === 'working') {
      speechGen++; // (also a reply still being fetched)
      if (mode === 'speaking') { d.engine.stopSpeaking(); send('stop'); }
    }
  }

  // an engine crash ends voice at once, whatever the mode; a speech pending is dropped (end bumps speechGen), not finished
  d.engine.onCrash?.(() => {
    if (mode === 'off') return;
    d.say('Voice stopped working. Turn it on again with /voice.');
    end('worker-crashed');
  });

  return { mode: () => mode, toggle, esc, stopButton, end, observe, send };
}
