"""Serialization of the ``session-config`` start payload: per-call fields
and absent-stays-absent."""

from __future__ import annotations

import asyncio
from dataclasses import replace
from typing import Any

import pytest
from pydantic import ValidationError

from cosmo_ai import (
    RealtimeClient,
    CosmoVadConfig,
    DetectObjectsTool,
    EndCallTool,
    ExamineImageTool,
    GeminiModelOptions,
    OpenAIModelOptions,
    PointAtObjectTool,
    WebSearchTool,
)
from cosmo_ai._internal.protocol import (
    SDK_NAME,
    SDK_VERSION,
    CatalogAgentConfig,
    InlineAgentConfig,
)
from cosmo_ai.tools import ClientTool

from .fakes import start_body


async def _noop_handler(args: dict[str, Any]) -> dict[str, Any]:
    return {}


def test_minimal_config_sends_protocol_envelope_and_omits_absent_fields() -> None:
    body = start_body()
    assert body["type"] == "session-config"
    assert body["sdk"] == {"name": SDK_NAME, "version": SDK_VERSION}
    assert isinstance(body["id"], str) and body["id"]
    for absent in (
        "name",
        "inputs",
        "instructions",
        "model",
        "model_options",
        "voice",
        "tools",
        # Unset stays off the wire — the server defaults apply.
        "interruption_sensitivity",
        "audio",
    ):
        assert absent not in body["agent"]
    assert "experimental" not in body["session"]


def test_model_serializes_under_agent_and_absent_when_unset() -> None:
    body = start_body(model="gemini-live")
    assert body["agent"]["model"] == "gemini-live"
    silent = start_body()
    assert "model" not in silent["agent"]


def test_model_options_serialize_under_agent_and_absent_when_unset() -> None:
    body = start_body(
        model="gemini",
        model_options=GeminiModelOptions(
            temperature=0.7, max_output_tokens=4096, thinking_level="high"
        ),
    )
    opts = body["agent"]["model_options"]
    assert opts["provider"] == "gemini"
    assert opts["temperature"] == 0.7
    assert opts["max_output_tokens"] == 4096
    assert opts["thinking_level"] == "high"
    silent = start_body()
    assert "model_options" not in silent["agent"]


def test_gemini_endpointing_knobs_serialize_under_their_wire_names() -> None:
    body = start_body(
        model="gemini",
        model_options=GeminiModelOptions(
            include_thoughts=False,
            end_of_speech_sensitivity="high",
            silence_duration_ms=200,
            prefix_padding_ms=100,
        ),
    )
    opts = body["agent"]["model_options"]
    assert opts["include_thoughts"] is False
    assert opts["end_of_speech_sensitivity"] == "high"
    assert opts["silence_duration_ms"] == 200
    assert opts["prefix_padding_ms"] == 100
    assert "temperature" not in opts


def test_gemini_server_vad_opt_out_serializes_and_default_stays_off_wire() -> None:
    body = start_body(
        model="gemini",
        model_options=GeminiModelOptions(turn_detection="server_vad"),
    )
    assert body["agent"]["model_options"]["turn_detection"] == "server_vad"
    default = start_body(model="gemini", model_options=GeminiModelOptions())
    assert "model_options" not in default["agent"] or "turn_detection" not in (
        default["agent"]["model_options"]
    )


def test_gemini_cosmo_vad_block_serializes_under_its_wire_names() -> None:
    body = start_body(
        model="gemini",
        model_options=GeminiModelOptions(
            turn_detection="cosmo_vad",
            cosmo_vad=CosmoVadConfig(pause_ms=250, prefix_ms=300, max_hold_ms=900),
        ),
    )
    opts = body["agent"]["model_options"]
    assert opts["turn_detection"] == "cosmo_vad"
    assert opts["cosmo_vad"] == {
        "pause_ms": 250,
        "prefix_ms": 300,
        "max_hold_ms": 900,
    }
    assert "silence_duration_ms" not in opts


def test_openai_turn_detection_knobs_serialize_under_their_wire_names() -> None:
    body = start_body(
        model="openai",
        model_options=OpenAIModelOptions(
            turn_detection="semantic_vad", eagerness="high"
        ),
    )
    opts = body["agent"]["model_options"]
    assert opts["provider"] == "openai"
    assert opts["turn_detection"] == "semantic_vad"
    assert opts["eagerness"] == "high"
    assert "silence_duration_ms" not in opts


def test_model_options_reject_cross_provider_knob() -> None:
    # thinking_level lives only on the Gemini block — the OpenAI block forbids it.
    with pytest.raises(ValidationError):
        OpenAIModelOptions(thinking_level="high")  # type: ignore[call-arg]


def test_greeting_serializes_under_agent_and_absent_when_unset() -> None:
    body = start_body(greeting="Hi, I'm Cosmo.")
    assert body["agent"]["greeting"] == "Hi, I'm Cosmo."
    silent = start_body()
    assert "greeting" not in silent["agent"]


