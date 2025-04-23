import subprocess
import shlex
import asyncio
import traceback

# Whitelist expanded to permit pip/python for runtime installs
ALLOWED_COMMANDS = {
    'ls', 'pwd', 'echo', 'cat', 'grep', 'mkdir', 'rmdir',
    'touch', 'head', 'tail', 'date',
    'python', 'python3', 'pip', 'pip3'
}
TIMEOUT_SECONDS = 15

async def execute_shell_command(full_command: str, websocket) -> str:
    """
    Safely execute whitelisted shell commands (including pip/python).
    """
    await websocket.send_text(f"Agent: Preparing shell command: {full_command[:50]}...")
    print(f"Attempting shell command: {full_command}")

    # 1) Parse & validate
    try:
        cmd_parts = shlex.split(full_command)
    except ValueError as e:
        err = f"Error parsing command: {e}"
        await websocket.send_text(f"Agent Error: {err}")
        print(err)
        return err

    if not cmd_parts:
        await websocket.send_text("Agent Error: Empty command.")
        return "Error: Empty command."

    cmd, args = cmd_parts[0], cmd_parts[1:]
    if cmd not in ALLOWED_COMMANDS:
        err = f"Error: Command '{cmd}' not allowed."
        await websocket.send_text(f"Agent Error: {err}")
        print(err)
        return err

    # 2) Sanitize args
    for arg in args:
        if not all(c.isalnum() or c in (' ', '-', '_', '.', '/', ':') for c in arg) or '..' in arg:
            if any(c in arg for c in ";|&`$()<>*?[]{}!\\"):
                err = f"Error: Unsafe argument '{arg}'"
                await websocket.send_text(f"Agent Error: {err}")
                print(err)
                return err

    # 3) Execute
    try:
        cmd_exec = [cmd] + args
        await websocket.send_text(f"Agent: Running: {' '.join(cmd_exec)}")
        print(f"Executing: {cmd_exec}")

        loop = asyncio.get_running_loop()
        proc = await loop.run_in_executor(
            None,
            lambda: subprocess.run(
                cmd_exec,
                capture_output=True,
                text=True,
                timeout=TIMEOUT_SECONDS,
                shell=False
            )
        )

        code = proc.returncode
        out, err_out = proc.stdout or "", proc.stderr or ""
        print(f"Shell finished: exit={code}")

        result = f"Exit Code: {code}\n"
        if out:
            result += f"Output:\n{out}\n"
        if err_out:
            result += f"Errors:\n{err_out}\n"

        await websocket.send_text(f"Agent: Shell finished (Exit: {code}).")
        return result.strip()

    except subprocess.TimeoutExpired:
        tm_err = f"Error: Timeout after {TIMEOUT_SECONDS}s."
        await websocket.send_text(f"Agent Error: {tm_err}")
        print(tm_err)
        return tm_err

    except FileNotFoundError:
        not_found = f"Error: Command '{cmd}' not found."
        await websocket.send_text(f"Agent Error: {not_found}")
        print(not_found)
        return not_found

    except PermissionError as e:
        perm_err = f"Error: Permission denied for '{cmd}': {e}"
        await websocket.send_text(f"Agent Error: {perm_err}")
        print(perm_err)
        return perm_err

    except Exception as e:
        exc = f"Error executing shell '{full_command}': {e}"
        await websocket.send_text(f"Agent Error: {exc}")
        print(exc)
        traceback.print_exc()
        return exc
