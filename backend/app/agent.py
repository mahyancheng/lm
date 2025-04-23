# backend/app/agent.py

import os
import datetime
import asyncio
import traceback
import json
import re
import time # Import time for potential delays if needed

# Attempt to import json_repair, warn if not available
try:
    from json_repair import repair_json
    JSON_REPAIR_AVAILABLE = True
except ImportError:
    JSON_REPAIR_AVAILABLE = False
    print("Warning: 'json-repair' library not found. Run 'pip install json-repair' for better JSON parsing robustness.")
    def repair_json(s): # Define a dummy function if library is missing
        return s # Just return the original string

from .prompt_template import SYSTEM_PROMPT
from .llm_handler import (
    simple_prompt,          # ← replacement for send_prompt
    chat,                   # ← replacement for send_prompt_with_functions
    PLANNING_TOOLING_MODEL,
    DEEPCODER_MODEL
)

from .tools.shell_terminal         import execute_shell_command         as execute_shell_command_impl
from .tools.code_interpreter       import execute_python_code          as execute_python_code_impl
from .tools.browseruse_integration import browse_website               as browse_website_impl

# -------------------------------------------------------------------
# Configuration
# -------------------------------------------------------------------
TASK_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "tasks"))
os.makedirs(TASK_DIR, exist_ok=True)
MAX_RETRIES = 2
# Overall workflow step limit
MAX_WORKFLOW_STEPS = 10  # <<< SET YOUR DESIRED OVERALL STEP LIMIT HERE
# Suggestion for the browser agent's internal step limit (adjust as needed)
BROWSER_STEP_LIMIT_SUGGESTION = 15
# -------------------------------------------------------------------

# -------------------------------------------------------------------
# Helper: Send Task List Update
# -------------------------------------------------------------------
async def send_task_update(websocket, tasks_with_status):
    """Formats tasks with status and sends via WebSocket."""
    # tasks_with_status should be a list of dicts:
    # [{'description': '...', 'status': 'pending|running|done|error'}, ...]
    try:
        # Ensure keys expected by frontend are present
        tasks_for_ui = [
            {"description": t.get("description", "Unnamed Task"), "status": t.get("status", "pending")}
            for t in tasks_with_status
        ]
        payload = json.dumps(tasks_for_ui)
        await websocket.send_text(f"Agent Task Update:{payload}")
        # print(f"DEBUG: Sent task update: {payload}") # Optional debug
    except Exception as e:
        print(f"Error sending task update: {e}")
        try:
            # Try to inform the client about the failure
            await websocket.send_text(f"Agent Error: Failed to send task list update to UI.")
        except:
             pass # Ignore error if websocket is already closed

