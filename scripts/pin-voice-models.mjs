// Pins the voice model files: resolves each repo's current commit, downloads the files into a
// scratch folder (pass it as argv[2]; never inside the repo), and prints the VOICE_FILES array
// for src/shared/voice-manifest.ts plus every host seen on redirects. Run by hand, then review.
// The espeak-ng WASM is not listed: the `phonemizer` npm package embeds it in its bundle.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const out = process.argv[2];
if (!out) { console.error('usage: node scripts/pin-voice-models.mjs <scratch folder>'); process.exit(2); }

const REPOS = {
  kokoro: ['onnx-community/Kokoro-82M-v1.0-ONNX', ['onnx/model_quantized.onnx', 'config.json', 'tokenizer.json', 'tokenizer_config.json', 'voices/af_heart.bin', 'voices/bm_george.bin']],
  whisper: ['onnx-community/whisper-base.en', ['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx', 'config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json']],
};
const hosts = new Set(['huggingface.co']);
const rows = [];

async function get(url) {
  for (let hop = 0; hop < 4; hop++) {
    const r = await fetch(url, { redirect: 'manual' });
    if (r.status >= 300 && r.status < 400) { url = new URL(r.headers.get('location'), url).href; hosts.add(new URL(url).host); continue; }
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return Buffer.from(await r.arrayBuffer());
  }
  throw new Error('too many redirects');
}

for (const [dir, [repo, files]] of Object.entries(REPOS)) {
  const sha = (await (await fetch(`https://huggingface.co/api/models/${repo}`)).json()).sha;
  for (const f of files) {
    const url = `https://huggingface.co/${repo}/resolve/${sha}/${f}`;
    const buf = await get(url);
    const name = `${dir}/${f}`;
    mkdirSync(path.dirname(path.join(out, name)), { recursive: true });
    writeFileSync(path.join(out, name), buf);
    rows.push({ name, url, sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length });
    console.error('pinned', name, buf.length);
  }
}
console.log('export const VOICE_FILES: readonly VoiceFile[] = ' + JSON.stringify(rows, null, 2) + ';');
console.log('hosts:', JSON.stringify([...hosts].sort()));
console.log('total:', rows.reduce((n, r) => n + r.bytes, 0));
