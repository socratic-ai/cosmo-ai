"""Tool authoring beyond the basics: the raw :class:`ClientTool` spec the
``@tool`` decorator lowers to, the background variant and its job handle, the
construction-time schema error, and the renderer client tools the SDK ships
itself (:func:`draw_box` / :func:`draw_point`)."""

from cosmo_ai.errors import ToolInputValidationError, ToolSchemaError
from cosmo_ai._internal.protocol import (
    BackgroundClientTool,
    ClientTool,
    ScreenLocateTool,
)
from cosmo_ai.tools._draw import (
    DRAW_BOX_TOOL_NAME,
    DRAW_POINT_TOOL_NAME,
    DrawBoxHandler,
    DrawBoxRequest,
    DrawOutcome,
    DrawPointHandler,
    DrawPointRequest,
    NormalizedBox,
    NormalizedPoint,
    draw_box,
    draw_point,
)
from cosmo_ai.tools._screen import (
    screen_click_element,
    screen_highlight_box,
    screen_highlight_element,
    screen_locate,
)
from cosmo_ai.tools._screen_capture import (
    SCREEN_CLICK_TOOL_NAME,
    SCREEN_HIGHLIGHT_BOX_TOOL_NAME,
    SCREEN_HIGHLIGHT_TOOL_NAME,
)
from cosmo_ai.tools._screen_types import (
    ScreenBox,
    ScreenCapture,
    ScreenCaptureHandler,
    ScreenCaptureRequest,
    ScreenClickAction,
    ScreenClickHandler,
    ScreenClickOutcome,
    ScreenClickTarget,
    ScreenElement,
    ScreenElementHint,
    ScreenHighlightBoxHandler,
    ScreenHighlightBoxRequest,
    ScreenHighlightHandler,
    ScreenHighlightOutcome,
    ScreenHighlightTarget,
)
from cosmo_ai.tools._jobs import ClientToolJob
from cosmo_ai.tools._video_geometry import (
    Point,
    Rect,
    Size,
    VideoContentMode,
    box_rect,
    point_position,
)
from cosmo_ai.tools._decorator import tool

__all__ = [
    "BackgroundClientTool",
    "ClientTool",
    "ClientToolJob",
    "DRAW_BOX_TOOL_NAME",
    "DRAW_POINT_TOOL_NAME",
    "DrawBoxHandler",
    "DrawBoxRequest",
    "DrawOutcome",
    "DrawPointHandler",
    "DrawPointRequest",
    "NormalizedBox",
    "NormalizedPoint",
    "Point",
    "Rect",
    "SCREEN_CLICK_TOOL_NAME",
    "SCREEN_HIGHLIGHT_BOX_TOOL_NAME",
    "SCREEN_HIGHLIGHT_TOOL_NAME",
    "ScreenBox",
    "ScreenCapture",
    "ScreenCaptureHandler",
    "ScreenCaptureRequest",
    "ScreenClickAction",
    "ScreenClickHandler",
    "ScreenClickOutcome",
    "ScreenClickTarget",
    "ScreenElement",
    "ScreenElementHint",
    "ScreenHighlightBoxHandler",
    "ScreenHighlightBoxRequest",
    "ScreenHighlightHandler",
    "ScreenHighlightOutcome",
    "ScreenHighlightTarget",
    "ScreenLocateTool",
    "Size",
    "ToolInputValidationError",
    "ToolSchemaError",
    "VideoContentMode",
    "box_rect",
    "draw_box",
    "draw_point",
    "point_position",
    "screen_click_element",
    "screen_highlight_box",
    "screen_highlight_element",
    "screen_locate",
    "tool",
]
