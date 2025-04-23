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
# Load .env from backend directory, one level up from where this script might be copied/run
dotenv_path=os.path.join(SCRIPT_DIR, '.env')
load_dotenv(dotenv_path=dotenv_path)
if not os.path.exists(dotenv_path):
     logging.warning(f".env file not found at {dotenv_path}, using defaults.")


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
# === Corrected Default Ollama Base URL ===
OLLAMA_BASE_URL = os.getenv("OLLAMA_ENDPOINT", "http://localhost:11434")
# =========================================


def extract_headlines(html: str) -> list:
    # Extracts up to 3 headlines from H1, H2, H3 tags
    import re
    # Slightly improved pattern to avoid capturing attributes within the tag
    pattern = r'<h[1-3][^>]*>\s*(.*?)\s*</h[1-3]>'
    headlines = re.findall(pattern, html, re.IGNORECASE | re.DOTALL)
    clean_headlines = []
    for hl in headlines:
        # Remove inner tags (like links or spans)
        hl_clean = re.sub(r'<[^>]+>', '', hl)
        # Replace multiple whitespace chars with single space and strip
        hl_clean = re.sub(r'\s+', ' ', hl_clean).strip()
        # Add only if non-empty after cleaning
        if hl_clean:
            clean_headlines.append(hl_clean)
    # Return only the first 3 found
    return clean_headlines[:3]

