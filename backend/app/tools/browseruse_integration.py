# backend/app/tools/browseruse_integration.py
import asyncio
import subprocess
import json
import sys
import os
import traceback

PYTHON_EXECUTABLE = sys.executable
TOOLS_DIR = os.path.dirname(__file__)
HELPER_SCRIPT_PATH = os.path.abspath(os.path.join(TOOLS_DIR, "..", "..", "run_browser_task.py"))

print(f"Browser integration script will call: {HELPER_SCRIPT_PATH}")

async def close_browser_context(): pass # Handled by subprocess
async def close_browser_instance(): pass # Handled by subprocess

async def browse_website(instructions: str, websocket) -> str:
    """Launches run_browser_task.py in a separate process."""
    await websocket.send_text(f"Agent: Preparing isolated browser task...")
    print(f"Attempting isolated browser action via subprocess: {instructions}")

    if not os.path.exists(HELPER_SCRIPT_PATH):
         error_msg = f"Error: Helper script not found at {HELPER_SCRIPT_PATH}"
         await websocket.send_text(f"Agent Error: {error_msg}"); print(error_msg); return error_msg

    try:
        input_data = json.dumps({"instructions": instructions})
        process_env = {**os.environ, 'PYTHONIOENCODING': 'utf-8'} # Force UTF-8
        cmd = [PYTHON_EXECUTABLE, HELPER_SCRIPT_PATH, input_data]

        await websocket.send_text(f"Agent: Launching browser subprocess...")
        print(f"Running subprocess command: {' '.join(cmd)}")
        loop = asyncio.get_running_loop()
        timeout_seconds = 240.0

        process = await loop.run_in_executor(None, lambda: subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_seconds, check=False, encoding='utf-8', env=process_env))

        stdout = process.stdout.strip() if process.stdout else ""
        stderr = process.stderr.strip() if process.stderr else ""
        exit_code = process.returncode

        print(f"Subprocess finished. Exit Code: {exit_code}")
        if stderr: print(f"--- Subprocess STDERR Start ---\n{stderr}\n--- Subprocess STDERR End ---")
        if stdout: print(f"--- Subprocess STDOUT Start (Should ONLY be JSON) ---\n{stdout}\n--- Subprocess STDOUT End ---")

        if exit_code != 0: error_msg = f"Browser subprocess failed (Exit Code {exit_code}). Check STDERR in logs."; await websocket.send_text(f"Agent Error: {error_msg}"); print(error_msg + f" STDERR: {stderr[:500]}..."); return error_msg
        try:
             if not stdout: error_msg = "Browser subprocess finished successfully but produced no output (stdout)."; await websocket.send_text("Agent Error: Browser process gave no result."); print(error_msg); return error_msg
             result_data = json.loads(stdout)
             if "error" in result_data: error_msg = f"Browser subprocess reported error: {result_data['error']}"; await websocket.send_text(f"Agent Error: {error_msg[:200]}..."); print(error_msg); return error_msg
             final_result = result_data.get("result", "Subprocess finished, no 'result' key."); print(f"Browser action final result (from subprocess): {final_result[:200]}..."); await websocket.send_text(f"Agent: Browser action completed."); return final_result
        except json.JSONDecodeError: error_msg = f"Browser subprocess finished successfully (Exit 0), but failed to decode JSON result from stdout."; detailed_error = f"{error_msg} Raw stdout: {stdout}"; await websocket.send_text(f"Agent Error: {error_msg}"); print(detailed_error); return detailed_error
        except Exception as e: error_msg = f"Error processing browser subprocess output: {e}. Raw stdout: {stdout}"; await websocket.send_text("Agent Error: Error processing browser result."); print(error_msg); traceback.print_exc(); return error_msg
    except subprocess.TimeoutExpired: error_msg = f"Error: Browser subprocess timed out."; await websocket.send_text(f"Agent Error: {error_msg}"); print(error_msg); return error_msg
    except Exception as e: error_msg = f"Error launching browser subprocess: {e}"; await websocket.send_text(f"Agent Error: {error_msg}"); print(error_msg); traceback.print_exc(); return f"Error performing browser action: {e}"
