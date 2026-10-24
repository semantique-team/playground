"""Entry point: python -m serve --runs runs/example runs/qwen-dot"""

from __future__ import annotations

import argparse
from pathlib import Path

import uvicorn

from serve.app import create_app


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.strip("\"\n'"))
    parser.add_argument(
        "--runs",
        "--run",
        nargs="+",
        default=["runs/example"],
        help="ANT checkpoint directories (ant_head.pt + config.json); the first "
        "one is the default model, all of them are listed by /api/models.",
    )
    parser.add_argument(
        "--backbone",
        default=None,
        help="Override the Qwen checkpoint path/repoid for real-backbone runs.",
    )
    parser.add_argument(
        "--backend",
        choices=("torch", "mlx"),
        default="torch",
        help="Inference backend for the frozen Qwen backbone; mlx is the "
        "Apple Silicon path (pass an --backbone folder converted with "
        "ant-4b's scripts/mlx_convert.py).",
    )
    parser.add_argument(
        "--allow-mock",
        action="store_true",
        help="serve mock-backbone checkpoints (tests/demos only; answers are meaningless)",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    runs = [Path(run) for run in args.runs]
    for run in runs:
        if not (run / "config.json").exists():
            parser.error(f"{run} does not look like an ANT checkpoint (no config.json)")
    app = create_app(
        runs, backbone=args.backbone, backend=args.backend, allow_mock=args.allow_mock
    )
    print(f"ANT serving {len(runs)} model(s): {', '.join(r.name for r in runs)}")
    print(f"API: http://{args.host}:{args.port}/api/models  (add this URL in the playground)")
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
