"""Variantes del modelo A (LightGBM) para la tabla de ablación y para elegir en la interfaz.

Cada variante es un dict de opciones; ModeloGBM las aplica igual en CV, en el ajuste final y en
predict.py. Todas devuelven log(precio).
  features : 1 (v1, 13,7 %) | 2 (+ atributos del texto, piso, antigüedad)
  calle    : agrega la calle (primera palabra de la dirección) como categoría
  target   : "log_price" | "log_ppm2" (log USD/m²; se suma log m² al predecir)
  pesos    : "ninguno" | "balanceado" (peso 1 en el centro de la distribución de precios y hasta
             1,5 en los deciles extremos, para que las colas baratas y caras pesen más)
  objetivo : "l2" | "huber" | "l1"
  calle_norm: calle normalizada (apellido final, sin "Av.", nombres de pila ni altura)
  te       : target encoding fuera de fold (log USD/m²) de calle, calle+cuadra, barrio×ambientes y barrio×tamaño
  tfidf    : TF-IDF + SVD (30) del texto sin montos, ajustado sólo con el train de cada fold
  calibracion: "isotonica" = corrección post-hoc pred→real ajustada con predicciones fuera de fold
  segmentos: modelos separados por superficie (< 100 m² y ≥ 100 m², entrenados con solape)
"""
from __future__ import annotations