# -------------------------------------------------------------------
# Step 0: Parse the JSON plan produced by the LLM
# -------------------------------------------------------------------
def parse_plan(plan_json: str):
    """
    Parse the LLM's plan JSON into a list of task dicts.
    Attempts to repair JSON before parsing.
    Raises if invalid JSON or unexpected format.
    Returns a list of dictionaries, e.g., [{'tool': 'shell', 'command': ['ls']}]
    """
    original_plan_json = plan_json # Keep original for error messages
    try:
        # Clean potential markdown code fences first
        plan_json_cleaned = re.sub(r'^```json\s*|\s*```$', '', plan_json, flags=re.MULTILINE | re.DOTALL).strip()
        if not plan_json_cleaned:
             raise ValueError("Received empty plan after cleaning.")

        repaired_json_string = ""
        parsed_plan = None
        try:
            # Attempt to repair the JSON string first (if library available)
            repaired_json_string = repair_json(plan_json_cleaned)
            parsed_plan = json.loads(repaired_json_string)
        except Exception as repair_or_load_error:
            print(f"Warning: Failed to parse potentially repaired JSON ({repair_or_load_error}). Falling back to original.")
            # Fallback: try parsing the cleaned original string directly
            try:
                 parsed_plan = json.loads(plan_json_cleaned)
            except json.JSONDecodeError as final_decode_error:
                 # Raise the more informative error if both fail
                 error_detail = f"Invalid JSON plan received (JSONDecodeError: {final_decode_error})"
                 if repaired_json_string and repaired_json_string != plan_json_cleaned:
                      error_detail += f"\nRepair attempt output (may be invalid):\n{repaired_json_string[:500]}..." # Show snippet of repair attempt
                 raise ValueError(error_detail) from final_decode_error

        if parsed_plan is None: # Should not happen if exceptions are caught, but safeguard
             raise ValueError("Failed to parse JSON plan after cleaning and repair attempts.")

        # ===>>> Rest of the validation logic remains the same <<<===
        if not isinstance(parsed_plan, list):
             if isinstance(parsed_plan, dict) and all(k in parsed_plan for k in ['tool', 'description']):
                 print("Warning: LLM returned a single task dict, wrapping in a list.")
                 parsed_plan = [parsed_plan]
             else:
                 raise ValueError("Plan is not a list of tasks.")

        validated_tasks = []
        for idx, task in enumerate(parsed_plan):
             if not isinstance(task, dict):
                 raise ValueError(f"Item at index {idx} in plan is not a dictionary: {task}")
             if 'tool' not in task:
                 raise ValueError(f"Task at index {idx} is missing 'tool' key: {task}")
             # Ensure description exists, provide a default if missing
             if 'description' not in task or not task.get('description'):
                 print(f"Warning: Task at index {idx} missing description. Generating default.")
                 task['description'] = f"Execute {task.get('tool', 'unknown tool')} step {idx+1}"
             validated_tasks.append(task)

        return validated_tasks

    except ValueError as e: # Catch errors from validation or repair failure message
         # Ensure the original raw plan is included in the error message
         raise ValueError(f"Invalid plan structure or failed repair: {e}\nOriginal Plan JSON:\n{original_plan_json}") from e

# -------------------------------------------------------------------
# Step 1b: Review & auto‑repair a failing tool invocation
# -------------------------------------------------------------------
async def review_and_resolve(task: dict, result: str, attempt: int, websocket):
    """
    If `result` contains error indicators and we haven't exhausted retries,
    ask the LLM to return one corrected JSON tool call.
    Returns the corrected task dict or None.
    """
    # More robust error check - look for common error indicators
    is_error = any(err_indicator in result.lower() for err_indicator in
                   ["error:", "failed", "exception", "traceback", "exit code: 1", "command not found", "module not found"])

    if is_error and attempt < MAX_RETRIES:
        task_desc = task.get("description", f"Execute {task.get('tool', 'unknown tool')}")

        prompt = (
            f"The following agent step failed (Attempt {attempt + 1}/{MAX_RETRIES}):\n"
            f"**Task:** {task_desc}\n"
            f"**Tool Call JSON:**\n```json\n{json.dumps(task, indent=2)}\n```\n\n"
            f"**Output/Error:**\n```\n{result}\n```\n\n"
            "Analyze the error and the original tool call. Provide **only** the corrected JSON tool call needed to fix the error and achieve the original task goal. Maintain the original 'description' field if present. Your output must be **only** valid JSON, without any markdown fences."
        )
        await websocket.send_text(f"Agent: Reviewing failure (attempt {attempt + 1}) and trying to resolve...")
        corrected_json_str = send_prompt_with_functions(
            model_name=PLANNING_TOOLING_MODEL, # Use planning model for correction
            prompt=prompt,
            system_message=SYSTEM_PROMPT # Provide context
        )

        if not corrected_json_str:
            await websocket.send_text("Agent Error: LLM failed to provide a correction.")
            return None

        try:
            # Clean potential markdown code fences and parse
            corrected_json_str = re.sub(r'^```json\s*|\s*```$', '', corrected_json_str, flags=re.MULTILINE | re.DOTALL).strip()
            if not corrected_json_str:
                 raise ValueError("LLM returned empty correction string.")

            # Try to repair potential minor issues in correction
            repaired_correction = repair_json(corrected_json_str)
            corrected_task = json.loads(repaired_correction)

            # Basic validation of the correction
            if not isinstance(corrected_task, dict) or 'tool' not in corrected_task:
                raise ValueError("Correction is not a valid task dictionary (missing 'tool' key).")
            # Ensure description exists in correction, copying from original if needed
            if 'description' not in corrected_task or not corrected_task.get('description'):
                 corrected_task['description'] = task.get('description', f"Execute {corrected_task.get('tool', 'unknown tool')} (corrected)")

            await websocket.send_text("Agent: Received potential correction from LLM.")
            return corrected_task
        except (json.JSONDecodeError, ValueError) as e:
            await websocket.send_text(f"Agent Error: Failed to parse LLM correction: {e}\nRaw correction:\n{corrected_json_str}")
            return None # Failed to parse correction
    return None # No error or max retries reached

