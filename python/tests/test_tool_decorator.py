"""The ``@tool`` builder: inference (name/description/schema), decoration-time
rejection, runtime validation with the normalized ``INVALID_INPUT`` error
shape, background variants, and lowering — a decorated tool is a plain
``ClientTool`` that behaves identically to a hand-written spec through the
dispatch layer.

No ``from __future__ import annotations`` here: it would stringify the
handlers' annotations and the test models are function-local, which
``get_type_hints`` cannot resolve (the decorator raises a targeted TypeError
for that case, covered below).
"""

import asyncio
import json
from typing import Any, Literal

import pytest
import structlog.testing
from pydantic import BaseModel, ConfigDict, Field
from cosmo_ai import tool
from cosmo_ai.tools._dispatch import _invoke_handler
from cosmo_ai.errors import ToolInputValidationError
from cosmo_ai._internal.hooks import HookEngine, PreToolUseResult, pre_tool_use
from cosmo_ai.tools import (
    BackgroundClientTool,
    ClientTool,
    ClientToolJob,
    ToolSchemaError,
)

from .fakes import run_awaitable

class WeatherInput(BaseModel):
    city: str = Field(description="City name")
    unit: Literal["c", "f"] = "c"


class Item(BaseModel):
    sku: str


class OrderInput(BaseModel):
    items: list[Item]


def _weather_tool() -> ClientTool:
    @tool
    async def get_weather(input: WeatherInput) -> dict[str, Any]:
        """Current weather for a city."""
        return {"temp_c": 21, "city": input.city, "unit": input.unit}

    return get_weather


# ─────────────────────────────────────────────────────────────────────────────
# Inference and lowering
# ─────────────────────────────────────────────────────────────────────────────


def test_infers_name_description_and_dialect_schema() -> None:
    spec = _weather_tool()
    assert isinstance(spec, ClientTool)
    assert not isinstance(spec, BackgroundClientTool)
    assert spec.name == "get_weather"
    assert spec.description == "Current weather for a city."
    assert spec.parameters == {
        "type": "object",
        "properties": {
            "city": {"type": "string", "description": "City name"},
            "unit": {"type": "string", "enum": ["c", "f"], "default": "c"},
        },
        "required": ["city"],
    }


def test_explicit_name_and_description_override() -> None:
    @tool(name="weather_now", description="Look up current weather.")
    async def whatever(input: WeatherInput) -> dict[str, Any]:
        """Ignored docstring."""
        return {}

    assert whatever.name == "weather_now"
    assert whatever.description == "Look up current weather."


def test_docstring_is_dedented() -> None:
    @tool
    async def list_files(input: WeatherInput) -> dict[str, Any]:
        """List files.

        Second line kept.
        """
        return {}

    assert list_files.description == "List files.\n\nSecond line kept."


def test_nested_model_refs_are_inlined() -> None:
    @tool(description="Place an order.")
    async def place_order(input: OrderInput) -> dict[str, Any]:
        return {}

    assert place_order.parameters == {
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"sku": {"type": "string"}},
                    "required": ["sku"],
                },
            }
        },
        "required": ["items"],
    }


def test_optional_and_enum_fields_emit_dialect_schema() -> None:
    from enum import Enum

    class Priority(str, Enum):
        low = "low"
        high = "high"

    class TicketInput(BaseModel):
        title: str
        assignee: str | None = None
        priority: Priority = Priority.low

    @tool(description="Open a ticket.")
    async def open_ticket(input: TicketInput) -> dict[str, Any]:
        return {}

    props = open_ticket.parameters["properties"]
    # Optional -> anyOf with a null branch; the enum is inlined ($ref resolved).
    assert props["assignee"] == {
        "anyOf": [{"type": "string"}, {"type": "null"}],
        "default": None,
    }
    assert props["priority"] == {
        "type": "string",
        "enum": ["low", "high"],
        "default": "low",
    }
    assert open_ticket.parameters["required"] == ["title"]


def test_union_scalar_field_emits_any_of() -> None:
    class FlexibleInput(BaseModel):
        value: int | str

    @tool(description="Accept an int or string.")
    async def flexible(input: FlexibleInput) -> dict[str, Any]:
        return {}

    assert flexible.parameters["properties"]["value"] == {
        "anyOf": [{"type": "integer"}, {"type": "string"}]
    }