import re
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
    # Iteración 3 (todas parten de v3_ppm2_huber)
    "v4_calle_norm": {"features": 2, "calle": True, "target": "log_ppm2", "pesos": "ninguno", "objetivo": "huber", "segmentos": False, "calle_norm": True},
    "v4_texto3": {"features": 3, "calle": True, "target": "log_ppm2", "pesos": "ninguno", "objetivo": "huber", "segmentos": False, "calle_norm": True},
    "v4_te": {"features": 2, "calle": True, "target": "log_ppm2", "pesos": "ninguno", "objetivo": "huber", "segmentos": False, "calle_norm": True, "te": True},
    "v4_tfidf": {"features": 2, "calle": True, "target": "log_ppm2", "pesos": "ninguno", "objetivo": "huber", "segmentos": False, "calle_norm": True, "tfidf": True},
    "v4_iso": {"features": 2, "calle": True, "target": "log_ppm2", "pesos": "ninguno", "objetivo": "huber", "segmentos": False, "calibracion": "isotonica"},
    "v4_todo": {"features": 3, "calle": True, "target": "log_ppm2", "pesos": "ninguno", "objetivo": "huber", "segmentos": False, "calle_norm": True, "te": True, "tfidf": True, "calibracion": "isotonica"},
    "v4_todo_sin_iso": {"features": 3, "calle": True, "target": "log_ppm2", "pesos": "ninguno", "objetivo": "huber", "segmentos": False, "calle_norm": True, "te": True, "tfidf": True},
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
        X = self._prep_fit(X, y, sup)
        w_all = pesos_balanceados(y, sup) if self.o["pesos"] == "balanceado" else np.ones(len(y))
        for k, m in self._segs(sup, train=True).items():
            if eval_set is not None:
                Xva, yva, supva = eval_set
                Xva = self._prep(Xva)
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

    def _prep_fit(self, X, y, sup):
        """Ajusta (sólo con este train) los target encodings y el TF-IDF+SVD; quita las columnas clave."""
        self.te_maps, self.svd = {}, None
        X = X.copy()
        r = np.asarray(y) - np.log(np.asarray(sup, float))      # log USD/m²
        self.te_global = float(np.mean(r))
        for c in [c for c in X.columns if c.startswith(CLAVE)]:
            k = X[c].astype(object).where(X[c].notna(), None).values
            oof = np.full(len(X), np.nan)
            idx = np.random.default_rng(self.seed).permutation(len(X)) % 5
            for f in range(5):
                mp = _te_tabla(k[idx != f], r[idx != f], self.te_global)
                oof[idx == f] = [mp.get(z, (self.te_global, 0))[0] if z is not None else np.nan for z in k[idx == f]]
            full = _te_tabla(k, r, self.te_global)
            self.te_maps[c] = full
            X["te_" + c[len(CLAVE):]] = oof
            X["n_" + c[len(CLAVE):]] = [full.get(z, (0, 0))[1] if z is not None else 0 for z in k]
        if TEXTO in X:
            from sklearn.decomposition import TruncatedSVD
            from sklearn.feature_extraction.text import TfidfVectorizer
            tf = TfidfVectorizer(ngram_range=(1, 2), min_df=5, max_features=40000, sublinear_tf=True)
            try:
                A = tf.fit_transform(X[TEXTO].fillna("").astype(str))
            except ValueError:   # vocabulario vac?o (datos muy chicos)
                A = None
            k = min(N_SVD, A.shape[1] - 1) if A is not None else 0
            if k >= 1:
                sv = TruncatedSVD(k, random_state=self.seed).fit(A)
                self.svd = (tf, sv)
                X = pd.concat([X, pd.DataFrame(sv.transform(A), index=X.index, columns=[f"svd_{i}" for i in range(k)])], axis=1)
        return X.drop(columns=[c for c in X.columns if c.startswith(CLAVE) or c == TEXTO])

    def _prep(self, X):
        if not getattr(self, "te_maps", None) and getattr(self, "svd", None) is None:
            return X.drop(columns=[c for c in X.columns if c.startswith(CLAVE) or c == TEXTO], errors="ignore")
        X = X.copy()
        for c, mp in self.te_maps.items():
            k = X[c].astype(object).where(X[c].notna(), None).values if c in X else [None] * len(X)
            X["te_" + c[len(CLAVE):]] = [mp.get(z, (self.te_global, 0))[0] if z is not None else np.nan for z in k]
            X["n_" + c[len(CLAVE):]] = [mp.get(z, (0, 0))[1] if z is not None else 0 for z in k]
        if self.svd is not None:
            tf, sv = self.svd
            B = sv.transform(tf.transform(X[TEXTO].fillna("").astype(str) if TEXTO in X else [""] * len(X)))
            X = pd.concat([X, pd.DataFrame(B, index=X.index, columns=[f"svd_{i}" for i in range(B.shape[1])])], axis=1)
        return X.drop(columns=[c for c in X.columns if c.startswith(CLAVE) or c == TEXTO], errors="ignore")

    def predict(self, X, sup, calibrar=True):
        X = self._prep(X)
        out = np.zeros(len(X))
        for k, m in self._segs(np.asarray(sup, float)).items():
            if m.any():
                mdl = self.models[k]
                out[m] = mdl.predict(X[m], num_iteration=self.best.get(k))
        out = out + np.log(np.asarray(sup, float)) if self.o["target"] == "log_ppm2" else out
        if calibrar and getattr(self, "calibrador", None) is not None:
            out = self.calibrador.predict(out)
        return out

    @property
    def feature_name_(self):
        return next(iter(self.models.values())).feature_name_

    @property
    def booster_(self):
        return next(iter(self.models.values())).booster_


def agregar_calle(X: pd.DataFrame, d: pd.DataFrame, normalizada: bool = False) -> pd.DataFrame:
    import precio
    X = X.copy()
    f = calle_norm if normalizada else (lambda a: (precio.clave_direccion(a) or "|").split("|")[0] or None)
    X["calle"] = d["address"].map(f).astype("category") if "address" in d \
        else pd.Series(np.nan, index=d.index, dtype="category")
    return X


def niveles_calle(serie_train: pd.Series) -> list[str]:
    vc = serie_train.astype(object).value_counts()
    return sorted(str(v) for v in vc[vc >= MIN_CALLE].index)


