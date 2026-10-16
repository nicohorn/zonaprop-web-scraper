"""Modelo A · precio de venta de departamentos en CABA (USD). Pipeline completo:

  limpiar()      reglas de consistencia, pozo, casi-duplicados (con conteo de filas en cada paso)
  separar()      test fijo agrupado (la misma propiedad nunca queda en train y en test)
  recorte_train  percentiles de USD/m² calculados SÓLO con train (también dentro de cada fold)
  cv_*()         5 folds agrupados sobre train para baselines, Ridge y la grilla de LightGBM
  entrenar()     arma todo, elige hiperparámetros por CV y evalúa UNA vez en test

Lo usan ml/run.py (tarea "price" de la interfaz) y notebooks/01_price_prediction.ipynb.
"""
from __future__ import annotations

import itertools
import re

import numpy as np
import pandas as pd

import zpml

# --- Limpieza -------------------------------------------------------------------------------
SUP_MIN, SUP_MAX = 18, 1000            # m²
PRECIO_MIN, PRECIO_MAX = 20_000, 15_000_000   # USD
PPM2_MIN, PPM2_MAX = 500, 15_000       # USD/m² (fuera: pesos como dólares, precios parciales, m² mal cargados)
EXP_M2_MIN, EXP_M2_MAX = 200, 30_000   # expensas ARS/m²/mes; fuera de rango se toman como faltantes


def _paso(pasos, nombre, d, antes):
    pasos.append({"paso": nombre, "filas": int(len(d)), "quitadas": int(antes - len(d))})


def limpiar(df: pd.DataFrame, operacion="venta", currency="USD", tipo="departamento", fx=1450.0,
            excluir_pozo=True, deduplicar=True) -> tuple[pd.DataFrame, list[dict]]:
    """Devuelve (avisos limpios con columnas price_x, sup, ppm2, grupo) y la tabla de pasos."""
    pasos: list[dict] = []
    d = df.copy()
    _paso(pasos, "Avisos de CABA (última versión de cada id)", d, len(d))
    n = len(d); d = d[d["operacion"] == operacion]; _paso(pasos, f"Operación = {operacion}", d, n)
    if tipo and tipo != "todos":
        n = len(d); d = d[d["tipo_prop"] == tipo]; _paso(pasos, f"Tipo = {tipo}", d, n)
    d["price"] = pd.to_numeric(d["price"], errors="coerce")
    n = len(d)
    if currency == "convertir_a_USD":
        d = d[d["price_currency"].isin(["USD", "ARS"])].copy()
        d["price_x"] = np.where(d["price_currency"] == "ARS", d["price"] / fx, d["price"])
    else:
        d = d[d["price_currency"] == currency].copy()
        d["price_x"] = d["price"]
    _paso(pasos, f"Moneda = {currency}", d, n)

    for c in ["superficie_total", "superficie_cubierta", "ambientes", "dormitorios", "banos", "cocheras", "expensas"]:
        d[c] = zpml.num_col(d, c)
    d["sup"] = zpml.superficie(d)
    n = len(d); d = d[(d["price_x"] > 0) & (d["sup"] > 0)]; _paso(pasos, "Con precio y superficie", d, n)

    n = len(d)
    cub_ok = d["superficie_cubierta"].isna() | d["superficie_total"].isna() | (d["superficie_cubierta"] <= d["superficie_total"] * 1.05)
    d = d[d["sup"].between(SUP_MIN, SUP_MAX) & cub_ok]
    _paso(pasos, f"Superficie entre {SUP_MIN} y {SUP_MAX} m² y cubierta ≤ total", d, n)

    n = len(d)
    amb, dor, ban = d["ambientes"], d["dormitorios"], d["banos"]
    ok = (amb.isna() | amb.between(1, 10)) & (dor.isna() | amb.isna() | (dor <= amb)) & (ban.isna() | ban.between(1, 6))
    ok &= amb.isna() | (d["sup"] / amb >= 9)   # menos de 9 m² por ambiente: m² o ambientes mal cargados
    d = d[ok]
    _paso(pasos, "Ambientes 1–10, dormitorios ≤ ambientes, baños 1–6, ≥ 9 m² por ambiente", d, n)

    d["ppm2"] = d["price_x"] / d["sup"]
    if operacion == "venta" and currency != "ARS":
        n = len(d)
        d = d[d["price_x"].between(PRECIO_MIN, PRECIO_MAX) & d["ppm2"].between(PPM2_MIN, PPM2_MAX)]
        _paso(pasos, f"Precio USD {PRECIO_MIN:,}–{PRECIO_MAX:,} y USD/m² {PPM2_MIN}–{PPM2_MAX:,}", d, n)

    d["pozo"] = zpml.es_pozo(d)
    if excluir_pozo:
        n = len(d); d = d[~d["pozo"]]; _paso(pasos, "Sin pozo / en construcción / emprendimiento (precio parcial)", d, n)

    # Valores sueltos implausibles -> faltante (no se descarta el aviso)
    em2 = d["expensas"] / d["sup"]
    d.loc[~em2.between(EXP_M2_MIN, EXP_M2_MAX), "expensas"] = np.nan
    d.loc[d["cocheras"] > 6, "cocheras"] = np.nan

    # Casi-duplicados: la misma unidad publicada por varias inmobiliarias o republicada con otro id
    d["huella"] = huella(d, con_precio=True)
    d["grupo"] = huella(d, con_precio=False)
    d = d.sort_values(["date_posted", "scraped_at"], na_position="first")
    if deduplicar:
        n = len(d); d = d.drop_duplicates("huella", keep="last"); _paso(pasos, "Sin casi-duplicados (barrio + m² + ambientes + dormitorios + baños + precio redondeado)", d, n)
    return d.sort_index(), pasos


