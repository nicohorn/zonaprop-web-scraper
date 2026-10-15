"""Predicción con un modelo de precio guardado (modelo A).

  echo {"run": "<id o vacío = último>", "inputs": {...}} | python ml/predict.py

Responde un JSON por stdout: precio estimado (en la moneda del modelo), USD/m², rango a partir de
los cuantiles de error del test y las métricas de test del modelo.
"""
from __future__ import annotations

import json
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
sys.path.insert(0, str(Path(__file__).parent))

import numpy as np
import pandas as pd

import zpml

RUNS = zpml.DATA / "ml" / "runs"
LATEST = zpml.DATA / "ml" / "latest_price.json"

DEFAULTS = {"barrio": "Palermo", "tipo": "departamento", "superficie_total": 55, "superficie_cubierta": 50,
            "ambientes": 2, "dormitorios": 1, "banos": 1, "cocheras": 0, "expensas": None}


def fail(msg):
    print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
    sys.exit(0)


def num(v):
    try:
        return None if v in (None, "") else float(v)
    except (TypeError, ValueError):
        return None


def main():
    req = json.loads(sys.stdin.read() or "{}")
    run = req.get("run") or (json.loads(LATEST.read_text(encoding="utf-8"))["run"] if LATEST.exists() else None)
    if not run:
        fail("Todavía no hay un modelo de precio guardado: entrená el modelo A primero.")
    if not all(c.isalnum() or c in "-_" for c in run):
        fail("Corrida inválida.")
    path = RUNS / run / "model.joblib"
    if not path.exists():
        fail(f"La corrida {run} no tiene modelo guardado: entrená el modelo A primero.")
    import joblib
    bundle = joblib.load(path)
    meta = bundle["meta"]
    if not meta.get("predictable", True):
        fail("Ese modelo se entrenó con variables de texto; el formulario no puede generarlas. Elegí otro.")

    x = {**DEFAULTS, **{k: v for k, v in (req.get("inputs") or {}).items() if v not in (None, "")}}
    row = {
        "id": "pred", "url": "", "title": "", "description_short": "", "photos": [], "highlight": None,
        "posting_type": "PROPERTY", "barrio": x["barrio"], "tipo_prop": x["tipo"], "location": f"{x['barrio']}, Capital Federal",
        **{k: num(x.get(k)) for k in ["superficie_total", "superficie_cubierta", "ambientes", "dormitorios", "banos", "cocheras", "expensas"]},
    }
    df = pd.DataFrame([row])
    X, _, _ = zpml.build_features(df)
    X = X.reindex(columns=meta["columns"])
    for c in meta["cats"]:
        X[c] = pd.Categorical(X[c].astype(object), categories=meta["levels"][c])
    for c in meta["nums"]:
        if c in X:
            X[c] = pd.to_numeric(X[c], errors="coerce").astype(float)

    sup = zpml.superficie(df).iloc[0]
    if not sup or not np.isfinite(sup):
        fail("Indicá la superficie (total o cubierta).")
    raw = float(bundle["gbm"].predict(X)[0])
    ridge_raw = float(bundle["ridge"].predict(X.astype({c: object for c in meta["cats"]}))[0])
    to_price = (lambda v: float(np.exp(v))) if meta["target"] == "log_price" else (lambda v: float(v * sup))
    price, ridge_price = to_price(raw), to_price(ridge_raw)
    q = meta["resid_log_quantiles"]
    warn = []
    if x["barrio"] not in meta["levels"].get("barrio", []):
        warn.append(f"El modelo no vio avisos en {x['barrio']}: la predicción ignora el barrio.")
    if x["tipo"] not in meta.get("tipos", []):
        warn.append(f"El modelo no se entrenó con '{x['tipo']}'.")
    gb = next((v for k, v in meta["metricas_test"].items() if not k.startswith("Ridge")), {})
    print(json.dumps({
        "ok": True, "run": run, "modelo": meta["modelo"], "moneda": "USD" if meta["currency"] != "ARS" else "ARS",
        "operacion": meta["operacion"], "precio": round(price), "precio_m2": round(price / sup, 1), "superficie_usada": sup,
        # rango: precio real / predicho en el test, percentiles 10–90 y 25–75
        "rango_80": [round(price * np.exp(q["q10"])), round(price * np.exp(q["q90"]))],
        "rango_50": [round(price * np.exp(q["q25"])), round(price * np.exp(q["q75"]))],
        "ridge_precio": round(ridge_price), "error_test": gb, "n_train": meta["n_train"], "n_test": meta["n_test"],
        "split": meta.get("split"), "avisos": warn, "inputs": x,
    }, ensure_ascii=False, default=lambda o: o.item() if hasattr(o, "item") else str(o)))


if __name__ == "__main__":
    main()
