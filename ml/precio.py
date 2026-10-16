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
    if deduplicar == "huella":   # regla v1 (13,7 %): sólo la huella; ~30 % de precisión en la muestra revisada
        n = len(d); d = d.drop_duplicates("huella", keep="last"); _paso(pasos, "Sin casi-duplicados v1 (sólo huella)", d, n)
    elif deduplicar:
        d["dup_id"] = dup_ids(d)
        n = len(d); d = d.drop_duplicates("dup_id", keep="last")
        _paso(pasos, "Sin duplicados (misma huella Y misma calle/altura o texto casi igual)", d, n)
    return d.sort_index(), pasos


_STOP = {"av", "avda", "avenida", "al", "calle", "de", "del", "la", "el", "los", "las", "y", "e", "entre", "gral", "general",
         "teniente", "pasaje", "pje", "dr", "virrey", "piso", "venta", "departamento", "depto", "nro", "n"}


def clave_direccion(a) -> str | None:
    """'Av. Rivadavia al 10700' -> 'rivadavia|107' (primera palabra de la calle + cuadra)."""
    a = re.sub(r"[^a-z0-9 ]", " ", zpml.norm(a))
    m = re.search(r"\b(\d{2,5})\b", a)
    toks = [t for t in a.split() if not t.isdigit() and t not in _STOP and len(t) > 1]
    if not toks or not m:
        return None
    return f"{toks[0]}|{int(m.group(1)) // 100}"


def dup_ids(d: pd.DataFrame, umbral_texto=0.6) -> pd.Series:
    """Duplicado = misma huella (barrio, m², ambientes, dormitorios, baños, precio ±2 %) Y además
    misma calle+cuadra o título+descripción casi iguales (coseno de n-gramas de caracteres ≥ 0,6).
    Validado a mano sobre muestras de pares: ver docs/modelo_precio.md."""
    from sklearn.feature_extraction.text import TfidfVectorizer
    ids = pd.Series(np.arange(len(d)), index=d.index)
    multi = d[d.duplicated("huella", keep=False)]
    if multi.empty:
        return ids
    txt = (zpml._text_col(multi, "title") + " " + zpml._text_col(multi, "description_short")).map(zpml.norm).map(zpml.strip_amounts).str[:300]
    T = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), min_df=2).fit_transform(txt)
    key = multi["address"].map(clave_direccion) if "address" in multi else pd.Series(None, index=multi.index)
    pos = {ix: i for i, ix in enumerate(multi.index)}
    parent = {ix: ix for ix in multi.index}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]; x = parent[x]
        return x
    for _, g in multi.groupby("huella"):
        ix = list(g.index)
        S = (T[[pos[i] for i in ix]] @ T[[pos[i] for i in ix]].T).toarray()
        for a in range(len(ix)):
            for b in range(a + 1, len(ix)):
                ka, kb = key[ix[a]], key[ix[b]]
                if (ka is not None and ka == kb) or S[a, b] >= umbral_texto:
                    parent[find(ix[a])] = find(ix[b])
    root = {ix: find(ix) for ix in multi.index}
    for ix, rt in root.items():
        ids[ix] = ids[rt]
    return ids


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


GRILLA = {"num_leaves": [31, 63, 127], "min_child_samples": [10, 30], "learning_rate": [0.03], "reg_lambda": [0.0]}
VARIANTE_DEFAULT = "v4_todo_sin_iso"   # iteraci?n 3, elegida por CV agrupado en la ablaci?n (antes v3_ppm2_huber)