def test_resume_session_id_serializes_under_session_experimental() -> None:
    body = start_body(
        resume_session_id="0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    )
    assert body["session"]["experimental"] == {
        "resume_session_id": "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
    }
    assert "resume_session_id" not in body["session"]


def test_store_recording_serializes_under_session_and_absent_when_unset() -> None:
    body = start_body(store_recording=False)
    assert body["session"]["store_recording"] is False
    # Unset stays off the wire — the server default (record) applies.
    assert "store_recording" not in start_body()["session"]


def test_tools_serialize_with_kind_discriminators() -> None:
    body = start_body(
        tools=[
            ClientTool(
                name="get_local_time",
                description="Returns the local wall-clock time.",
                parameters={"type": "object", "properties": {}, "required": []},
                handler=_noop_handler,
            ),
            WebSearchTool(),
        ]
    )
    assert body["agent"]["tools"] == [
        {
            "kind": "client",
            "name": "get_local_time",
            "description": "Returns the local wall-clock time.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
        {"kind": "web_search"},
    ]


def test_typed_server_opt_ins_serialize_as_bare_kinds() -> None:
    body = start_body(
        tools=[
            WebSearchTool(),
            ExamineImageTool(),
            DetectObjectsTool(),
            PointAtObjectTool(),
            EndCallTool(),
        ]
    )
    assert body["agent"]["tools"] == [
        {"kind": "web_search"},
        {"kind": "examine_image"},
        {"kind": "detect_objects"},
        {"kind": "point_at_object"},
        {"kind": "end_call"},
    ]


def test_typed_server_opt_ins_reject_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        WebSearchTool(name="cosmo.web_search")  # type: ignore[call-arg]


def test_agent_name_and_inputs_serialize_under_agent() -> None:
    body = start_body(name="driver-pay", inputs={"caller_name": "Sam"})
    assert body["agent"]["type"] == "catalog"
    assert body["agent"]["name"] == "driver-pay"
    assert body["agent"]["inputs"] == {"caller_name": "Sam"}


def test_agent_name_reference_omits_unset_fields_from_the_wire() -> None:
    body = start_body(name="driver-pay")
    assert body["agent"] == {"type": "catalog", "name": "driver-pay"}


def test_reference_variant_has_no_stored_config_fields() -> None:
    # The union makes reference + stored-config unrepresentable: a stored
    # field on the reference variant is a validation error, and the inline
    # variant has no reference fields at all.
    with pytest.raises(ValidationError):
        CatalogAgentConfig(name="driver-pay", instructions="Be terse.")  # type: ignore[call-arg]
    with pytest.raises(ValidationError):
        InlineAgentConfig(inputs={"caller_name": "Sam"})  # type: ignore[call-arg]
    with pytest.raises(ValidationError):
        InlineAgentConfig(name="driver-pay")  # type: ignore[call-arg]


def test_catalog_launch_carries_a_per_run_voice_override() -> None:
    # Voice is the one cosmetic ride-along a catalog launch may send; the
    # server prefers it over the stored agent's voice for that run.
    body = start_body(name="driver-pay", voice="Upbeat")
    assert body["agent"] == {
        "type": "catalog",
        "name": "driver-pay",
        "voice": {"name": "Upbeat"},
    }


def test_catalog_launch_rejects_stored_config_on_a_hand_built_agent() -> None:
    # ``RealtimeAgent`` is a public frozen dataclass, so ``dataclasses.replace`` can
    # still put a stored-config field on a catalog launch that no factory
    # would accept; the start-time guard is what covers that path.
    client = RealtimeClient(api_key="k")
    illegal = replace(client.catalog_agent("driver-pay"), instructions="Be terse.")

    async def open_session() -> None:
        await illegal.start()

    with pytest.raises(ValueError, match="stored config verbatim"):
        asyncio.run(open_session())


def test_factories_reject_cross_variant_kwargs_at_the_type_level() -> None:
    # ``catalog_agent`` has no stored-config parameters and ``agent`` has no
    # reference parameters, so type-checkers (and Python itself) reject the
    # illegal combinations before anything touches the wire.
    client = RealtimeClient(api_key="k")
    with pytest.raises(TypeError):
        client.catalog_agent("driver-pay", instructions="Be terse.")  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        client.agent(name="driver-pay")  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        client.catalog_agent(inputs={"x": "y"})  # type: ignore[call-arg]


def test_agent_name_rejects_invalid_handles() -> None:
    for bad in ("Driver Pay", "-leading", "trailing-", "UPPER"):
        with pytest.raises(ValidationError):
            CatalogAgentConfig(name=bad)




def test_client_tool_requires_a_handler() -> None:
    with pytest.raises(ValidationError):
        ClientTool(
            name="get_local_time",
            description="Returns the local wall-clock time.",
            parameters={"type": "object", "properties": {}},
        )  # type: ignore[call-arg]


def test_background_client_tool_requires_a_handler() -> None:
    from cosmo_ai.tools import BackgroundClientTool

    with pytest.raises(ValidationError):
        BackgroundClientTool(
            name="export_report",
            description="Long export.",
            parameters={"type": "object", "properties": {}},
        )  # type: ignore[call-arg]
