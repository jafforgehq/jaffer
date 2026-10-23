# Third-party notices

Jaffer is licensed under GPL-3.0-or-later (see `LICENSE`). The voice feature uses the components below.

## espeak-ng (GPL-3.0-or-later)

Text-to-phoneme conversion for speech output. Copyright the espeak-ng authors. Licensed GPL-3.0-or-later; source: https://github.com/espeak-ng/espeak-ng

The espeak-ng source tree also carries `COPYING.BSD2` (its README says this covers the `getopt.c` compatibility code from NetBSD, used on Windows), `COPYING.APACHE` and `COPYING.UCD` (Unicode data terms). Other parts of the source tree may be under these licences; see the espeak-ng source for the full list.

## Kokoro model weights (Apache-2.0)

Speech synthesis model by hexgrad (Kokoro-82M). Licensed Apache-2.0: https://www.apache.org/licenses/LICENSE-2.0

## Whisper (MIT)

Speech recognition model by OpenAI. Copyright (c) 2022 OpenAI. Licensed MIT: https://github.com/openai/whisper/blob/main/LICENSE

## Voice worker libraries

The voice worker (`dist/renderer/voice-worker.js`) bundles these npm packages, and the app ships the onnxruntime-web WASM binary (`ort-wasm-simd-threaded.jsep.wasm`) beside it:

- `@huggingface/transformers` 3.8.1 (Apache-2.0), https://github.com/huggingface/transformers.js
- `kokoro-js` 1.2.1 (Apache-2.0), https://github.com/hexgrad/kokoro
- `phonemizer` 1.2.1 (Apache-2.0 for its own code), https://github.com/xenova/phonemizer.js; its bundle embeds espeak-ng compiled to WASM with espeak-ng's data, which are GPL-3.0-or-later (above)
- `onnxruntime-web` 1.22.0-dev.20250409-89f8206ba4 and `onnxruntime-common` 1.21.0 (MIT, Copyright (c) Microsoft Corporation), https://github.com/microsoft/onnxruntime
- `@huggingface/jinja` 0.5.10 (MIT), https://github.com/huggingface/huggingface.js

The Apache-2.0 text is at https://www.apache.org/licenses/LICENSE-2.0; each package's own licence file is in its npm package.

## npm dependencies

Runtime and build dependencies are MIT, ISC, BSD, Apache-2.0, BlueOak-1.0.0, 0BSD, CC0 or similar permissive licences; each ships its own licence text in `node_modules`.
