from __future__ import annotations

import itertools

import pytest

from cosmo_ai._internal.hooks import (
    Hook,
    HookEngine,
    PostToolUseContext,
    PreToolUseContext,
    PreToolUseResult,
    SessionStartContext,
    SessionStartResult,
    SessionEndContext,
    ToolDenied,
    ToolOk,
    post_tool_use,
    pre_tool_use,
    resolve_hooks,
    session_end,
    session_start,
)


@pytest.mark.asyncio
async def test_session_start_concatenates_context_in_list_order():
    @session_start
    def first(ctx: SessionStartContext) -> SessionStartResult:
        return SessionStartResult(additional_context="A")

    @session_start
    async def second(ctx: SessionStartContext) -> SessionStartResult:
        return SessionStartResult(additional_context="B")

    merged = await HookEngine([first, second]).run_session_start(SessionStartContext())
    assert merged == "A\n\nB"


@pytest.mark.asyncio
async def test_session_start_returns_none_when_no_context():
    @session_start
    def noop(ctx: SessionStartContext) -> None:
        return None

    assert await HookEngine([noop]).run_session_start(SessionStartContext()) is None


@pytest.mark.asyncio
async def test_pre_tool_use_first_deny_wins_and_short_circuits():
    seen: list[str] = []

    @pre_tool_use
    def deny(ctx: PreToolUseContext) -> PreToolUseResult:
        seen.append("deny")
        return PreToolUseResult(permission="deny", reason="nope")

    @pre_tool_use
    def after(ctx: PreToolUseContext) -> PreToolUseResult:
        seen.append("after")
        return PreToolUseResult(updated_arguments={"x": 1})

    outcome = await HookEngine([deny, after]).run_pre_tool_use(
        tool_name="delete_x", arguments={"a": 1}, session_id="s1"
    )
    assert outcome.denied is True
    assert outcome.reason == "nope"
    assert seen == ["deny"]  # second hook never ran


@pytest.mark.asyncio
async def test_pre_tool_use_sequential_argument_transforms():
    @pre_tool_use
    def add_b(ctx: PreToolUseContext) -> PreToolUseResult:
        return PreToolUseResult(updated_arguments={**ctx.arguments, "b": 2})

    @pre_tool_use
    def double_b(ctx: PreToolUseContext) -> PreToolUseResult:
        return PreToolUseResult(updated_arguments={**ctx.arguments, "b": ctx.arguments["b"] * 2})

    outcome = await HookEngine([add_b, double_b]).run_pre_tool_use(
        tool_name="t", arguments={"a": 1}, session_id="s1"
    )
    assert outcome.denied is False
    assert outcome.arguments == {"a": 1, "b": 4}


@pytest.mark.asyncio
async def test_pre_tool_use_matcher_filters_by_tool_name():
    @pre_tool_use(matcher="delete_*")
    def guard(ctx: PreToolUseContext) -> PreToolUseResult:
        return PreToolUseResult(permission="deny", reason="x")

    engine = HookEngine([guard])
    denied = await engine.run_pre_tool_use(tool_name="delete_card", arguments={}, session_id="s")
    allowed = await engine.run_pre_tool_use(tool_name="read_card", arguments={}, session_id="s")
    assert denied.denied is True
    assert allowed.denied is False


@pytest.mark.parametrize(
    "matcher",
    ["[delete_*", "tool[0-9", "[!abc", "prefix_[a-z"],
)
def test_malformed_matcher_rejected_at_decoration(matcher: str) -> None:
    with pytest.raises(ValueError, match="malformed hook matcher"):
        pre_tool_use(matcher=matcher)


@pytest.mark.parametrize(
    "matcher",
    ["delete_*", "tool[0-9]", "tool[!12]", "get*balance", "[abc]", ""],
)
def test_well_formed_matcher_accepted_at_decoration(matcher: str) -> None:
    hook = pre_tool_use(matcher=matcher)(lambda ctx: None)  # must not raise
    assert isinstance(hook, Hook)


def test_decorators_produce_hooks_in_both_forms() -> None:
    @session_start
    def bare(ctx):
        return None

    @pre_tool_use(matcher="x_*")
    def parameterized(ctx):
        return None

    assert bare == Hook("SessionStart", bare.callback)
    assert parameterized.event == "PreToolUse"
    assert parameterized.matcher == "x_*"


