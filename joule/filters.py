import re

from joule.config import Preferences
from joule.sources import Candidate


def tidy(text: str) -> str:
    words = re.sub(r"[^\w\s]", " ", text.lower()).split()
    return " ".join(word for word in words if word not in {"inc", "ltd"})


def location_unclear(candidate: Candidate) -> bool:
    return not candidate.remote and candidate.city is None


def filter_reason(candidate: Candidate, preferences: Preferences) -> str | None:
    return None
