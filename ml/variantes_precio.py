"""Variantes del modelo A (LightGBM) para la tabla de ablación y para elegir en la interfaz.

Cada variante es un dict de opciones; ModeloGBM las aplica igual en CV, en el ajuste final y en
predict.py. Todas devuelven log(precio).
  features : 1 (v1, 13,7 %) | 2 (+ atributos del texto, piso, antigüedad)
  calle    : agrega la calle (primera palabra de la dirección) como categoría
  target   : "log_price" | "log_ppm2" (log USD/m²; se suma log m² al predecir)
  pesos    : "ninguno" | "balanceado" (peso 1 en el centro de la distribución de precios y hasta
             1,5 en los deciles extremos, para que las colas baratas y caras pesen más)
  objetivo : "l2" | "huber" | "l1"
  segmentos: modelos separados por superficie (< 100 m² y ≥ 100 m², entrenados con solape)
"""
from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

VARIANTES = {
    "v1": {"features": 1, "calle": False, "target": "log_price", "pesos": "ninguno", "objetivo": "l2", "segmentos": False},
    "v2_texto": {"features": 2, "calle": False, "target": "log_price", "pesos": "ninguno", "objetivo": "l2", "segmentos": False},
    "v2_texto_calle": {"features": 2, "calle": True, "target": "log_price", "pesos": "ninguno", "objetivo": "l2", "segmentos": False},
    "v2_ppm2": {"features": 2, "calle": True, "target": "log_ppm2", "pesos": "ninguno", "objetivo": "l2", "segmentos": False},
    "v2_pesos": {"features": 2, "calle": True, "target": "log_price", "pesos": "balanceado", "objetivo": "l2", "segmentos": False},
    "v2_huber": {"features": 2, "calle": True, "target": "log_price", "pesos": "ninguno", "objetivo": "huber", "segmentos": False},
    "v2_l1": {"features": 2, "calle": True, "target": "log_price", "pesos": "ninguno", "objetivo": "l1", "segmentos": False},
    "v2_segmentos": {"features": 2, "calle": True, "target": "log_price", "pesos": "ninguno", "objetivo": "l2", "segmentos": True},
    "v3_ppm2_huber": {"features": 2, "calle": True, "target": "log_ppm2", "pesos": "ninguno", "objetivo": "huber", "segmentos": False},
    "v3_ppm2_pesos": {"features": 2, "calle": True, "target": "log_ppm2", "pesos": "balanceado", "objetivo": "l2", "segmentos": False},
    "v3_ppm2_huber_pesos": {"features": 2, "calle": True, "target": "log_ppm2", "pesos": "balanceado", "objetivo": "huber", "segmentos": False},
}
CORTE_SEG, SOLAPE = 100, 20
MIN_CALLE = 15


def pesos_balanceados(y_log_price, sup, bins=10):
    q2 = np.quantile(y_log_price, np.linspace(0, 1, bins + 1)[1:-1])
    b2 = np.digitize(y_log_price, q2)
    w = 1 + 0.5 * (np.abs(b2 - (bins - 1) / 2) / ((bins - 1) / 2)) ** 2
    return w / w.mean()


class ModeloGBM:
    def __init__(self, opts: dict, params: dict, n_estimators=5000, seed=42):
        self.o, self.p, self.n, self.seed = opts, params, n_estimators, seed

    def _lgbm(self, n):
        import lightgbm as lgb
        obj = {"l2": "regression", "huber": "huber", "l1": "regression_l1"}[self.o["objetivo"]]
        extra = {"alpha": 0.15} if obj == "huber" else {}
        return lgb.LGBMRegressor(objective=obj, n_estimators=n, learning_rate=self.p["learning_rate"], num_leaves=self.p["num_leaves"],
                                 min_child_samples=self.p["min_child_samples"], reg_lambda=self.p.get("reg_lambda", 0.0),
                                 subsample=0.8, subsample_freq=1, colsample_bytree=0.8, cat_smooth=10, verbose=-1,
                                 random_state=self.seed, **extra)

    def _y(self, y, sup):
        return y - np.log(sup) if self.o["target"] == "log_ppm2" else y

    def _segs(self, sup, train=False):
        if not self.o["segmentos"]:
            return {"todo": np.ones(len(sup), bool)}
        if train:
            return {"chico": sup < CORTE_SEG + SOLAPE, "grande": sup >= CORTE_SEG - SOLAPE}
        return {"chico": sup < CORTE_SEG, "grande": sup >= CORTE_SEG}

    def fit(self, X, y, sup, eval_set=None, n_por_seg=None):
        """eval_set=(Xva, yva, supva): early stopping; si no, n_por_seg = árboles por segmento."""
        import lightgbm as lgb
        warnings.filterwarnings("ignore", category=Warning, module="lightgbm")
        self.models, self.best = {}, {}
        w_all = pesos_balanceados(y, sup) if self.o["pesos"] == "balanceado" else np.ones(len(y))
        for k, m in self._segs(sup, train=True).items():
            if eval_set is not None:
                Xva, yva, supva = eval_set
                mv = self._segs(supva, train=True)[k]
                mdl = self._lgbm(self.n).fit(X[m], self._y(y[m], sup[m]), sample_weight=w_all[m],
                                             eval_set=[(Xva[mv], self._y(yva[mv], supva[mv]))], eval_metric="l1",
                                             callbacks=[lgb.early_stopping(100, verbose=False)])
                self.best[k] = int(mdl.best_iteration_ or self.n)
            else:
                mdl = self._lgbm(int(n_por_seg[k])).fit(X[m], self._y(y[m], sup[m]), sample_weight=w_all[m])
                self.best[k] = int(n_por_seg[k])
            self.models[k] = mdl
        return self

    def predict(self, X, sup):
        out = np.zeros(len(X))
        for k, m in self._segs(np.asarray(sup, float)).items():
            if m.any():
                mdl = self.models[k]
                out[m] = mdl.predict(X[m], num_iteration=self.best.get(k))
        return out + np.log(sup) if self.o["target"] == "log_ppm2" else out

    @property
    def feature_name_(self):
        return next(iter(self.models.values())).feature_name_

    @property
    def booster_(self):
        return next(iter(self.models.values())).booster_


def agregar_calle(X: pd.DataFrame, d: pd.DataFrame) -> pd.DataFrame:
    import precio
    X = X.copy()
    X["calle"] = d["address"].map(lambda a: (precio.clave_direccion(a) or "|").split("|")[0] or None).astype("category") if "address" in d \
        else pd.Series(np.nan, index=d.index, dtype="category")
    return X


def niveles_calle(serie_train: pd.Series) -> list[str]:
    vc = serie_train.astype(object).value_counts()
    return sorted(str(v) for v in vc[vc >= MIN_CALLE].index)
