# backend/app/main.py (FastAPI Version)
import sys
import asyncio
import os
from pathlib import Path  # Use pathlib for robust path handling

print(f"--- FastAPI running with Python: {sys.executable} ---")
print(f"--- Using default asyncio policy: {type(asyncio.get_event_loop_policy()).__name__} ---")

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.routing import APIRouter
from fastapi.staticfiles import StaticFiles
import json
import traceback

# --- Import Agent Logic ---
try:
    from .agent import handle_agent_workflow
    print("Agent components imported successfully.")
    AGENT_AVAILABLE = True
except ImportError as e:
    print(f"ERROR: Failed to import agent components from '.agent' : {e}")
    traceback.print_exc()
    AGENT_AVAILABLE = False
except Exception as e:
    print(f"ERROR: Unexpected error during agent import: {e}")
    traceback.print_exc()
    AGENT_AVAILABLE = False

app = FastAPI(title="Local AI Agent Backend")

api_router = APIRouter()

@api_router.get("/health")
async def health_check():
    return {"status": "ok", "agent_available": AGENT_AVAILABLE}

app.include_router(api_router, prefix="/api")

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """Handles WebSocket connections for FastAPI."""
    await websocket.accept()
    print(f"Client connected: {websocket.client}")
    selected_model = "qwen2.5:32b-instruct"
    if not AGENT_AVAILABLE:
        await websocket.send_text("Agent Error: Backend agent components failed.")
        await websocket.close(code=1011)
        return
    try:
        while True:
            data = await websocket.receive_text()
            try:
                message_data = json.loads(data)
                user_query = message_data.get("query")
                newly_selected_model = message_data.get("model", selected_model)
                if newly_selected_model != selected_model:
                    selected_model = newly_selected_model
                    print(f"Client set model: {selected_model}")
                if user_query:
                    print(f"Query: '{user_query}' (Review: {selected_model})")
                    await handle_agent_workflow(user_query, selected_model, websocket)
                else:
                    await websocket.send_text("Agent Error: Empty query.")
            except json.JSONDecodeError:
                await websocket.send_text("Agent Error: Invalid JSON.")
                print(f"Invalid data: {data}")
            except WebSocketDisconnect:
                print("Client disconnected during processing.")
                break
            except Exception as e:
                error_msg = f"Agent Error: Processing error: {e}"
                print(f"Error: {e}")
                traceback.print_exc()
                try:
                    await websocket.send_text(error_msg)
                except Exception:
                    pass
    except WebSocketDisconnect:
        print(f"Client disconnected: {websocket.client}")
    except Exception as e:
        print(f"WebSocket Error: {e}")
        traceback.print_exc()
    finally:
        print(f"Closing connection: {websocket.client}")
        try:
            await websocket.close(code=1000)
        except Exception:
            pass

# --- Serve Frontend Static Files ---
# Inside the container, WORKDIR is /app and frontend is located at /app/frontend
# Relative to this script (in /app/app/) the correct path is ../frontend.
script_dir = Path(__file__).parent  # /app/app/
app_dir = script_dir.parent         # /app/
frontend_dir = app_dir / "frontend"   # /app/frontend/

if frontend_dir.is_dir():
    print(f"Attempting to serve static files from container path: {frontend_dir}")
    try:
        app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="static")
        print("Frontend static files mounted successfully at root '/'. Access via http://localhost:8000/")
    except Exception as e:
        print(f"Error mounting static files: {e}")
        @app.get("/")
        async def read_root_fallback():
            return {"message": "Backend running, couldn't mount frontend."}
else:
    print(f"Frontend directory not found at container path: {frontend_dir}")
    @app.get("/")
    async def read_root_no_frontend():
        return {"message": "Backend running. Frontend directory not found."}
