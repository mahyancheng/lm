import asyncio, json, traceback, sys, os
from pathlib import Path
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.routing import APIRouter

from .agent import handle_agent_workflow
from .api import router as api_router

print(f"Python: {sys.executable}")
print(f"Asyncio policy: {type(asyncio.get_event_loop_policy()).__name__}")

app = FastAPI(title="Local AI Agent Backend")
app.include_router(api_router, prefix="/api")

# ——— WebSocket ————————————————————————————————————————————
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    planner_model   = os.getenv("PLANNING_TOOLING_MODEL", "llama3:latest")
    browser_model   = os.getenv("BROWSER_AGENT_INTERNAL_MODEL", "qwen2.5:7b")

    try:
        while True:
            msg = await ws.receive_text()
            try:
                data = json.loads(msg)
                user_query    = data.get("query", "")
                planner_model = data.get("model", planner_model)
                browser_model = data.get("browser_model", browser_model)

                if not user_query:
                    await ws.send_text("Agent Error: Empty query."); continue

                # expose chosen browser model to subprocess via env var
                os.environ["BROWSER_AGENT_INTERNAL_MODEL"] = browser_model
                await handle_agent_workflow(user_query, planner_model, ws)

            except json.JSONDecodeError:
                await ws.send_text("Agent Error: Invalid JSON.")

    except WebSocketDisconnect:
        print("client disconnect")
    except Exception as e:
        traceback.print_exc()
        try: await ws.send_text(f"Agent Error: {e}")
        except: pass
    finally:
        try: await ws.close()
        except: pass

# ——— static frontend ————————————————————————————————
ROOT = Path(__file__).parent.parent   # /app
FRONTEND = ROOT / "frontend"
if FRONTEND.is_dir():
    app.mount("/", StaticFiles(directory=str(FRONTEND), html=True), name="static")
else:
    @app.get("/")
    def placeholder():
        return {"msg": "frontend not found"}
