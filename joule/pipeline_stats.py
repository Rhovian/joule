"""Flow and reply rates for the current application of each Pipeline Job."""

from collections import Counter

STAGES = ("applied", "screen", "interview", "offer", "accepted")
BANDS = ("90+", "80–89", "70–79", "<70", "Unscored")


def summarize(db, rows):
    histories = {row["job_id"]: [0, False] for row in rows}
    for move in db.execute(
        "SELECT h.job_id,h.stage,h.closed_reason FROM pipeline_moves h "
        "JOIN pipeline p ON p.job_id=h.job_id AND h.id>=p.first_move_id"
    ):
        if move["job_id"] in histories:
            history = histories[move["job_id"]]
            history[0] = max(history[0], STAGES.index(move["stage"]))
            history[1] |= move["closed_reason"] == "rejected"
    reached = [0] * 4
    terminals = Counter()
    bands = {band: {"applied": 0, "replies": 0} for band in BANDS}
    sources = {}
    replies = 0
    for row in rows:
        furthest, rejected = histories[row["job_id"]]
        replied = furthest >= 1 or rejected
        replies += replied
        for index in range(min(furthest, 3) + 1):
            reached[index] += 1
        # A backward Move preserves reach, but its blue exit names the current Stage.
        terminals[min(furthest, 3), row["stage"], row["closed_reason"]] += 1
        score = row["score"]
        band = (
            "Unscored"
            if score is None
            else BANDS[
                0 if score >= 90 else 1 if score >= 80 else 2 if score >= 70 else 3
            ]
        )
        source = sources.setdefault(row["source"], {"applied": 0, "replies": 0})
        for group in (bands[band], source):
            group["applied"] += 1
            group["replies"] += replied
    return {
        "total": len(rows),
        "replies": replies,
        "reached": reached,
        "terminals": [
            {"at": at, "stage": stage, "closed_reason": reason, "count": count}
            for (at, stage, reason), count in terminals.items()
        ],
        "bands": [{"name": name, **values} for name, values in bands.items()],
        "sources": [{"name": name, **sources[name]} for name in sorted(sources)],
    }
