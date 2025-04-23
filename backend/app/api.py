from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import json, os

from .llm_handler import simple_prompt, PLANNING_TOOLING_MODEL, list_local_models

router = APIRouter()

# ─── list local ollama models (pure JSON, no CLI) ────────────────
@router.get("/models")
def list_models():
    return {"models": list_local_models()}

# ─── minimal chat (HTTP) ─────────────────────────────────────────
class ChatInput(BaseModel):
    query: str
    model: str | None = None

@router.post("/chat")
async def chat(inp: ChatInput):
    model = inp.model or PLANNING_TOOLING_MODEL
    ans   = simple_prompt(model, inp.query)
    if ans is None:
        raise HTTPException(500, "LLM failure")
    return {"response": ans}