async def run_task(instructions: str):
    llm_instance = None
    browser_instance = None
    context_instance = None
    result_text = ""
    try:
        logging.info(f"Initializing LLM ({BROWSER_AGENT_INTERNAL_MODEL}) for browser task...")
        try:
            # Use the corrected OLLAMA_BASE_URL
            llm_instance = ChatOllama(
                model=BROWSER_AGENT_INTERNAL_MODEL,
                base_url=OLLAMA_BASE_URL,
                temperature=0.0
            )
            # Test connection (optional but recommended)
            # await llm_instance.ainvoke("Respond with OK")
            logging.info("LLM initialized.")
        except Exception as e:
            # Provide more specific error if possible
            logging.exception(f"Failed to initialize or connect LLM: {e}")
            raise RuntimeError(f"Failed to initialize LLM: {e}. Check Ollama server at {OLLAMA_BASE_URL}") from e

        logging.info("Initializing Browser (headless=False)...")
        try:
            # Ensure security is not disabled unless absolutely necessary and understood
            browser_config = BrowserConfig(headless=False, disable_security=True) # Set disable_security=False if possible
            browser_instance = Browser(config=browser_config)
            #removed: await browser_instance.start() # Explicitly start browser
            logging.info("Browser initialized and started.")
        except Exception as e:
            logging.exception(f"Failed to initialize Browser: {e}")
            raise RuntimeError(f"Failed to initialize Browser: {e}") from e

        logging.info("Creating Browser Context...")
        try:
            context_config = BrowserContextConfig(
                browser_window_size=BrowserContextWindowSize(width=1280, height=1080)
            )
            context_instance = await browser_instance.new_context(config=context_config)
            logging.info("Context created.")
        except Exception as e:
            logging.exception(f"Failed to create Context: {e}")
            raise RuntimeError(f"Failed to create Context: {e}") from e

        logging.info("Initializing BrowserUseAgent...")
        try:
            agent_instance = BrowserUseAgent(
                task=instructions,
                browser=browser_instance,
                browser_context=context_instance,
                llm=llm_instance,
                use_vision=False,
                # Add any other relevant parameters if needed
            )
            logging.info("BrowserUseAgent initialized.")
        except Exception as e:
            logging.exception(f"Failed to initialize Agent: {e}")
            raise RuntimeError(f"Failed to initialize Agent: {e}") from e

        logging.info("Running agent task...")
        # Increased timeout slightly
        result_history = await asyncio.wait_for(agent_instance.run(), timeout=240.0)
        logging.info("Agent run completed.")

        # Extract final result text
        if result_history and hasattr(result_history, 'final_result'):
            result_text = result_history.final_result() or ""
        elif result_history is not None:
            # Fallback if final_result() is not available or empty
            result_text = str(result_history)
        else:
             result_text = "Agent run finished, but no result history was generated."

        # If result is empty or a generic placeholder, try extracting headlines as fallback
        if (not result_text) or ("no result text" in result_text.lower()) or ("agent run finished" in result_text.lower()):
            logging.warning(f"Agent result was empty or generic ('{result_text}'); attempting headline extraction fallback.")
            if context_instance and not getattr(context_instance, 'is_closed', False):
                try:
                    logging.info("Attempting to extract headlines from current page...")
                    current_page = await context_instance.get_current_page()
                    if current_page:
                        html_content = await current_page.content()
                        headlines = extract_headlines(html_content)
                        if headlines:
                            result_text = "Fallback: Extracted top headlines: " + ", ".join(headlines)
                            logging.info(f"Extracted headlines: {headlines}")
                        else:
                            result_text = "Fallback: No headlines could be extracted from the final page."
                            logging.info("No headlines extracted.")
                    else:
                         result_text = "Fallback: Could not get current page to extract headlines."
                         logging.warning("Could not get current page for headline extraction.")
                except Exception as extraction_error:
                    logging.error(f"Error extracting headlines during fallback: {extraction_error}")
                    result_text += " (Error during headline extraction fallback)" # Append error to existing text if any
            else:
                logging.error("Browser context is closed; cannot extract headlines.")
                result_text += " (Browser context closed; no extraction possible)"

        return {"result": result_text}

    except asyncio.TimeoutError:
        logging.error("Browser action timed out.")
        # Attempt to get *some* information even on timeout
        final_page_url = "Unknown"
        try:
            if context_instance and not getattr(context_instance, 'is_closed', False):
                current_page = await context_instance.get_current_page()
                if current_page:
                    final_page_url = current_page.url
        except Exception as e:
             logging.warning(f"Could not get final page URL after timeout: {e}")
        return {"error": f"Browser action timed out in subprocess. Last known page: {final_page_url}"}

    except Exception as e:
        logging.exception(f"Error during run_task: {e}")
        return {"error": f"Error in subprocess run_task: {str(e)}"}

    finally:
        # Ensure resources are cleaned up
        logging.info("Cleaning up browser resources...")
        if context_instance and hasattr(context_instance, 'close') and callable(context_instance.close):
             if not getattr(context_instance, 'is_closed', False):
                 try:
                     await context_instance.close()
                     logging.info("Context closed.")
                 except Exception as e_ctx:
                     logging.warning(f"Error closing context during cleanup: {e_ctx}")
             else:
                  logging.info("Context already closed.")

        if browser_instance and hasattr(browser_instance, 'close') and callable(browser_instance.close):
             # Check if browser is connected/running before closing
             # Note: Browser object might not have a simple 'is_connected' attribute
             try:
                 await browser_instance.close()
                 logging.info("Browser closed.")
             except Exception as e_brw:
                 logging.warning(f"Error closing browser during cleanup: {e_brw}")
        logging.info("Cleanup finished.")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No input JSON provided."}))
        sys.exit(1)

    input_json_str = sys.argv[1]
    result_data = {"error": "Subprocess main block failed unexpectedly."} # Default error

    try:
        input_data = json.loads(input_json_str)
        instructions = input_data.get("instructions")

        if not instructions:
            result_data = {"error": "Missing 'instructions' key in input JSON."}
        else:
            # Run the async function
            result_data = asyncio.run(run_task(instructions))

    except json.JSONDecodeError:
        logging.error(f"Invalid JSON input received: {input_json_str[:200]}...")
        result_data = {"error": "Invalid JSON input provided to subprocess."}
    except Exception as main_err:
        logging.exception(f"FATAL: Unexpected error in subprocess main block: {main_err}")
        result_data = {"error": f"Fatal error in subprocess: {str(main_err)}"}
    finally:
        # Ensure *something* is always printed as JSON
        try:
            print(json.dumps(result_data))
        except Exception as print_err:
            # Final fallback if result serialization fails
            print(json.dumps({"error": f"Failed to serialize final result: {str(print_err)}"}))

        # Exit with 0 if 'result' key exists (even if empty), 1 otherwise (indicates an error occurred)
        sys.exit(0 if "result" in result_data else 1)