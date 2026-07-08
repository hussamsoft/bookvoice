import os
import asyncio
import edge_tts
import subprocess
import shutil

async def generate_voice(voice_id, name, text):
    communicate = edge_tts.Communicate(text, voice_id)
    mp3_path = os.path.join("data", "voices", f"{name}.mp3")
    wav_path = os.path.join("data", "voices", f"{name}.wav")
    default_wav_path = os.path.join("data", "default_voices", f"{name}.wav")
    
    await communicate.save(mp3_path)
    
    try:
        # Convert to WAV using ffmpeg at 24kHz mono (best for TTS prompt)
        subprocess.run(["ffmpeg", "-y", "-i", mp3_path, "-ac", "1", "-ar", "24000", wav_path], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shutil.copy2(wav_path, default_wav_path)
        print(f"Successfully generated {name}")
    except Exception as e:
        print(f"Failed to convert {name} using ffmpeg: {e}")
    finally:
        if os.path.exists(mp3_path):
            os.remove(mp3_path)

async def main():
    os.makedirs(os.path.join("data", "voices"), exist_ok=True)
    os.makedirs(os.path.join("data", "default_voices"), exist_ok=True)
    
    voices = [
        ("en-US-AriaNeural", "Aria", "Hi there, my name is Aria. I can read your favorite books with a smooth, expressive voice."),
        ("en-GB-RyanNeural", "Ryan", "Greetings, my name is Ryan. I have a professional British voice suitable for long reading sessions."),
        ("en-GB-SoniaNeural", "Sonia", "Hello, I am Sonia. I will be your narrator for this book. I hope you enjoy listening."),
        ("en-US-GuyNeural", "Guy", "Hello, I'm Guy. Let's dive into some great stories together."),
        ("en-AU-NatashaNeural", "Natasha", "Hi, I'm Natasha, an Australian voice. I love reading adventures and mysteries."),
        ("en-US-ChristopherNeural", "Christopher", "Hi, I'm Christopher. I have a deep and relaxing voice, perfect for storytelling."),
    ]
    for v_id, name, text in voices:
        print(f"Generating {name}...")
        await generate_voice(v_id, name, text)

if __name__ == "__main__":
    asyncio.run(main())
