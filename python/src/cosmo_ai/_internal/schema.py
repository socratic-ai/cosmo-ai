"""JSON-Schema handling for client tools, against the backend's restricted
dialect (``client_declared.py``: allowlisted keys, top-level ``type:
"object"``, depth ≤ 6, ≤ 64 properties total).

Two deliberately different policies live here:

* **Strict builder pipeline** (``build_tool_parameters`` /
  ``emit_model_schema``) for authored tools (`cosmo_ai.tools`):
  inline refs, silently drop only what doesn't change what the model should
  produce, and raise :class:`ToolSchemaError` at construction for anything
  the dialect cannot express — otherwise the model would keep producing args
  that bounce at runtime.
* **Permissive sanitizer** (``sanitize_schema_permissive``) for the MCP
  proxy: foreign servers' schemas can't be fixed by the author, so unknown
  keys are dropped instead of rejected.

The dialect check mirrors the backend gate node-for-node — depth counts from
1 at the top level, the property cap is global across the schema — and is
pinned against the shared vectors in
``client-tool-schema-vectors.json``.
"""

from __future__ import annotations

import json
import re
from typing import Any

from pydantic import BaseModel

from cosmo_ai.errors import ToolSchemaError

SCHEMA_ALLOWED_KEYS = frozenset(
    {
        "type",
        "properties",
        "required",
        "items",
        "enum",
        "description",
        "anyOf",
        "default",
        "maxLength",
        "minLength",
        "maximum",
        "minimum",
    }
)
_SCHEMA_NUMERIC_KEYS = frozenset({"maxLength", "minLength", "maximum", "minimum"})
_SCHEMA_ALLOWED_TYPES = frozenset(
    {"object", "string", "number", "integer", "boolean", "array", "null"}
)
_SCHEMA_MAX_DEPTH = 6
_SCHEMA_MAX_PROPERTIES = 64

# Mirrors the backend's ``text_sanitize``: control characters and forged
# ``---`` prompt-section fences are rejected there, so catch them here at
# construction instead of at connect.
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")
_CONTROL_CHARS_EXCEPT_NEWLINE_RE = re.compile(r"[\x00-\x09\x0b-\x1f\x7f]")
_PROMPT_FENCE_RE = re.compile(r"^[ \t]*-{3,}.*$", re.MULTILINE)


def text_violation(value: str, *, allow_newlines: bool) -> str | None:
    """First sanitization violation in ``value``, or ``None`` if clean."""
    control_re = _CONTROL_CHARS_EXCEPT_NEWLINE_RE if allow_newlines else _CONTROL_CHARS_RE
    if control_re.search(value):
        return "contains a control character"
    if _PROMPT_FENCE_RE.search(value):
        return "contains a prompt section delimiter"
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Permissive path (MCP proxy)
# ─────────────────────────────────────────────────────────────────────────────


def sanitize_schema_permissive(node: Any) -> Any:
    """Reduce a schema node to the dialect's allowed keys, dropping everything
    else silently. Never raises — the MCP proxy uses this for foreign
    servers' schemas."""
    if not isinstance(node, dict):
        return node
    out: dict[str, Any] = {}
    for key, value in node.items():
        if key not in SCHEMA_ALLOWED_KEYS:
            continue
        if key == "properties" and isinstance(value, dict):
            out[key] = {k: sanitize_schema_permissive(v) for k, v in value.items()}
        elif key == "items":
            out[key] = sanitize_schema_permissive(value)
        elif key == "anyOf" and isinstance(value, list):
            out[key] = [sanitize_schema_permissive(v) for v in value]
        else:
            out[key] = value
    return out


_SCHEMA_MAX_BYTES = 8 * 1024  # the backend's _CLIENT_TOOL_MAX_SCHEMA_BYTES


def schema_bound_violation(schema: dict[str, Any]) -> str | None:
    """First size bound a sanitized foreign schema still exceeds — ``"bytes"``,
    ``"depth"``, or ``"properties"`` — or ``None`` when within the backend's
    caps. Dropping unknown keys can't fix an over-bound schema, so the MCP
    proxy skips such a tool up front. The two backend outcomes it preempts
    differ: an over-``bytes`` schema fails request validation and rejects the
    whole session start; over-``depth``/``properties`` schemas are rejected
    per-tool at connect (a ``rejected_tools`` echo). The skip turns both into
    the same structured build-time signal. Text rules are deliberately not
    pre-checked — the backend rejects those per-tool and the session survives.
    Traversal mirrors ``_check_node``: depth from 1, property count global
    across the schema."""
    serialized = json.dumps(schema, separators=(",", ":"))
    if len(serialized.encode("utf-8")) > _SCHEMA_MAX_BYTES:
        return "bytes"
    props_total = 0

    def walk(node: Any, depth: int) -> str | None:
        nonlocal props_total
        if depth > _SCHEMA_MAX_DEPTH:
            return "depth"
        if not isinstance(node, dict):
            return None
        props = node.get("properties")
        if isinstance(props, dict):
            props_total += len(props)
            if props_total > _SCHEMA_MAX_PROPERTIES:
                return "properties"
            for child in props.values():
                found = walk(child, depth + 1)
                if found is not None:
                    return found
        if "items" in node:
            found = walk(node["items"], depth + 1)
            if found is not None:
                return found
        any_of = node.get("anyOf")
        if isinstance(any_of, list):
            for variant in any_of:
                found = walk(variant, depth + 1)
                if found is not None:
                    return found
        return None

    return walk(schema, 1)


