from __future__ import annotations

import asyncio
import json

from cosmo_ai import UserSpeechTimeoutEvent
from cosmo_ai.hooks import EndCall, Say, SilenceTimeout

from .fakes import start_fake_session


def test_assemble_config_serializes_server_hooks() -> None:
    from cosmo_ai.client import RealtimeClient

    client = RealtimeClient(api_key="k")
    config = client._assemble_config(
        name=None, inputs=None,
        instructions=None, model=None, model_options=None,
        voice=None,
        tools=None,
        interruption_sensitivity=None, audio=None,
        resume_session_id=None,
        server_hooks=[SilenceTimeout(timeout_seconds=7.5, action=Say(text="hi"))],
    )
    dumped = config.model_dump(mode="json", exclude_none=True)
    hooks = dumped["agent"]["hooks"]
    assert hooks[0]["trigger"] == "user.speech.timeout"
    assert hooks[0]["action"] == {"type": "say", "text": "hi"}


def test_agent_carries_server_hooks_in_the_hooks_list() -> None:
    from cosmo_ai.client import RealtimeClient

    hooks = [SilenceTimeout(timeout_seconds=25, action=EndCall())]
    client = RealtimeClient(api_key="k")
    agent = client.agent(hooks=hooks)
    assert agent.hooks == tuple(hooks)


def test_server_hooks_ride_the_unified_hooks_list_onto_the_wire() -> None:
    import asyncio

    from cosmo_ai.hooks import session_start

    @session_start
    def note(ctx):
        return None

    async def scenario() -> None:
        harness = await start_fake_session(
            instructions="hi",
            hooks=[
                note,
                SilenceTimeout(timeout_seconds=9, action=Say(text="still there?")),
            ],
        )
        sent = harness.start_bodies[0]["agent"]
        assert sent["hooks"][0]["action"] == {"type": "say", "text": "still there?"}
        assert "runtime_hooks" not in sent

    asyncio.run(scenario())


def test_catalog_agent_rejects_server_hooks() -> None:
    import pytest

    from cosmo_ai.client import RealtimeClient

    client = RealtimeClient(api_key="k")
    with pytest.raises(TypeError, match="stored config verbatim"):
        client.catalog_agent(
            "driver-pay",
            hooks=[SilenceTimeout(timeout_seconds=9, action=EndCall())],  # type: ignore[list-item]
        )


def test_decode_registry_includes_user_speech_timeout() -> None:
    from cosmo_ai.session._engine import _SERVER_EVENT_BY_TYPE

    assert "user-speech-timeout" in _SERVER_EVENT_BY_TYPE


def test_user_speech_timeout_frame_lands_on_the_event_stream() -> None:
    """A fired server hook is something the SERVER did, so it reaches the
    caller as an event — there is no client-hook seam for it."""

    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None

        frame = {
            "type": "user-speech-timeout",
            "session_id": "sess-test",
            "silence_ms": 7500,
            "trigger_count": 2,
            "max_count": 3,
            "action": {"type": "say", "text": "Are you still there?"},
        }
        await session._handle_payload(json.dumps(frame).encode("utf-8"))

        event = await asyncio.wait_for(session.__anext__(), timeout=1)
        assert isinstance(event, UserSpeechTimeoutEvent)
        assert event.session_id == "sess-test"
        assert event.silence_ms == 7500
        assert event.trigger_count == 2
        assert event.max_count == 3
        assert event.action == Say(text="Are you still there?")

    asyncio.run(scenario())
