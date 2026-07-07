"""Central, fully-overridable configuration for the agentic eval suite.

The SUBJECT (the model the chat API runs under) is the server-configured
provider — admin runtime settings with the EXPLORER_DEFAULT_* env as fallback
(spec 035 removed the per-request provider block, so the eval can no longer
pick the subject per request; repoint the server's settings/env instead).

The JUDGE — the LLM-as-judge that scores prose faithfulness (G-Eval) — remains
its own seam: it defaults to the repo's EXPLORER_DEFAULT_* (the self-hosted
gemma on spark) but can be repointed via EVAL_JUDGE_* — e.g. to grade gemma
with a different, stronger judge for independence.

Resolution order for any value: eval/.env override > repo-root .env > built-in
default. Secrets (API keys) come from env only and are never logged.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

# Load repo-root .env first (inherits EXPLORER_DEFAULT_*), then a local override.
_REPO_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(_REPO_ROOT / ".env")
load_dotenv(Path(__file__).resolve().parent / ".env", override=True)


def _get(*keys: str, default: str | None = None) -> str | None:
    """First non-empty value across the given env keys, else default."""
    for k in keys:
        v = os.environ.get(k)
        if v:
            return v
    return default


@dataclass(frozen=True)
class ProviderCfg:
    """An OpenAI-compatible (or anthropic) chat endpoint."""

    kind: str          # "openai-compatible" | "anthropic"
    model: str
    base_url: str | None
    api_key: str | None


@dataclass(frozen=True)
class EvalConfig:
    api_base_url: str   # the running danni explorer-api (chat lives here)
    judge: ProviderCfg
    judge_temperature: float
    judge_structured: bool   # constrain judge output via response_format=json_schema
    request_timeout_s: float


def load() -> EvalConfig:
    judge = ProviderCfg(
        kind=_get("EVAL_JUDGE_KIND", default="openai-compatible"),
        model=_get("EVAL_JUDGE_MODEL", "EXPLORER_DEFAULT_MODEL", default="gemma-4-26b-uncensored"),
        base_url=_get("EVAL_JUDGE_BASE_URL", "EXPLORER_DEFAULT_BASE_URL", default="http://spark:8000/v1"),
        api_key=_get("EVAL_JUDGE_API_KEY", "EXPLORER_DEFAULT_API_KEY", default="EMPTY"),
    )
    return EvalConfig(
        api_base_url=_get("EVAL_API_BASE_URL", default="http://localhost:8790"),
        judge=judge,
        judge_temperature=float(_get("EVAL_JUDGE_TEMPERATURE", default="0") or "0"),
        judge_structured=(_get("EVAL_JUDGE_STRUCTURED", default="1") == "1"),
        request_timeout_s=float(_get("EVAL_REQUEST_TIMEOUT_S", default="180") or "180"),
    )


CONFIG = load()
