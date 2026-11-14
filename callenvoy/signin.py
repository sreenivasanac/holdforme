"""Prints a one-time console sign-in link (first use without mail, or recovery). Run on the server:

    uv run python -m callenvoy.signin [email]      (default: the admin, OWNER_EMAIL)

Same rules as a mailed link: one use, SIGNIN_TOKEN_MINUTES, bound to that address (the account is made at the
first sign-in, as by mail). Reads PUBLIC_BASE_URL and OWNER_EMAIL from .env when they are not set.
"""

import os
import sys

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
    email = (sys.argv[1] if len(sys.argv) > 1 else store.admin_email()).strip().lower()
    if not auth.email_ok(email):
        raise SystemExit("usage: uv run python -m callenvoy.signin [email]  (without an address OWNER_EMAIL is used)")
    store.open_db()
    print(f"Sign-in link for {email} (one use, {config.SIGNIN_TOKEN_MINUTES} minutes):\n{auth.signin_link(email)}")
