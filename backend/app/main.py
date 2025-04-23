"""
main.py ─ FastAPI application entry-point
──────────────────────────────────────────
•   Serves   /api/*   JSON endpoints
•   Serves   /ws      WebSocket for live chat
•   Mounts   static   frontend
"""

from __future__ import annotations
import asyncio, json, os, sys, traceback
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from .api   import router as api_router
from .agent import handle_agent_workflow
from .llm_handler import (
    PLANNING_TOOLING_MODEL,
    DEEPCODER_MODEL,
)

print(f"Python: {sys.executable}")
print(f"Asyncio policy: {type(asyncio.get_event_loop_policy()).__name__}")

app = FastAPI(title="Local AI Agent Backend")
app.include_router(api_router, prefix="/api")

# ─────────────────────────── WebSocket chat ────────────────────────────
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()

    # runtime defaults – will be overwritten by first client message
    planner_model = PLANNING_TOOLING_MODEL
    browser_model = os.getenv("BROWSER_AGENT_INTERNAL_MODEL", "qwen2.5:7b")
    code_model    = os.getenv("DEEPCODER_MODEL",              "deepcoder:latest")

    try:
        while True:
            raw = await ws.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_text("Agent Error: invalid JSON payload.")
                continue

            # new key names coming from frontend
            user_query    = data.get("query", "")
            planner_model = data.get("planner_model", planner_model)
            browser_model = data.get("browser_model", browser_model)
            code_model    = data.get("code_model",    code_model)

            if not user_query:
                await ws.send_text("Agent Error: empty query.")
                continue

            # expose chosen tool-specific models to sub-processes
            os.environ["BROWSER_AGENT_INTERNAL_MODEL"] = browser_model
            os.environ["DEEPCODER_MODEL"]              = code_model

            await handle_agent_workflow(user_query, planner_model, ws)

    except WebSocketDisconnect:
        # client closed tab / refreshed – nothing to do
        pass
    except Exception as e:
        traceback.print_exc()
        try:
            await ws.send_text(f"Agent Error: {e}")
        except Exception:
            pass
    finally:
        try:
            await ws.close()
        except Exception:
            pass


# ──────────────────────── serve static frontend  ───────────────────────
ROOT      = Path(__file__).parent.parent   # /app
FRONTEND  = ROOT / "frontend"

if FRONTEND.is_dir():
    app.mount("/", StaticFiles(directory=str(FRONTEND), html=True), name="static")
else:
    @app.get("/")
    def frontend_missing():
        return {"msg": "frontend directory not found in image"}
