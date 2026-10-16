"""Búsqueda de hiperparámetros con Optuna para una variante del modelo A (sólo train, CV agrupado).

  python ml/optuna_precio.py <variante> [n_trials=12] [folds=3]

Nunca mira el test: usa la misma limpieza y el mismo split que precio.entrenar y CV agrupado dentro de train.
Guarda data/ml/optuna/<variante>.json (todos los intentos + mejores parámetros); la tarea A los usa con
hiperparametros=optuna. Se escribe después de cada intento, así una interrupción no pierde lo hecho.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import numpy as np
import optuna

import precio
import variantes_precio as vp
import zpml


def main(variante="v4_todo_sin_iso", n_trials=12, n_folds=3, seed=42):
    df = zpml.load()
    d, _ = precio.limpiar(df)
    d = d.reset_index(drop=True)
    tr0, _ = precio.separar(d, "agrupado", 0.2, seed)
    fl = precio.folds(d["grupo"].values[tr0], n_folds, seed)
    opts = vp.VARIANTES[variante]
    out = zpml.DATA / "ml" / "optuna"; out.mkdir(parents=True, exist_ok=True)
    f = out / f"{variante}.json"
    intentos = []

    def objetivo(trial):
        params = {"num_leaves": trial.suggest_int("num_leaves", 31, 255, log=True),
                  "min_child_samples": trial.suggest_int("min_child_samples", 5, 60, log=True),
                  "learning_rate": trial.suggest_float("learning_rate", 0.02, 0.08, log=True),
                  "reg_lambda": trial.suggest_float("reg_lambda", 1e-3, 10.0, log=True)}
        t = time.time()
        r, _, n = precio.cv_variante(d, tr0, fl, opts, params, 1.0)
        v = float(r["MAPE_mediana_%"].mean())
        intentos.append({"n": trial.number, **params, "arboles": n, "MAPE_cv_%": v, "MAPE_cv_std": float(r["MAPE_mediana_%"].std()),
                         "segundos": round(time.time() - t)})
        best = min(intentos, key=lambda x: x["MAPE_cv_%"])
        f.write_text(json.dumps({"variante": variante, "folds": n_folds, "n_train": int(len(tr0)), "intentos": intentos,
                                 "mejores_parametros": {k: best[k] for k in precio.GRILLA}, "mejor_MAPE_cv_%": best["MAPE_cv_%"],
                                 "nota": "CV agrupado sólo sobre train; el test no se usa."}, ensure_ascii=False, indent=1), encoding="utf-8")
        print(json.dumps(intentos[-1], default=str), flush=True)
        return v

    st = optuna.create_study(direction="minimize", sampler=optuna.samplers.TPESampler(seed=seed))
    # primer intento = la grilla ganadora de la iteración 3, como referencia
    st.enqueue_trial({"num_leaves": 127, "min_child_samples": 10, "learning_rate": 0.03, "reg_lambda": 0.001})
    st.optimize(objetivo, n_trials=n_trials)


if __name__ == "__main__":
    a = sys.argv[1:]
    main(a[0] if a else "v4_todo_sin_iso", int(a[1]) if len(a) > 1 else 12, int(a[2]) if len(a) > 2 else 3)
