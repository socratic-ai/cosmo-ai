"""The SDK's logger factory — quiet unless the embedding app opts in.

structlog's unconfigured default renders straight to stdout, so a bare
``structlog.get_logger()`` in library code interleaves SDK diagnostics with the
app's own output the moment the SDK is imported. Libraries don't get to make
that choice for their callers, so every SDK logger binds to a stdlib logger
under the ``cosmo_ai`` namespace, which carries a :class:`~logging.NullHandler`
— nothing is emitted until the app attaches a handler and lowers the level::

    logging.basicConfig()
    logging.getLogger("cosmo_ai").setLevel(logging.INFO)

Only the *sink* is pinned. The processor chain still resolves through the
global structlog configuration, so an app that configures structlog renders SDK
logs in its own format, and ``structlog.testing.capture_logs`` still sees them.
"""

from __future__ import annotations

import logging
from typing import cast

import structlog

NAMESPACE = "cosmo_ai"

logging.getLogger(NAMESPACE).addHandler(logging.NullHandler())


def get_logger(name: str) -> structlog.stdlib.BoundLogger:
    """A structlog logger writing through the stdlib logger named ``name``."""
    return cast(
        structlog.stdlib.BoundLogger,
        structlog.wrap_logger(
            logging.getLogger(name),
            wrapper_class=structlog.stdlib.BoundLogger,
        ),
    )
