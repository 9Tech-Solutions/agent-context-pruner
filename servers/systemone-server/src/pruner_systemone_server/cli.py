"""Command line: load a Hugging Face model that has system_one() and serve it on /v1/systemone."""

from __future__ import annotations

import argparse
import ipaddress
import logging
import sys
from typing import Any

from .app import PATH, SystemOneModel, serve

log = logging.getLogger("pruner_systemone_server")
INSTALL_HINT = "uv run --extra hf pruner-systemone-server ... (or pip install torch transformers)"


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="pruner-systemone-server",
        description="Serve a model with a system_one() method (such as LiquidAI/d1-3B) on /v1/systemone.",
    )
    parser.add_argument("--model", required=True, help="Hugging Face model id or local path")
    parser.add_argument(
        "--trust-remote-code",
        action="store_true",
        help="run the code the model repository ships (d1-3B needs it); only for models you trust",
    )
    parser.add_argument("--host", default="127.0.0.1", help="address to listen on (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="port (default 8000)")
    parser.add_argument("--max-body-mb", type=float, default=8.0, help="largest request body (default 8)")
    return parser.parse_args(argv)


def is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def pick_device(torch: Any) -> tuple[str, Any]:
    """The device and dtype the d1-3B card recommends: float32 on CPU, bfloat16 on a GPU."""
    if torch.cuda.is_available():
        return "cuda", torch.bfloat16
    if torch.backends.mps.is_available():
        return "mps", torch.bfloat16
    return "cpu", torch.float32


def load_model(name: str, trust_remote_code: bool) -> SystemOneModel:
    try:
        import torch
        from transformers import AutoModel
    except ImportError:
        sys.exit(f"torch and transformers are not installed: {INSTALL_HINT}")
    device, dtype = pick_device(torch)
    model = AutoModel.from_pretrained(name, trust_remote_code=trust_remote_code, dtype=dtype).to(device)
    if not callable(getattr(model, "system_one", None)):
        sys.exit(f"{name} has no system_one() method; it may need --trust-remote-code")
    return model


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if not is_loopback(args.host):
        log.warning("listening on %s: anyone who can reach this port can send it transcripts", args.host)
    model = load_model(args.model, args.trust_remote_code)
    server = serve(model, args.host, args.port, int(args.max_body_mb * 1024 * 1024))
    host, port = server.server_address[:2]
    log.info("serving %s at http://%s:%s%s", args.model, host, port, PATH)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