def huella(d: pd.DataFrame, con_precio: bool) -> pd.Series:
    parts = [d["barrio"].map(zpml.norm), d["sup"].round(0).astype("Int64").astype(str),
             d["ambientes"].astype("Int64").astype(str), d["dormitorios"].astype("Int64").astype(str),
             d["banos"].astype("Int64").astype(str)]
    if con_precio:
        # precio redondeado a ~2 % (escala logarítmica): 149.999 y 150.000 caen juntos
        parts.append((np.log(d["price_x"]) / np.log(1.02)).round(0).astype(int).astype(str))
    out = parts[0]
    for p in parts[1:]:
        out = out + "|" + p
    return out


# --- Separación -------------------------------------------------------------------------------
def separar(d: pd.DataFrame, modo="agrupado", test_size=0.2, seed=42) -> tuple[np.ndarray, np.ndarray]:
    """Índices posicionales (train, test).
    agrupado: GroupShuffleSplit por 'grupo' (misma unidad física sin precio) -> nunca en ambos lados.
    temporal: test = avisos publicados más recientemente; se sacan de train los grupos que estén en test.
    aleatorio: train_test_split clásico (sólo para comparar con el protocolo anterior)."""
    from sklearn.model_selection import GroupShuffleSplit, train_test_split
    n = len(d)
    if modo == "aleatorio":
        return tuple(np.sort(a) for a in train_test_split(np.arange(n), test_size=test_size, random_state=seed))
    g = d["grupo"].values
    if modo == "temporal":
        when = pd.to_datetime(d["date_posted"], errors="coerce")
        order = np.argsort(when.fillna(when.min()).values, kind="stable")
        k = max(1, int(round(n * test_size)))
        te = np.sort(order[-k:])
        tr = np.setdiff1d(np.arange(n), te)
        tr = tr[~np.isin(g[tr], g[te])]
        return tr, te
    tr, te = next(GroupShuffleSplit(1, test_size=test_size, random_state=seed).split(np.zeros(n), groups=g))
    return np.sort(tr), np.sort(te)