# ─────────────────────────────────────────────────────────────────────────────
# Strict path (tool builders)
# ─────────────────────────────────────────────────────────────────────────────

_SAFE_DROP_KEYS = frozenset({"title", "$schema"})

_ESCAPE_HATCH_HINT = (
    "rewrite the model within the dialect or pass hand-written raw "
    "`parameters` on ClientTool instead"
)


def _inline_refs(schema: dict[str, Any], *, tool_name: str) -> dict[str, Any]:
    """Inline ``$defs``/``$ref`` (and merge single-element ``allOf`` wrappers
    Pydantic emits for annotated nested models). Recursive models raise —
    the dialect has no way to express them."""
    defs = schema.get("$defs") or {}

    def resolve(node: Any, stack: frozenset[str]) -> Any:
        if isinstance(node, list):
            return [resolve(item, stack) for item in node]
        if not isinstance(node, dict):
            return node
        out = dict(node)
        out.pop("$defs", None)
        all_of = out.get("allOf")
        if isinstance(all_of, list) and len(all_of) == 1 and isinstance(all_of[0], dict):
            del out["allOf"]
            merged = dict(all_of[0])
            merged.update(out)  # sibling keys (description, default) win
            out = merged
        ref = out.get("$ref")
        if isinstance(ref, str):
            del out["$ref"]
            def_name = ref.removeprefix("#/$defs/")
            if def_name == ref or def_name not in defs:
                raise ToolSchemaError(
                    code="forbidden_key",
                    message=f"{tool_name}: unresolvable $ref {ref!r}",
                )
            if def_name in stack:
                raise ToolSchemaError(
                    code="recursive_schema",
                    message=(
                        f"{tool_name}: recursive model {def_name!r} cannot be "
                        f"expressed in the tool-schema dialect; {_ESCAPE_HATCH_HINT}"
                    ),
                )
            merged = dict(resolve(defs[def_name], stack | {def_name}))
            merged.update(out)
            out = merged
        return {key: resolve(value, stack) for key, value in out.items()}

    resolved = resolve(schema, frozenset())
    assert isinstance(resolved, dict)
    return resolved


def _normalize_node(node: Any, *, tool_name: str) -> Any:
    """Safe normalization: drop ``title``/``$schema``, drop
    ``additionalProperties`` when ``true``, rewrite ``const`` as a one-value
    ``enum``. ``additionalProperties: false`` and schema-valued
    ``additionalProperties`` raise — dropping them would tell the model
    extra keys are fine while validation rejects them."""
    if isinstance(node, list):
        return [_normalize_node(item, tool_name=tool_name) for item in node]
    if not isinstance(node, dict):
        return node
    out: dict[str, Any] = {}
    const: Any = None
    has_const = False
    for key, value in node.items():
        if key in _SAFE_DROP_KEYS:
            continue
        if key == "additionalProperties":
            if value is True:
                continue
            detail = (
                "'additionalProperties: false' (a strict/extra-forbid model)"
                if value is False
                else "schema-valued 'additionalProperties' (a map type)"
            )
            raise ToolSchemaError(
                code="additional_properties_forbidden",
                message=(
                    f"{tool_name}: {detail} cannot be expressed in the "
                    f"tool-schema dialect; use default extra-key handling, "
                    f"{_ESCAPE_HATCH_HINT}"
                ),
            )
        if key == "const":
            has_const = True
            const = value
            continue
        if key == "properties" and isinstance(value, dict):
            out[key] = {
                k: _normalize_node(v, tool_name=tool_name) for k, v in value.items()
            }
        elif key == "items":
            out[key] = _normalize_node(value, tool_name=tool_name)
        elif key == "anyOf" and isinstance(value, list):
            out[key] = [_normalize_node(v, tool_name=tool_name) for v in value]
        else:
            out[key] = value
    if has_const and "enum" not in out:
        out["enum"] = [const]
    return out


