"""
llm_handler.py
──────────────
Centralised helpers for talking to a local Ollama server.

✓ Lists local models via the Ollama **HTTP API** (no CLI required)
✓ Falls back to `ollama list --json` if the REST endpoint is unreachable
✓ Auto-pulls a model the first time it is requested
✓ Exposes helpers used by the rest of the backend
"""
from __future__ import annotations

import http.client, json, os, ssl, subprocess, traceback, urllib.parse, shutil
from typing import Dict, List

import ollama
from dotenv import load_dotenv

# ─── env / defaults ──────────────────────────────────────────────
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"), override=True)

OLLAMA                 = os.getenv("OLLAMA_ENDPOINT", "http://localhost:11434")
PLANNING_TOOLING_MODEL = os.getenv("PLANNING_TOOLING_MODEL", "llama3:latest")
DEEPCODER_MODEL        = os.getenv("DEEPCODER_MODEL",        "deepcoder:latest")

_client = ollama.Client(host=OLLAMA)

# ──────────────────────────────────────────────────────────────────
# 1) minimal HTTP helper that avoids the `context` kwarg on plain HTTP
# -----------------------------------------------------------------
def _http_json(method: str, path: str, body: Dict | None = None) -> Dict:
    url  = urllib.parse.urlparse(OLLAMA)
    port = url.port or (443 if url.scheme == "https" else 80)

    if url.scheme == "https":
        conn = http.client.HTTPSConnection(
            url.hostname,
            port,
            context=ssl._create_unverified_context()      # accept self-signed
        )
    else:
        conn = http.client.HTTPConnection(url.hostname, port)

    conn.request(
        method, path, json.dumps(body or {}),
        {"Content-Type": "application/json"},
    )
    res  = conn.getresponse()
    data = res.read().decode()
    conn.close()
    return json.loads(data)

# ─── 2) discover local models ────────────────────────────────────
def list_local_models() -> List[str]:
    """
    Returns e.g.  ["llama3:latest", "qwen2.5:7b", …]
    """
    # preferred: REST
    try:
        resp = _http_json("GET", "/api/tags")
        out: List[str] = [
            m.get("model") or m.get("name")
            for m in resp.get("models", [])
            if (m.get("model") or m.get("name"))
        ]
        if out:
            return sorted(set(out))
    except Exception as e:
        print(f"[ollama] REST discovery failed: {e} – falling back to CLI")

    # fallback: CLI
    try:
        if not shutil.which("ollama"):
            raise FileNotFoundError("ollama CLI not found in PATH")

        raw = subprocess.check_output(
            ["ollama", "list", "--json"], text=True
        )
        # one JSON object PER LINE
        names = [
            json.loads(line)["name"]
            for line in raw.splitlines()
            if line.strip()
        ]
        return sorted(set(names))

    except Exception as e2:
        print(f"[ollama] CLI fallback failed: {e2}")
        return []          # fail-soft → empty dropdowns

# ─── 3) small wrappers used by the rest of the app ───────────────
def _ensure(model: str):
    try:
        _client.pull(model)
    except Exception as e:
        print(f"[ollama] pull failed for {model}: {e}")

for _m in (PLANNING_TOOLING_MODEL, DEEPCODER_MODEL):
    _ensure(_m)

def chat(model: str, messages: List[Dict]) -> str | None:
    try:
        return _client.chat(model=model, messages=messages)["message"]["content"]
    except Exception:
        traceback.print_exc()
        return None

def simple_prompt(model: str, prompt: str, system: str | None = None):
    msgs = ([{"role": "system", "content": system}] if system else []) + [
        {"role": "user", "content": prompt}
    ]
    return chat(model, msgs)

# Back-compat helpers
send_prompt                = simple_prompt
send_prompt_with_functions = simple_prompt