def recorte_train(ppm2: np.ndarray, pct=1.0) -> np.ndarray:
    """Máscara de filas de TRAIN dentro de los percentiles pct–(100-pct) de USD/m² (calculados con ese train)."""
    if pct <= 0 or len(ppm2) < 50:
        return np.ones(len(ppm2), bool)
    lo, hi = np.percentile(ppm2, [pct, 100 - pct])
    return (ppm2 >= lo) & (ppm2 <= hi)


# --- Métricas -------------------------------------------------------------------------------
def metricas(real, pred) -> dict:
    from sklearn.metrics import r2_score
    yt, yp = np.asarray(real, float), np.clip(np.asarray(pred, float), 1, None)
    ape = np.abs(yp - yt) / yt
    return {"MAE": float(np.mean(np.abs(yp - yt))), "MAPE_mediana_%": float(np.median(ape) * 100),
            "dentro_10%_%": float(np.mean(ape < 0.10) * 100), "R2_log": float(r2_score(np.log(yt), np.log(yp))),
            "R2": float(r2_score(yt, yp))}


# --- Modelos ----------------------------------------------------------------------------------
class MedianaGlobal:
    def fit(self, X, y_log, sup=None):
        self.v = float(np.median(y_log)); return self

    def predict(self, X, sup=None):
        return np.full(len(X), self.v)


class MedianaBarrio:
    """Mediana de USD/m² del barrio (en train) × superficie. Barrio con < 5 avisos: mediana global."""
    def fit(self, X, y_log, sup):
        ppm2 = np.exp(y_log) / sup
        s = pd.Series(ppm2, index=X.index).groupby(X["barrio"].astype(object).values)
        cnt, med = s.size(), s.median()
        self.map = med[cnt >= 5].to_dict(); self.glob = float(np.median(ppm2)); return self

    def predict(self, X, sup):
        m = X["barrio"].astype(object).map(self.map).astype(float).fillna(self.glob).values
        return np.log(m * sup)


def ridge(nums, cats, alpha=1.0):
    from sklearn.compose import ColumnTransformer
    from sklearn.impute import SimpleImputer
    from sklearn.linear_model import Ridge
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import OneHotEncoder, StandardScaler
    pre = ColumnTransformer([
        ("num", make_pipeline(SimpleImputer(strategy="median", add_indicator=True), StandardScaler()), nums),
        # min_frequency se ajusta dentro del Pipeline: sólo ve el train de cada fit
        ("cat", make_pipeline(SimpleImputer(strategy="constant", fill_value="NA"), OneHotEncoder(handle_unknown="infrequent_if_exist", min_frequency=10)), cats),
    ])
    return make_pipeline(pre, Ridge(alpha=alpha))


class RidgeLog:
    def __init__(self, nums, cats, alpha):
        self.nums, self.cats, self.alpha = nums, cats, alpha

    def _o(self, X):
        return X.astype({c: object for c in self.cats})

    def fit(self, X, y_log, sup=None):
        self.m = ridge(self.nums, self.cats, self.alpha).fit(self._o(X), y_log); return self

    def predict(self, X, sup=None):
        return self.m.predict(self._o(X))


def lgbm(params: dict, n_estimators: int, seed=42):
    import lightgbm as lgb
    return lgb.LGBMRegressor(n_estimators=n_estimators, learning_rate=params["learning_rate"], num_leaves=params["num_leaves"],
                             min_child_samples=params["min_child_samples"], max_depth=params.get("max_depth", -1),
                             subsample=0.8, subsample_freq=1, colsample_bytree=0.8, reg_lambda=params.get("reg_lambda", 1.0),
                             cat_smooth=10, verbose=-1, random_state=seed)


def fijar_categorias(X: pd.DataFrame, cats: list[str], levels: dict[str, list[str]]) -> pd.DataFrame:
    """Categorías con los niveles de train; lo no visto queda NaN."""
    X = X.copy()
    for c in cats:
        X[c] = pd.Categorical(X[c].astype(object), categories=levels[c])
    return X


