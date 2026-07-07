"""Thin client for the real danni chat API (POST /api/chat, SSE).

Drives the *actual* agentic loop (runChatTurn → mirror tools → grounding) over
HTTP and collects what we grade: the final answer text, the tools the model
called, and the dataset citations the pipeline let through. This is the
system-under-test exactly as the browser sees it.
"""

from __future__ import annotations

import json
import os
import uuid
from dataclasses import dataclass, field

import httpx

from config import CONFIG

# The chat API is gated (spec 019): POST /api/chat now requires a valid Kratos
# session. The eval registers a throwaway user once via the single-port /kratos
# proxy and reuses the resulting session cookie for every request. Public read
# endpoints (/api/datasets/...) don't need it, but sharing one cookie-jar client
# is simplest and harmless.
_CLIENT: httpx.Client | None = None


def _csrf(flow: dict) -> str:
    for n in flow.get("ui", {}).get("nodes", []):
        attrs = n.get("attributes", {})
        if attrs.get("name") == "csrf_token":
            return attrs.get("value", "")
    return ""


def _client() -> httpx.Client:
    """Lazily build a cookie-jar httpx client authenticated as a throwaway user.

    Override the identity with EVAL_AUTH_EMAIL / EVAL_AUTH_PASSWORD to reuse an
    existing account (e.g. to grade under an admin or a higher token quota)."""
    global _CLIENT
    if _CLIENT is not None:
        return _CLIENT
    base = CONFIG.api_base_url.rstrip("/")
    c = httpx.Client(timeout=CONFIG.request_timeout_s, follow_redirects=True)
    email = os.environ.get("EVAL_AUTH_EMAIL") or f"eval-{uuid.uuid4().hex}@example.com"
    password = os.environ.get("EVAL_AUTH_PASSWORD") or f"Eval-{uuid.uuid4().hex[:16]}-Pw9"
    headers = {"accept": "application/json", "content-type": "application/json"}
    # If an explicit account is given, log in; otherwise self-register a throwaway one.
    if os.environ.get("EVAL_AUTH_EMAIL"):
        flow = c.get(
            f"{base}/kratos/self-service/login/browser", headers={"accept": "application/json"}
        ).json()
        endpoint = f"{base}/kratos/self-service/login?flow={flow['id']}"
        payload = {"csrf_token": _csrf(flow), "method": "password",
                   "identifier": email, "password": password}
    else:
        flow = c.get(
            f"{base}/kratos/self-service/registration/browser",
            headers={"accept": "application/json"},
        ).json()
        endpoint = f"{base}/kratos/self-service/registration?flow={flow['id']}"
        payload = {"csrf_token": _csrf(flow), "method": "password",
                   "password": password, "traits": {"email": email}}
    body = c.post(endpoint, headers=headers, json=payload).json()
    if not (body.get("session") or body.get("identity")):
        msgs = body.get("ui", {}).get("messages", [])
        raise RuntimeError(f"eval auth failed (no session for {email}): {msgs or body}")
    # httpx's cookie jar doesn't reliably re-send the Set-Cookie from the registration
    # response (domain/path quirk through the proxy), so pin the session token as an
    # explicit Cookie header instead — that authenticates every subsequent request.
    sess = c.cookies.get("ory_kratos_session")
    if not sess:
        raise RuntimeError(f"eval auth: no ory_kratos_session cookie for {email}")
    c.cookies.clear()
    c.headers["cookie"] = f"ory_kratos_session={sess}"
    _CLIENT = c
    return c


@dataclass
class ChatResult:
    text: str = ""
    tools_called: list[str] = field(default_factory=list)
    citations: list[dict] = field(default_factory=list)
    anchors: dict = field(default_factory=dict)
    grounding_text: str | None = None  # exact context injected into the model (debug)
    session_id: str | None = None
    error: dict | None = None

    @property
    def cited_dataset_ids(self) -> list[str]:
        return [c.get("datasetId") for c in self.citations if c.get("datasetId")]


def dataset_detail(dataset_id: str) -> dict | None:
    """Fetch a cited dataset's real record (title/publisher/tags/resources) to
    reconstruct the grounding context the answer should be faithful to."""
    url = f"{CONFIG.api_base_url.rstrip('/')}/api/datasets/{dataset_id}"
    try:
        r = _client().get(url, timeout=30.0)
        if r.status_code != 200:
            return None
        return r.json()
    except httpx.HTTPError:
        return None


def dataset_rows_sample(dataset_id: str, resource_id: str, limit: int = 200) -> list | None:
    """Fetch a sample of a resource's rows — the actual ground truth the chat was
    grounded on — so the faithfulness judge can verify row-level claims."""
    url = (
        f"{CONFIG.api_base_url.rstrip('/')}/api/datasets/{dataset_id}"
        f"/resources/{resource_id}/rows?limit={limit}"
    )
    try:
        r = _client().get(url, timeout=60.0)
        if r.status_code != 200:
            return None
        body = r.json()
        return body.get("rows")
    except httpx.HTTPError:
        return None


def chat(message: str, *, grounding_dataset_ids: list[str] | None = None,
         scope: dict | None = None) -> ChatResult:
    """Send one turn (fresh session) and parse the SSE stream into a ChatResult."""
    # debug=True → the server emits a `grounding` event with the EXACT context it injected,
    # so faithfulness is judged against what the model actually saw (no reconstruction guesswork).
    # The provider is server-configured only (spec 035): the request carries no provider block —
    # the graded subject is whatever model the API's admin settings / EXPLORER_DEFAULT_* select.
    body: dict = {"message": message, "debug": True}
    if grounding_dataset_ids:
        body["groundingDatasetIds"] = grounding_dataset_ids
    if scope:
        body["scope"] = scope

    res = ChatResult()
    url = f"{CONFIG.api_base_url.rstrip('/')}/api/chat"
    with _client().stream("POST", url, json=body, timeout=CONFIG.request_timeout_s) as r:
        r.raise_for_status()
        for event, data in _iter_sse(r.iter_lines()):
            if event == "session":
                res.session_id = data.get("sessionId")
            elif event == "token":
                res.text += data.get("delta", "")
            elif event == "tool":
                # The model may emit the same tool's start+done; record on start only.
                if data.get("status") == "start" and data.get("name"):
                    res.tools_called.append(data["name"])
            elif event == "grounding":
                res.grounding_text = data.get("text")
            elif event == "citations":
                res.citations = data.get("citations", [])
            elif event == "anchors":
                res.anchors = data
            elif event == "error":
                res.error = data
    return res


def _iter_sse(lines):
    """Yield (event, parsed_data) tuples from an SSE line stream."""
    event = "message"
    data_buf: list[str] = []
    for raw in lines:
        line = raw.rstrip("\n")
        if line == "":  # dispatch on blank line
            if data_buf:
                raw_data = "\n".join(data_buf)
                try:
                    parsed = json.loads(raw_data)
                except json.JSONDecodeError:
                    parsed = {"_raw": raw_data}
                yield event, parsed
            event, data_buf = "message", []
            continue
        if line.startswith("event:"):
            event = line[len("event:"):].strip()
        elif line.startswith("data:"):
            data_buf.append(line[len("data:"):].lstrip())
