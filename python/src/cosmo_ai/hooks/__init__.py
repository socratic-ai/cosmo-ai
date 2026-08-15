"""Hooks for the realtime SDK: in-process lifecycle callbacks fired by the
session at four seams, plus declarative server hooks the SERVER executes.

Two kinds of hooks, one idea (when X happens, do Y), one ``hooks=[...]`` list:

* **client hooks** — your callbacks, run in-process. Declare with the seam
  decorators: ``@hooks.session_start``, ``@hooks.pre_tool_use(matcher=...)``,
  ``@hooks.post_tool_use``, ``@hooks.session_end``. List order is fold order.

A fired server hook reaches you as a ``UserSpeechTimeoutEvent`` event on
the session's event stream, not as a hook — hooks are seams in what this
process does, events are what the server did.
* **server hooks** — wire config the server executes, working even if this
  process dies mid-call: :class:`SilenceTimeout` with a :class:`Say` or
  :class:`EndCall` action.

See :mod:`cosmo_ai._internal.hooks` for the dispatch semantics (pinned by
the shared hook-engine vectors).
"""

from cosmo_ai._internal.protocol import EndCall, Say, ServerHook, SilenceTimeout

from cosmo_ai._internal.hooks import (
    Hook,
    PostToolUseContext,
    PreToolUseContext,
    PreToolUseResult,
    SessionEndContext,
    SessionStartContext,
    SessionStartResult,
    ToolDenied,
    ToolError,
    ToolOk,
    post_tool_use,
    pre_tool_use,
    session_end,
    session_start,
)

__all__ = [
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
