"""The ``cosmo_sdk_`` namespace: client tools the SDK ships itself.

A client tool the SDK ships is still a client tool — it runs in your app — but
the SDK owns its name, description and schema. A caller's tool taking one of
those names would swap it for something the model was told behaves
differently, so the prefix is reserved and the check runs where the tool set
becomes the session config, covering every way a spec can be built.

The SDK's own tools clear that check by construction, not by an allow-list of
names: only this package can build a :class:`_SdkClientTool`, so a hand-built
spec cannot claim an SDK tool's name — not even its exact name, which is the
case an allow-list would let through.
"""

from __future__ import annotations

from collections.abc import Iterable

from cosmo_ai._internal.protocol import AgentTool, ClientTool

SDK_TOOL_NAME_PREFIX = "cosmo_sdk_"
"""Reserved for the client tools the SDK ships itself. (The wider ``cosmo_``
namespace belongs to server tools; the server rejects those too.)"""


class _SdkClientTool(ClientTool):
    """A client tool one of this package's SDK-tool factories built."""


def reserved_name_error(name: str) -> ValueError:
    return ValueError(
        f"tool name {name!r}: the {SDK_TOOL_NAME_PREFIX!r} prefix is "
        f"reserved for tools the SDK ships — rename your tool"
    )


def assert_no_reserved_tool_names(tools: Iterable[AgentTool]) -> None:
    """Raise for a caller-built client tool inside the reserved namespace.

    Raised here rather than left to the server's 422 so the message names the
    offending tool while the caller is still looking at the code that declared
    it. Zero-config server opt-ins carry no name at all, and an SDK-built tool
    is exempt by its type.
    """
    for spec in tools:
        if not isinstance(spec, ClientTool) or isinstance(spec, _SdkClientTool):
            continue
        if spec.name.startswith(SDK_TOOL_NAME_PREFIX):
            raise reserved_name_error(spec.name)
