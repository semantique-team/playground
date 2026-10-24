"""FastAPI app that exposes ANT checkpoints as a typed decision API.

Endpoints:
    GET  /api/health    — registry summary and per-model configurations.
    GET  /api/models    — the models served by this instance.
    POST /api/decision  — state + question + candidates (+ optional model,
                          temperature) -> choice, probabilities, confidence,
                          execute/escalate.
    POST /api/typed     — state + typed questions (choice/noul/score, System
                          One style) -> one typed answer per question id.
    GET  /api/examples  — real held-out inputs shipped with a model (?model=name).

This is a pure API; the Vite web interface in this repository can point at any
number of these servers.

Models are registered eagerly (a light config.json read) but loaded lazily on
first use, with an LRU eviction so several hubs of a model family can share
one process without keeping every backbone in memory.
"""

from __future__ import annotations

import json
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Sequence

import torch
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from ant.config import ANTConfig
from ant.inference.cache import CandidateEmbeddingCache
from ant.inference.escalation import AlwaysExecute
from ant.inference.predictor import ANTPredictor
from ant.inference.typed import TypedQuestionError, answer_questions
from ant.types import PredictionResult

_MAX_CANDIDATES = 100
_WARMUP_CALL = ("warmup state", "warmup question", ["a", "b"])


def _read_policy_name(run: Path) -> str:
    """Escalation policy name from escalation.json, 'always_execute' if absent."""
    policy_file = run / "escalation.json"
    if not policy_file.exists():
        return "always_execute"
    return json.loads(policy_file.read_text()).get("name", "unknown")


def _read_card(run: Path) -> dict[str, Any]:
    """Optional card.json written by training: display_name, description."""
    card_file = run / "card.json"
    return json.loads(card_file.read_text()) if card_file.exists() else {}


def read_examples(run: Path) -> list[dict[str, Any]]:
    """Playground examples from examples.json: real inputs, never generated here."""
    examples_file = run / "examples.json"
    return json.loads(examples_file.read_text()) if examples_file.exists() else []


class ModelRegistry:
    """Named set of checkpoint directories, lazily loaded, LRU-evicted."""

    def __init__(
        self,
        runs: list[Path],
        *,
        backbone: str | None = None,
        backend: str = "torch",
        max_loaded: int | None = 1,
    ) -> None:
        names = [run.name for run in runs]
        if len(set(names)) != len(names):
            raise ValueError("run directories must have distinct names")
        self.backbone_override = backbone
        self.backend = backend
        self.max_loaded = max_loaded
        self._entries: OrderedDict[str, Path] = OrderedDict(zip(names, runs))
        self._loaded: OrderedDict[str, ANTPredictor] = OrderedDict()

    def names(self) -> list[str]:
        return list(self._entries)

    def describe(self) -> list[dict[str, Any]]:
        """Light metadata per model: checkpoint config, no weights loaded."""
        cards: list[dict[str, Any]] = []
        for name, run in self._entries.items():
            config = ANTConfig.load(run / "config.json")
            card = _read_card(run)
            cards.append(
                {
                    "name": name,
                    "display_name": card.get("display_name", name),
                    "description": card.get("description"),
                    "n_examples": len(read_examples(run)),
                    "backbone_model": config.backbone_model,
                    "scorer": config.scorer,
                    "scoring_dim": config.scoring_dim,
                    "calibratable": (run / "calibrator.pt").exists(),
                    "escalation": _read_policy_name(run),
                    "loaded": name in self._loaded,
                }
            )
        return cards

    def run_dir(self, name: str) -> Path:
        return self._entries[name]

    def get(self, name: str) -> ANTPredictor:
        """Load on first use; keep at most ``max_loaded`` predictors alive."""
        if name not in self._entries:
            raise KeyError(name)
        if name in self._loaded:
            self._loaded.move_to_end(name)
            return self._loaded[name]
        predictor = load_predictor(
            self._entries[name], backbone=self.backbone_override, backend=self.backend
        )
        self._loaded[name] = predictor
        while self.max_loaded is not None and len(self._loaded) > self.max_loaded:
            # the freshly loaded predictor sits last, so eviction frees the
            # oldest one; with max_loaded=1 memory never grows with the family
            self._loaded.popitem(last=False)
        return self._loaded[name]