def niveles(X: pd.DataFrame, cats) -> dict[str, list[str]]:
    return {c: sorted(str(v) for v in X[c].dropna().astype(object).unique()) for c in cats}


# --- Validación cruzada sobre train ---------------------------------------------------------------
def folds(groups, k=5, seed=42):
    from sklearn.model_selection import GroupKFold
    return list(GroupKFold(n_splits=k, shuffle=True, random_state=seed).split(np.zeros(len(groups)), groups=groups))


def cv_modelo(fabrica, X, y_log, sup, ppm2, fl, trim_pct=1.0, lgb_params=None):
    """Métricas por fold (recorte de percentiles sólo con el train del fold) + predicciones fuera de fold.
    Si lgb_params: LightGBM con early stopping sobre el fold de validación; devuelve también best_iter."""
    oof = np.full(len(X), np.nan); res, iters = [], []
    for tr, va in fl:
        tr = tr[recorte_train(ppm2[tr], trim_pct)]
        lev = niveles(X.iloc[tr], [c for c in X.columns if str(X[c].dtype) == "category"])
        Xtr, Xva = fijar_categorias(X.iloc[tr], list(lev), lev), fijar_categorias(X.iloc[va], list(lev), lev)
        if lgb_params is not None:
            import warnings
            import lightgbm as lgb
            warnings.filterwarnings("ignore", category=Warning, module="lightgbm")
            m = lgbm(lgb_params, 5000).fit(Xtr, y_log[tr], eval_set=[(Xva, y_log[va])], eval_metric="l1",
                                         callbacks=[lgb.early_stopping(100, verbose=False)])
            iters.append(int(m.best_iteration_)); p = m.predict(Xva, num_iteration=m.best_iteration_)
        else:
            p = fabrica().fit(Xtr, y_log[tr], sup[tr]).predict(Xva, sup[va])
        oof[va] = p
        res.append(metricas(np.exp(y_log[va]), np.exp(p)))
    return pd.DataFrame(res), oof, iters


def resumen_cv(df_folds: pd.DataFrame) -> dict:
    return {f"{k}_media": float(df_folds[k].mean()) for k in df_folds} | {f"{k}_std": float(df_folds[k].std()) for k in df_folds}


GRILLA = {"num_leaves": [31, 63, 127], "min_child_samples": [10, 30], "learning_rate": [0.03], "reg_lambda": [0.0, 5.0]}


