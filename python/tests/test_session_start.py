"""Every session posts to the single session-start endpoint — there is no
fallback URL. A construct the endpoint does not serve (a catalog launch
today) still posts there and takes the server's typed rejection instead of
quietly riding a different flow. These pin the URL.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest

from cosmo_ai import (
    DetectObjectsTool,
    EndCallTool,
    ExamineImageTool,
    GeminiModelOptions,
    PointAtObjectTool,
    WebSearchTool,
)
from cosmo_ai._internal.protocol import AgentTool
from cosmo_ai.hooks import EndCall, SilenceTimeout
from cosmo_ai.tools import ClientTool

from .fakes import START_RESPONSE_JSON, FakeSessionHarness, start_fake_session

_BASE = "https://api.test"  # pinned by conftest's COSMO_BASE_URL fixture
START_URL = f"{_BASE}/api/v1/external/realtime/session/start"


def _start(**session_kwargs: Any) -> FakeSessionHarness:
    return asyncio.run(start_fake_session(**session_kwargs))


def _tools(harness: FakeSessionHarness) -> Any:
    return harness.start_bodies[-1]["agent"].get("tools")


async def _noop_handler(args: dict[str, Any]) -> dict[str, Any]:
    return {}


def _client_tool() -> ClientTool:
    return ClientTool(
        name="get_local_time",
        description="Local wall-clock time.",
        parameters={"type": "object", "properties": {}},
        handler=_noop_handler,
    )


def _silence_hook() -> SilenceTimeout:
    return SilenceTimeout(
        timeout_seconds=10, action=EndCall(farewell="Goodbye.")
    )


# ── every config posts to the resolved endpoint ────────────────────────────


def test_plain_inline_agent_posts_to_the_resolved_endpoint() -> None:
    harness = _start(instructions="be terse")
    assert harness.start_urls == [START_URL]


@pytest.mark.parametrize(
    "tool",
    [
        WebSearchTool(),
        ExamineImageTool(),
        DetectObjectsTool(),
        PointAtObjectTool(),
        EndCallTool(),
    ],
    ids=[
        "web_search",
        "examine_image",
        "detect_objects",
        "point_at_object",
        "end_call",
    ],
)
def test_typed_opt_in_posts_to_the_resolved_endpoint(tool: AgentTool) -> None:
    harness = _start(tools=[tool])
    assert harness.start_urls == [START_URL]
    assert _tools(harness) == [tool.model_dump(mode="json", exclude_none=True)]


def test_client_tool_only_agent_posts_to_the_resolved_endpoint() -> None:
    harness = _start(tools=[_client_tool()])
    assert harness.start_urls == [START_URL]


def test_server_hook_config_posts_to_the_resolved_endpoint() -> None:
    harness = _start(instructions="be terse", hooks=[_silence_hook()])
    assert harness.start_urls == [START_URL]


def test_model_options_post_to_the_resolved_endpoint() -> None:
    harness = _start(
        model="cosmo-voice",
        model_options=GeminiModelOptions(temperature=0.4),
    )
    assert harness.start_urls == [START_URL]


def test_catalog_launch_posts_to_the_resolved_endpoint() -> None:
    # No fallback: a catalog launch posts to the same endpoint and takes the
    # server's typed rejection until catalog resolution lands there.
    harness = _start(name="driver-pay")
    assert harness.start_urls == [START_URL]
    assert harness.start_bodies[-1]["agent"]["type"] == "catalog"


def test_agent_without_tools_declares_none() -> None:
    harness = _start(instructions="be terse")
    assert _tools(harness) is None


# ── what a started session surfaces from the start response ────────────────


def test_started_session_exposes_session_id_and_server_timings() -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                **START_RESPONSE_JSON,
                "timings": {
                    "version_check_ms": 1,
                    "project_check_ms": 2,
                    "provider_resolve_ms": 3,
                    "db_insert_ms": 4,
                    "mint_tokens_ms": 5,
                    "dispatch_ms": 6,
                    "total_ms": 7,
                },
            },
        )

    harness = asyncio.run(start_fake_session(respond=respond))
    session = harness.session
    assert session is not None

    assert session.session_id == "sess-test"
    timings = session.connect_timings
    server = timings.server_timings
    assert server is not None
    assert server.total_ms == 7
    assert server.version_check_ms == 1
    # Absent on a backend predating the resolved flow, even when the sibling
    # phases are present.
    assert server.resolve_ms is None

    # Client-measured phases: real elapsed time, and the parts sum to the
    # whole (this SDK has no prepared-room fast path where they overlap).
    assert timings.ws_ms is not None and timings.ws_ms >= 0
    assert timings.room_ms is not None and timings.room_ms >= 0
    assert timings.total_ms is not None
    assert timings.total_ms == pytest.approx(timings.ws_ms + timings.room_ms, abs=1.0)
    # No mic phase: audio publishes through an explicit call, not the join.
    assert timings.mic_ms is None


def test_server_timings_are_none_when_the_backend_omits_them() -> None:
    harness = _start()
    session = harness.session
    assert session is not None
    timings = session.connect_timings
    assert timings.server_timings is None
    # Client phases are still measured — they don't depend on the backend.
    assert timings.total_ms is not None
