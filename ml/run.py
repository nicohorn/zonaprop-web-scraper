"""Entrenamientos de la sección "Modelos" de la interfaz.

  python ml/run.py <tarea> --run-dir data/ml/runs/<id>

Lee <run-dir>/params.json (los faltantes toman el default de ml/tasks.json), informa el avance
como líneas JSON por stdout ({"pct": 40, "step": "..."}) y deja en <run-dir>:
  result.json   métricas, tablas chicas para la interfaz, lista de archivos
  *.csv / *.png artefactos
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import traceback
import warnings
from datetime import date, datetime, timezone
from pathlib import Path

warnings.filterwarnings("ignore")
sys.path.insert(0, str(Path(__file__).parent))

import numpy as np
import pandas as pd

import zpml

RUN: Path = Path(".")
ARTIFACTS: list[str] = []


def progress(pct: float, step: str):
    print(json.dumps({"pct": round(float(pct), 1), "step": step}, ensure_ascii=False), flush=True)


def save_csv(df: pd.DataFrame, name: str):
    df.to_csv(RUN / name, index=False, encoding="utf-8-sig")
    ARTIFACTS.append(name)


def save_fig(fig, name: str):
    fig.tight_layout()
    fig.savefig(RUN / name, dpi=110)
    ARTIFACTS.append(name)
    import matplotlib.pyplot as plt
    plt.close(fig)


def plt_():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    return plt


def table(df: pd.DataFrame, n=30) -> dict:
    d = df.head(n).replace({np.nan: None})
    return {"columns": list(d.columns), "rows": [[_py(v) for v in r] for r in d.itertuples(index=False)]}


def _py(v):
    if isinstance(v, (np.floating, float)):
        return None if not np.isfinite(v) else round(float(v), 4)
    if isinstance(v, np.integer):
        return int(v)
    return v if v is None or isinstance(v, (int, str, bool)) else str(v)


def have(mod: str) -> bool:
    try:
        __import__(mod)
        return True
    except Exception:
        return False


def need_rows(d, n, what):
    if len(d) < n:
        raise SystemExit(f"Hay {len(d)} avisos para {what}; hacen falta al menos {n}. Dejá correr el scraper un rato más.")


def gbm(params, n_rows):
    """LightGBM si está instalado; si no, HistGradientBoosting de scikit-learn."""
    if have("lightgbm"):
        import lightgbm as lgb
        return lgb.LGBMRegressor(n_estimators=int(params.get("n_estimators", 800)), learning_rate=float(params.get("learning_rate", 0.05)),
                                 max_depth=int(params.get("max_depth", -1)), num_leaves=int(params.get("num_leaves", 63)),
                                 min_child_samples=max(5, min(20, n_rows // 50)), subsample=0.8, subsample_freq=1,
                                 colsample_bytree=0.8, verbose=-1, random_state=42), "LightGBM"
    from sklearn.ensemble import HistGradientBoostingRegressor
    md = int(params.get("max_depth", -1))
    return HistGradientBoostingRegressor(max_iter=int(params.get("n_estimators", 800)), learning_rate=float(params.get("learning_rate", 0.05)),
                                         max_depth=None if md < 1 else md, categorical_features="from_dtype", random_state=42), "HistGradientBoosting"


def ridge_pipe(nums, cats, alpha):
    from sklearn.compose import ColumnTransformer
    from sklearn.impute import SimpleImputer
    from sklearn.linear_model import Ridge
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import OneHotEncoder, StandardScaler
    pre = ColumnTransformer([
        ("num", make_pipeline(SimpleImputer(strategy="median", add_indicator=True), StandardScaler()), nums),
        ("cat", make_pipeline(SimpleImputer(strategy="constant", fill_value="NA"), OneHotEncoder(handle_unknown="ignore", min_frequency=3)), cats),
    ])
    return make_pipeline(pre, Ridge(alpha=alpha))


def metrics(y_true_price, y_pred_price) -> dict:
    from sklearn.metrics import mean_absolute_error, r2_score
    yt, yp = np.asarray(y_true_price, float), np.clip(np.asarray(y_pred_price, float), 1e-9, None)
    ape = np.abs(yp - yt) / yt
    return {"MAE": float(mean_absolute_error(yt, yp)), "MAPE_mediana_%": float(np.median(ape) * 100),
            "dentro_10%_%": float(np.mean(ape < 0.10) * 100), "R2_log": float(r2_score(np.log(yt), np.log(yp)))}


def text_svd(texts_train, texts_test, p):
    from sklearn.decomposition import TruncatedSVD
    from sklearn.feature_extraction.text import TfidfVectorizer
    vec = TfidfVectorizer(max_features=int(p.get("max_features", 5000)), ngram_range=(1, int(p.get("ngram_max", 2))),
                          min_df=int(p.get("min_df", 5)), strip_accents="unicode", lowercase=True, sublinear_tf=True)
    A = vec.fit_transform(texts_train)
    B = vec.transform(texts_test)
    k = max(2, min(int(p.get("svd_components", 50)), A.shape[1] - 1, A.shape[0] - 1))
    svd = TruncatedSVD(n_components=k, random_state=42)
    cols = [f"txt_{i}" for i in range(k)]
    return pd.DataFrame(svd.fit_transform(A), columns=cols), pd.DataFrame(svd.transform(B), columns=cols), vec, A, B


def texts(d):
    desc = d["description"] if "description" in d else pd.Series("", index=d.index)
    return (d["title"].fillna("") + ". " + desc.fillna(d.get("description_short", "")).fillna("")).astype(str)


def split_idx(d: pd.DataFrame, p) -> tuple[np.ndarray, np.ndarray]:
    """aleatorio: train_test_split con semilla; temporal: el test son los avisos más nuevos."""
    from sklearn.model_selection import train_test_split
    n, ts = len(d), float(p.get("test_size", 0.2))
    if p.get("split") == "temporal":
        col = lambda c: pd.to_datetime(d[c] if c in d else pd.Series(pd.NaT, index=d.index), errors="coerce", utc=True)
        when = col("date_posted").fillna(col("scraped_at"))
        order = np.argsort(when.fillna(when.min()).values, kind="stable")
        k = max(1, int(round(n * ts)))
        return np.sort(order[:-k]), np.sort(order[-k:])
    return train_test_split(np.arange(n), test_size=ts, random_state=int(p.get("seed", 42)))


def save_price_model(model, ridge, name, columns, nums, cats, X, d, p, metrics_, n_tr, n_te, resid_log):
    """Modelo + metadatos en la carpeta de la corrida; data/ml/latest_price.json apunta a la última."""
    import joblib
    levels = {c: [str(v) for v in X[c].cat.categories] for c in cats}
    q = np.quantile(resid_log, [0.1, 0.25, 0.5, 0.75, 0.9]) if len(resid_log) else np.zeros(5)
    meta = {
        "run": RUN.name, "created_at": datetime.now(timezone.utc).isoformat(), "modelo": name,
        "target": p["target"], "operacion": p["operacion"], "currency": p["currency"], "fx_mep": p["fx_mep"], "tipo": p["tipo"],
        "split": p.get("split", "aleatorio"), "test_size": p["test_size"], "seed": p.get("seed", 42),
        "n_train": int(n_tr), "n_test": int(n_te), "metricas_test": metrics_,
        "columns": list(columns), "nums": nums, "cats": cats, "levels": levels,
        "barrios": d["barrio"].value_counts().to_dict(), "tipos": sorted(d["tipo_prop"].dropna().unique().tolist()),
        "resid_log_quantiles": {"q10": float(q[0]), "q25": float(q[1]), "q50": float(q[2]), "q75": float(q[3]), "q90": float(q[4])},
        "predictable": not p.get("use_text"),
    }
    joblib.dump({"gbm": model, "ridge": ridge, "meta": meta}, RUN / "model.joblib")
    (RUN / "model.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1, default=_py), encoding="utf-8")
    ARTIFACTS.append("model.json")
    if meta["predictable"]:
        (RUN.parent.parent / "latest_price.json").write_text(json.dumps({"run": RUN.name}), encoding="utf-8")


# ---------------------------------------------------------------------------------------------
def task_price(p):
    from sklearn.model_selection import train_test_split
    progress(3, "Cargando avisos")
    df = zpml.load()
    d = zpml.price_frame(df, p["operacion"], p["currency"], float(p["fx_mep"]), p["tipo"])
    need_rows(d, 60, "entrenar")
    progress(10, f"{len(d)} avisos · armando variables")
    X, nums, cats = zpml.build_features(d)
    y_price = d["price_x"].values
    sup = d["sup"].values
    y = np.log(y_price) if p["target"] == "log_price" else y_price / sup
    to_price = (lambda v, s: np.exp(v)) if p["target"] == "log_price" else (lambda v, s: v * s)
    tr, te = split_idx(d, p)
    Xtr, Xte = X.iloc[tr].reset_index(drop=True), X.iloc[te].reset_index(drop=True)
    if p.get("use_text"):
        progress(15, "Texto: TF-IDF + SVD")
        t = texts(d)
        A, B, *_ = text_svd(t.iloc[tr], t.iloc[te], {"svd_components": 30, "min_df": 3})
        Xtr, Xte = pd.concat([Xtr, A], axis=1), pd.concat([Xte, B], axis=1)
        nums = nums + list(A.columns)

    progress(25, "Baseline: Ridge")
    rp = ridge_pipe(nums, cats, float(p["ridge_alpha"]))
    obj = lambda Z: Z.astype({c: object for c in cats})  # one-hot sobre texto, no category
    rp.fit(obj(Xtr), y[tr])
    m_ridge = metrics(y_price[te], to_price(rp.predict(obj(Xte)), sup[te]))

    model, name = gbm(p, len(tr))
    progress(45, f"Entrenando {name} ({p['n_estimators']} árboles)")
    model.fit(Xtr, y[tr])
    pred = to_price(model.predict(Xte), sup[te])
    m_gbm = metrics(y_price[te], pred)
    progress(70, "Gráficos")

    plt = plt_()
    fig, ax = plt.subplots(figsize=(6, 6))
    ax.scatter(y_price[te], pred, s=6, alpha=.4)
    lim = [np.percentile(y_price[te], 1), np.percentile(y_price[te], 99)]
    ax.plot(lim, lim, "r--", lw=1); ax.set_xscale("log"); ax.set_yscale("log")
    ax.set_xlabel("Precio real"); ax.set_ylabel("Predicción"); ax.set_title(f"{name}: test")
    save_fig(fig, "pred_vs_real.png")

    imp = None
    if hasattr(model, "feature_importances_"):
        imp = pd.DataFrame({"variable": Xtr.columns, "importancia": model.feature_importances_}).sort_values("importancia", ascending=False)
        fig, ax = plt.subplots(figsize=(7, 6))
        top = imp.head(20)[::-1]
        ax.barh(top["variable"], top["importancia"]); ax.set_title("Importancia (splits)")
        save_fig(fig, "importancia.png")
        save_csv(imp, "importancia.csv")

    if p.get("shap") and have("shap") and name == "LightGBM":
        progress(80, "SHAP")
        try:
            import shap
            sample = Xte.sample(min(1000, len(Xte)), random_state=0)
            sv = shap.TreeExplainer(model).shap_values(sample)
            shap.summary_plot(sv, sample, show=False, max_display=20)
            save_fig(plt.gcf(), "shap_summary.png")
        except Exception as e:  # SHAP es un extra: no voltea la corrida
            progress(85, f"SHAP falló: {e}")

    progress(92, "Guardando predicciones")
    out = d.iloc[te][["id", "url", "barrio", "tipo_prop", "price_x", "sup", "ambientes"]].copy()
    out["pred"] = pred
    out["residuo_%"] = (out["price_x"] / out["pred"] - 1) * 100
    save_csv(out.sort_values("residuo_%"), "predicciones_test.csv")
    progress(96, "Guardando modelo")
    save_price_model(model, rp, name, Xtr.columns, nums, cats, X, d, p, {"Ridge": m_ridge, name: m_gbm},
                     len(tr), len(te), np.log(y_price[te] / pred))
    return {"n_train": len(tr), "n_test": len(te), "split": p["split"], "modelo": name, "modelo_guardado": "model.joblib",
            "metricas": {"Ridge (test)": m_ridge, f"{name} (test)": m_gbm},
            "tablas": {"Importancia": table(imp, 20)} if imp is not None else {}}


def task_anomaly(p):
    from sklearn.ensemble import IsolationForest
    from sklearn.model_selection import KFold
    progress(3, "Cargando avisos")
    df = zpml.load()
    d = zpml.price_frame(df, p["operacion"], "USD" if p["operacion"] == "venta" else "ARS", tipo=p["tipo"])
    counts = d["barrio"].value_counts()
    d = d[d["barrio"].isin(counts[counts >= int(p["min_barrio"])].index)].reset_index(drop=True)
    need_rows(d, 60, "buscar anomalías")
    X, nums, cats = zpml.build_features(d)
    y = np.log(d["price_x"].values)
    oof = np.zeros(len(d))
    k = int(p["n_folds"])
    for i, (tr, te) in enumerate(KFold(k, shuffle=True, random_state=42).split(X)):
        progress(10 + 60 * i / k, f"Residuos fuera de muestra: fold {i + 1}/{k}")
        m, name = gbm({"n_estimators": 500}, len(tr))
        m.fit(X.iloc[tr], y[tr])
        oof[te] = m.predict(X.iloc[te])
    progress(75, "IsolationForest")
    d["pred"] = np.exp(oof)
    d["residuo_%"] = (d["price_x"] / d["pred"] - 1) * 100
    med = d.groupby("barrio")["ppm2"].transform("median")
    d["ppm2_mediana_barrio"] = med
    d["ppm2_vs_barrio_%"] = (d["ppm2"] / med - 1) * 100
    F = np.column_stack([np.log(d["ppm2"] / med), y - oof, np.log(d["sup"]), d["ambientes"].fillna(d["ambientes"].median()).fillna(2)])
    iso = IsolationForest(contamination=float(p["contamination"]), random_state=42).fit(F)
    d["anomalia"] = iso.predict(F) == -1
    d["score_anomalia"] = -iso.score_samples(F)
    # Control de calidad de datos ANTES de rankear oportunidades
    thr = float(p.get("umbral_barrio", 0.35))
    ratio = d["ppm2"] / med
    amb = pd.to_numeric(d["ambientes"], errors="coerce")
    motivos = pd.DataFrame(index=d.index)
    motivos[f"USD/m² < {thr:g}× mediana del barrio"] = ratio < thr
    motivos["m² implausibles"] = (~d["sup"].between(18, 1500)) | (amb.notna() & (amb > 0) & (d["sup"] / amb.where(amb > 0) < 9))
    # Precio en pesos cargado como USD: USD/m² absurdo o muy por encima del barrio
    motivos["posible ARS cargado como USD"] = (d["ppm2"] > 25000) | (ratio > 6) | (d["price_x"] > 30_000_000)
    motivos["precio implausiblemente bajo"] = d["price_x"] < 15000
    d["error_datos"] = motivos.any(axis=1)
    d["motivo_error"] = motivos.apply(lambda r: "; ".join(c for c, v in r.items() if v), axis=1)
    # Oportunidad = barato según el modelo Y contra su barrio
    d["score_oportunidad"] = -(d["residuo_%"] + d["ppm2_vs_barrio_%"]) / 2
    cols = ["id", "url", "barrio", "tipo_prop", "price_x", "sup", "ambientes", "ppm2", "ppm2_mediana_barrio", "ppm2_vs_barrio_%", "pred", "residuo_%", "anomalia", "score_anomalia", "score_oportunidad"]
    ok = d[~d["error_datos"]]
    deals = ok.sort_values("score_oportunidad", ascending=False)[cols]
    errores = d[d["error_datos"]].sort_values("score_oportunidad", ascending=False)[cols + ["motivo_error"]]
    opps = deals[deals["score_oportunidad"] > 0]
    save_csv(deals, "oportunidades.csv")
    save_csv(errores, "posibles_errores_de_datos.csv")
    save_csv(d[d["anomalia"]].sort_values("score_anomalia", ascending=False)[cols + ["error_datos", "motivo_error"]], "anomalias.csv")
    plt = plt_()
    fig, ax = plt.subplots(figsize=(7, 4))
    ax.hist(d["residuo_%"].clip(-80, 150), bins=80); ax.set_xlabel("Precio vs. predicción (%)"); ax.set_title("Residuos fuera de muestra")
    save_fig(fig, "residuos.png")
    n = int(p["top_n"])
    anom = d["anomalia"]
    return {"n": len(d), "anomalias": int(anom.sum()), "umbral_barrio": thr,
            "posibles_errores_de_datos": int(d["error_datos"].sum()),
            "anomalias_error_datos": int((anom & d["error_datos"]).sum()),
            "anomalias_oportunidad": int((anom & ~d["error_datos"] & (d["score_oportunidad"] > 0)).sum()),
            "errores_por_motivo": {c: int(motivos[c].sum()) for c in motivos.columns},
            "metricas": {"Residuos": {"MAPE_mediana_%": float(np.median(np.abs(d["residuo_%"])))}},
            "tablas": {"Posibles oportunidades (datos limpios, más baratas que lo esperado)": table(opps.drop(columns=["score_anomalia"]), n),
                       "Posibles errores de datos": table(errores.drop(columns=["score_anomalia"]), n),
                       "Anomalías (IsolationForest)": table(d[anom].sort_values("score_anomalia", ascending=False)[cols + ["motivo_error"]], n)}}


def fetch_mep(manual=None, fallback=1450.0):
    """Dólar MEP: valor manual si se pasa (>0); si no, dolarapi.com (venta de 'bolsa'); si falla, el fallback."""
    if manual not in (None, "", 0, "0") and float(manual) > 0:
        return float(manual), {"fuente": "manual", "valor": float(manual)}
    url = "https://dolarapi.com/v1/dolares/bolsa"
    try:
        import urllib.request
        req = urllib.request.Request(url, headers={"User-Agent": "zonapropscraper"})
        with urllib.request.urlopen(req, timeout=10) as r:
            j = json.loads(r.read().decode("utf-8"))
        v = float(j["venta"])
        return v, {"fuente": url, "valor": v, "compra": j.get("compra"), "fechaActualizacion": j.get("fechaActualizacion"),
                   "consultado": datetime.now(timezone.utc).isoformat()}
    except Exception as e:
        return float(fallback), {"fuente": "fallback fijo", "valor": float(fallback), "error": f"{type(e).__name__}: {e}"}


def task_yields(p):
    progress(5, "Cargando avisos")
    df = zpml.load(include_details=False)
    as_of = p.get("as_of") or date.today().isoformat()
    if "scraped_at" in df:
        df = df[df["scraped_at"].astype(str).str[:10] <= as_of]
    fx, fx_info = fetch_mep(p.get("fx_mep"))
    progress(10, f"Dólar MEP {fx:g} ({fx_info['fuente']})")
    if p["tipo"] != "todos":
        df = df[df["tipo_prop"] == p["tipo"]]
    df = df.assign(sup=zpml.superficie(df))
    df = df[df["sup"].between(15, 3000)]
    progress(30, "Venta USD/m²")
    v = df[(df["operacion"] == "venta") & (df["price_currency"] == "USD")].copy()
    v["ppm2"] = pd.to_numeric(v["price"], errors="coerce") / v["sup"]
    progress(50, "Alquiler USD/m²")
    a = df[df["operacion"] == "alquiler"].copy()
    a["usd"] = zpml.rent_to_usd(a, fx)
    if p.get("include_expensas"):
        a["usd"] = a["usd"] - pd.to_numeric(a["expensas"], errors="coerce").fillna(0) / fx
    a["ppm2"] = a["usd"] / a["sup"]
    a = a[a["ppm2"] > 0]
    mn = int(p["min_n"])
    sv = v.groupby("barrio")["ppm2"].agg(venta_usd_m2="median", n_venta="size")
    sa = a.groupby("barrio")["ppm2"].agg(alquiler_usd_m2_mes="median", n_alquiler="size")
    t = sv.join(sa, how="inner")
    t = t[(t["n_venta"] >= mn) & (t["n_alquiler"] >= mn)]
    if t.empty:
        raise SystemExit("Ningún barrio tiene suficientes avisos de venta y de alquiler. Bajá el mínimo o esperá más datos.")
    t["rentabilidad_bruta_%"] = t["alquiler_usd_m2_mes"] * 12 / t["venta_usd_m2"] * 100
    t["años_para_recuperar"] = 100 / t["rentabilidad_bruta_%"]
    t = t.sort_values("rentabilidad_bruta_%", ascending=False).reset_index()
    save_csv(t, "rentabilidad_por_barrio.csv")
    progress(80, "Gráfico")
    plt = plt_()
    fig, ax = plt.subplots(figsize=(8, max(4, len(t) * .25)))
    s = t[::-1]
    ax.barh(s["barrio"], s["rentabilidad_bruta_%"]); ax.set_xlabel("% bruto anual"); ax.set_title(f"Rentabilidad bruta (MEP {fx:g}, al {as_of})")
    save_fig(fig, "rentabilidad.png")
    return {"as_of": as_of, "fx_mep": fx, "fx_mep_info": fx_info, "metricas": {"CABA": {"mediana_%": float(t["rentabilidad_bruta_%"].median()), "barrios": len(t)}},
            "tablas": {"Rentabilidad por barrio": table(t, 60)}}


def task_segments(p):
    from sklearn.decomposition import PCA
    from sklearn.impute import SimpleImputer
    from sklearn.preprocessing import StandardScaler
    progress(5, "Cargando avisos")
    df = zpml.load()
    d = zpml.price_frame(df, p["operacion"], "USD" if p["operacion"] == "venta" else "ARS").reset_index(drop=True)
    need_rows(d, 50, "segmentar")
    X, _, _ = zpml.build_features(d)
    X["usd_m2"] = d["ppm2"].values
    feats = [f for f in p["features"] if f in X and X[f].notna().mean() > 0.3]
    if len(feats) < 2:
        raise SystemExit(f"Hacen falta al menos 2 variables con datos; disponibles: {feats}. (antigüedad/amenities requieren fichas.)")
    progress(25, f"Estandarizando {', '.join(feats)}")
    M = X[feats].astype(float).copy()
    for c in ["usd_m2", "superficie", "expensas_m2"]:
        if c in M:
            M[c] = np.log1p(M[c].clip(lower=0))
    Z = StandardScaler().fit_transform(SimpleImputer(strategy="median").fit_transform(M))
    progress(45, f"Clustering ({p['method']})")
    if p["method"] == "hdbscan":
        from sklearn.cluster import HDBSCAN
        labels = HDBSCAN(min_cluster_size=int(p["min_cluster_size"])).fit_predict(Z)
    else:
        from sklearn.cluster import KMeans
        labels = KMeans(n_clusters=int(p["k"]), n_init=10, random_state=42).fit_predict(Z)
    d["segmento"] = labels
    progress(75, "Perfiles")
    prof = X[feats].assign(segmento=labels).groupby("segmento").median()
    prof.insert(0, "n", pd.Series(labels).value_counts().sort_index())
    prof["barrios_top"] = d.groupby("segmento")["barrio"].agg(lambda s: ", ".join(s.value_counts().head(3).index))
    prof = prof.reset_index()
    save_csv(prof, "segmentos_perfil.csv")
    save_csv(d[["id", "url", "barrio", "tipo_prop", "price_x", "sup", "ambientes", "segmento"]], "segmentos.csv")
    P = PCA(2, random_state=42).fit_transform(Z)
    plt = plt_()
    fig, ax = plt.subplots(figsize=(7, 6))
    sc = ax.scatter(P[:, 0], P[:, 1], c=labels, s=5, cmap="tab10", alpha=.6)
    ax.legend(*sc.legend_elements(), title="seg.", fontsize=8); ax.set_title("Segmentos (PCA)")
    save_fig(fig, "segmentos_pca.png")
    return {"n": len(d), "features": feats, "segmentos": int(len(set(labels) - {-1})), "ruido": int((labels == -1).sum()),
            "tablas": {"Perfil (medianas)": table(prof, 40)}}


def task_text(p):
    from sklearn.linear_model import Ridge
    from sklearn.model_selection import train_test_split
    progress(5, "Cargando avisos")
    df = zpml.load()
    d = zpml.price_frame(df, p["operacion"], "USD" if p["operacion"] == "venta" else "ARS", tipo=p["tipo"]).reset_index(drop=True)
    need_rows(d, 80, "el modelo de texto")
    t = texts(d)
    y = np.log(d["price_x"].values)
    tr, te = split_idx(d, p)
    progress(20, "TF-IDF")
    A, B, vec, Atf, Btf = text_svd(t.iloc[tr], t.iloc[te], p)
    progress(40, "Ridge sólo texto (log precio por m²)")
    ylm = np.log(d["ppm2"].values)
    r = Ridge(alpha=3.0).fit(Atf, ylm[tr])
    terms = np.array(vec.get_feature_names_out())
    order = np.argsort(r.coef_)
    words = pd.DataFrame({"suben_precio": terms[order[::-1][:30]], "coef_sube": r.coef_[order[::-1][:30]],
                          "bajan_precio": terms[order[:30]], "coef_baja": r.coef_[order[:30]]})
    save_csv(words, "terminos.csv")
    X, nums, cats = zpml.build_features(d)
    Xtr, Xte = X.iloc[tr].reset_index(drop=True), X.iloc[te].reset_index(drop=True)
    res = {}
    progress(55, "Modelo estructurado (sin texto)")
    m, name = gbm({"n_estimators": 600}, len(tr)); m.fit(Xtr, y[tr])
    res[f"{name} sin texto"] = metrics(np.exp(y[te]), np.exp(m.predict(Xte)))
    progress(75, "Modelo estructurado + texto")
    m2, _ = gbm({"n_estimators": 600}, len(tr)); m2.fit(pd.concat([Xtr, A], axis=1), y[tr])
    res[f"{name} + texto"] = metrics(np.exp(y[te]), np.exp(m2.predict(pd.concat([Xte, B], axis=1))))
    res = {f"{k} (test)": v for k, v in res.items()}
    return {"n": len(d), "n_train": len(tr), "n_test": len(te), "split": p["split"], "vocabulario": int(len(terms)), "fuente_texto": "description" if "description" in d else "title + description_short",
            "metricas": res, "tablas": {"Términos que mueven el USD/m²": table(words, 30)}}


def task_survival(p):
    progress(5, "Cargando historial")
    df = zpml.load(include_details=False, history=True)
    df = df[df["operacion"] == p["operacion"]]
    fails = pd.DataFrame(zpml.read_jsonl(zpml.DATA / "failures.jsonl"))
    gone = set()
    if not fails.empty and "error" in fails:
        gone = set(fails.loc[fails["error"].astype(str).str.contains("no parece ficha"), "key"].astype(str).str.replace("detail:", "", regex=False))
    g = df.groupby("id").agg(barrio=("barrio", "first"), first=("date_posted", "min"), last=("scraped_at", "max"),
                             cambios=("changed_fields", lambda s: s.notna().sum()) if "changed_fields" in df else ("id", lambda s: 0))
    g["event"] = g.index.astype(str).isin(gone).astype(int)
    first = pd.to_datetime(g["first"], errors="coerce", utc=True)
    last = pd.to_datetime(g["last"], errors="coerce", utc=True)
    g["dias"] = (last - first).dt.days
    g = g[g["dias"] >= 0]
    n_ev = int(g["event"].sum())
    span = (last.max() - last.min()).days if len(last.dropna()) else 0
    if n_ev < int(p["min_events"]):
        return {"estado": "faltan_datos", "bajas_observadas": n_ev, "avisos": len(g), "dias_de_historial": span,
                "nota": ("Para esto hace falta volver a recorrer las búsquedas con 'Historial de cambios' activado durante varias "
                         "semanas y visitar las fichas (las dadas de baja quedan en failures.jsonl). Con eso se mide cuánto tarda "
                         "un aviso en bajarse y qué lo acelera (precio vs. barrio, rebajas).")}
    from lifelines import CoxPHFitter, KaplanMeierFitter
    progress(40, "Kaplan-Meier")
    plt = plt_()
    fig, ax = plt.subplots(figsize=(7, 5))
    for b in g["barrio"].value_counts().head(int(p["top_barrios"])).index:
        s = g[g["barrio"] == b]
        KaplanMeierFitter().fit(s["dias"], s["event"], label=b).plot_survival_function(ax=ax, ci_show=False)
    ax.set_xlabel("días publicados"); save_fig(fig, "kaplan_meier.png")
    progress(70, "Cox")
    cph = CoxPHFitter(penalizer=0.1).fit(g[["dias", "event", "cambios"]], "dias", "event")
    summ = cph.summary.reset_index()[["covariate", "exp(coef)", "p"]]
    return {"estado": "ok", "bajas_observadas": n_ev, "avisos": len(g), "tablas": {"Cox": table(summ)}}


TASK_FUNCS = {"price": task_price, "anomaly": task_anomaly, "yields": task_yields, "segments": task_segments,
              "text": task_text, "survival": task_survival}


def with_defaults(task: str, raw: dict) -> dict:
    spec = zpml.TASKS[task]["params"]
    return {k: raw.get(k, v["default"]) for k, v in spec.items()}


def main():
    global RUN
    ap = argparse.ArgumentParser()
    ap.add_argument("task", choices=sorted(TASK_FUNCS))
    ap.add_argument("--run-dir", required=True)
    a = ap.parse_args()
    RUN = Path(a.run_dir); RUN.mkdir(parents=True, exist_ok=True)
    pfile = RUN / "params.json"
    params = with_defaults(a.task, json.loads(pfile.read_text(encoding="utf-8")) if pfile.exists() else {})
    t0 = time.time()
    result = {"task": a.task, "params": params, "started_at": datetime.now(timezone.utc).isoformat()}
    try:
        out = TASK_FUNCS[a.task](params)
        result.update(status="ok", **out)
        code = 0
    except SystemExit as e:
        result.update(status="error", error=str(e))
        code = 2
    except Exception as e:
        result.update(status="error", error=f"{type(e).__name__}: {e}", traceback=traceback.format_exc())
        code = 1
    result["seconds"] = round(time.time() - t0, 1)
    result["artifacts"] = ARTIFACTS
    (RUN / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=1, default=_py), encoding="utf-8")
    progress(100, "Listo" if code == 0 else f"Error: {result['error']}")
    sys.exit(code)


if __name__ == "__main__":
    main()