# -------------------------------------------------------------------
# Step 1→3: Main Agent Workflow (With Task Updates & Step Limit)
# -------------------------------------------------------------------
async def handle_agent_workflow(user_query: str, selected_model: str, websocket):
    """
    1) PLAN   → ask the LLM for a JSON array of steps (tasks)
    2) SEND   → send initial task list to UI
    3) EXECUTE each task, updating UI status (pending->running->done/error)
       - Includes self-repair loop on errors
       - Enforces MAX_WORKFLOW_STEPS limit
       - Passes browser step limit suggestion
    4) FINALIZE → signal completion/failure/limit-reached to the user
    """
    tasks_with_status = [] # Holds [{'description': '...', 'status': '...', 'original_task': {...}, 'result': '...', 'final_executed_task': {...}}]
    final_agent_message = "Agent: Workflow finished." # Default success message
    workflow_stopped_by_limit = False # Flag to track stopping reason

    try:
        # 1) PLAN
        await websocket.send_text("Agent: Planning steps based on your request...")
        # Construct prompt for planning - include JSON code escaping instruction
        planning_prompt = (
            f"User request: '{user_query}'\n\n"
            "Based on the user request and the available tools (shell_terminal, code_interpreter, browser), generate a plan as a JSON list of dictionaries. Each dictionary must represent one step and include:\n"
            "1. `tool`: The name of the tool to use (string).\n"
            "2. `description`: A short, user-friendly description of what this step aims to achieve (string).\n"
            "3. Tool-specific parameters (e.g., `command`: list of strings for shell, `code`: string for python, `input`: string for browser).\n\n"
            "**CRITICAL:** If providing Python code for the `code_interpreter` tool, the value for the `code` key MUST be a single valid JSON string. This means all special characters within the Python code, especially newlines, backslashes, and double quotes, MUST be properly escaped (e.g., newlines as '\\n', backslashes as '\\\\', double quotes as '\\\"'). Do NOT use Python triple quotes (`\"\"\"`) within the JSON output.\n\n"
            # Optional: You can still suggest a limit to the LLM here, but the loop limit is the guarantee
            # f"**IMPORTANT:** The plan should ideally contain around {MAX_WORKFLOW_STEPS} steps or fewer if possible.\n\n"
            "Output **only** the valid JSON list, without markdown fences."
        )
        plan_json = send_prompt_with_functions(
            model_name=PLANNING_TOOLING_MODEL, # Use the designated planning model
            prompt=planning_prompt,
            system_message=SYSTEM_PROMPT # Provide capabilities/context
        )

        if not plan_json:
             raise ValueError("LLM failed to generate a plan.")

        raw_tasks = parse_plan(plan_json) # Returns list of dicts, raises ValueError on failure

        # Initialize tasks with 'pending' status for UI
        tasks_with_status = [
            {'description': task.get('description'), # Use description from plan
             'status': 'pending',
             'original_task': task,
             'result': None, # Placeholder for result
             'final_executed_task': None} # Placeholder for last executed version
            for task in raw_tasks # raw_tasks already validated by parse_plan
        ]

        # 2) SEND Initial Task List to UI
        await send_task_update(websocket, tasks_with_status)
        if not tasks_with_status:
             await websocket.send_text("Agent: Plan generated, but no actionable steps found.")
             final_agent_message = "Agent: No actionable steps planned." # Update final message
             return # End if no tasks
        else:
             await websocket.send_text(f"Agent: Plan generated with {len(tasks_with_status)} steps.")
        await asyncio.sleep(0.1) # Small delay for UI update

        # 3) EXECUTE
        last_successful_result = "No output from previous steps."
        executed_step_count = 0 # Counter for executed steps

        for idx, task_info in enumerate(tasks_with_status):

            # ===>>> Check Step Limit BEFORE starting the step <<<===
            if executed_step_count >= MAX_WORKFLOW_STEPS:
                await websocket.send_text(f"**Agent Warning: Maximum step limit ({MAX_WORKFLOW_STEPS}) reached. Stopping workflow.**")
                final_agent_message = f"Agent: Workflow stopped after reaching the maximum limit of {MAX_WORKFLOW_STEPS} executed steps."
                workflow_stopped_by_limit = True
                # Mark remaining tasks as pending (or skipped) for clarity
                for i in range(idx, len(tasks_with_status)):
                     tasks_with_status[i]['status'] = 'pending' # Or could use 'skipped' if UI handles it
                await send_task_update(websocket, tasks_with_status) # Final task update
                break # Exit the execution loop

            # --- Update UI: Mark as Running ---
            tasks_with_status[idx]['status'] = 'running'
            await send_task_update(websocket, tasks_with_status)
            await websocket.send_text(f"**Agent: Starting Step {idx + 1}/**{len(tasks_with_status)}: {task_info['description']}")
            await asyncio.sleep(0.1) # Small delay

            current_task_dict = task_info['original_task'].copy() # Use a copy for the retry loop
            step_result = "" # Result of the last attempt for this step
            final_task_executed_this_step = current_task_dict # Track the last version executed

            # Retry loop for self‑repair
            for attempt in range(MAX_RETRIES + 1):
                tool = current_task_dict.get("tool")
                tool_input_desc = "" # For logging
                current_attempt_result = "" # Result for *this specific* attempt

                try:
                    if tool == "shell_terminal":
                        cmd_list = current_task_dict.get("command", [])
                        full_cmd = " ".join(cmd_list)
                        tool_input_desc = f"`{' '.join(cmd_list)}`"
                        await websocket.send_text(f"Agent: Executing shell command: {tool_input_desc}")
                        current_attempt_result = await execute_shell_command_impl(full_cmd, websocket)

                    elif tool == "code_interpreter":
                        code = current_task_dict.get("code", "")
                        tool_input_desc = f"Python code snippet (approx {len(code)} chars)"
                        await websocket.send_text(f"Agent: Executing {tool_input_desc}")
                        current_attempt_result = await execute_python_code_impl(code, websocket)

                    elif tool == "browser":
                        inp = current_task_dict.get("input") or current_task_dict.get("browser_input", "")
                        # Prepend the step limit suggestion
                        browser_instructions = (
                            f"Please complete the following task efficiently, aiming for roughly {BROWSER_STEP_LIMIT_SUGGESTION} internal actions or fewer. "
                            f"If you anticipate exceeding this limit significantly, stop and return the results gathered so far.\n\n"
                            f"Original Task Instruction: {inp}"
                        )
                        tool_input_desc = f"Browser instruction: '{inp[:100]}...'"
                        await websocket.send_text(f"Agent: Executing {tool_input_desc} (Limit Suggestion: {BROWSER_STEP_LIMIT_SUGGESTION})")
                        current_attempt_result = await browse_website_impl(browser_instructions, websocket)

                    else:
                        current_attempt_result = f"Error: Unknown tool '{tool}' specified in plan."
                        await websocket.send_text(f"Agent Error: Step {idx+1} specifies unknown tool '{tool}'.")

                    # Check for errors in this attempt's result
                    is_error = any(err_indicator in current_attempt_result.lower() for err_indicator in
                                   ["error:", "failed", "exception", "traceback", "exit code: 1", "command not found", "module not found"])

                    step_result = current_attempt_result # Store result of this attempt

                    if not is_error:
                        final_task_executed_this_step = current_task_dict # Update last successfully executed version
                        break # Exit retry loop on success

                    # Error occurred, try to correct if retries remain
                    await websocket.send_text(f"Agent: Step {idx + 1} encountered an error (Attempt {attempt + 1}).")
                    corrected_task_dict = await review_and_resolve(current_task_dict, step_result, attempt, websocket)

                    if corrected_task_dict:
                        await websocket.send_text(f"Agent: Applying correction for step {idx + 1}.")
                        # Update description if it changed in the correction
                        if 'description' in corrected_task_dict and corrected_task_dict['description'] != tasks_with_status[idx]['description']:
                             tasks_with_status[idx]['description'] = corrected_task_dict['description']
                             await send_task_update(websocket, tasks_with_status) # Update UI with new description

                        current_task_dict = corrected_task_dict # Use the corrected task for the next attempt
                        final_task_executed_this_step = current_task_dict # Track that the corrected version is now the one being run

                    else:
                        # No correction provided or possible, break retry loop
                         if attempt < MAX_RETRIES:
                              await websocket.send_text(f"Agent: Could not resolve error for step {idx + 1} after review.")
                         else: # Max retries reached
                             await websocket.send_text(f"Agent: Max retries reached for step {idx + 1}. Failing step.")
                         break # Exit retry loop if no fix or max retries

                except Exception as tool_exec_err:
                    tb = traceback.format_exc()
                    step_result = f"Error: Unhandled exception during tool execution: {tool_exec_err}\n{tb}"
                    await websocket.send_text(f"Agent Error: Critical error executing tool '{tool}' in step {idx+1}: {tool_exec_err}")
                    break # Exit retry loop on critical tool error

            # ===>>> Increment counter AFTER step attempt is fully processed <<<===
            executed_step_count += 1

            # --- Update UI: Mark as Done or Error based on the final result of the step ---
            final_status_is_error = any(err_indicator in step_result.lower() for err_indicator in
                                        ["error:", "failed", "exception", "traceback", "exit code: 1"])
            final_status = 'error' if final_status_is_error else 'done'

            tasks_with_status[idx]['status'] = final_status
            tasks_with_status[idx]['final_executed_task'] = final_task_executed_this_step # Store what was last run/attempted
            tasks_with_status[idx]['result'] = step_result # Store final result/error for this step

            await send_task_update(websocket, tasks_with_status)

            # Report the final result of this step (or the final error after retries)
            await websocket.send_text(f"**Agent: Step {idx + 1} Result ({final_status.upper()})**:\n```\n{step_result}\n```")

            if final_status == 'error':
                final_agent_message = f"Agent Error: Workflow failed at step {idx + 1} ({tasks_with_status[idx]['description']})."
                await websocket.send_text(f"**{final_agent_message}**") # Send failure message immediately
                # Stop workflow execution
                return

            # Store successful result for potential context in later steps (optional)
            if final_status == 'done':
                last_successful_result = step_result

            await asyncio.sleep(0.2) # Slightly longer pause after step completion

        # 4) FINALIZE
        # Determine final message if loop finished (either naturally or by limit)
        if not any(t['status'] == 'error' for t in tasks_with_status): # Check if no errors occurred
             if workflow_stopped_by_limit:
                 # Message already set correctly inside the loop limit check
                 pass
             else: # All steps completed successfully
                 final_agent_message = "Agent: Workflow completed successfully."
        # else: final_agent_message was already set by the failing step

        await websocket.send_text(f"**{final_agent_message}**") # Send final status message, bolded

        # Optional: Generate a final summary based on successful steps if workflow didn't fail
        # ... (summary generation logic could go here) ...


    except ValueError as e: # Catch planning/parsing errors
        tb = traceback.format_exc()
        error_msg = f"Agent Error: Failed during planning or plan parsing: {e}"
        print(f"{error_msg}\n{traceback.format_exc(limit=1)}")
        await websocket.send_text(error_msg)
        await send_task_update(websocket, []) # Send empty task list update to clear UI
        final_agent_message = "Agent Error: Workflow failed during planning."
    except Exception as e: # Catch any other unexpected errors during workflow setup or execution
        tb = traceback.format_exc()
        error_msg = f"Agent Error: An unexpected error occurred during the workflow: {e}"
        print(f"{error_msg}\n{tb}")
        await websocket.send_text(error_msg)
        # Update task list to show error state if possible
        updated = False
        for task_info in tasks_with_status:
            if task_info['status'] in ['running', 'pending']:
                task_info['status'] = 'error'
                updated = True
                break
        if updated:
            await send_task_update(websocket, tasks_with_status)
        final_agent_message = "Agent Error: Workflow failed unexpectedly."

    finally:
        print(f"Agent workflow function finished. Final status message attempt: {final_agent_message}")
        # Optional: Add a small delay before the websocket might close if needed
        # await asyncio.sleep(0.5)


