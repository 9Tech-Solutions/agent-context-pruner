"""The /v1/systemone HTTP endpoint, around any object with a system_one(state, questions) method."""

from __future__ import annotations

import json
import logging
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Protocol

PATH = "/v1/systemone"
QUESTION_TYPES = frozenset({"noul", "choice", "score"})
log = logging.getLogger("pruner_systemone_server")


class SystemOneModel(Protocol):
    """What LiquidAI/d1-3B's remote code exposes: named questions over one state, in one pass."""

    def system_one(self, state: Any, questions: dict[str, Any]) -> Any: ...


class BadRequest(Exception):
    """A request the server refuses. Messages never quote the request, which holds transcript text."""

    def __init__(self, status: HTTPStatus, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def parse_request(body: bytes) -> tuple[Any, dict[str, Any]]:
    """The state and questions of a SystemOne request body: `{"model", "state", "questions"}`."""
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        raise BadRequest(HTTPStatus.BAD_REQUEST, "body is not valid JSON") from None
    if not isinstance(payload, dict):
        raise BadRequest(HTTPStatus.BAD_REQUEST, "body must be a JSON object")
    questions = payload.get("questions")
    if not isinstance(questions, dict) or not questions:
        raise BadRequest(HTTPStatus.BAD_REQUEST, "questions must be a non-empty object")
    for question in questions.values():
        if not isinstance(question, dict) or question.get("type") not in QUESTION_TYPES:
            raise BadRequest(HTTPStatus.BAD_REQUEST, "every question needs a type of noul, choice or score")
    return payload.get("state"), questions


def answer(
    model: SystemOneModel, lock: threading.Lock, state: Any, questions: dict[str, Any]
) -> dict[str, Any]:
    """Asks the model, one request at a time, and keeps only `answers` and `usage` from what it returns."""
    with lock:
        result = model.system_one(state, questions)
    if not isinstance(result, dict) or not isinstance(result.get("answers"), dict):
        raise TypeError("the model returned no answers object")
    response: dict[str, Any] = {"answers": result["answers"]}
    if "usage" in result:
        response["usage"] = result["usage"]
    return response


def make_handler(model: SystemOneModel, max_body: int) -> type[BaseHTTPRequestHandler]:
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        server_version = "pruner-systemone-server"

        def do_GET(self) -> None:
            if self.path == "/health":
                self._send(HTTPStatus.OK, {"ok": True})
            else:
                self._send(HTTPStatus.NOT_FOUND, {"error": "not found"})

        def do_POST(self) -> None:
            if self.path != PATH:
                self._send(HTTPStatus.NOT_FOUND, {"error": "not found"})
                return
            try:
                state, questions = parse_request(self._read_body())
                self._send(HTTPStatus.OK, answer(model, lock, state, questions))
            except BadRequest as error:
                self._send(error.status, {"error": error.message})
            except Exception as error:  # noqa: BLE001 - any model failure becomes a 500
                # The exception text can quote the state, so only its type is logged.
                log.error("model error: %s", type(error).__name__)
                self._send(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "the model failed on this request"})

        def _read_body(self) -> bytes:
            length = self.headers.get("Content-Length", "")
            if not length.isdigit():
                raise BadRequest(HTTPStatus.LENGTH_REQUIRED, "Content-Length is required")
            if int(length) > max_body:
                raise BadRequest(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, f"body is over {max_body} bytes")
            return self.rfile.read(int(length))

        def _send(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
            data = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    return Handler


def serve(model: SystemOneModel, host: str, port: int, max_body: int) -> ThreadingHTTPServer:
    """A server ready for `serve_forever()`; requests reach the model one at a time."""
    return ThreadingHTTPServer((host, port), make_handler(model, max_body))