def entrenar(df: pd.DataFrame, p: dict, progreso=lambda pct, msg: None) -> dict:
    """Pipeline completo. Devuelve dict con datos, modelos, métricas CV y test, tablas de error."""
    dedup = "huella" if p.get("duplicados") == "v1_huella" else True
    d, pasos = limpiar(df, p.get("operacion", "venta"), p.get("currency", "USD"), p.get("tipo", "departamento"),
                       float(p.get("fx_mep", 1450)), bool(p.get("excluir_pozo", True)), deduplicar=dedup)
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

    # Grilla de LightGBM (variante elegida) por CV con early stopping
    import variantes_precio as vp
    nombre_var = p.get("variante", VARIANTE_DEFAULT)
    opts = vp.VARIANTES[nombre_var]
    Xv, nums_v, cats_v = matriz(d, opts)
    if p.get("hiperparametros") == "optuna":
        import json as _json
        f = zpml.DATA / "ml" / "optuna" / f"{nombre_var}.json"
        if not f.exists():
            raise SystemExit(f"No hay búsqueda Optuna guardada para {nombre_var} ({f}). Corré ml/optuna_precio.py primero.")
        best_p = _json.loads(f.read_text(encoding="utf-8"))["mejores_parametros"]
        grid = [{k: best_p[k] for k in GRILLA}]
    else:
        grid = None
    grid = grid or [dict(zip(GRILLA, v)) for v in itertools.product(*GRILLA.values())] if p.get("tune", True) else \
        [{"num_leaves": int(p.get("num_leaves", 63)), "min_child_samples": 10, "learning_rate": float(p.get("learning_rate", 0.03)), "reg_lambda": 0.0}]
    tuning = []
    best_g = None
    for i, g in enumerate(grid):
        progreso(30 + 40 * i / len(grid), f"CV LightGBM {nombre_var} {i + 1}/{len(grid)}: {g}")
        r, o, nseg = cv_variante(d, tr0, fl, opts, g, trim)
        row = {**g, "n_arboles": str(nseg), **resumen_cv(r)}
        tuning.append(row)
        if best_g is None or row["MAPE_mediana_%_media"] < best_g[0]["MAPE_mediana_%_media"]:
            best_g = (row, r, o, nseg)
    g_row, cv["LightGBM"], oofs["LightGBM"], n_seg = best_g
    params_lgb = {k: g_row[k] for k in GRILLA}

    # Intervalo: cuantiles de los residuos fuera de fold (train), luego se mide su cobertura en test
    res_oof = ytr0 - oofs["LightGBM"]
    q = {f"q{int(a * 100)}": float(np.quantile(res_oof, a)) for a in [0.1, 0.25, 0.5, 0.75, 0.9]}

    # Ajuste final sobre todo train (recortado) y evaluación única en test
    progreso(75, f"Modelo final: {n_seg} árboles")
    lev = niveles(X.iloc[tr], cats)
    Xtr, Xte = fijar_categorias(X.iloc[tr], cats, lev), fijar_categorias(X.iloc[te], cats, lev)
    finales = {"Mediana global": MedianaGlobal().fit(Xtr, y[tr]),
               "Mediana USD/m² del barrio × m²": MedianaBarrio().fit(Xtr, y[tr], sup[tr]),
               "Ridge": RidgeLog(nums, cats, best_a).fit(Xtr, y[tr])}
    lev_v = _niveles_var(Xv.iloc[tr], cats_v)
    Xvtr, Xvte = fijar_categorias(Xv.iloc[tr], cats_v, lev_v), fijar_categorias(Xv.iloc[te], cats_v, lev_v)
    gbm = vp.ModeloGBM(opts, params_lgb).fit(Xvtr, y[tr], sup[tr], n_por_seg=n_seg)
    if opts.get("calibracion") == "isotonica":
        # el calibrador se ajusta con las predicciones fuera de fold SIN calibrar del CV (train)
        _, oof_crudo, _ = cv_variante(d, tr0, fl, {**opts, "calibracion": None}, params_lgb, trim)
        gbm.calibrador = vp.ajustar_calibrador(oof_crudo, ytr0)
    preds = {k: np.exp(m.predict(Xte, sup[te])) for k, m in finales.items()}
    if p.get("referencia_v1", True) and nombre_var != "v1":
        # Referencia: la variante v1 (iteración anterior, 13,7 %) con sus hiperparámetros, mismo train/test.
        X1, _, c1 = matriz(d, vp.VARIANTES["v1"]); l1 = _niveles_var(X1.iloc[tr], c1)
        r1, _, n1 = cv_variante(d, tr0, fl, vp.VARIANTES["v1"], PARAMS_V1, trim)
        cv["LightGBM v1 (referencia)"] = r1
        m1 = vp.ModeloGBM(vp.VARIANTES["v1"], PARAMS_V1).fit(fijar_categorias(X1.iloc[tr], c1, l1), y[tr], sup[tr], n_por_seg=n1)
        preds["LightGBM v1 (referencia)"] = np.exp(m1.predict(fijar_categorias(X1.iloc[te], c1, l1), sup[te]))
    preds["LightGBM"] = np.exp(gbm.predict(Xvte, sup[te]))
    sin_dir = None
    if (opts.get("calle") or opts.get("te")) and p.get("modelo_sin_direccion", True):
        # Modelo de respaldo para el formulario cuando no se indica dirección: sin calle ni encodings de calle/cuadra.
        progreso(80, "Modelo de respaldo sin dirección")
        o_sd = {**opts, "calle": False, "sin_direccion": True}
        Xs, nums_s, cats_s = matriz(d, o_sd); lev_s = _niveles_var(Xs.iloc[tr], cats_s)
        r_sd, oof_sd, n_sd = cv_variante(d, tr0, fl, o_sd, params_lgb, trim)
        cv["LightGBM sin dirección (respaldo)"] = r_sd
        g_sd = vp.ModeloGBM(o_sd, params_lgb).fit(fijar_categorias(Xs.iloc[tr], cats_s, lev_s), y[tr], sup[tr], n_por_seg=n_sd)
        preds["LightGBM sin dirección (respaldo)"] = np.exp(g_sd.predict(fijar_categorias(Xs.iloc[te], cats_s, lev_s), sup[te]))
        res_sd = ytr0 - oof_sd
        sin_dir = {"gbm": g_sd, "columns": list(Xs.columns), "nums": nums_s, "cats": cats_s, "levels": lev_s, "opciones": o_sd,
                   "resid_log_quantiles": {f"q{int(a * 100)}": float(np.quantile(res_sd, a)) for a in [0.1, 0.25, 0.5, 0.75, 0.9]}}
    real = d["price_x"].values[te]
    test = {k: metricas(real, v) for k, v in preds.items()}
    seg_test = {k: tabla_segmentos(real, v, sup[te], d["barrio"].values[te]) for k, v in preds.items()}
    r_te = np.log(real / preds["LightGBM"])
    cobertura = {"80%": float(np.mean((r_te >= q["q10"]) & (r_te <= q["q90"])) * 100),
                 "50%": float(np.mean((r_te >= q["q25"]) & (r_te <= q["q75"])) * 100)}
    base = {"nums_base": nums, "cats_base": cats, "columns_base": list(X.columns)}
    X, nums, cats, lev = Xv, nums_v, cats_v, lev_v   # lo que se guarda para predecir es la variante

    out = d.iloc[te][["id", "url", "barrio", "price_x", "sup", "ambientes", "dormitorios", "banos", "date_posted"]].copy()
    out["pred"] = preds["LightGBM"]; out["residuo_%"] = (out["price_x"] / out["pred"] - 1) * 100
    out["ape_%"] = (out["pred"] - out["price_x"]).abs() / out["price_x"] * 100
    return {"d": d, "pasos": pasos, "X": X, "nums": nums, "cats": cats, "levels": lev, "tr": tr, "te": te, "tr0": tr0,
            "cv": {k: resumen_cv(v) for k, v in cv.items()}, "cv_folds": cv, "tuning": pd.DataFrame(tuning),
            "params_lgb": {**params_lgb, "n_estimators": n_seg}, "variante": nombre_var, "opciones": opts, "segmentos_test": seg_test,
            "levels_base": niveles(Xtr, base["cats_base"]), **base, "ridge_alpha": best_a, "test": test,
            "cobertura": cobertura, "resid_log_quantiles": q, "gbm": gbm, "sin_direccion": sin_dir, "ridge": finales["Ridge"].m, "modelos": finales,
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


def comparar_aleatorio(df: pd.DataFrame, p: dict, params_lgb: dict, variante: str = "v1") -> dict:
    """Protocolo anterior: sin quitar duplicados y con split aleatorio, mismos hiperparámetros y variante.
    Sirve para ver cuánto del error "bajo" venía de tener la misma propiedad en train y test."""
    import variantes_precio as vp
    d, _ = limpiar(df, p.get("operacion", "venta"), p.get("currency", "USD"), p.get("tipo", "departamento"),
                   float(p.get("fx_mep", 1450)), bool(p.get("excluir_pozo", True)), deduplicar=False)
    d = d.reset_index(drop=True)
    opts = vp.VARIANTES[variante]
    X, nums, cats = matriz(d, opts)
    y = np.log(d["price_x"].values); sup = d["sup"].values
    tr, te = separar(d, "aleatorio", float(p.get("test_size", 0.2)), int(p.get("seed", 42)))
    tr = tr[recorte_train(d["ppm2"].values[tr], float(p.get("trim_pct", 1.0)))]
    lev = _niveles_var(X.iloc[tr], cats)
    n = params_lgb["n_estimators"]
    m = vp.ModeloGBM(opts, {k: v for k, v in params_lgb.items() if k != "n_estimators"}).fit(
        fijar_categorias(X.iloc[tr], cats, lev), y[tr], sup[tr], n_por_seg=n)
    pred = np.exp(m.predict(fijar_categorias(X.iloc[te], cats, lev), sup[te]))
    compartidos = np.isin(d["grupo"].values[te], d["grupo"].values[tr]).mean() * 100
    return {"n": int(len(d)), "n_test": int(len(te)), "test_con_gemelo_en_train_%": float(compartidos),
            "metricas": metricas(d["price_x"].values[te], pred)}


# --- Variantes y ablación (iteración 2) ------------------------------------------------------
BARRIOS_DEBILES = ["Villa Lugano", "Mataderos", "Constitución", "Centro / Microcentro", "La Boca"]
PARAMS_V1 = {"num_leaves": 63, "min_child_samples": 10, "learning_rate": 0.03, "reg_lambda": 0.0}


def segmentos(precio_real, sup, barrio) -> dict[str, np.ndarray]:
    precio_real, sup = np.asarray(precio_real), np.asarray(sup)
    return {"todos": np.ones(len(sup), bool), "< USD 80k": precio_real < 80e3, "> USD 600k": precio_real > 600e3,
            "≥ 150 m²": sup >= 150, "barrios débiles": np.isin(np.asarray(barrio, object), BARRIOS_DEBILES)}


def matriz(d: pd.DataFrame, opts: dict):
    import variantes_precio as vp
    X, nums, cats = zpml.build_features(d, version=int(opts["features"]))
    X = vp.extender(X, d, opts)
    if opts.get("calle"):
        cats = cats + ["calle"]
    return X, nums, cats


def _niveles_var(Xtr, cats):
    import variantes_precio as vp
    lev = niveles(Xtr, [c for c in cats if c != "calle"])
    if "calle" in cats:
        lev["calle"] = vp.niveles_calle(Xtr["calle"])
    return lev


def cv_variante(d, tr0, fl, opts, params, trim=1.0):
    """OOF de una variante sobre train (folds agrupados, recorte y niveles por fold)."""
    import variantes_precio as vp
    X, nums, cats = matriz(d, opts)
    X = X.iloc[tr0].reset_index(drop=True)
    y = np.log(d["price_x"].values[tr0]); sup = d["sup"].values[tr0]; ppm2 = d["ppm2"].values[tr0]
    oof = np.full(len(X), np.nan); res, iters = [], []
    for a, va in fl:
        a = a[recorte_train(ppm2[a], trim)]
        lev = _niveles_var(X.iloc[a], cats)
        Xa, Xv = fijar_categorias(X.iloc[a], cats, lev), fijar_categorias(X.iloc[va], cats, lev)
        m = vp.ModeloGBM(opts, params).fit(Xa, y[a], sup[a], eval_set=(Xv, y[va], sup[va]))
        iters.append(m.best); oof[va] = m.predict(Xv, sup[va])
        res.append(metricas(np.exp(y[va]), np.exp(oof[va])))
    if opts.get("calibracion") == "isotonica":   # corrección post-hoc con cross-fitting (sin mirar el fold que corrige)
        oof = vp.calibrar_oof(oof, y, fl)
        res = [metricas(np.exp(y[va]), np.exp(oof[va])) for _, va in fl]
    n_seg = {k: int(np.mean([it[k] for it in iters]) * 1.1) for k in iters[0]}
    return pd.DataFrame(res), oof, n_seg


def tabla_segmentos(real, pred, sup, barrio) -> dict:
    out = {}
    for k, m in segmentos(real, sup, barrio).items():
        if m.sum():
            ape = np.abs(pred[m] - real[m]) / real[m]
            out[k] = {"n": int(m.sum()), "MAPE_mediana_%": float(np.median(ape) * 100),
                      "sesgo_mediano_%": float(np.median(real[m] / pred[m] - 1) * 100)}
    return out


def ablacion(df: pd.DataFrame, p: dict, nombres=None, progreso=lambda pct, msg: None) -> dict:
    import variantes_precio as vp
    d, pasos = limpiar(df, p.get("operacion", "venta"), p.get("currency", "USD"), p.get("tipo", "departamento"),
                       float(p.get("fx_mep", 1450)), bool(p.get("excluir_pozo", True)))
    d = d.reset_index(drop=True)
    tr0, te = separar(d, "agrupado", float(p.get("test_size", 0.2)), int(p.get("seed", 42)))
    fl = folds(d["grupo"].values[tr0], int(p.get("cv_folds", 5)), int(p.get("seed", 42)))
    real = d["price_x"].values[tr0]; sup = d["sup"].values[tr0]; bar = d["barrio"].values[tr0]
    filas, oofs = [], {}
    nombres = nombres or list(vp.VARIANTES)
    for i, n in enumerate(nombres):
        progreso(5 + 90 * i / len(nombres), f"Ablación: {n}")
        r, oof, nseg = cv_variante(d, tr0, fl, vp.VARIANTES[n], PARAMS_V1, float(p.get("trim_pct", 1.0)))
        oofs[n] = oof
        seg = tabla_segmentos(real, np.exp(oof), sup, bar)
        filas.append({"variante": n, **{f"{k}_media": r[k].mean() for k in ["MAPE_mediana_%", "dentro_10%_%", "R2_log", "MAE"]},
                      "MAPE_mediana_%_std": r["MAPE_mediana_%"].std(),
                      **{f"MAPE {k}": v["MAPE_mediana_%"] for k, v in seg.items() if k != "todos"},
                      **{f"sesgo {k}": v["sesgo_mediano_%"] for k, v in seg.items() if k != "todos"}})
    return {"d": d, "pasos": pasos, "tr0": tr0, "te": te, "fl": fl, "tabla": pd.DataFrame(filas), "oofs": oofs}
