import json
from contextlib import closing

from fastapi.testclient import TestClient

from joule.app import create_app
from joule.db import connect
from joule.job_urls import url_key


def test_lookup_all_jobs_destinations_duplicates_and_ambiguity(tmp_path):
    with TestClient(create_app(tmp_path), base_url="http://localhost") as client:
        with closing(connect(tmp_path / "joule.db")) as db, db:
            db.executemany(
                "INSERT INTO jobs(id,source,source_id,link,title,first_seen_at) "
                "VALUES(?,'hotfix',?,?,'Engineer','now')",
                [(i, str(i), f"https://example.com/{i}") for i in range(1, 503)],
            )
            db.execute(
                "UPDATE jobs SET extra=? WHERE id=501",
                (
                    json.dumps(
                        dict(
                            apply_url="https://jobs.lever.co/acme/501",
                            application_url="https://jobs.ashbyhq.com/acme/502",
                        )
                    ),
                ),
            )
            db.execute("UPDATE jobs SET primary_id=502 WHERE id=501")
            db.execute(
                "UPDATE jobs SET state='applied', filtered_reason='pay' WHERE id=502"
            )
            db.execute("UPDATE jobs SET source='upwork' WHERE id=500")

        def lookup(url):
            response = client.get("/api/jobs/resolve", params={"url": url})
            assert response.status_code == 200
            assert "access-control-allow-origin" not in response.headers
            return response.json()

        for url in (
            "https://example.com/502",
            "https://jobs.lever.co/acme/501/apply/?utm_source=feed#form",
            "https://jobs.ashbyhq.com/acme/502/application/",
        ):
            assert lookup(url) == dict(
                id=502, title="Engineer", company=None, source="hotfix"
            )
        for url in (
            "https://example.com/500",
            "https://example.com/unknown",
            "http://example.com/502",
            "invalid",
            "file:///tmp/form",
        ):
            assert lookup(url) is None
        with closing(connect(tmp_path / "joule.db")) as db, db:
            row = db.execute("SELECT state FROM jobs WHERE id=502").fetchone()
            assert row[0] == "applied"
            db.execute("UPDATE jobs SET link='https://example.com/502' WHERE id=1")
        assert lookup("https://example.com/502") is None


def test_preserve_greenhouse_job_id():
    url = "https://example.com/careers?gh_jid=123"
    assert url_key(url) == url_key(url + "&utm_source=feed&gh_src=feed#form")
    assert url_key(url) != url_key(url.replace("123", "456"))
