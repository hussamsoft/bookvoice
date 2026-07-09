import os
import torch
import torchaudio as ta
import gc
from chatterbox.tts import ChatterboxTTS
from chatterbox.mtl_tts import ChatterboxMultilingualTTS
import threading

_model = None
_model_type = None
_model_state = {"status": "idle", "detail": ""}
_model_lock = threading.Lock()


def _data_dirs():
    data_dir = os.environ.get("DATA_DIR", "data")
    voices_dir = os.path.join(data_dir, "voices")
    sessions_dir = os.path.join(data_dir, "sessions")
    os.makedirs(voices_dir, exist_ok=True)
    os.makedirs(sessions_dir, exist_ok=True)
    return data_dir, voices_dir, sessions_dir


def _load_local_en(ckpt_dir, device):
    from chatterbox.tts import ChatterboxTTS, Conditionals
    from chatterbox.models.voice_encoder import VoiceEncoder
    from chatterbox.models.t3 import T3
    from chatterbox.models.s3gen import S3Gen
    from chatterbox.models.tokenizers import EnTokenizer
    from safetensors.torch import load_file
    from pathlib import Path
    
    ckpt_dir = Path(ckpt_dir)
    map_location = torch.device('cpu') if device in ["cpu", "mps"] else None

    _model_state["detail"] = "Loading Voice Encoder..."
    ve = VoiceEncoder()
    ve.load_state_dict(load_file(ckpt_dir / "ve.safetensors"))
    ve.to(device).eval()

    _model_state["detail"] = "Loading T3 neural decoder (2.1GB)..."
    t3 = T3()
    t3_state = load_file(ckpt_dir / "t3_cfg.safetensors")
    if "model" in t3_state.keys():
        t3_state = t3_state["model"][0]
    t3.load_state_dict(t3_state)
    t3.to(device).eval()

    _model_state["detail"] = "Loading S3Gen audio decoder (1.0GB)..."
    s3gen = S3Gen()
    s3gen.load_state_dict(load_file(ckpt_dir / "s3gen.safetensors"), strict=False)
    s3gen.to(device).eval()

    _model_state["detail"] = "Initializing Text Tokenizer..."
    tokenizer = EnTokenizer(str(ckpt_dir / "tokenizer.json"))

    conds = None
    if (builtin_voice := ckpt_dir / "conds.pt").exists():
        _model_state["detail"] = "Loading default speaker prompt..."
        conds = Conditionals.load(builtin_voice, map_location=map_location).to(device)

    return ChatterboxTTS(t3, s3gen, ve, tokenizer, device, conds=conds)


def _load_local_mtl(ckpt_dir, device):
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS, Conditionals, _resolve_multilingual_t3_model
    from chatterbox.models.voice_encoder import VoiceEncoder
    from chatterbox.models.t3 import T3
    from chatterbox.models.t3.modules.t3_config import T3Config
    from chatterbox.models.s3gen import S3Gen
    from chatterbox.models.tokenizers import MTLTokenizer
    from safetensors.torch import load_file as load_safetensors
    from pathlib import Path
    
    ckpt_dir = Path(ckpt_dir)
    t3_model = _resolve_multilingual_t3_model(None)
    map_location = torch.device('cpu') if device in ["cpu", "mps"] else None

    _model_state["detail"] = "Loading Voice Encoder (multilingual)..."
    ve = VoiceEncoder()
    ve.load_state_dict(torch.load(ckpt_dir / "ve.pt", map_location=map_location, weights_only=True))
    ve.to(device).eval()

    _model_state["detail"] = "Loading Multilingual T3 decoder (2.1GB)..."
    t3 = T3(T3Config.multilingual())
    t3_state = load_safetensors(ckpt_dir / t3_model)
    if "model" in t3_state.keys():
        t3_state = t3_state["model"][0]
    t3.load_state_dict(t3_state)
    t3.to(device).eval()

    _model_state["detail"] = "Loading S3Gen audio decoder (1.0GB)..."
    s3gen = S3Gen()
    s3gen.load_state_dict(torch.load(ckpt_dir / "s3gen.pt", map_location=map_location, weights_only=True))
    s3gen.to(device).eval()

    _model_state["detail"] = "Initializing Multilingual Tokenizer..."
    tokenizer = MTLTokenizer(str(ckpt_dir / "grapheme_mtl_merged_expanded_v1.json"))

    conds = None
    if (builtin_voice := ckpt_dir / "conds.pt").exists():
        _model_state["detail"] = "Loading default speaker prompt..."
        conds = Conditionals.load(builtin_voice, map_location=map_location).to(device)

    return ChatterboxMultilingualTTS(t3, s3gen, ve, tokenizer, device, conds=conds)


def get_model(language_id="en"):
    global _model, _model_type
    target_type = "en" if language_id == "en" else "multilingual"

    with _model_lock:
        if _model is not None and _model_type != target_type:
            print(f"Switching models from {_model_type} to {target_type}. Freeing VRAM...")
            _model = None
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

        if _model is None:
            _model_state["status"] = "loading"
            _model_state["detail"] = "Searching local model..."
            device = "cuda" if torch.cuda.is_available() else "cpu"
            
            # Resolve local model directory path (e.g. backend/data/models/en or dist/data/models/en)
            local_model_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data", "models", target_type))
            has_local = False
            if target_type == "en":
                has_local = os.path.exists(os.path.join(local_model_path, "tokenizer.json"))
            else:
                has_local = os.path.exists(os.path.join(local_model_path, "grapheme_mtl_merged_expanded_v1.json"))
                
            try:
                if has_local:
                    print(f"Loading {target_type} Chatterbox TTS model from local bundle: {local_model_path} on {device}...")
                    if target_type == "en":
                        _model = _load_local_en(local_model_path, device)
                    else:
                        _model = _load_local_mtl(local_model_path, device)
                else:
                    error_msg = f"Local model weights for '{target_type}' not found in the bundle at: {local_model_path}. Internet download fallback is disabled."
                    print(error_msg)
                    raise FileNotFoundError(error_msg)
                
                _model_type = target_type
                _model_state["status"] = "ready"
                _model_state["detail"] = "Model loaded successfully."
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
