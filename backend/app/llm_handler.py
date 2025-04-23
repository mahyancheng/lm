# backend/app/llm_handler.py

import ollama
import os
from dotenv import load_dotenv
import traceback

# Load environment variables (looking for .env in backend/)
dotenv_path = os.path.join(os.path.dirname(__file__), '..', '.env')
load_dotenv(dotenv_path=dotenv_path)

# Model names (can be overridden via env)
PLANNING_TOOLING_MODEL      = os.getenv("PLANNING_TOOLING_MODEL",      "llama3:latest")
DEEPCODER_MODEL             = os.getenv("DEEPCODER_MODEL",             "deepcoder:latest")
BROWSER_AGENT_INTERNAL_MODEL= os.getenv("BROWSER_AGENT_INTERNAL_MODEL","qwen2.5:7b")
# === Corrected Default Ollama Base URL ===
OLLAMA_BASE_URL             = os.getenv("OLLAMA_ENDPOINT",             "http://localhost:11434")
# =========================================

# ======================================================================
#  MODEL LOADING
# ======================================================================
def load_model(model_name: str):
    """Pulls the given Ollama model from the configured host."""
    if not model_name:
        print("Warning: empty model name, skipping load.")
        return None
    try:
        # Use the corrected OLLAMA_BASE_URL here
        client = ollama.Client(host=OLLAMA_BASE_URL)
        print(f"Ensuring model '{model_name}' is available at {OLLAMA_BASE_URL}...")
        # This call uses the correct /api/pull endpoint relative to the host
        client.pull(model_name)
        print(f"Model '{model_name}' ready.")
        return model_name
    except ollama.ResponseError as e:
        print(f"[Ollama API Error] Pulling '{model_name}' (Status {e.status_code}): {e.error}")
        traceback.print_exc()
        return None
    except Exception as e:
        print(f"[Error] loading model '{model_name}': {e}")
        traceback.print_exc()
        return None

print("\n--- Loading LLM Models ---")
_models = {
    "planning":    load_model(PLANNING_TOOLING_MODEL),
    "deepcoder":   load_model(DEEPCODER_MODEL),
    "browser":     load_model(BROWSER_AGENT_INTERNAL_MODEL),
}
print("--- Model Loading Complete ---")
# Adjust check based on which models are strictly essential for startup
# For the primary workflow, planning is essential. Browser model is loaded by subprocess.
if not _models["planning"]:
    print(f"FATAL: Planning model '{PLANNING_TOOLING_MODEL}' failed to load. Check Ollama server at {OLLAMA_BASE_URL}")
# It's okay if browser model fails here, run_browser_task.py will handle its own loading.

# ======================================================================
#  PROMPT SENDING
# ======================================================================
def send_prompt(model_name: str, prompt: str, system_message: str = None) -> str:
    """
    Send `prompt` to Ollama `model_name`, optionally with a `system_message`.
    Returns the assistant's content, or None on failure.
    """
    # Check if model needs on-demand loading or if it failed startup loading
    key = None
    active_model_name = model_name # Use the provided model name
    if model_name == PLANNING_TOOLING_MODEL:       key = "planning"
    elif model_name == DEEPCODER_MODEL:            key = "deepcoder"
    # Browser model is handled separately in run_browser_task.py

    # If it's a pre-defined key, check if it loaded successfully at startup
    if key and not _models.get(key):
        print(f"[Error] Model '{model_name}' was configured but failed to load at startup.")
        # Decide if you want to attempt on-demand loading anyway or just fail
        # For now, let's attempt on-demand load
        if not load_model(model_name):
             print(f"[Error] On-demand load failed for {model_name}")
             return None
    # If it's not a pre-defined key, try loading on demand
    elif not key:
        if not load_model(model_name):
            print(f"[Error] Could not load model on demand: {model_name}")
            return None

    messages = []
    if system_message:
        messages.append({"role": "system",  "content": system_message})
    messages.append({"role": "user",    "content": prompt})

    try:
        # Use the corrected OLLAMA_BASE_URL here
        client   = ollama.Client(host=OLLAMA_BASE_URL)
        print(f"Sending prompt to '{active_model_name}'...")
        # This call uses the correct /api/chat endpoint relative to the host
        response = client.chat(model=active_model_name, messages=messages)

        msg = response.get("message") or {}
        content = msg.get("content")
        print(f"Received response from '{active_model_name}'.")
        return content
    except ollama.ResponseError as e:
        print(f"[Ollama API Error] Chatting with '{active_model_name}' (Status {e.status_code}): {e.error}")
        # traceback.print_exc() # Optional: full traceback
        return None
    except Exception as e:
        print(f"[Error] during Ollama chat with '{active_model_name}': {e}")
        traceback.print_exc()
        return None

def send_prompt_with_functions(model_name: str, prompt: str, system_message: str = None) -> str:
    """
    Alias for send_prompt — provided so agent.py can call it
    when using the JSON‑tool‐calling style. Currently, Ollama doesn't have
    native function calling like OpenAI, so this relies on the LLM
    generating the JSON correctly based on the prompt.
    """
    return send_prompt(model_name, prompt, system_message)