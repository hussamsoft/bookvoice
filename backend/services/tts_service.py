import os
import torch
import torchaudio as ta
from chatterbox.tts import ChatterboxTTS

# Singleton instance for the TTS model to avoid reloading
_model = None

def get_model():
    global _model
    if _model is None:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"Loading Chatterbox TTS model on {device}...")
        _model = ChatterboxTTS.from_pretrained(device=device)
        print("Model loaded.")
    return _model

def narrate_text(text: str, session_id: str, page_index: int, voice_id: str = None) -> str:
    """
    Generates audio for the given text and saves it.
    Returns the relative path to the generated audio file.
    """
    model = get_model()
    
    audio_prompt_path = None
    if voice_id:
        audio_prompt_path = os.path.join("data", "voices", f"{voice_id}.wav")
        if not os.path.exists(audio_prompt_path):
            raise Exception(f"Voice profile '{voice_id}' not found.")
            
    if audio_prompt_path:
        wav = model.generate(text, audio_prompt_path=audio_prompt_path)
    else:
        wav = model.generate(text)
    
    # Save the output
    output_dir = os.path.join("data", "sessions", session_id)
    os.makedirs(output_dir, exist_ok=True)
    
    filename = f"page_{page_index}.wav"
    output_path = os.path.join(output_dir, filename)
    
    ta.save(output_path, wav, model.sr)
    
    return f"/sessions/{session_id}/{filename}"