def entrenar(df: pd.DataFrame, p: dict, progreso=lambda pct, msg: None) -> dict:
    """Pipeline completo. Devuelve dict con datos, modelos, métricas CV y test, tablas de error."""
    d, pasos = limpiar(df, p.get("operacion", "venta"), p.get("currency", "USD"), p.get("tipo", "departamento"),
                       float(p.get("fx_mep", 1450)), bool(p.get("excluir_pozo", True)))
    if len(d) < 60:
        raise SystemExit(f"Hay {len(d)} avisos limpios; hacen falta al menos 60.")
    d = d.reset_index(drop=True)
    X, nums, cats = zpml.build_features(d)
    y = np.log(d["price_x"].values); sup = d["sup"].values; ppm2 = d["ppm2"].values
    tr0, te = separar(d, p.get("split", "agrupado"), float(p.get("test_size", 0.2)), int(p.get("seed", 42)))
    trim = float(p.get("trim_pct", 1.0))
    keep = recorte_train(ppm2[tr0], trim)
    tr = tr0[keep]
    pasos.append({"paso": f"Train: recorte de USD/m² percentiles {trim:g}–{100 - trim:g} (calculados sólo con train)",
                  "filas": int(len(tr)), "quitadas": int((~keep).sum())})
    groups_tr = d["grupo"].values[tr0]
    fl = folds(groups_tr, int(p.get("cv_folds", 5)), int(p.get("seed", 42)))
    Xtr0, ytr0, suptr0, ppm2tr0 = X.iloc[tr0].reset_index(drop=True), y[tr0], sup[tr0], ppm2[tr0]

    # Baselines y Ridge por CV
    cv, oofs = {}, {}
    fab = {"Mediana global": lambda: MedianaGlobal(), "Mediana USD/m² del barrio × m²": lambda: MedianaBarrio()}
    progreso(15, "CV: baselines")
    for k, f in fab.items():
        r, oofs[k], _ = cv_modelo(f, Xtr0, ytr0, suptr0, ppm2tr0, fl, trim); cv[k] = r
    progreso(22, "CV: Ridge (alpha)")
    best_a, best = None, np.inf
    for a in [0.3, 3.0, 30.0]:
        r, o, _ = cv_modelo(lambda a=a: RidgeLog(nums, cats, a), Xtr0, ytr0, suptr0, ppm2tr0, fl, trim)
        if r["MAPE_mediana_%"].mean() < best:
            best, best_a, cv["Ridge"], oofs["Ridge"] = r["MAPE_mediana_%"].mean(), a, r, o

    # Grilla de LightGBM por CV con early stopping
    grid = [dict(zip(GRILLA, v)) for v in itertools.product(*GRILLA.values())] if p.get("tune", True) else \
        [{"num_leaves": int(p.get("num_leaves", 63)), "min_child_samples": 20, "learning_rate": float(p.get("learning_rate", 0.05)), "reg_lambda": 1.0}]
    tuning = []
    best_g = None
    for i, g in enumerate(grid):
        progreso(30 + 40 * i / len(grid), f"CV LightGBM {i + 1}/{len(grid)}: {g}")
        r, o, it = cv_modelo(None, Xtr0, ytr0, suptr0, ppm2tr0, fl, trim, lgb_params=g)
        row = {**g, "n_arboles_medio": int(np.mean(it)), **resumen_cv(r)}
        tuning.append(row)
        if best_g is None or row["MAPE_mediana_%_media"] < best_g[0]["MAPE_mediana_%_media"]:
            best_g = (row, r, o, it)
    g_row, cv["LightGBM"], oofs["LightGBM"], it = best_g
    params_lgb = {k: g_row[k] for k in GRILLA}
    n_arb = int(np.mean(it) * 1.1)  # train final con todos los folds: ~10 % más de datos

    # Intervalo: cuantiles de los residuos fuera de fold (train), luego se mide su cobertura en test
    res_oof = ytr0 - oofs["LightGBM"]
    q = {f"q{int(a * 100)}": float(np.quantile(res_oof, a)) for a in [0.1, 0.25, 0.5, 0.75, 0.9]}

    # Ajuste final sobre todo train (recortado) y evaluación única en test
    progreso(75, f"Modelo final: {n_arb} árboles")
    lev = niveles(X.iloc[tr], cats)
    Xtr, Xte = fijar_categorias(X.iloc[tr], cats, lev), fijar_categorias(X.iloc[te], cats, lev)
    finales = {"Mediana global": MedianaGlobal().fit(Xtr, y[tr]),
               "Mediana USD/m² del barrio × m²": MedianaBarrio().fit(Xtr, y[tr], sup[tr]),
               "Ridge": RidgeLog(nums, cats, best_a).fit(Xtr, y[tr])}
    gbm = lgbm(params_lgb, n_arb).fit(Xtr, y[tr])
    preds = {k: np.exp(m.predict(Xte, sup[te])) for k, m in finales.items()}
    preds["LightGBM"] = np.exp(gbm.predict(Xte))
    real = d["price_x"].values[te]
    test = {k: metricas(real, v) for k, v in preds.items()}
    r_te = np.log(real / preds["LightGBM"])
    cobertura = {"80%": float(np.mean((r_te >= q["q10"]) & (r_te <= q["q90"])) * 100),
                 "50%": float(np.mean((r_te >= q["q25"]) & (r_te <= q["q75"])) * 100)}

    out = d.iloc[te][["id", "url", "barrio", "price_x", "sup", "ambientes", "dormitorios", "banos", "date_posted"]].copy()
    out["pred"] = preds["LightGBM"]; out["residuo_%"] = (out["price_x"] / out["pred"] - 1) * 100
    out["ape_%"] = (out["pred"] - out["price_x"]).abs() / out["price_x"] * 100
    return {"d": d, "pasos": pasos, "X": X, "nums": nums, "cats": cats, "levels": lev, "tr": tr, "te": te, "tr0": tr0,
            "cv": {k: resumen_cv(v) for k, v in cv.items()}, "cv_folds": cv, "tuning": pd.DataFrame(tuning),
            "params_lgb": {**params_lgb, "n_estimators": n_arb}, "ridge_alpha": best_a, "test": test,
            "cobertura": cobertura, "resid_log_quantiles": q, "gbm": gbm, "ridge": finales["Ridge"].m, "modelos": finales,
            "pred_test": out, "n_grupos_test": int(d["grupo"].iloc[te].nunique()),
            "grupos_compartidos": int(len(set(d["grupo"].values[tr]) & set(d["grupo"].values[te])))}


