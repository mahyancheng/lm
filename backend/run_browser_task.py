#!/usr/bin/env python
# backend/run_browser_task.py

import asyncio
import sys
import os
import json
import traceback
import logging
from dotenv import load_dotenv

logging.basicConfig(
    level=logging.INFO,
    stream=sys.stderr,
    format='%(asctime)s [SUBPROCESS:%(levelname)s] [%(name)s] %(message)s',
    datefmt='%H:%M:%S', encoding='utf-8', force=True
)
logging.getLogger('httpx').setLevel(logging.WARNING)
logging.getLogger('httpcore').setLevel(logging.WARNING)

SCRIPT_DIR = os.path.dirname(__file__)
load_dotenv(dotenv_path=os.path.join(SCRIPT_DIR, '.env'))

try:
    from browser_use.agent.service import Agent as BrowserUseAgent
    from browser_use.browser.browser import Browser, BrowserConfig
    from browser_use.browser.context import BrowserContext, BrowserContextConfig, BrowserContextWindowSize
    from langchain_ollama import ChatOllama
    logging.info("Subprocess: Dependencies imported successfully.")
except ImportError as e:
    logging.exception(f"FATAL: Subprocess Import Error: {e}")
    print(json.dumps({"error": f"Subprocess failed library import: {e}"}))
    sys.exit(1)
except Exception as e:
    logging.exception(f"FATAL: Unexpected error during subprocess import: {e}")
    print(json.dumps({"error": "Subprocess unexpected error importing."}))
    sys.exit(1)

BROWSER_AGENT_INTERNAL_MODEL = os.getenv("BROWSER_AGENT_INTERNAL_MODEL", "qwen2.5:7b")
OLLAMA_BASE_URL = os.getenv("OLLAMA_ENDPOINT", "http://localhost:11434")

def extract_headlines(html: str) -> list:
    import re
    pattern = r'<h[1-3][^>]*>(.*?)</h[1-3]>'
    headlines = re.findall(pattern, html, re.IGNORECASE | re.DOTALL)
    clean_headlines = []
    for hl in headlines:
        hl_clean = re.sub(r'<[^>]+>', '', hl)
        hl_clean = re.sub(r'\s+', ' ', hl_clean).strip()
        if hl_clean:
            clean_headlines.append(hl_clean)
    return clean_headlines[:3]

async def run_task(instructions: str):
    llm_instance = None
    browser_instance = None
    context_instance = None
    result_text = ""
    try:
        logging.info(f"Initializing LLM ({BROWSER_AGENT_INTERNAL_MODEL})...")
        try:
            llm_instance = ChatOllama(model=BROWSER_AGENT_INTERNAL_MODEL, base_url=OLLAMA_BASE_URL, temperature=0.0)
            logging.info("LLM initialized.")
        except Exception as e:
            raise RuntimeError(f"Failed to initialize LLM: {e}") from e

        logging.info("Initializing Browser (headless=False)...")
        try:
            browser_config = BrowserConfig(headless=False, disable_security=True)
            browser_instance = Browser(config=browser_config)
            logging.info("Browser initialized.")
        except Exception as e:
            raise RuntimeError(f"Failed to initialize Browser: {e}") from e

        logging.info("Creating Browser Context...")
        try:
            context_config = BrowserContextConfig(
                browser_window_size=BrowserContextWindowSize(width=1280, height=1080)
            )
            context_instance = await browser_instance.new_context(config=context_config)
            logging.info("Context created.")
        except Exception as e:
            raise RuntimeError(f"Failed to create Context: {e}") from e

        logging.info("Initializing BrowserUseAgent...")
        try:
            agent_instance = BrowserUseAgent(
                task=instructions,
                browser=browser_instance,
                browser_context=context_instance,
                llm=llm_instance,
                use_vision=False
            )
            logging.info("BrowserUseAgent initialized.")
        except Exception as e:
            raise RuntimeError(f"Failed to initialize Agent: {e}") from e

        logging.info("Running agent task...")
        result_history = await asyncio.wait_for(agent_instance.run(), timeout=180.0)
        logging.info("Agent run completed.")

        if result_history and hasattr(result_history, 'final_result'):
            result_text = result_history.final_result() or ""
        elif result_history is not None:
            result_text = str(result_history)

        if (not result_text) or ("no result text" in result_text.lower()):
            if context_instance and not getattr(context_instance, 'is_closed', False):
                try:
                    logging.info("Result text empty or default; attempting to extract headlines from current page...")
                    current_page = await context_instance.get_current_page()
                    html_content = await current_page.content()
                    headlines = extract_headlines(html_content)
                    if headlines:
                        result_text = "Top headlines: " + ", ".join(headlines)
                        logging.info(f"Extracted headlines: {headlines}")
                    else:
                        result_text = "No headlines could be extracted."
                        logging.info("No headlines extracted.")
                except Exception as extraction_error:
                    logging.error(f"Error extracting headlines: {extraction_error}")
                    result_text = "Error extracting headlines."
            else:
                logging.error("Browser context is closed; cannot extract headlines.")
                result_text = "Browser context closed; no extraction possible."

        return {"result": result_text}
    except asyncio.TimeoutError:
        logging.error("Browser action timed out.")
        return {"error": "Browser action timed out in subprocess."}
    except Exception as e:
        logging.exception(f"Error during run_task: {e}")
        return {"error": f"Error in subprocess run_task: {e}"}
    finally:
        logging.info("Cleaning up browser resources...")
        if context_instance and hasattr(context_instance, 'is_closed') and not context_instance.is_closed:
            try:
                await context_instance.close()
                logging.info("Context closed.")
            except Exception as e_ctx:
                logging.warning(f"Cleanup context error: {e_ctx}")
        if browser_instance:
            try:
                await browser_instance.close()
                logging.info("Browser closed.")
            except Exception as e_brw:
                logging.warning(f"Cleanup browser error: {e_brw}")
        logging.info("Cleanup finished.")

if __name__ == "__main__":
    load_dotenv(dotenv_path=os.path.join(SCRIPT_DIR, '.env'))
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No input JSON provided."}))
        sys.exit(1)
    input_json_str = sys.argv[1]
    result_data = {"error": "Subprocess main block failed."}
    try:
        input_data = json.loads(input_json_str)
        instructions = input_data.get("instructions")
        if not instructions:
            result_data = {"error": "Missing 'instructions' key."}
        else:
            result_data = asyncio.run(run_task(instructions))
    except json.JSONDecodeError:
        result_data = {"error": "Invalid JSON input."}
    except Exception as main_err:
        logging.exception(f"FATAL: Unexpected error: {main_err}")
        result_data = {"error": f"Fatal error: {main_err}"}
    finally:
        try:
            print(json.dumps(result_data))
        except Exception as print_err:
            print(json.dumps({"error": f"Failed to serialize result: {print_err}"}))
        sys.exit(0 if "result" in result_data else 1)
