# tiny-voca (vendored)

The GGUF reader and the dizione phonemizer from the plain-JavaScript port of
[tiny-voca](https://github.com/n4ze3m/tiny-voca) (`js/`), Apache-2.0 (see
LICENSE), copied unchanged at commit 61b258fd2f2aeaad27818fcc6f097674cd609108.

Jarvis uses the phonemizer to turn text into phoneme ids and runs the ONNX
export of the model (`onnx/model.onnx` on Hugging Face) with ONNX Runtime;
see `src/main/tts-tiny.js`. Model files are downloaded on first use.