def test_resolve_hooks_snapshots_and_rejects_non_hooks() -> None:
    @session_end
    def fine(ctx):
        return None

    assert resolve_hooks(None) is None
    assert resolve_hooks([fine]) == (fine,)
    with pytest.raises(TypeError, match="must be Hook"):
        resolve_hooks([lambda ctx: None])  # type: ignore[list-item]


@pytest.mark.asyncio
async def test_slow_hook_logs_warning(monkeypatch: pytest.MonkeyPatch) -> None:
    @session_end
    def slow(ctx: SessionEndContext) -> None:
        return None

    # First call (hook start) returns 0.0; every call after (including any
    # made outside the hook, e.g. by the event loop) returns 5.0 — 5s
    # elapsed, well over the warning threshold.
    times = itertools.chain([0.0], itertools.repeat(5.0))
    monkeypatch.setattr("cosmo_ai._internal.hooks.time.monotonic", lambda: next(times))

    logged: list[dict[str, object]] = []
    monkeypatch.setattr(
        "cosmo_ai._internal.hooks.logger.warning",
        lambda event, **kw: logged.append({"event": event, **kw}),
    )

    from cosmo_ai.session import DisconnectReason

    await HookEngine([slow]).run_session_end(
        SessionEndContext(reason=DisconnectReason.CLIENT_ENDED, detail=None, session_id="s")
    )

    assert len(logged) == 1
    assert logged[0]["event"] == "realtime.hook_slow"
    assert logged[0]["hook_event"] == "SessionEnd"
    assert logged[0]["elapsed_ms"] == 5000.0


@pytest.mark.asyncio
async def test_fast_hook_does_not_log_warning(monkeypatch: pytest.MonkeyPatch) -> None:
    @session_end
    def fast(ctx: SessionEndContext) -> None:
        return None

    logged: list[dict[str, object]] = []
    monkeypatch.setattr(
        "cosmo_ai._internal.hooks.logger.warning",
        lambda event, **kw: logged.append({"event": event, **kw}),
    )

    from cosmo_ai.session import DisconnectReason

    await HookEngine([fast]).run_session_end(
        SessionEndContext(reason=DisconnectReason.CLIENT_ENDED, detail=None, session_id="s")
    )

    assert logged == []


@pytest.mark.asyncio
async def test_throwing_hook_is_isolated():
    ran: list[str] = []

    @session_end
    def boom(ctx: SessionEndContext) -> None:
        raise RuntimeError("kaboom")

    @session_end
    def ok(ctx: SessionEndContext) -> None:
        ran.append("ok")

    # Must not raise; the second hook still runs.
    from cosmo_ai.session import DisconnectReason

    await HookEngine([boom, ok]).run_session_end(
        SessionEndContext(reason=DisconnectReason.CLIENT_ENDED, detail=None, session_id="s")
    )
    assert ran == ["ok"]


@pytest.mark.asyncio
async def test_post_tool_use_observes_outcome():
    seen: list[object] = []

    @post_tool_use
    async def observe(ctx: PostToolUseContext) -> None:
        seen.append(ctx.outcome)

    engine = HookEngine([observe])
    await engine.run_post_tool_use(
        PostToolUseContext(
            tool_name="t", arguments={"a": 1}, outcome=ToolOk(result={"r": 1}), session_id="s"
        )
    )
    await engine.run_post_tool_use(
        PostToolUseContext(
            tool_name="t", arguments={}, outcome=ToolDenied(reason="no"), session_id="s"
        )
    )
    assert seen == [ToolOk(result={"r": 1}), ToolDenied(reason="no")]


def test_public_surface() -> None:
    import cosmo_ai as cr
    import cosmo_ai.hooks as hooks_mod

    assert sorted(hooks_mod.__all__) == [
        "EndCall",
        "Hook",
        "PostToolUseContext",
        "PreToolUseContext",
        "PreToolUseResult",
        "Say",
        "ServerHook",
        "SessionEndContext",
        "SessionStartContext",
        "SessionStartResult",
        "SilenceTimeout",
        "ToolDenied",
        "ToolError",
        "ToolOk",
        "post_tool_use",
        "pre_tool_use",
        "session_end",
        "session_start",
    ]
    for name in ("HookRegistry", "SessionStartContext", "PreToolUseResult", "ToolOk"):
        assert not hasattr(cr, name), name