def _check_node(
    node: Any, *, depth: int, counts: dict[str, int], tool_name: str
) -> None:
    """Dialect gate, mirroring the backend's ``_schema_violation``. Raises
    :class:`ToolSchemaError` with a stable ``code`` on the first violation."""
    if depth > _SCHEMA_MAX_DEPTH:
        raise ToolSchemaError(
            code="max_depth_exceeded",
            message=f"{tool_name}: schema nesting exceeds depth {_SCHEMA_MAX_DEPTH}",
        )
    if not isinstance(node, dict):
        raise ToolSchemaError(
            code="node_not_object",
            message=f"{tool_name}: schema node is not an object",
        )
    for key, value in node.items():
        if key not in SCHEMA_ALLOWED_KEYS:
            raise ToolSchemaError(
                code="forbidden_key",
                message=(
                    f"{tool_name}: schema key {key!r} is not in the restricted "
                    f"tool-schema dialect; {_ESCAPE_HATCH_HINT}"
                ),
            )
        if key == "type":
            if value not in _SCHEMA_ALLOWED_TYPES:
                raise ToolSchemaError(
                    code="forbidden_type",
                    message=f"{tool_name}: schema type {value!r} is not allowed",
                )
        elif key == "description":
            if not isinstance(value, str):
                raise ToolSchemaError(
                    code="invalid_text",
                    message=f"{tool_name}: schema description is not a string",
                )
            reason = text_violation(value, allow_newlines=True)
            if reason is not None:
                raise ToolSchemaError(
                    code="invalid_text",
                    message=f"{tool_name}: schema description {reason}",
                )
        elif key == "required":
            if not isinstance(value, list) or not all(
                isinstance(item, str) for item in value
            ):
                raise ToolSchemaError(
                    code="invalid_required",
                    message=f"{tool_name}: schema 'required' is not a list of strings",
                )
        elif key == "enum":
            if not isinstance(value, list) or not all(
                isinstance(item, (str, int, float, bool)) for item in value
            ):
                raise ToolSchemaError(
                    code="invalid_enum",
                    message=f"{tool_name}: schema 'enum' is not a list of scalars",
                )
        elif key == "properties":
            if not isinstance(value, dict):
                raise ToolSchemaError(
                    code="invalid_properties",
                    message=f"{tool_name}: schema 'properties' is not an object",
                )
            counts["properties"] += len(value)
            if counts["properties"] > _SCHEMA_MAX_PROPERTIES:
                raise ToolSchemaError(
                    code="max_properties_exceeded",
                    message=(
                        f"{tool_name}: schema exceeds "
                        f"{_SCHEMA_MAX_PROPERTIES} properties"
                    ),
                )
            for prop_name, prop_schema in value.items():
                if not isinstance(prop_name, str) or text_violation(
                    prop_name, allow_newlines=False
                ):
                    raise ToolSchemaError(
                        code="invalid_text",
                        message=(
                            f"{tool_name}: schema property name is not a clean string"
                        ),
                    )
                _check_node(
                    prop_schema, depth=depth + 1, counts=counts, tool_name=tool_name
                )
        elif key == "items":
            _check_node(value, depth=depth + 1, counts=counts, tool_name=tool_name)
        elif key == "anyOf":
            if not isinstance(value, list):
                raise ToolSchemaError(
                    code="invalid_any_of",
                    message=f"{tool_name}: schema 'anyOf' is not a list",
                )
            for variant in value:
                _check_node(variant, depth=depth + 1, counts=counts, tool_name=tool_name)
        elif key == "default":
            if isinstance(value, str):
                reason = text_violation(value, allow_newlines=False)
                if reason is not None:
                    raise ToolSchemaError(
                        code="invalid_text",
                        message=f"{tool_name}: schema default {reason}",
                    )
            elif not isinstance(value, (int, float, bool, type(None))):
                raise ToolSchemaError(
                    code="invalid_default",
                    message=f"{tool_name}: schema 'default' must be a scalar",
                )
        elif key in _SCHEMA_NUMERIC_KEYS:
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ToolSchemaError(
                    code="invalid_bound",
                    message=f"{tool_name}: schema {key!r} is not a number",
                )


def check_schema_dialect(schema: Any, *, tool_name: str) -> None:
    """Raise :class:`ToolSchemaError` unless ``schema`` is a top-level object
    schema entirely within the restricted dialect."""
    if not isinstance(schema, dict) or schema.get("type") != "object":
        raise ToolSchemaError(
            code="top_level_not_object",
            message=f"{tool_name}: parameters must declare top-level type 'object'",
        )
    _check_node(schema, depth=1, counts={"properties": 0}, tool_name=tool_name)


def build_tool_parameters(
    schema: dict[str, Any], *, tool_name: str
) -> dict[str, Any]:
    """Strict pipeline for an authored schema: inline refs → normalize →
    dialect check. Returns the wire-ready ``parameters`` dict."""
    inlined = _inline_refs(schema, tool_name=tool_name)
    normalized = _normalize_node(inlined, tool_name=tool_name)
    check_schema_dialect(normalized, tool_name=tool_name)
    assert isinstance(normalized, dict)
    return normalized


def emit_model_schema(
    model: type[BaseModel], *, tool_name: str
) -> dict[str, Any]:
    """Wire-ready ``parameters`` for a Pydantic input model."""
    return build_tool_parameters(model.model_json_schema(), tool_name=tool_name)
