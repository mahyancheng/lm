import subprocess
import tempfile
import os
import asyncio
import traceback
import sys
import re

TIMEOUT_SECONDS = 30

async def execute_python_code_subprocess(code: str, websocket) -> str:
    """
    Executes Python code in a subprocess.
    On ModuleNotFoundError, auto-installs the missing package via pip and retries.
    """
    # 1) Write to temp file
    with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False, encoding='utf-8') as tmp:
        script_path = tmp.name
        tmp.write(code)

    def run_script():
        return subprocess.run(
            [sys.executable, script_path],
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS
        )

    try:
        await websocket.send_text(f"Agent: Running Python script {os.path.basename(script_path)}...")
        print(f"Executing code file: {script_path}")

        loop = asyncio.get_running_loop()
        proc = await loop.run_in_executor(None, run_script)

        out, err = proc.stdout or "", proc.stderr or ""
        code_ret = proc.returncode
        result = f"Exit Code: {code_ret}\n"
        if out:
            result += f"Output:\n{out}\n"
        if err:
            result += f"Errors:\n{err}\n"

        # 2) Auto-install on missing module
        if code_ret != 0 and "ModuleNotFoundError: No module named" in err:
            missing = re.search(r"No module named ['\"](.+?)['\"]", err)
            if missing:
                pkg = missing.group(1)
                await websocket.send_text(f"Agent: Installing missing package '{pkg}'...")
                print(f"Auto-installing: {pkg}")
                subprocess.run([sys.executable, '-m', 'pip', 'install', pkg], check=False)

                # Retry
                proc2 = await loop.run_in_executor(None, run_script)
                out2, err2 = proc2.stdout or "", proc2.stderr or ""
                code2 = proc2.returncode
                retry_res = f"After install -> Exit Code: {code2}\n"
                if out2:
                    retry_res += f"Output:\n{out2}\n"
                if err2:
                    retry_res += f"Errors:\n{err2}\n"
                return retry_res.strip()

        return result.strip()

    except subprocess.TimeoutExpired:
        timeout_msg = f"Error: Python execution timed out after {TIMEOUT_SECONDS}s."
        await websocket.send_text(f"Agent Error: {timeout_msg}")
        print(timeout_msg)
        return timeout_msg

    except FileNotFoundError:
        fnf = "Error: Python interpreter not found."
        await websocket.send_text(f"Agent Error: {fnf}")
        print(fnf)
        return fnf

    except Exception as e:
        exc = f"Error executing Python code: {e}"
        await websocket.send_text(f"Agent Error: {exc}")
        print(exc)
        traceback.print_exc()
        return exc

    finally:
        # 3) Cleanup
        try:
            os.remove(script_path)
        except OSError:
            pass

async def execute_python_code(code: str, websocket) -> str:
    return await execute_python_code_subprocess(code, websocket)
