"""The client → agent → session split: persona fields ride under the wire
``agent`` block, per-run transport fields under ``session``. ``agent.start()``
is the only way to open a session."""

from __future__ import annotations

import asyncio
from typing import Any

from cosmo_ai import AudioConfig, RealtimeClient, InterruptionSensitivity
from cosmo_ai._internal.protocol import SDK_NAME, SDK_VERSION, InlineAgentConfig
from cosmo_ai.hooks import session_end

from .fakes import start_body


def _without_id(body: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in body.items() if k != "id"}


def test_all_fields_partition_into_agent_and_session_blocks() -> None:
    body = start_body(
        instructions="You are a support agent.",
        voice="Puck",
        interruption_sensitivity=InterruptionSensitivity.HIGH,
        audio=AudioConfig(noise_cancellation=True),
        resume_session_id="0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    )
    assert _without_id(body) == {
        "type": "session-config",
        "sdk": {"name": SDK_NAME, "version": SDK_VERSION},
        "agent": {
            "type": "inline",
            "instructions": "You are a support agent.",
            "voice": {"name": "Puck"},
            "interruption_sensitivity": "high",
            "audio": {"noise_cancellation": True},
        },
        "session": {
            "experimental": {
                "resume_session_id": "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
            },
        },
    }


def test_unset_audio_sends_no_block_and_opts_out_explicitly() -> None:
    # An unconfigured agent sends no audio block, so every knob takes its
    # server default (noise cancellation among them, which is on) and the
    # body stays compatible with a backend that predates any one of them.
    # The opt-out still has to reach the wire as a value.
    assert "audio" not in start_body()["agent"]
    opted_out = start_body(audio=AudioConfig(noise_cancellation=False))
    assert opted_out["agent"]["audio"] == {"noise_cancellation": False}


def test_catalog_launch_carries_no_audio_block() -> None:
    # The stored agent's audio options run verbatim; a block synthesized
    # here would trip the same guard that rejects a caller-set value.
    body = start_body(name="driver-pay")
    assert body["agent"] == {"type": "catalog", "name": "driver-pay"}


def test_agents_open_independent_sessions() -> None:
    async def scenario() -> None:
        client = RealtimeClient(api_key="k")
        # Audio handling is persona config: vary it by building another agent,
        # not per start() call.
        quiet = client.agent(
            instructions="shared persona",
            voice="Puck",
            audio=AudioConfig(noise_cancellation=True),
        ).start()
        loud = client.agent(
            instructions="shared persona",
            voice="Puck",
            audio=AudioConfig(noise_cancellation=False),
        ).start()
        q_config = quiet._build_config(())
        l_config = loud._build_config(())
        assert isinstance(q_config.agent, InlineAgentConfig)
        assert isinstance(l_config.agent, InlineAgentConfig)
        assert q_config.agent.instructions == "shared persona"
        assert l_config.agent.instructions == "shared persona"
        assert q_config.agent.audio.noise_cancellation is True
        assert l_config.agent.audio.noise_cancellation is False

    asyncio.run(scenario())


def test_agent_carries_hooks() -> None:
    client = RealtimeClient(api_key="k")
    h = session_end(lambda ctx: None)
    agent = client.agent(instructions="hi", hooks=[h])
    assert agent.hooks == (h,)