# -------------------------------------------------------------------
# Original Helper Functions (Kept for reference, not used by handle_agent_workflow above)
# -------------------------------------------------------------------
# Note: These functions use a different workflow based on markdown files
# and are NOT called by the primary handle_agent_workflow function above.
async def create_task_list(user_input: str, model_to_use: str, websocket) -> str:
    """ (Original Description) """
    await websocket.send_text("Agent: Requesting task list (legacy method)...")
    system_message = """You are a planning agent...""" # Truncated
    prompt = f"Based on the user request: '{user_input}', create the task list..."
    # ... (rest of original legacy code) ...
    task_list_md = send_prompt(model_name=model_to_use, prompt=prompt, system_message=system_message)
    if not task_list_md: raise ValueError("LLM communication failed for task list.")
    lines = task_list_md.strip().splitlines(); items = []; pattern = re.compile(r"^\s*\d+\.\s*\[\s*\]\s*.*"); started = False
    for line in lines:
        if pattern.match(line): items.append(line); started = True
        elif started: break
    if not items: raise ValueError(f"Invalid task list format:\n{task_list_md}")
    safe_name = "".join(c for c in user_input[:30] if c.isalnum() or c in (' ','_')).strip().replace(' ', '_'); filename = f"tasks_{safe_name}_{datetime.datetime.now():%Y%m%d_%H%M%S}.md"; path = os.path.join(TASK_DIR, filename)
    with open(path, "w", encoding="utf-8") as f: f.write("\n".join(items))
    await websocket.send_text(f"Agent: Task list saved: {filename} (legacy)")
    return path

