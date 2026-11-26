"""Flow and reply rates for the current application of each Pipeline Job."""

from collections import Counter

STAGES = ("applied", "screen", "interview", "offer", "accepted")


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
    sources = {}
    replies = 0
    for row in rows:
        furthest, rejected = histories[row["job_id"]]
        replied = furthest >= 1 or rejected
        replies += replied
        for index in range(min(furthest, 3) + 1):
            reached[index] += 1
        # A backward Move preserves reach, but its blue exit names the current Stage.
        stage = None if row["closed_reason"] else row["stage"]
        terminals[min(furthest, 3), stage, row["closed_reason"]] += 1
        source = sources.setdefault(row["source"], {"applied": 0, "replies": 0})
        source["applied"] += 1
        source["replies"] += replied
    return {
        "total": len(rows),
        "job_ids": list(histories),
        "replies": replies,
        "reached": reached,
        "terminals": [
            {"at": at, "stage": stage, "closed_reason": reason, "count": count}
            for (at, stage, reason), count in terminals.items()
        ],
        "sources": [{"name": name, **sources[name]} for name in sorted(sources)],
    }
