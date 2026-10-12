"""The /v1/systemone endpoint against a fake model: no torch, no download."""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator
from typing import Any

import pytest

from pruner_systemone_server import PATH, serve
from pruner_systemone_server.cli import is_loopback, parse_args

SECRET = "transcript text that must never be echoed"
QUESTIONS = {
    "call_t1": {"type": "noul", "instructions": "Should the call stay?"},
    "result_t1": {"type": "noul", "instructions": "Should the result stay?"},
}


class FakeModel:
    """Answers every question with P(yes) = 0.25 and records what it was asked."""

    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.calls: list[tuple[Any, dict[str, Any]]] = []

    def system_one(self, state: Any, questions: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((state, questions))
        if self.fail:
            raise ValueError(f"cannot read {state}")
        return {"answers": {name: {"noul": 0.25} for name in questions}, "usage": {"input_tokens": 3}}


Start = Callable[..., str]


@pytest.fixture
def start() -> Iterator[Start]:
    servers = []

    def run(model: FakeModel, max_body: int = 4096) -> str:
        server = serve(model, "127.0.0.1", 0, max_body)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
        return f"http://127.0.0.1:{server.server_address[1]}"

    yield run
    for server in servers:
        server.shutdown()
        server.server_close()


def request(url: str, body: bytes | None = None) -> tuple[int, dict[str, Any]]:
    headers = {"Content-Type": "application/json"}
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=headers)) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def body(payload: Any) -> bytes:
    return json.dumps(payload).encode("utf-8")


def test_answers_the_questions_over_the_state(start: Start) -> None:
    model = FakeModel()
    state = {"goal": "fix the test", "history": []}
    status, response = request(
        start(model) + PATH, body({"model": "d1", "state": state, "questions": QUESTIONS})
    )
    assert status == 200
    assert response == {
        "answers": {"call_t1": {"noul": 0.25}, "result_t1": {"noul": 0.25}},
        "usage": {"input_tokens": 3},
    }
    assert model.calls == [(state, QUESTIONS)]


@pytest.mark.parametrize(
    "payload",
    [
        b"not json " + SECRET.encode(),
        body([SECRET]),
        body({"state": SECRET}),
        body({"state": SECRET, "questions": {"q": {"type": "essay", "instructions": SECRET}}}),
    ],
)
def test_refuses_bad_requests_without_quoting_them(start: Start, payload: bytes) -> None:
    model = FakeModel()
    status, response = request(start(model) + PATH, payload)
    assert status == 400
    assert SECRET not in json.dumps(response)
    assert model.calls == []


def test_hides_what_a_failing_model_says(start: Start) -> None:
    status, response = request(
        start(FakeModel(fail=True)) + PATH, body({"state": SECRET, "questions": QUESTIONS})
    )
    assert status == 500
    assert SECRET not in json.dumps(response)


def test_refuses_an_oversized_body(start: Start) -> None:
    status, _ = request(
        start(FakeModel(), max_body=64) + PATH, body({"state": "x" * 200, "questions": QUESTIONS})
    )
    assert status == 413


def test_serves_health_and_nothing_else(start: Start) -> None:
    url = start(FakeModel())
    assert request(url + "/health") == (200, {"ok": True})
    assert request(url + "/v1/other", body({}))[0] == 404


def test_listens_on_loopback_by_default() -> None:
    args = parse_args(["--model", "LiquidAI/d1-3B"])
    assert (args.host, args.port, args.trust_remote_code) == ("127.0.0.1", 8000, False)
    assert all(is_loopback(host) for host in ["127.0.0.1", "::1", "localhost"])
    assert not is_loopback("0.0.0.0")
    with pytest.raises(SystemExit):
        parse_args([])