async def execute_tasks(task_file_path: str, model_to_use_for_review: str, websocket):
    """ (Original Description) """
    if not os.path.exists(task_file_path): raise FileNotFoundError(f"Task file not found: {task_file_path}")
    await websocket.send_text(f"Agent: Executing legacy task file: {os.path.basename(task_file_path)}")
    await asyncio.sleep(1); await websocket.send_text("Agent: Task execution finished (legacy - placeholder).")

async def review_and_repair(task_file_path: str, task_index: int, task_description: str, task_output: str, model_to_use: str, websocket):
    """ (Original Description) """
    system_message = "You are a meticulous reviewing agent…"; prompt = (f"Original Task: {task_description}\nOutput:\n---\n{task_output[:1000]}...\n---\nReview Result (Satisfactory or Issue/Suggestion):")
    review = send_prompt(model_to_use, prompt, system_message); review_text = review.strip() if review else "Review failed."
    await websocket.send_text(f"Agent: Review result: {review_text} (legacy)"); return review_text

async def final_review(task_file_path: str, original_query: str, model_to_use: str, websocket) -> str:
    """ (Original Description) """
    await websocket.send_text(f"Agent: Generating final review from {os.path.basename(task_file_path)} (legacy)")
    try:
        with open(task_file_path, "r", encoding="utf-8") as f: content = f.read()
    except Exception as e: await websocket.send_text(f"Agent Error: Failed to read legacy task file: {e}"); return "Error reading task file."
    system_message = "You are a final review and summarization agent…"; prompt = (f"Original User Query: {original_query}\n\nTask File Content:\n---\n{content}\n---\nGenerate the final response based on completed tasks ([x]).")
    final = send_prompt(model_to_use, prompt, system_message); final_text = final.strip() if final else "Summary generation failed."
    await websocket.send_text("Agent: Final summary generated (legacy)."); return final_text