def test_lowers_to_equivalent_hand_written_spec() -> None:
    decorated = _weather_tool()
    # Ground truth written by hand — not `decorated.parameters` — so the
    # equality pins that the builder lowers to exactly this ClientTool.
    async def _hand_written_handler(args: dict[str, Any]) -> dict[str, Any]:
        return {}

    hand_written = ClientTool(
        name="get_weather",
        description="Current weather for a city.",
        parameters={
            "type": "object",
            "properties": {
                "city": {"type": "string", "description": "City name"},
                "unit": {"type": "string", "enum": ["c", "f"], "default": "c"},
            },
            "required": ["city"],
        },
        handler=_hand_written_handler,
    )
    assert decorated.model_dump(mode="json") == hand_written.model_dump(mode="json")


# ─────────────────────────────────────────────────────────────────────────────
# Runtime validation
# ─────────────────────────────────────────────────────────────────────────────


def test_handler_receives_validated_model() -> None:
    spec = _weather_tool()
    assert spec.handler is not None
    result = run_awaitable(spec.handler({"city": "Paris"}))
    assert result == {"temp_c": 21, "city": "Paris", "unit": "c"}


def test_surplus_arguments_are_ignored_not_rejected() -> None:
    # The dialect cannot express `additionalProperties: false` (it is rejected
    # at construction), so extra keys use Pydantic's default: ignored, not an
    # error. This pins that intended behavior against a "should we forbid
    # extras?" regression.
    spec = _weather_tool()
    assert spec.handler is not None
    result = run_awaitable(spec.handler({"city": "Paris", "surplus": "ignored"}))
    assert result == {"temp_c": 21, "city": "Paris", "unit": "c"}


def test_none_return_is_a_valid_null_result() -> None:
    @tool(description="Fire and forget.")
    async def noop(input: WeatherInput) -> None:
        return None

    assert noop.handler is not None
    assert run_awaitable(noop.handler({"city": "Paris"})) is None


def test_non_dict_return_fails_closed() -> None:
    @tool(name="bad_return", description="Returns a list.")
    async def bad_return(input: WeatherInput):
        return ["not", "an", "object"]

    assert bad_return.handler is not None
    with pytest.raises(TypeError, match="must be a dict"):
        run_awaitable(bad_return.handler({"city": "Paris"}))


def test_non_dict_return_becomes_error_envelope_through_dispatch() -> None:
    async def scenario() -> None:
        @tool(name="scalar_return", description="Returns a scalar.")
        async def scalar_return(input: WeatherInput):
            return 42

        assert scalar_return.handler is not None
        reply = await _invoke_handler(
            scalar_return.handler,
            json.dumps({"city": "Paris"}),
            tool_name="scalar_return",
        )
        envelope = json.loads(reply)
        assert envelope["ok"] is False
        assert "must be a dict" in envelope["error"]

    asyncio.run(scenario())


def test_invalid_args_raise_normalized_error_without_submitted_values() -> None:
    spec = _weather_tool()
    assert spec.handler is not None
    with pytest.raises(ToolInputValidationError) as excinfo:
        run_awaitable(spec.handler({"unit": "kelvin-secret-value"}))
    message = str(excinfo.value)
    lines = message.splitlines()
    assert lines[0] == "INVALID_INPUT: get_weather rejected parameters:"
    assert lines[-1] == "Fix the input and retry."
    assert "- city: required" in lines
    assert any(line.startswith("- unit: expected one of") for line in lines)
    assert "kelvin-secret-value" not in message
    assert excinfo.value.__cause__ is None
    assert excinfo.value.__suppress_context__
    assert {issue["type"] for issue in excinfo.value.issues} == {
        "missing",
        "literal_error",
    }
    assert all("input" not in issue for issue in excinfo.value.issues)


def test_nested_paths_are_dotted_and_indexed() -> None:
    @tool(description="Place an order.")
    async def place_order(input: OrderInput) -> dict[str, Any]:
        return {}

    assert place_order.handler is not None
    with pytest.raises(ToolInputValidationError) as excinfo:
        run_awaitable(place_order.handler({"items": [{"sku": "ok"}, {}]}))
    assert "- items[1].sku: required" in str(excinfo.value)