# ---- Iteración 3: calle normalizada, claves para target encoding, texto para TF-IDF, calibración ----
CLAVE, TEXTO, N_SVD, SUAVIZADO = "_k_", "_t_texto", 30, 20
_STOP_CALLE = {"av", "avda", "avenida", "al", "calle", "de", "del", "la", "el", "los", "las", "y", "e", "gral", "general", "teniente",
               "pasaje", "pje", "dr", "doctor", "ing", "presidente", "pres", "cnel", "coronel", "capitan", "cap", "virrey", "nro", "n",
               "santa", "san", "juan", "jose", "maria", "manuel", "luis", "carlos", "martin", "franklin", "domingo", "faustino", "bartolome",
               "mariano", "raul", "julio", "d", "b", "f", "a"}


def calle_norm(a) -> str | None:
    """'Av. Franklin D. Roosevelt 3000' -> 'roosevelt'; 'ALBERDI, JUAN B., AV. 833' -> 'alberdi'."""
    import zpml
    s = zpml.norm(a)
    if not s:
        return None
    s = re.split(r"\d", s, maxsplit=1)[0]
    s = re.split(r"\be/|\bentre\b|\besq\b|\by\b", s)[0]
    if "," in s:
        s = s.split(",")[0]
    toks = [t for t in re.sub(r"[^a-z ]", " ", s).split() if t not in _STOP_CALLE and len(t) > 1]
    return toks[-1] if toks else None


def cuadra(a) -> str | None:
    import zpml
    m = re.search(r"\b(\d{1,5})\b", zpml.norm(a))
    return str(int(m.group(1)) // 100) if m else None


def _te_tabla(k, r, glob, m=SUAVIZADO):
    s = pd.DataFrame({"k": k, "r": r}).dropna(subset=["k"]).groupby("k")["r"].agg(["sum", "count"])
    return {z: (float((row["sum"] + m * glob) / (row["count"] + m)), int(row["count"])) for z, row in s.iterrows()}


def extender(X: pd.DataFrame, d: pd.DataFrame, opts: dict) -> pd.DataFrame:
    """Columnas extra según la variante (las mismas en entrenamiento y en predict.py)."""
    import zpml
    if opts.get("calle"):
        X = agregar_calle(X, d, bool(opts.get("calle_norm")))
    addr = d["address"] if "address" in d else pd.Series(None, index=d.index)
    if opts.get("te"):
        cn = addr.map(calle_norm)
        cu = addr.map(cuadra)
        X[CLAVE + "calle"] = cn
        X[CLAVE + "cuadra"] = [f"{a}|{b}" if a and b else None for a, b in zip(cn, cu)]
        bar = d["barrio"].astype(str)
        amb = zpml.num_col(d, "ambientes")
        X[CLAVE + "barrio_amb"] = [f"{b}|{int(a)}" if pd.notna(a) else None for b, a in zip(bar, amb)]
        sup = zpml.superficie(d)
        sb = pd.cut(sup, [0, 35, 45, 55, 70, 90, 120, 160, 1e9], labels=False)
        X[CLAVE + "barrio_sup"] = [f"{b}|{int(s)}" if pd.notna(s) else None for b, s in zip(bar, sb)]
    if opts.get("tfidf"):
        X[TEXTO] = zpml.listing_text(d).str[:600].values
    return X


def calibrar_oof(oof, y, fl):
    """Isotónica pred→real con cross-fitting: el fold k se corrige con un ajuste hecho en los otros folds."""
    from sklearn.isotonic import IsotonicRegression
    out = oof.copy()
    for _, va in fl:
        m = np.ones(len(oof), bool); m[va] = False
        out[va] = IsotonicRegression(out_of_bounds="clip").fit(oof[m], y[m]).predict(oof[va])
    return out


def ajustar_calibrador(oof, y):
    from sklearn.isotonic import IsotonicRegression
    return IsotonicRegression(out_of_bounds="clip").fit(oof, y)
