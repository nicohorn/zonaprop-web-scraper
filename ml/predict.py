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

DEFAULTS = {"barrio": "Palermo", "tipo": "departamento", "superficie_total": 55, "superficie_cubierta": None,
            "ambientes": 2, "dormitorios": 1, "banos": 1, "cocheras": 0, "expensas": None}
# Casillas del formulario -> mismas palabras clave que zpml.FLAGS busca en el texto del aviso
FLAG_TEXT = {"a_estrenar": "a estrenar", "balcon_terraza": "balcon", "amenities": "amenities", "apto_credito": "apto credito"}


def truthy(v):
    return v is True or str(v).lower() in ("1", "true", "on", "si", "sí", "yes")


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
    warn = []
    levels = meta["levels"]
    barrio = str(x["barrio"])
    if barrio not in levels.get("barrio", []):
        # Barrio no visto: el modelo lo trata como faltante (NaN) y se avisa; el rango se ensancha de hecho.
        warn.append(f"El modelo no vio avisos en {barrio}: la predicción no usa el barrio (menos precisa).")
    if x["tipo"] not in meta.get("tipos", []):
        warn.append(f"El modelo no se entrenó con '{x['tipo']}'.")
    if not meta.get("usa_superficie_cubierta", True) and x.get("superficie_cubierta") not in (None, ""):
        # El listado no trae superficie cubierta: el modelo aprendió con la superficie total.
        if num(x.get("superficie_total")) is None:
            x["superficie_total"] = x["superficie_cubierta"]
        x["superficie_cubierta"] = None
    flags = " ".join(t for k, t in FLAG_TEXT.items() if truthy(x.get(k)))
    extra = []
    if num(x.get("piso")) is not None:
        extra.append(f"piso {int(num(x['piso']))}")
    if num(x.get("antiguedad")) is not None:
        extra.append(f"{int(num(x['antiguedad']))} anos de antiguedad")
    # Texto libre: mismas palabras clave que en los avisos; los montos se borran como en el entrenamiento
    texto = zpml.strip_amounts(str(x.get("descripcion") or ""))[:2000]
    row = {
        "id": "pred", "url": "", "title": " ".join([flags, *extra]), "description_short": texto, "pills": [],
        "address": str(x.get("direccion") or "")[:200],
        "barrio": barrio, "tipo_prop": x["tipo"], "location": f"{barrio}, Capital Federal",
        **{k: num(x.get(k)) for k in ["superficie_total", "superficie_cubierta", "ambientes", "dormitorios", "banos", "cocheras", "expensas"]},
    }
    df = pd.DataFrame([row])
    sup = zpml.superficie(df).iloc[0]
    if not sup or not np.isfinite(sup) or sup <= 0:
        fail("Indicá la superficie (total o cubierta).")
    e = row["expensas"]
    if e is not None and not (200 <= e / sup <= 30000):
        warn.append("Expensas fuera de rango para la superficie: se ignoran.")
        df["expensas"] = np.nan
    opts = meta.get("opciones") or {"features": 1}

    def matriz(columns, cats, nums, lv, version, calle=False):
        X, _, _ = zpml.build_features(df, version=version)
        if calle:
            import variantes_precio as vp
            X = vp.extender(X, df, opts)
        X = X.reindex(columns=columns)
        for c in cats:
            X[c] = pd.Categorical(X[c].astype(object), categories=lv[c])
        for c in nums:
            if c in X:
                X[c] = pd.to_numeric(X[c], errors="coerce").astype(float)
        return X

    X = matriz(meta["columns"], meta["cats"], meta["nums"], levels, int(opts.get("features", 1)), bool(opts.get("calle")))
    if opts.get("calle") and row.get("address") and pd.isna(X["calle"].iloc[0]):
        warn.append("La calle no está entre las vistas en el entrenamiento (≥ 15 avisos): se ignora.")
    Xb = X if "columns_base" not in meta else matriz(meta["columns_base"], meta["cats_base"], meta["nums_base"], meta["levels_base"], 1)
    raw = float(bundle["gbm"].predict(X, np.array([sup]))[0]) if "opciones" in meta else float(bundle["gbm"].predict(X)[0])
    Xr = Xb.astype({c: object for c in meta.get("cats_base", meta["cats"])})
    ridge_raw = float(bundle["ridge"].predict(Xr)[0])
    to_price = (lambda v: float(np.exp(v))) if meta["target"] == "log_price" else (lambda v: float(v * sup))
    price, ridge_price = to_price(raw), to_price(ridge_raw)
    q = meta["resid_log_quantiles"]
    bmed = meta.get("barrio_ppm2_mediana", {}).get(barrio)
    gb = next((v for k, v in meta["metricas_test"].items() if not k.startswith("Ridge")), {})
    print(json.dumps({
        "ok": True, "run": run, "modelo": meta["modelo"], "moneda": "USD" if meta["currency"] != "ARS" else "ARS",
        "operacion": meta["operacion"], "precio": round(price), "precio_m2": round(price / sup, 1), "superficie_usada": sup,
        # rango: precio real / predicho en el test, percentiles 10–90 y 25–75
        "rango_80": [round(price * np.exp(q["q10"])), round(price * np.exp(q["q90"]))],
        "rango_50": [round(price * np.exp(q["q25"])), round(price * np.exp(q["q75"]))],
        "ridge_precio": round(ridge_price), "baseline_barrio_precio": round(bmed * sup) if bmed else None,
        "cobertura_test": meta.get("cobertura_test_%"), "error_test": gb, "n_train": meta["n_train"], "n_test": meta["n_test"],
        "split": meta.get("split"), "avisos": warn, "inputs": x,
    }, ensure_ascii=False, default=lambda o: o.item() if hasattr(o, "item") else str(o)))


if __name__ == "__main__":
    main()