def test_issue_lines_capped_at_five_and_message_bounded() -> None:
    class WideInput(BaseModel):
        a: str
        b: str
        c: str
        d: str
        e: str
        f: str
        g: str

    @tool(description="Wide tool.")
    async def wide_tool(input: WideInput) -> dict[str, Any]:
        return {}

    assert wide_tool.handler is not None
    with pytest.raises(ToolInputValidationError) as excinfo:
        run_awaitable(wide_tool.handler({}))
    message = str(excinfo.value)
    assert message.count("\n- ") == 6  # 5 issues + the overflow line
    assert "- … and 2 more" in message
    assert len(message.encode("utf-8")) <= 1024
    assert len(excinfo.value.issues) == 7


def test_error_envelope_through_dispatch() -> None:
    async def scenario() -> None:
        spec = _weather_tool()
        assert spec.handler is not None
        reply = await _invoke_handler(
            spec.handler, json.dumps({"unit": "x"}), tool_name=spec.name
        )
        envelope = json.loads(reply)
        assert envelope["ok"] is False
        assert envelope["error"].startswith("INVALID_INPUT: get_weather")

    asyncio.run(scenario())


def test_hook_rewrite_to_invalid_args_logs_structured_event() -> None:
    async def scenario() -> None:
        spec = _weather_tool()
        assert spec.handler is not None
        async def rewrite(context: Any) -> PreToolUseResult:
            return PreToolUseResult(updated_arguments={"unit": "bogus"})

        hooks = HookEngine([pre_tool_use(rewrite)])
        with structlog.testing.capture_logs() as logs:
            reply = await _invoke_handler(
                spec.handler,
                json.dumps({"city": "Paris"}),
                tool_name=spec.name,
                hooks=hooks,
                session_id="s-1",
            )
        assert json.loads(reply)["ok"] is False
        events = [log["event"] for log in logs]
        assert (
            "realtime.client_tool_validation_failed_after_hook_rewrite" in events
        )

    asyncio.run(scenario())


def test_valid_model_args_do_not_log_rewrite_event() -> None:
    async def scenario() -> None:
        spec = _weather_tool()
        assert spec.handler is not None
        with structlog.testing.capture_logs() as logs:
            reply = await _invoke_handler(
                spec.handler, json.dumps({"unit": "x"}), tool_name=spec.name
            )
        assert json.loads(reply)["ok"] is False
        assert not any(
            log["event"]
            == "realtime.client_tool_validation_failed_after_hook_rewrite"
            for log in logs
        )

    asyncio.run(scenario())


# ─────────────────────────────────────────────────────────────────────────────
# Background tools
# ─────────────────────────────────────────────────────────────────────────────


def test_background_tool_lowers_to_background_spec_and_validates() -> None:
    async def scenario() -> None:
        seen: list[tuple[WeatherInput, ClientToolJob]] = []

        @tool(background=True, description="Slow weather export.")
        async def export_weather(input: WeatherInput, job: ClientToolJob) -> None:
            seen.append((input, job))

        assert isinstance(export_weather, BackgroundClientTool)
        assert export_weather.handler is not None

        job = ClientToolJob.__new__(ClientToolJob)  # handler only forwards it
        await export_weather.handler({"city": "Paris"}, job)
        assert seen[0][0].city == "Paris"
        assert seen[0][1] is job

        with pytest.raises(ToolInputValidationError):
            await export_weather.handler({}, job)

    asyncio.run(scenario())


def test_background_job_annotation_is_optional_but_checked() -> None:
    @tool(background=True, description="Job param unannotated.")
    async def unannotated(input: WeatherInput, job) -> None:
        pass

    assert isinstance(unannotated, BackgroundClientTool)

    with pytest.raises(TypeError, match="second"):

        @tool(background=True, description="Wrong job annotation.")  # type: ignore[arg-type]
        async def wrong_job(input: WeatherInput, job: str) -> None:
            pass


# ─────────────────────────────────────────────────────────────────────────────
# Decoration-time rejection
# ─────────────────────────────────────────────────────────────────────────────


