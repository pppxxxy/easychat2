"""EasyChat2 Agent SDK (Python, stdlib-only).

Drives the on-device OpenAI-compatible server exposed by EasyChat2's
`localApiServer` plugin (`/v1/models`, `/v1/chat/completions`, `/v1/agent`),
bound to loopback with Bearer auth.

    from easychat2 import EasyChat2

    client = EasyChat2(base_url="http://127.0.0.1:8686", api_key="<token>")
    print(client.list_models())
    result = client.run_agent("列出工作区文件并总结", mode="read")
    print(result)

    for piece in client.stream_chat([{"role": "user", "content": "你好"}]):
        print(piece, end="", flush=True)

Zero third-party dependencies (urllib only), so it runs anywhere with Python 3.8+.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Dict, Iterable, Iterator, List, Optional

__all__ = ["EasyChat2", "EasyChat2Error", "parse_sse_text"]

DEFAULT_BASE_URL = "http://127.0.0.1:8686"


class EasyChat2Error(RuntimeError):
    """Raised when the device server returns a non-2xx response."""

    def __init__(self, status: int, body: str):
        super().__init__(f"HTTP {status}: {body}")
        self.status = status
        self.body = body


def parse_sse_text(text: str) -> List[Dict[str, Any]]:
    """Parse a block of SSE text into a list of ``{"event", "data"}`` items.

    ``data`` is the raw string (``"[DONE]"`` kept verbatim). The caller is
    responsible for buffering partial trailing lines across chunks.
    """
    events: List[Dict[str, Any]] = []
    for block in text.split("\n\n"):
        event = "message"
        data_lines: List[str] = []
        for line in block.split("\n"):
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                data_lines.append(line[5:].lstrip(" "))
        if not data_lines:
            continue
        events.append({"event": event, "data": "\n".join(data_lines)})
    return events


def chunk_text(chunk: Any) -> str:
    """Extract the incremental text from an OpenAI-style streaming chunk."""
    if not isinstance(chunk, dict):
        return ""
    choices = chunk.get("choices") or []
    if choices:
        choice = choices[0]
        delta = choice.get("delta") or {}
        if isinstance(delta.get("content"), str):
            return delta["content"]
        if isinstance(choice.get("text"), str):
            return choice["text"]
    if isinstance(chunk.get("delta"), str):
        return chunk["delta"]
    return ""


class EasyChat2:
    """A tiny client for EasyChat2's local agent server."""

    def __init__(self, base_url: str = DEFAULT_BASE_URL, api_key: str = "", timeout: float = 120.0):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key or ""
        self.timeout = timeout

    # -- internal ---------------------------------------------------------
    def _headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def _request(self, method: str, path: str, payload: Optional[dict] = None):
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}{path}", data=data, method=method, headers=self._headers()
        )
        try:
            return urllib.request.urlopen(req, timeout=self.timeout)
        except urllib.error.HTTPError as exc:  # pragma: no cover - network path
            raise EasyChat2Error(exc.code, exc.read().decode("utf-8", "replace")) from exc

    # -- public -----------------------------------------------------------
    def list_models(self) -> Dict[str, Any]:
        """Return the installed model catalog (``{"object": "list", "data": [...]}``)."""
        with self._request("GET", "/v1/models") as resp:
            return json.loads(resp.read().decode("utf-8"))

    def run_agent(
        self,
        prompt: str,
        mode: str = "read",
        character_id: str = "default",
        **extra: Any,
    ) -> Dict[str, Any]:
        """Run one agent tool loop; returns the ``object: 'agent.run'`` result."""
        payload = {"prompt": prompt, "mode": mode, "characterId": character_id, **extra}
        with self._request("POST", "/v1/agent", payload) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def stream_chat(
        self,
        messages: Iterable[Dict[str, Any]],
        model: str = "",
        **extra: Any,
    ) -> Iterator[str]:
        """Yield assistant text deltas from ``/v1/chat/completions`` (SSE)."""
        payload = {"model": model, "messages": list(messages), "stream": True, **extra}
        with self._request("POST", "/v1/chat/completions", payload) as resp:
            buffer = ""
            for raw_line in resp:
                buffer += raw_line.decode("utf-8", "replace")
                while "\n\n" in buffer:
                    block, buffer = buffer.split("\n\n", 1)
                    for item in parse_sse_text(block + "\n\n"):
                        if item["data"] == "[DONE]":
                            return
                        try:
                            parsed = json.loads(item["data"])
                        except json.JSONDecodeError:
                            continue
                        text = chunk_text(parsed)
                        if text:
                            yield text
