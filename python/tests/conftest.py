import sys
from pathlib import Path

import pytest

# The SDK is unpublished (local-path installs only); make `cosmo_ai`
# importable without an editable install.
_SRC = Path(__file__).resolve().parents[1] / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))


@pytest.fixture(autouse=True)
def _pin_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pin the SDK's base URL to a fixed test host so a developer's ambient
    ``COSMO_BASE_URL`` can't leak in and change the URLs the mock transports
    match on. Tests exercising base-URL resolution override this themselves."""
    monkeypatch.setenv("COSMO_BASE_URL", "https://api.test")