def _build_mlx_backbone(model_id: str, config: ANTConfig):
    """Apple Silicon MLX backbone; weight quantization is read from the model folder."""
    from ant.backbone.mlx import MlxBackbone

    quantization = None
    bits, group_size = 8, 64
    model_config = Path(model_id) / "config.json"
    if model_config.is_file():
        packed = json.loads(model_config.read_text()).get("quantization_config") or {}
        if packed.get("bits") is not None and packed.get("group_size") is not None:
            quantization = "mlx"
            bits = int(packed["bits"])
            group_size = int(packed["group_size"])
    return MlxBackbone(
        model_id,
        torch_dtype=config.torch_dtype,
        device="cpu",  # the torch head stays on CPU; MLX runs on Metal internally
        max_length=config.max_context_tokens,
        quantization=quantization,
        quantization_bits=bits,
        quantization_group_size=group_size,
    )


def load_predictor(
    run: Path, *, backbone: str | None = None, backend: str = "torch", warmup: bool = True
) -> ANTPredictor:
    """Load a run directory as a serving-ready predictor.

    ``ANTModel.load`` already knows how to rebuild both backbone types: a mock
    backbone from the checkpoint blob itself, or the Qwen checkpoint named in
    config.json. Passing ``backbone`` overrides only the latter, e.g. to serve
    a head checkpoint from a moved or downloaded backbone directory. ``backend``
    selects the inference implementation: ``torch`` (default) or ``mlx`` for
    Apple Silicon.
    """
    run = Path(run)
    if not (run / "ant_head.pt").exists():
        raise FileNotFoundError(f"no ant_head.pt under {run}")
    if backbone is not None or backend == "mlx":
        config = ANTConfig.load(run / "config.json")
        if config.backbone_model == "mock":
            raise ValueError("backbone override is only valid for real-backbone checkpoints")
        model_id = backbone or config.backbone_model
        if backend == "mlx":
            qwen = _build_mlx_backbone(model_id, config)
        else:
            from ant.backbone.qwen import QwenBackbone

            qwen = QwenBackbone(
                model_id,
                torch_dtype=config.torch_dtype,
                device="auto",  # the saved device is the training machine's, not this one
                max_length=config.max_context_tokens,
                attn_implementation=config.attn_implementation,
            )
        predictor = ANTPredictor.load(run, backbone=qwen, map_location="cpu")
    else:
        predictor = ANTPredictor.load(run, map_location="cpu")
    predictor.candidate_cache = CandidateEmbeddingCache()
    if warmup:
        # pay encoder/tokenizer one-time costs now, not on the first request
        predictor.predict(*_WARMUP_CALL)
    return predictor


class DecisionRequest(BaseModel):
    """One routing decision, the same shape the playground sends."""

    state: str = Field(min_length=1, max_length=8000)
    question: str = Field(min_length=1, max_length=2000)
    candidates: list[str] = Field(min_length=2, max_length=_MAX_CANDIDATES)
    model: str | None = Field(default=None, description="Registry name; defaults to the first model")
    temperature: float | None = Field(default=None, gt=0.0, le=20.0)


class DecisionResponse(BaseModel):
    """PredictionResult plus the latency and model the caller needs to know."""

    result: dict[str, Any]
    model: str
    latency_ms: float


class TypedRequest(BaseModel):
    """System One style typed questions about one state.

    Each question is ``{type, instructions, criteria}`` where type is one of
    ``choice``, ``noul``, ``score``; see ``ant.inference.typed`` for the exact
    criteria shapes and the answer layout.
    """

    state: str = Field(min_length=1, max_length=8000)
    questions: dict[str, dict[str, Any]] = Field(min_length=1, max_length=64)
    model: str | None = Field(default=None, description="Registry name; defaults to the first model")
    temperature: float | None = Field(default=None, gt=0.0, le=20.0)


class TypedResponse(BaseModel):
    """One typed answer per question id, plus the model and total latency."""

    answers: dict[str, dict[str, Any]]
    model: str
    latency_ms: float


