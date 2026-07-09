import os
import torch
import torchaudio as ta
import gc
from chatterbox.tts import ChatterboxTTS
from chatterbox.mtl_tts import ChatterboxMultilingualTTS

_model = None
_model_type = None
_model_state = {"status": "idle", "detail": ""}


def _data_dirs():
    data_dir = os.environ.get("DATA_DIR", "data")
    voices_dir = os.path.join(data_dir, "voices")
    sessions_dir = os.path.join(data_dir, "sessions")
    os.makedirs(voices_dir, exist_ok=True)
    os.makedirs(sessions_dir, exist_ok=True)
    return data_dir, voices_dir, sessions_dir


def get_model(language_id="en"):
    global _model, _model_type
    target_type = "en" if language_id == "en" else "multilingual"

    if _model is not None and _model_type != target_type:
        print(f"Switching models from {_model_type} to {target_type}. Freeing VRAM...")
        _model = None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    if _model is None:
        _model_state["status"] = "loading"
        _model_state["detail"] = ""
        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"Loading {target_type} Chatterbox TTS model on {device}...")
        try:
            if target_type == "en":
                _model = ChatterboxTTS.from_pretrained(device=device)
            else:
                _model = ChatterboxMultilingualTTS.from_pretrained(device=device)
            _model_type = target_type
            _model_state["status"] = "ready"
            _model_state["detail"] = ""
            print("Model loaded.")
        except Exception as e:
            _model_state["status"] = "error"
            _model_state["detail"] = str(e)
            print(f"Model load failed: {e}")
            raise

    return _model


def narrate_text(text, session_id, page_index, voice_id=None, language_id="en"):
    model = get_model(language_id)
    _, voices_dir, sessions_dir = _data_dirs()

    audio_prompt_path = None
    if voice_id:
        safe_id = "".join(c for c in voice_id if c.isalnum() or c in ('-', '_')).strip()
        if not safe_id:
            raise Exception("Invalid voice id.")
        audio_prompt_path = os.path.join(voices_dir, f"{safe_id}.wav")
        if not os.path.exists(audio_prompt_path):
            raise Exception(f"Voice profile '{safe_id}' not found.")

    generate_kwargs = {}
    if audio_prompt_path:
        generate_kwargs["audio_prompt_path"] = audio_prompt_path

    if language_id != "en":
        generate_kwargs["language_id"] = language_id

    wav = model.generate(text, **generate_kwargs)

    output_dir = os.path.join(sessions_dir, session_id)
    os.makedirs(output_dir, exist_ok=True)

    filename = f"page_{page_index}.wav"
    output_path = os.path.join(output_dir, filename)

    ta.save(output_path, wav, model.sr)

    return f"/sessions/{session_id}/{filename}"
