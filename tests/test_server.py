"""Tests for the FastAPI service layer: model registry, decision endpoint, page."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from serve.app import create_app

MODEL_REPOSITORY = Path(__file__).resolve().parents[2] / "ant-4b"
RUN_DIR = MODEL_REPOSITORY / "runs" / "example"

pytestmark = pytest.mark.skipif(
    not (RUN_DIR / "ant_head.pt").exists(),
    reason="runs/example checkpoint not present",
)


def _payload(**overrides):
    body = {
        "state": "The customer was charged twice for the same invoice.",
        "question": "Which team should handle this case?",
        "candidates": ["Billing", "Technical Support", "Sales", "Legal"],
    }
    body.update(overrides)
    return body


@pytest.fixture(scope="module")
def client():
    # two distinct runs so the registry, the selector and the default-model
    # logic are exercised; with max_loaded=1 only one predictor is ever alive
    app = create_app([RUN_DIR, RUN_DIR.parent / "mock-dot"], allow_mock=True)
    with TestClient(app) as test_client:
        yield test_client


def test_health_lists_models_with_metadata(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["max_loaded"] == 1
    assert body["models"][0]["name"] == "example"
    assert body["models"][0]["scorer"] == "dot"
    assert body["models"][0]["scoring_dim"] == 32
    assert body["models"][0]["escalation"] in {"risk_coverage", "always_execute", "unknown"}


def test_models_endpoint_matches_health(client):
    assert client.get("/api/models").json() == {
        "models": client.get("/api/health").json()["models"]
    }


def test_decision_returns_probabilities_and_action(client):
    response = client.post("/api/decision", json=_payload())
    assert response.status_code == 200
    body = response.json()
    result = body["result"]
    assert body["model"] == "example"  # first registered model is the default
    assert result["choice"] in result["probabilities"]
    assert result["action"] in {"execute", "escalate"}
    assert pytest.approx(sum(result["probabilities"].values()), abs=1e-5) == 1.0
    assert body["latency_ms"] >= 0
    assert result["n_candidates"] == 4
    assert set(result["scores"]) == set(result["probabilities"])


def test_decision_switches_models(client):
    both = client.get("/api/models").json()["models"]
    assert [m["name"] for m in both] == ["example", "mock-dot"]
    response = client.post("/api/decision", json=_payload(model="mock-dot"))
    assert response.status_code == 200
    assert response.json()["model"] == "mock-dot"


def test_decision_accepts_explicit_model_name(client):
    response = client.post("/api/decision", json=_payload(model="example"))
    assert response.status_code == 200
    assert response.json()["model"] == "example"


def test_unknown_model_is_a_clean_404(client):
    response = client.post("/api/decision", json=_payload(model="does-not-exist"))
    assert response.status_code == 404
    assert "unknown model" in response.json()["detail"]


def test_decision_is_permutation_invariant(client):
    """Reordering candidates cannot change their probabilities (README claim)."""
    candidates = _payload()["candidates"]
    original = client.post("/api/decision", json=_payload()).json()["result"]
    reversed_input = client.post(
        "/api/decision", json=_payload(candidates=list(reversed(candidates)))
    ).json()["result"]
    for candidate, probability in original["probabilities"].items():
        assert reversed_input["probabilities"][candidate] == pytest.approx(probability, abs=1e-5)


def test_decision_accepts_temperature_dial(client):
    default = client.post("/api/decision", json=_payload()).json()["result"]
    sharpened = client.post("/api/decision", json=_payload(temperature=0.5)).json()["result"]
    # lower T sharpens the distribution; assert the floors stay valid and the
    # total is preserved
    assert min(sharpened["probabilities"].values()) <= min(default["probabilities"].values()) + 1e-6
    assert pytest.approx(sum(sharpened["probabilities"].values()), abs=1e-5) == 1.0


def test_decision_rejects_invalid_bodies(client):
    assert client.post("/api/decision", json=_payload(candidates=["only-one"])).status_code == 422
    assert client.post("/api/decision", json=_payload(state="")).status_code == 422


def test_cards_expose_display_name_and_example_count(client):
    card = client.get("/api/models").json()["models"][0]
    assert card["display_name"] == card["name"]  # no card.json: falls back to the name
    assert card["n_examples"] == 0


def test_examples_come_from_the_run_directory(tmp_path):
    run = tmp_path / "with-examples"
    shutil.copytree(RUN_DIR, run)
    rows = [{"state": "s", "question": "q", "candidates": ["a", "b"], "correct": "a"}]
    (run / "examples.json").write_text(json.dumps(rows))
    (run / "card.json").write_text(json.dumps({"display_name": "Pretty name"}))
    with TestClient(create_app([run], allow_mock=True)) as local:
        card = local.get("/api/models").json()["models"][0]
        assert card["display_name"] == "Pretty name" and card["n_examples"] == 1
        assert local.get("/api/examples").json()["examples"] == rows
        assert local.get("/api/examples?model=nope").status_code == 404


def test_mock_checkpoints_are_refused_by_default():
    with pytest.raises(ValueError, match="mock-backbone"):
        create_app([RUN_DIR])


def test_no_page_is_served(client):
    assert client.get("/").status_code == 404


def _typed_payload(**overrides):
    body = {
        "state": "The customer was charged twice for the same invoice and asks for a refund.",
        "questions": {
            "team": {
                "type": "choice",
                "instructions": "Which team should handle this ticket?",
                "criteria": {"billing": "invoices and refunds", "technical": "bugs"},
            },
            "refund": {
                "type": "noul",
                "instructions": "Is the customer asking for money back?",
            },
            "urgency": {
                "type": "score",
                "instructions": "How urgent is this?",
                "criteria": ["not urgent", "soon", "blocking"],
            },
        },
    }
    body.update(overrides)
    return body


def test_typed_answers_all_three_kinds(client):
    response = client.post("/api/typed", json=_typed_payload())
    assert response.status_code == 200
    body = response.json()
    assert body["model"] == "example"
    assert body["latency_ms"] >= 0
    answers = body["answers"]
    assert set(answers) == {"team", "refund", "urgency"}

    team = answers["team"]
    assert team["type"] == "choice"
    assert team["choice"] in {"billing", "technical"}
    assert set(team["probabilities"]) == {"billing", "technical"}

    refund = answers["refund"]
    assert refund["type"] == "noul"
    assert 0.0 <= refund["noul"] <= 1.0
    assert set(refund["probabilities"]) == {"yes", "no"}

    urgency = answers["urgency"]
    assert urgency["type"] == "score"
    assert 0.0 <= urgency["score"] <= 2.0
    assert set(urgency["legend"].values()) == {"not urgent", "soon", "blocking"}
    assert set(urgency["probabilities"]) == {"0", "1", "2"}


def test_typed_reports_the_answering_model(client):
    body = _typed_payload(model="mock-dot")
    response = client.post("/api/typed", json=body)
    assert response.status_code == 200
    assert response.json()["model"] == "mock-dot"


def test_typed_unknown_model_is_a_clean_404(client):
    response = client.post("/api/typed", json=_typed_payload(model="does-not-exist"))
    assert response.status_code == 404
    assert "unknown model" in response.json()["detail"]


def test_typed_malformed_question_is_a_422_naming_it(client):
    body = _typed_payload()
    body["questions"]["broken"] = {"type": "box", "instructions": "Find the logo"}
    response = client.post("/api/typed", json=body)
    assert response.status_code == 422
    assert "broken" in response.json()["detail"]


def test_typed_rejects_empty_questions(client):
    assert client.post("/api/typed", json=_typed_payload(questions={})).status_code == 422
