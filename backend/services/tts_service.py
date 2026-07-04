import os
import torch
import torchaudio as ta
import gc
from chatterbox.tts import ChatterboxTTS
from chatterbox.mtl_tts import ChatterboxMultilingualTTS

# Singleton instance for the TTS model to avoid reloading
_model = None
_model_type = None  # "en" or "multilingual"

def get_model(language_id: str = "en"):
    global _model, _model_type
    
    target_type = "en" if language_id == "en" else "multilingual"
    
    if _model is not None and _model_type != target_type:
        print(f"Switching models from {_model_type} to {target_type}. Freeing VRAM...")
        _model = None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            
    if _model is None:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"Loading {target_type} Chatterbox TTS model on {device}...")
        if target_type == "en":
            _model = ChatterboxTTS.from_pretrained(device=device)
        else:
            _model = ChatterboxMultilingualTTS.from_pretrained(device=device)
        _model_type = target_type
        print("Model loaded.")
        
    return _model

def narrate_text(text: str, session_id: str, page_index: int, voice_id: str = None, language_id: str = "en") -> str:
    """
    Generates audio for the given text and saves it.
    Returns the relative path to the generated audio file.
    """
    model = get_model(language_id)
    
    audio_prompt_path = None
    if voice_id:
        audio_prompt_path = os.path.join("data", "voices", f"{voice_id}.wav")
        if not os.path.exists(audio_prompt_path):
            raise Exception(f"Voice profile '{voice_id}' not found.")
            
    generate_kwargs = {}
    if audio_prompt_path:
        generate_kwargs["audio_prompt_path"] = audio_prompt_path
    
    if language_id != "en":
        generate_kwargs["language_id"] = language_id
        
    wav = model.generate(text, **generate_kwargs)
    
    # Save the output
    output_dir = os.path.join("data", "sessions", session_id)
    os.makedirs(output_dir, exist_ok=True)
    
    filename = f"page_{page_index}.wav"
    output_path = os.path.join(output_dir, filename)
    
    ta.save(output_path, wav, model.sr)
    
    return f"/sessions/{session_id}/{filename}"
