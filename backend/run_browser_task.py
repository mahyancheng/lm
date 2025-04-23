#!/usr/bin/env python
"""
run_browser_task.py
───────────────────
Executes Browser-Use’s Agent in isolation. Designed to be called
by browseruse_integration.py in a separate process.

Input (argv[1]): JSON
    {
      "instructions": "<fully-formed prompt>",
      "model":        "qwen2.5:7b"            # optional
    }

Stdout: exactly one JSON object
    {"result": "..."} on success
    {"error":  "..."} on failure
Exit code 0 iff "result" key is present.
"""

from __future__ import annotations
import asyncio
import json
import logging
import os
import sys
import traceback
from dotenv import load_dotenv

# ─── logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [browser-task] %(message)s",
)

# ─── env
BASE_DIR = os.path.dirname(__file__)
load_dotenv(os.path.join(BASE_DIR, ".env"), override=True)
OLLAMA = os.getenv("OLLAMA_ENDPOINT", "http://localhost:11434")

# ─── heavy imports
try:
    from browser_use.agent.service import Agent as BrowserAgent
    from browser_use.browser.browser import Browser, BrowserConfig
    from browser_use.browser.context import (
        BrowserContextConfig,
        BrowserContextWindowSize,
    )
    from langchain_ollama import ChatOllama
except ImportError as e:
    logging.error("Import failure: %s", e)
    print(json.dumps({"error": str(e)}))
    sys.exit(1)

# ───────────────────────────────────────────────── async core
async def _run(instructions: str, model: str) -> dict:
    # LLM
    try:
        llm = ChatOllama(model=model, base_url=OLLAMA, temperature=0.0)
    except Exception as e:
        return {"error": f"Init LLM '{model}' failed: {e}"}

    # browser
    browser = Browser(config=BrowserConfig(headless=False, disable_security=True))
    ctx = await browser.new_context(
        config=BrowserContextConfig(
            browser_window_size=BrowserContextWindowSize(width=1280, height=1024)
        )
    )

    agent = BrowserAgent(
        task=instructions, browser=browser, browser_context=ctx, llm=llm, use_vision=False
    )

    try:
        hist = await asyncio.wait_for(agent.run(), timeout=240.0)
        final = hist.final_result() if hasattr(hist, "final_result") else str(hist)
        return {"result": final or "Browser task finished (empty result)."}
    except asyncio.TimeoutError:
        return {"error": "Browser task timed out inside subprocess."}
    except Exception as e:
        traceback.print_exc()
        return {"error": f"Unexpected error: {e}"}
    finally:
        try:
            await ctx.close()
            await browser.close()
        except Exception:
            pass

# ───────────────────────────────────────────────── CLI glue
def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "no input"}))
        sys.exit(1)

    # parse argv
    try:
        data = json.loads(sys.argv[1])
        instructions = data["instructions"]
        model = data.get("model") or os.getenv(
            "BROWSER_AGENT_INTERNAL_MODEL", "qwen2.5:7b"
        )
    except Exception as e:
        print(json.dumps({"error": f"Bad input: {e}"}))
        sys.exit(1)

    result = asyncio.run(_run(instructions, model))
    print(json.dumps(result))
    sys.exit(0 if "result" in result else 1)


if __name__ == "__main__":
    main()
