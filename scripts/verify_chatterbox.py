import torchaudio as ta
import torch
import os
import time
from chatterbox.tts import ChatterboxTTS

print(f"CUDA Available: {torch.cuda.is_available()}")
device = "cuda" if torch.cuda.is_available() else "cpu"

print(f"Loading ChatterboxTTS on {device}...")
model = ChatterboxTTS.from_pretrained(device=device)

text = "This is a verification test to ensure the text to speech engine is working correctly."

print("Generating audio...")
start_time = time.time()
wav = model.generate(text)
end_time = time.time()

output_path = "verification_test.wav"
ta.save(output_path, wav, model.sr)

file_size = os.path.getsize(output_path)
print(f"Audio generated in {end_time - start_time:.2f} seconds.")
print(f"Saved to {output_path}. Size: {file_size} bytes.")
print(f"Sample Rate: {model.sr}")
print(f"Duration: {wav.shape[-1] / model.sr:.2f} seconds.")
