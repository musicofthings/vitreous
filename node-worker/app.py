import asyncio
import io
import os
import signal
from contextlib import redirect_stdout
from typing import Any, Dict, List, Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI
from pydantic import BaseModel

load_dotenv()

ORCHESTRATOR_URL = os.getenv("ORCHESTRATOR_URL", "http://localhost:8080")
NODE_ID = os.getenv("NODE_ID", "node-local-1")
NODE_URL = os.getenv("NODE_URL", "http://localhost:8090")
POLL_INTERVAL_SECONDS = float(os.getenv("POLL_INTERVAL_SECONDS", "2"))
ALLOWED_TOOLS = os.getenv("ALLOWED_TOOLS", "python,browser,api").split(",")
ALLOW_NETWORK = os.getenv("ALLOW_NETWORK", "false").lower() == "true"
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")

app = FastAPI(title="Agent Node Worker")
stop_event = asyncio.Event()


class PollTask(BaseModel):
    step_id: str
    agent_id: str
    tool: str
    payload: Dict[str, Any]
    attempt: int


async def register_node(client: httpx.AsyncClient):
    await client.post(
        f"{ORCHESTRATOR_URL}/nodes/register",
        json={"node_id": NODE_ID, "callback_url": NODE_URL, "capabilities": ALLOWED_TOOLS},
        timeout=10,
    )


@app.get("/health")
async def health():
    return {"ok": True, "node_id": NODE_ID}


@app.on_event("startup")
async def startup_event():
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except NotImplementedError:
            pass
    app.state.poller = asyncio.create_task(poll_loop())


@app.on_event("shutdown")
async def shutdown_event():
    stop_event.set()
    task = app.state.poller
    if task:
        task.cancel()


async def poll_loop():
    async with httpx.AsyncClient() as client:
        await register_node(client)
        while not stop_event.is_set():
            try:
                task_data = await client.post(f"{ORCHESTRATOR_URL}/tasks/poll", json={"node_id": NODE_ID}, timeout=15)
                task_json = task_data.json().get("task")
                if not task_json:
                    await asyncio.sleep(POLL_INTERVAL_SECONDS)
                    continue
                task = PollTask.model_validate(task_json)
                result = await execute_task(task, client)
                await client.post(
                    f"{ORCHESTRATOR_URL}/tasks/{task.step_id}/result",
                    json=result,
                    timeout=30,
                )
            except Exception as exc:  # noqa: BLE001
                print(f"poll error: {exc}")
                await asyncio.sleep(POLL_INTERVAL_SECONDS)


async def execute_task(task: PollTask, client: httpx.AsyncClient) -> Dict[str, Any]:
    if task.tool == "python":
        return await run_python(task.payload)
    if task.tool == "browser":
        return await run_browser(task.payload, client)
    if task.tool == "api":
        return await run_llm(task.payload, client)
    return {"status": "failed", "error": f"unsupported tool {task.tool}"}


async def run_python(payload: Dict[str, Any]) -> Dict[str, Any]:
    code = str(payload.get("code") or "result = 'no code provided'")
    safe_globals = {
        "__builtins__": {
            "print": print,
            "len": len,
            "range": range,
            "sum": sum,
            "min": min,
            "max": max,
            "str": str,
            "int": int,
            "float": float,
            "dict": dict,
            "list": list,
        }
    }
    safe_locals: Dict[str, Any] = {}
    stdout_buffer = io.StringIO()

    try:
        with redirect_stdout(stdout_buffer):
            exec(code, safe_globals, safe_locals)  # noqa: S102
        return {
            "status": "success",
            "output": {
                "stdout": stdout_buffer.getvalue(),
                "result": safe_locals.get("result", ""),
            },
        }
    except Exception as exc:  # noqa: BLE001
        return {"status": "failed", "error": f"python tool error: {exc}"}


async def run_browser(payload: Dict[str, Any], client: httpx.AsyncClient) -> Dict[str, Any]:
    if not ALLOW_NETWORK:
        return {"status": "failed", "error": "network calls disabled on node"}
    url = str(payload.get("url") or "https://example.com")
    try:
        resp = await client.get(url, timeout=10)
        text = resp.text[:1500]
        return {
            "status": "success",
            "output": {
                "url": url,
                "status_code": resp.status_code,
                "preview": text,
            },
        }
    except Exception as exc:  # noqa: BLE001
        return {"status": "failed", "error": f"browser tool error: {exc}"}


async def run_llm(payload: Dict[str, Any], client: httpx.AsyncClient) -> Dict[str, Any]:
    prompt = str(payload.get("instruction") or payload.get("goal") or "")
    if OPENAI_API_KEY:
        try:
            resp = await client.post(
                "https://api.openai.com/v1/responses",
                headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
                json={"model": "gpt-4.1-mini", "input": prompt},
                timeout=20,
            )
            data = resp.json()
            return {
                "status": "success",
                "output": {
                    "provider": "openai",
                    "response": data,
                },
            }
        except Exception as exc:  # noqa: BLE001
            return {"status": "failed", "error": f"llm tool error: {exc}"}

    return {
        "status": "success",
        "output": {
            "provider": "mock",
            "response": f"Mock synthesis for: {prompt}",
        },
    }