def test_rejects_sync_function() -> None:
    with pytest.raises(TypeError, match="async def"):

        @tool  # type: ignore[arg-type]
        def sync_tool(input: WeatherInput) -> dict[str, Any]:
            """Sync."""
            return {}


def test_rejects_wrong_parameter_counts() -> None:
    with pytest.raises(TypeError, match="exactly one parameter"):

        @tool(description="Two params inline.")  # type: ignore[arg-type]
        async def two_params(input: WeatherInput, extra: str) -> dict[str, Any]:
            return {}

    with pytest.raises(TypeError, match="exactly two parameters"):

        @tool(background=True, description="One param background.")  # type: ignore[arg-type]
        async def one_param(input: WeatherInput) -> None:
            pass


def test_rejects_var_args_and_unannotated_first_param() -> None:
    with pytest.raises(TypeError, match="args"):

        @tool(description="Star args.")
        async def star_args(*args: Any) -> dict[str, Any]:
            return {}

    with pytest.raises(TypeError, match="BaseModel subclass"):

        @tool(description="No annotation.")
        async def unannotated(input) -> dict[str, Any]:
            return {}

    with pytest.raises(TypeError, match="not BaseModel itself"):

        @tool(description="Bare BaseModel.")
        async def bare_model(input: BaseModel) -> dict[str, Any]:
            return {}


def test_rejects_bad_names_and_missing_description() -> None:
    with pytest.raises(ValueError, match="tool name"):

        @tool(description="Camel case name.")
        async def getWeather(input: WeatherInput) -> dict[str, Any]:
            return {}

    with pytest.raises(ValueError, match="no description"):

        @tool
        async def no_docstring(input: WeatherInput) -> dict[str, Any]:
            return {}


def test_rejects_overlong_description_with_actual_and_max() -> None:
    with pytest.raises(ValueError, match=r"2049 characters.*2048"):

        @tool(description="x" * 2049)
        async def long_description(input: WeatherInput) -> dict[str, Any]:
            return {}


def test_rejects_lossy_schema_constructs_at_decoration() -> None:
    class PatternInput(BaseModel):
        sku: str = Field(pattern="^[A-Z]+$")

    with pytest.raises(ToolSchemaError) as excinfo:

        @tool(description="Pattern field.")
        async def pattern_tool(input: PatternInput) -> dict[str, Any]:
            return {}

    assert excinfo.value.code == "forbidden_key"

    class StrictInput(BaseModel):
        model_config = ConfigDict(extra="forbid")
        city: str

    with pytest.raises(ToolSchemaError) as excinfo:

        @tool(description="Strict model.")
        async def strict_tool(input: StrictInput) -> dict[str, Any]:
            return {}

    assert excinfo.value.code == "additional_properties_forbidden"


def test_unresolvable_string_annotation_raises_targeted_error() -> None:
    with pytest.raises(TypeError, match="could not resolve annotation"):

        @tool(description="Stringified local annotation.")
        async def stringified(input: "WeatherInputLocal") -> dict[str, Any]:  # type: ignore[name-defined] # noqa: F821
            return {}


def test_rejects_recursive_model_at_decoration() -> None:
    class Node(BaseModel):
        children: list["Node"] = Field(default_factory=list)

    with pytest.raises(ToolSchemaError) as excinfo:

        @tool(description="Recursive model.")
        async def tree_tool(input: Node) -> dict[str, Any]:
            return {}

    assert excinfo.value.code == "recursive_schema"


def test_sdk_prefix_is_reserved_for_the_tools_the_sdk_ships() -> None:
    """The SDK owns the name and schema of its own client tools, so a
    caller's tool taking one would swap it for something the model was told
    behaves differently. Rejected at declaration, not at the server's 422."""

    class Args(BaseModel):
        query: str

    with pytest.raises(ValueError, match="reserved for tools the SDK ships"):

        @tool(name="cosmo_sdk_draw_box")
        async def impostor(input: Args) -> dict[str, Any]:
            """Impersonates an SDK tool."""
            return {}


def test_a_natural_name_outside_the_prefix_is_untouched() -> None:
    class Args(BaseModel):
        query: str

    @tool(name="draw_box")
    async def mine(input: Args) -> dict[str, Any]:
        """My own renderer — the natural name stays free."""
        return {}

    assert mine.name == "draw_box"
