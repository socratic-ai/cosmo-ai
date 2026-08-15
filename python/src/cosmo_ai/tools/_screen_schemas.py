"""The model-facing declarations for the three screen renderers: the tool
descriptions the model reads and the JSON-Schema parameter blocks it fills in.
Kept apart from the factories that mount them because these are wire contract —
every string and enum here is pinned by ``sdk-client-tool-vectors.json``
and shared with the sibling SDKs, so they change deliberately, not incidentally.
"""

from __future__ import annotations

from typing import Any

_SCREEN_CLICK_DESCRIPTION = (
    "Click an element on the shared screen. Takes a found_element handle from "
    "cosmo_screen_locate — pass one back exactly as you received it, never one "
    "you assembled yourself."
)

_SCREEN_HIGHLIGHT_DESCRIPTION = (
    "Highlight an element on the shared screen — point at it without acting on "
    "it. Takes a found_element handle from cosmo_screen_locate; pass one back "
    "exactly as you received it. Visual only: it never clicks."
)

_SCREEN_HIGHLIGHT_BOX_DESCRIPTION = (
    "Highlight a target on the shared screen, given its box as fractions of the "
    "surface and a tooltip label. This is the default way to point at something: "
    "it draws instantly, with no capture or lookup. Reach for cosmo_screen_locate "
    "and cosmo_sdk_screen_highlight_element only when you cannot give a box, or "
    "when this answered exact: false. A screen tool: it draws on the user's "
    "actual screen, so use it only for the shared screen — never for a camera "
    "feed, and never with a box taken from a camera frame."
)

_FOUND_ELEMENT_PARAMETER: dict[str, Any] = {
    "type": "string",
    "description": "A found_element handle exactly as cosmo_screen_locate returned it.",
}

_LABEL_PARAMETER: dict[str, Any] = {
    "type": "string",
    "maxLength": 80,
    "description": "Tooltip text shown beside the highlight.",
}

_PLACEMENT_PARAMETER: dict[str, Any] = {
    "type": "string",
    "enum": ["auto", "top", "bottom", "left", "right"],
    "description": "Which side of the target the tooltip sits on.",
}

_INTERACTION_PARAMETER: dict[str, Any] = {
    "type": "string",
    "enum": [
        "pointer",
        "click",
        "double_click",
        "left_click",
        "right_click",
        "drag_show",
        "press_hold",
        "inform",
    ],
    "description": (
        "Which glyph the highlight draws — the action being asked of the user."
    ),
}

_SCREEN_CLICK_PARAMETERS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "found_element": _FOUND_ELEMENT_PARAMETER,
        "button": {
            "type": "string",
            "enum": ["left", "right"],
            "description": "'right' opens context menus.",
        },
        "double": {
            "type": "boolean",
            "description": "True for a double-click (open a file, select a word).",
        },
    },
    "required": ["found_element"],
}

_SCREEN_HIGHLIGHT_PARAMETERS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "found_element": _FOUND_ELEMENT_PARAMETER,
        "label": _LABEL_PARAMETER,
        "placement": _PLACEMENT_PARAMETER,
        "interaction": _INTERACTION_PARAMETER,
    },
    "required": ["found_element", "label"],
}

_SCREEN_HIGHLIGHT_BOX_PARAMETERS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "x": {
            "type": "number",
            "minimum": 0,
            "maximum": 1,
            "description": "Target box left edge, fraction 0-1 of the shared surface width.",
        },
        "y": {
            "type": "number",
            "minimum": 0,
            "maximum": 1,
            "description": (
                "Target box top edge, fraction 0-1 of the shared surface height (0 = top)."
            ),
        },
        "width": {
            "type": "number",
            "minimum": 0,
            "maximum": 1,
            "description": "Target box width, fraction 0-1 of the surface width.",
        },
        "height": {
            "type": "number",
            "minimum": 0,
            "maximum": 1,
            "description": "Target box height, fraction 0-1 of the surface height.",
        },
        "label": _LABEL_PARAMETER,
        "element_title": {
            "type": "string",
            "maxLength": 200,
            "description": (
                "The control's own visible text, when it has one, e.g. 'Files changed'. "
                "When it matches the app's accessibility tree the highlight snaps onto "
                "that exact control instead of your box. Send the box regardless — many "
                "apps expose no usable label."
            ),
        },
        "element_role": {
            "type": "string",
            "maxLength": 64,
            "description": "Accessibility role disambiguating the title match, e.g. 'AXButton'.",
        },
        "placement": _PLACEMENT_PARAMETER,
        "interaction": _INTERACTION_PARAMETER,
    },
    "required": ["x", "y", "width", "height", "label"],
}