def error_por(out: pd.DataFrame, by: str | pd.Series, min_n=30) -> pd.DataFrame:
    g = out.groupby(by, observed=True)
    t = g.apply(lambda s: pd.Series({"n": len(s), "MAPE_mediana_%": s["ape_%"].median(),
                                    "dentro_10%_%": (s["ape_%"] < 10).mean() * 100,
                                    "sesgo_mediano_%": s["residuo_%"].median()}), include_groups=False)
    return t[t["n"] >= min_n]


def analisis_errores(out: pd.DataFrame) -> dict[str, pd.DataFrame]:
    tam = pd.cut(out["sup"], [0, 35, 50, 70, 100, 150, 1e9], labels=["<35", "35–50", "50–70", "70–100", "100–150", "150+"])
    pr = pd.cut(out["price_x"], [0, 80e3, 120e3, 180e3, 300e3, 600e3, 1e12],
                labels=["<80k", "80–120k", "120–180k", "180–300k", "300–600k", "600k+"])
    return {"barrio": error_por(out, "barrio").sort_values("MAPE_mediana_%"),
            "superficie_m2": error_por(out, tam, 1), "precio_usd": error_por(out, pr, 1)}


def comparar_aleatorio(df: pd.DataFrame, p: dict, params_lgb: dict) -> dict:
    """Protocolo anterior: sin quitar casi-duplicados y con split aleatorio, mismos hiperparámetros.
    Sirve para ver cuánto del error "bajo" venía de tener la misma propiedad en train y test."""
    d, _ = limpiar(df, p.get("operacion", "venta"), p.get("currency", "USD"), p.get("tipo", "departamento"),
                   float(p.get("fx_mep", 1450)), bool(p.get("excluir_pozo", True)), deduplicar=False)
    d = d.reset_index(drop=True)
    X, nums, cats = zpml.build_features(d)
    y = np.log(d["price_x"].values)
    tr, te = separar(d, "aleatorio", float(p.get("test_size", 0.2)), int(p.get("seed", 42)))
    tr = tr[recorte_train(d["ppm2"].values[tr], float(p.get("trim_pct", 1.0)))]
    lev = niveles(X.iloc[tr], cats)
    m = lgbm({k: v for k, v in params_lgb.items() if k != "n_estimators"}, params_lgb["n_estimators"]).fit(fijar_categorias(X.iloc[tr], cats, lev), y[tr])
    pred = np.exp(m.predict(fijar_categorias(X.iloc[te], cats, lev)))
    compartidos = np.isin(d["grupo"].values[te], d["grupo"].values[tr]).mean() * 100
    return {"n": int(len(d)), "n_test": int(len(te)), "test_con_gemelo_en_train_%": float(compartidos),
            "metricas": metricas(d["price_x"].values[te], pred)}
