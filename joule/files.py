"""Publish complete local files without exposing a partially written document."""

from pathlib import Path
from tempfile import NamedTemporaryFile


def atomic_write(path: Path, text: str | bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    # tempfile supplies unique writers; Path.replace atomically publishes the file.
    # https://docs.python.org/3.13/library/tempfile.html#tempfile.NamedTemporaryFile
    try:
        with NamedTemporaryFile(
            mode="wb" if isinstance(text, bytes) else "w",
            encoding=None if isinstance(text, bytes) else "utf-8",
            dir=path.parent,
            delete=False,
        ) as file:
            temporary = Path(file.name)
            file.write(text)
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
