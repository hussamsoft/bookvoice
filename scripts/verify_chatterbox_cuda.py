import torchaudio as ta
import torch
import os
from chatterbox.tts import ChatterboxTTS

def test_chatterbox():
    print("Testing CUDA availability...")
    if not torch.cuda.is_available():
        print("CUDA is NOT available! Check your PyTorch installation.")
        return

    device = "cuda"
    print(f"Using device: {device}")

    # Use standard Chatterbox TTS
    print("Loading ChatterboxTTS (500M) model...")
    model = ChatterboxTTS.from_pretrained(device=device)

    text = "Hello! This is a test of the BookVoice physical book narration system."
    print(f"Generating audio for text: '{text}'")
    wav = model.generate(text)

    # Validate output format
    print(f"Generated output format: type={type(wav)}, shape={wav.shape}, sample_rate={model.sr} Hz")
    if not isinstance(wav, torch.Tensor):
        raise RuntimeError(f"Output should be a torch Tensor, got {type(wav)!r}")
    if wav.dim() != 2:
        raise RuntimeError(f"Output tensor should be 2D (channels, length), got {wav.dim()}D")
    if model.sr != 24000:
        raise RuntimeError(f"Expected sample rate for Chatterbox is 24kHz, got {model.sr}")

    output_path = "test_output.wav"
    ta.save(output_path, wav, model.sr)
    print(f"Audio generated successfully at {os.path.abspath(output_path)}")

if __name__ == "__main__":
    test_chatterbox()
