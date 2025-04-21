# backend/app/llm_handler.py
import ollama
import os
from dotenv import load_dotenv
import traceback

# Load .env file - Docker Compose passes env vars, but this helps local running
dotenv_path = os.path.join(os.path.dirname(__file__), '..', '.env') # Assumes .env in backend/
load_dotenv(dotenv_path=dotenv_path)

# Use environment variables or defaults
PLANNING_TOOLING_MODEL = os.getenv("PLANNING_TOOLING_MODEL", "llama3:latest")
DEEPCODER_MODEL = os.getenv("DEEPCODER_MODEL", "deepcoder:latest")
BROWSER_AGENT_INTERNAL_MODEL = os.getenv("BROWSER_AGENT_INTERNAL_MODEL", "qwen2.5:7b")
# Crucial: Read the endpoint set by Docker Compose or default for local
OLLAMA_BASE_URL = os.getenv("OLLAMA_ENDPOINT", "http://localhost:11434")

# --- Model Loading ---
def load_model(model_name: str):
    """Ensures a model is available locally via Ollama, using the configured host."""
    if not model_name:
        print("Warning: Empty model name skipped.")
        return None
    try:
        # *** Explicitly create a client with the correct host ***
        client = ollama.Client(host=OLLAMA_BASE_URL)
        print(f"Ensuring model '{model_name}' is available at {OLLAMA_BASE_URL}...")
        # *** Use the client instance to pull ***
        client.pull(model_name)
        print(f"Model '{model_name}' is ready.")
        return model_name
    except ollama.ResponseError as e:
        # Catch specific Ollama errors if possible
        print(f"Error Ollama API for '{model_name}' (Status: {e.status_code}): {e.error}")
        traceback.print_exc(); return None
    except Exception as e:
        print(f"Error loading '{model_name}' from {OLLAMA_BASE_URL}: {e}")
        traceback.print_exc(); return None

print("\n--- Loading LLM Models ---")
# Load models sequentially at startup
models_loaded = {
    "planning": load_model(PLANNING_TOOLING_MODEL),
    "deepcoder": load_model(DEEPCODER_MODEL),
    "browser_agent": load_model(BROWSER_AGENT_INTERNAL_MODEL)
}
print("--- Model Loading Complete ---")
if not models_loaded["planning"] or not models_loaded["browser_agent"]:
     print("\nFATAL: Essential planning or browser agent LLM failed load.")
     print(f"Ensure Ollama running at {OLLAMA_BASE_URL} & models pulled.")
     # In a real app, might raise an exception or prevent startup here

# --- Prompt Sending ---
def send_prompt(model_name: str, prompt: str, system_message: str = None):
    """Sends a prompt to the specified Ollama model and returns the response content."""
    model_key = None
    if model_name == PLANNING_TOOLING_MODEL: model_key = "planning"
    elif model_name == DEEPCODER_MODEL: model_key = "deepcoder"
    elif model_name == BROWSER_AGENT_INTERNAL_MODEL: model_key = "browser_agent"

    # Check if the specific model needed was loaded successfully
    if model_key and not models_loaded.get(model_key):
        print(f"Error: Model '{model_name}' (key: {model_key}) was not loaded successfully at startup.")
        return None
    elif not model_key: # If not a preloaded model, try loading now
        # This might fail if called concurrently, safer to preload all needed models
        if not load_model(model_name):
             print(f"Error: Model '{model_name}' could not be loaded on demand.")
             return None

    messages = []
    if system_message: messages.append({'role': 'system', 'content': system_message})
    messages.append({'role': 'user', 'content': prompt})
    try:
        # *** Explicitly create a client with the correct host ***
        client = ollama.Client(host=OLLAMA_BASE_URL)
        print(f"Sending prompt to model '{model_name}' at {OLLAMA_BASE_URL}...");
        response = client.chat(model=model_name, messages=messages)
        print(f"Raw response from '{model_name}': {str(response)[:500]}...")
        if response and 'message' in response and 'content' in response['message']:
             content = response['message']['content']; print(f"Received content from '{model_name}'."); return content
        else: print(f"Unexpected response structure: {response}"); return None
    except ollama.ResponseError as e: print(f"Error Ollama API '{model_name}' (Status: {e.status_code}): {e.error}"); return None
    except Exception as e: print(f"Unexpected error Ollama chat '{model_name}': {e}"); traceback.print_exc(); return None
