"""Prints a one-time console sign-in link (first use without mail, or recovery). Run on the server:

    uv run python -m callenvoy.signin

Same rules as a mailed link: one use, SIGNIN_TOKEN_MINUTES. Reads PUBLIC_BASE_URL from .env when it is not set.
"""

import os

from . import auth, config, store


def load_env_file() -> None:
    """Fills missing variables from ROOT/.env (KEY=VALUE lines), as the systemd unit would."""
    path = config.ROOT / ".env"
    if not path.is_file():
        return
    for line in path.read_text().splitlines():
        name, sep, value = line.strip().partition("=")
        if sep and name and not name.startswith("#"):
            os.environ.setdefault(name.strip(), value.strip().strip("\"'"))


if __name__ == "__main__":
    os.umask(0o077)
    load_env_file()
    store.open_db()
    print(f"Sign-in link (one use, {config.SIGNIN_TOKEN_MINUTES} minutes):\n{auth.signin_link()}")