class ModelsResponse(BaseModel):
    models: list[dict[str, Any]]


class HealthResponse(BaseModel):
    models: list[dict[str, Any]]
    max_loaded: int | None


def create_app(
    runs: Sequence[Path],
    *,
    backbone: str | None = None,
    backend: str = "torch",
    allow_mock: bool = False,
) -> FastAPI:
    """Build the app over one or more checkpoint directories.

    The first registered model is warmed at startup (loading all its one-time
    costs); later models load lazily on their first request. Mock-backbone
    checkpoints only exist for tests and are refused unless ``allow_mock``.
    """
    registry = ModelRegistry([Path(run) for run in runs], backbone=backbone, backend=backend)
    if not registry.names():
        raise ValueError("at least one run directory is required")
    if not allow_mock:
        mocks = [
            name
            for name in registry.names()
            if ANTConfig.load(registry.run_dir(name) / "config.json").backbone_model == "mock"
        ]
        if mocks:
            raise ValueError(
                f"mock-backbone checkpoints give meaningless answers: {mocks}; "
                "serve a real-backbone run or pass allow_mock=True / --allow-mock"
            )
    registry.get(registry.names()[0])  # warm the default model

    app = FastAPI(
        title="ANT decision API",
        description="System 1 candidate scoring: state + question + candidates "
        "-> choice, probabilities, confidence, execute/escalate.",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(
            models=registry.describe(),
            max_loaded=registry.max_loaded,
        )

    @app.get("/api/models", response_model=ModelsResponse)
    def models() -> ModelsResponse:
        return ModelsResponse(models=registry.describe())

    @app.post("/api/decision", response_model=DecisionResponse)
    def decide(request: DecisionRequest) -> DecisionResponse:
        model_name = request.model or registry.names()[0]
        try:
            predictor = registry.get(model_name)
        except KeyError as error:
            raise HTTPException(
                status_code=404, detail=f"unknown model {model_name!r}; GET /api/models for the list"
            ) from error
        previous_temperature = predictor.temperature
        if request.temperature is not None:
            predictor.temperature = request.temperature
        started = time.perf_counter()
        try:
            with torch.no_grad():
                try:
                    result: PredictionResult = predictor.predict(
                        request.state, request.question, request.candidates
                    )
                except Exception as error:
                    raise HTTPException(
                        status_code=500, detail=f"prediction failed: {error}"
                    ) from error
        finally:
            predictor.temperature = previous_temperature
        latency_ms = (time.perf_counter() - started) * 1000.0
        return DecisionResponse(
            result=result.to_dict(), model=model_name, latency_ms=round(latency_ms, 2)
        )

    @app.post("/api/typed", response_model=TypedResponse)
    def typed(request: TypedRequest) -> TypedResponse:
        model_name = request.model or registry.names()[0]
        try:
            predictor = registry.get(model_name)
        except KeyError as error:
            raise HTTPException(
                status_code=404, detail=f"unknown model {model_name!r}; GET /api/models for the list"
            ) from error
        previous_temperature = predictor.temperature
        if request.temperature is not None:
            predictor.temperature = request.temperature
        started = time.perf_counter()
        try:
            with torch.no_grad():
                try:
                    answers = answer_questions(predictor, request.state, request.questions)
                except TypedQuestionError as error:
                    raise HTTPException(status_code=422, detail=str(error)) from error
                except Exception as error:
                    raise HTTPException(
                        status_code=500, detail=f"prediction failed: {error}"
                    ) from error
        finally:
            predictor.temperature = previous_temperature
        latency_ms = (time.perf_counter() - started) * 1000.0
        return TypedResponse(
            answers=answers, model=model_name, latency_ms=round(latency_ms, 2)
        )

    @app.get("/api/examples")
    def examples(model: str | None = None) -> dict[str, Any]:
        model_name = model or registry.names()[0]
        if model_name not in registry.names():
            raise HTTPException(status_code=404, detail=f"unknown model {model_name!r}")
        return {"model": model_name, "examples": read_examples(registry.run_dir(model_name))}

    return app
