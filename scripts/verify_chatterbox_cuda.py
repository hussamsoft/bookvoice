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
    assert isinstance(wav, torch.Tensor), "Output should be a torch Tensor"
    assert wav.dim() == 2, "Output tensor should be 2D (channels, length)"
    assert model.sr == 24000, "Expected sample rate for Chatterbox is 24kHz"

    output_path = "test_output.wav"
    ta.save(output_path, wav, model.sr)
    print(f"Audio generated successfully at {os.path.abspath(output_path)}")

if __name__ == "__main__":
    test_chatterbox()
