from fastapi.testclient import TestClient

from joule.app import create_app


def test_appearance_defaults_persist_and_validate(tmp_path):
    with TestClient(create_app(tmp_path), base_url="http://localhost") as client:
        assert client.get("/api/appearance").json() == {
            "theme": "system",
            "density": "compact",
        }
        for theme, density in [
            ("light", "comfortable"),
            ("dark", "compact"),
            ("system", "comfortable"),
        ]:
            expected = {"theme": theme, "density": density}
            response = client.put("/api/appearance", json=expected)
            assert response.status_code == 200 and response.json() == expected
            assert client.get("/api/appearance").json() == expected
        for invalid in [{"theme": "night"}, {"density": "dense"}, {"extra": True}]:
            assert client.put("/api/appearance", json=invalid).status_code == 422
        assert sorted(p.name for p in tmp_path.iterdir()) == [
            "appearance.json",
            "joule.db",
        ]
    with TestClient(create_app(tmp_path), base_url="http://localhost") as client:
        assert client.get("/api/appearance").json() == expected
