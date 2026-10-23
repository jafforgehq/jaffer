/**
 * The voice model files, pinned. `scripts/pin-voice-models.mjs` produced this list: every URL is
 * a `resolve/<commit sha>/` URL (never `main`) so the SHA-256 stays valid. Kokoro 82M q8 with the
 * `af_heart` and `bm_george` voices, Whisper base.en q8. The espeak-ng WASM is not listed: the
 * `phonemizer` npm package embeds it in its bundle. `name` is the path under `~/.jaffer/voice/`.
 * Main downloads these once, after consent (`src/main/voice-models.ts`), and only from VOICE_HOSTS.
 */
export interface VoiceFile { name: string; url: string; sha256: string; bytes: number }

export const VOICE_FILES: readonly VoiceFile[] = [
  {
    "name": "kokoro/onnx/model_quantized.onnx",
    "url": "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/onnx/model_quantized.onnx",
    "sha256": "fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478",
    "bytes": 92361116
  },
  {
    "name": "kokoro/config.json",
    "url": "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/config.json",
    "sha256": "df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f",
    "bytes": 44
  },
  {
    "name": "kokoro/tokenizer.json",
    "url": "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/tokenizer.json",
    "sha256": "77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34",
    "bytes": 3497
  },
  {
    "name": "kokoro/tokenizer_config.json",
    "url": "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/tokenizer_config.json",
    "sha256": "be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20",
    "bytes": 113
  },
  {
    "name": "kokoro/voices/af_heart.bin",
    "url": "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/af_heart.bin",
    "sha256": "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b",
    "bytes": 522240
  },
  {
    "name": "kokoro/voices/bm_george.bin",
    "url": "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/bm_george.bin",
    "sha256": "c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc",
    "bytes": 522240
  },
  {
    "name": "whisper/onnx/encoder_model_quantized.onnx",
    "url": "https://huggingface.co/onnx-community/whisper-base.en/resolve/51eefc0af78b103839eda9e7e4f4186acc6517fe/onnx/encoder_model_quantized.onnx",
    "sha256": "6e8001198c490bbae018c0044f630c2915efb826bad957006ce36152d0ab2a10",
    "bytes": 23201320
  },
  {
    "name": "whisper/onnx/decoder_model_merged_quantized.onnx",
    "url": "https://huggingface.co/onnx-community/whisper-base.en/resolve/51eefc0af78b103839eda9e7e4f4186acc6517fe/onnx/decoder_model_merged_quantized.onnx",
    "sha256": "dd4761a3f7add26afda3512abff4706920404c2517e85a9f2ff090b0c0987909",
    "bytes": 53692803
  },
  {
    "name": "whisper/config.json",
    "url": "https://huggingface.co/onnx-community/whisper-base.en/resolve/51eefc0af78b103839eda9e7e4f4186acc6517fe/config.json",
    "sha256": "c8a0de5ed8a083565a4319db29d0c210fda35b4d6076c2d711cae53ae00f3cb1",
    "bytes": 2197
  },
  {
    "name": "whisper/generation_config.json",
    "url": "https://huggingface.co/onnx-community/whisper-base.en/resolve/51eefc0af78b103839eda9e7e4f4186acc6517fe/generation_config.json",
    "sha256": "3479b1f44a07e41db799e22599222fee5816738036def94a39841cb9cdbb4120",
    "bytes": 1556
  },
  {
    "name": "whisper/preprocessor_config.json",
    "url": "https://huggingface.co/onnx-community/whisper-base.en/resolve/51eefc0af78b103839eda9e7e4f4186acc6517fe/preprocessor_config.json",
    "sha256": "a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d",
    "bytes": 339
  },
  {
    "name": "whisper/tokenizer.json",
    "url": "https://huggingface.co/onnx-community/whisper-base.en/resolve/51eefc0af78b103839eda9e7e4f4186acc6517fe/tokenizer.json",
    "sha256": "5eb60cec1e77aeeb6869a2bb5a8e01a84c3fe5d072d75369343021fe6f5310d0",
    "bytes": 2405679
  },
  {
    "name": "whisper/tokenizer_config.json",
    "url": "https://huggingface.co/onnx-community/whisper-base.en/resolve/51eefc0af78b103839eda9e7e4f4186acc6517fe/tokenizer_config.json",
    "sha256": "93879c3dccdd4b976f709acd85b44778873f30c275e67026f30ca1e4c975230c",
    "bytes": 282662
  }
];

/** Hosts a download may contact: the Hub, and the CDN host its redirects were seen to land on. */
export const VOICE_HOSTS: readonly string[] = ['huggingface.co', 'us.aws.cdn.hf.co'];

export const VOICE_TOTAL_BYTES: number = VOICE_FILES.reduce((n, f) => n + f.bytes, 0);
