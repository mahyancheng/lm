"""
browseruse_integration.py
─────────────────────────
Utility that launches `run_browser_task.py` in a separate Python
process so an LLM can drive Playwright through the Browser-Use library.

Public coroutine
----------------
    browse_website(user_instruction: str,
                   websocket,
                   *,
                   browser_model: str | None = None,
                   context_hint: str | None = None) -> str
Returns the final summary string from the isolated browser task, or an
error string starting with “Error: …”.
"""

from __future__ import annotations
import asyncio
import json
import os
import subprocess
import sys
import traceback

# paths
PYTHON = sys.executable
RUNNER = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "run_browser_task.py")
)

print(f"[browser-use] helper path: {RUNNER}")

# ───────────────────────────────────────────────── prompt helper
def _build_prompt(user_instruction: str, context_hint: str | None = None) -> str:
    """
    Adds a concise system header so the LLM knows it is
    inside an isolated browser agent and should be brief.
    """
    header = (
        "You are running INSIDE an isolated browser tool. "
        "Control Chromium through Browser-Use. "
        "Operate efficiently (≈15 actions max). "
        "When finished, summarise clearly in plain text or JSON.\n"
    )
    if context_hint:
        header += f"\nContext from previous steps:\n{context_hint}\n"
    return header + "\n--- USER TASK ---\n" + user_instruction.strip()

# ───────────────────────────────────────────────── subprocess helper
async def _run_subprocess(cmd: list[str], timeout: float):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None,
        lambda: subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        ),
    )

# ───────────────────────────────────────────────── public coroutine
async def browse_website(
    user_instruction: str,
    websocket,
    *,
    browser_model: str | None = None,
    context_hint: str | None = None,
) -> str:
    """
    Launch an isolated browser subprocess and return its final result.
    """
    if not os.path.exists(RUNNER):
        err = f"Error: helper script not found at {RUNNER}"
        await websocket.send_text(f"Agent Error: {err}")
        return err

    instructions = _build_prompt(user_instruction, context_hint)
    model = browser_model or os.getenv("BROWSER_AGENT_INTERNAL_MODEL", "qwen2.5:7b")

    await websocket.send_text("Agent: launching browser subprocess…")

    payload = json.dumps({"instructions": instructions, "model": model})
    cmd = [PYTHON, RUNNER, payload]

    try:
        proc = await _run_subprocess(cmd, timeout=240.0)
    except subprocess.TimeoutExpired:
        await websocket.send_text(
            "Agent Error: browser subprocess hard-timeout (240 s)."
        )
        return "Error: browser subprocess exceeded 240 s."

    stdout = (proc.stdout or "").strip()
    stderr = (proc.stderr or "").strip()

    if proc.returncode != 0:
        await websocket.send_text(
            f"Agent Error: browser subprocess exit {proc.returncode}"
        )
        if stderr:
            print(f"[browser-stderr]\n{stderr}\n")
        return f"Error: browser subprocess exit {proc.returncode}."

    # decode stdout JSON
    try:
        result = json.loads(stdout or "{}")
    except json.JSONDecodeError:
        await websocket.send_text("Agent Error: malformed JSON from browser task.")
        print(f"[browser-stdout]\n{stdout}\n")
        return "Error: browser task returned malformed JSON."

    if "error" in result:
        await websocket.send_text(f"Agent Error: {result['error'][:200]}")
        return f"Error: {result['error']}"

    await websocket.send_text("Agent: browser action completed.")
    return result.get("result", "Browser task finished (no result key).")
