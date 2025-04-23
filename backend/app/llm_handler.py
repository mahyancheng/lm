"""
Centralised Ollama helper.
"""
import os, traceback, ollama
from dotenv import load_dotenv

ENV_DIR = os.path.join(os.path.dirname(__file__), "..", ".env")
load_dotenv(ENV_DIR, override=True)

OLLAMA = os.getenv("OLLAMA_ENDPOINT", "http://localhost:11434")
PLANNING_TOOLING_MODEL = os.getenv("PLANNING_TOOLING_MODEL", "llama3:latest")
DEEPCODER_MODEL        = os.getenv("DEEPCODER_MODEL", "deepcoder:latest")

_client = ollama.Client(host=OLLAMA)

def _ensure(model: str):
    try:
        _client.pull(model)
    except Exception as e:
        print(f"[ollama] pull failed for {model}: {e}")

for _m in (PLANNING_TOOLING_MODEL, DEEPCODER_MODEL):
    _ensure(_m)

def chat(model: str, messages: list[dict]) -> str | None:
    try:
        return _client.chat(model=model, messages=messages)["message"]["content"]
    except Exception:
        traceback.print_exc(); return None

def simple_prompt(model: str, prompt: str, system: str | None = None):
    msgs = ([{"role": "system", "content": system}] if system else []) + \
           [{"role": "user", "content": prompt}]
    return chat(model, msgs)
