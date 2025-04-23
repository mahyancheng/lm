from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import subprocess, json, os

from .llm_handler import simple_prompt, PLANNING_TOOLING_MODEL

router = APIRouter()

# ——— list local ollama models ——————————————————————————
@router.get("/models")
def list_models():
    try:
        out = subprocess.check_output(["ollama", "list", "--json"],
                                      text=True, env=os.environ)
        names = [m["name"] for m in json.loads(out)]
        return {"models": names}
    except Exception as e:
        return {"error": str(e), "models": [PLANNING_TOOLING_MODEL]}

# ——— minimal chat (HTTP) ——————————————————————————————
class ChatInput(BaseModel):
    query: str
    model: str | None = None

@router.post("/chat")
async def chat(inp: ChatInput):
    model = inp.model or PLANNING_TOOLING_MODEL
    ans = simple_prompt(model, inp.query)
    if ans is None:
        raise HTTPException(500, "LLM failure")
    return {"response": ans}
