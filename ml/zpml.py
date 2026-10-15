"""Carga y preparación de datos de ZonaProp para los modelos (CABA).

Lo usan ml/run.py (la sección Modelos de la interfaz) y notebooks/01_price_prediction.ipynb.
Lee data/listings.jsonl (última versión de cada id) y, si existe, data/details.jsonl.
ZP_DATA_DIR cambia la carpeta (lo usan los tests).
"""
from __future__ import annotations

import json
import os
import re
import unicodedata
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("ZP_DATA_DIR") or ROOT / "data")
TASKS = json.loads((Path(__file__).parent / "tasks.json").read_text(encoding="utf-8"))


def norm(s) -> str:
    s = unicodedata.normalize("NFKD", str(s or ""))
    return "".join(c for c in s if not unicodedata.combining(c)).lower().strip()


def _caba_names() -> set[str]:
    # Misma lista que src/caba.js, para no mantener dos.
    src = (ROOT / "src" / "caba.js").read_text(encoding="utf-8")
    block = src.split("CABA_BARRIOS = [", 1)[1].split("];", 1)[0]
    names = re.findall(r"'([^']+)'", block)
    return {norm(n) for n in names} | {"capital federal", "caba", "ciudad autonoma de buenos aires"}


CABA = _caba_names()


def read_jsonl(path: Path) -> list[dict]:
    rows = []
    if not path.exists():
        return rows
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass  # línea cortada a mitad de escritura
    return rows


def barrio_from_location(loc) -> str | None:
    """'Palermo, Capital Federal' -> 'Palermo'; 'Las Cañitas, Palermo' -> 'Palermo'."""
    if not isinstance(loc, str) or not loc.strip():
        return None
    parts = [p.strip() for p in loc.split(",") if p.strip()]
    last = parts[-1]
    if norm(last) in {"capital federal", "caba"}:
        return parts[0] if len(parts) > 1 else None
    return last


def is_caba(loc) -> bool:
    if not isinstance(loc, str):
        return False
    parts = [p for p in loc.split(",") if p.strip()]
    return bool(parts) and norm(parts[-1]) in CABA


# Código del aviso en la URL: 've' venta / 'al' alquiler, 'cl' clasificado, luego tipo.
_TIPO_CODE = {"ap": "departamento", "ca": "casa", "ph": "ph", "tr": "terreno", "lc": "local", "oc": "oficina",
              "ga": "cochera", "ra": "cochera", "fc": "fondo_comercio", "de": "deposito", "ed": "edificio",
              "ht": "hotel", "bg": "otro"}  # verificado contra URLs reales (oct 2026)
_TIPO_WORDS = [("departamento", "departamento"), ("monoambiente", "departamento"), ("depto", "departamento"),
               ("ph", "ph"), ("casa", "casa"), ("terreno", "terreno"), ("lote", "terreno"), ("local", "local"),
               ("oficina", "oficina"), ("cochera", "cochera")]


def tipo_from_row(url, title, tipo_propiedad=None) -> str:
    if isinstance(tipo_propiedad, str) and tipo_propiedad:
        t = norm(tipo_propiedad)
        for w, v in _TIPO_WORDS:
            if w in t:
                return v
    if "/emprendimiento/" in str(url or ""):
        return "emprendimiento"
    m = re.search(r"/clasificado/[a-z]{4}([a-z]{2})[a-z]*-", str(url or ""))
    if m and m.group(1) in _TIPO_CODE:
        return _TIPO_CODE[m.group(1)]
    t = " " + norm(title) + " "
    for w, v in _TIPO_WORDS:
        if f" {w}" in t:
            return v
    return "otro"


def load(include_details: bool = True, caba_only: bool = True, history: bool = False) -> pd.DataFrame:
    rows = read_jsonl(DATA / "listings.jsonl")
    if not rows:
        raise SystemExit(f"No hay avisos en {DATA / 'listings.jsonl'}: corré el scraper primero.")
    df = pd.DataFrame(rows)
    if not history:
        df = df.drop_duplicates("id", keep="last")
    if include_details:
        det = read_jsonl(DATA / "details.jsonl")
        if det:
            d = pd.DataFrame(det).drop_duplicates("id", keep="last")
            extra = [c for c in d.columns if c not in df.columns or c in ("description", "photos")]
            d = d[["id"] + [c for c in extra if c != "id"]]
            df = df.drop(columns=[c for c in ("description", "photos") if c in d.columns and c in df.columns]).merge(d, on="id", how="left")
    if caba_only:
        df = df[df["location"].map(is_caba)]
    df = df.copy()
    df["barrio"] = df["location"].map(barrio_from_location)
    df["tipo_prop"] = [tipo_from_row(u, t, tp) for u, t, tp in zip(df["url"], df.get("title"), df.get("tipo_propiedad", pd.Series([None] * len(df), index=df.index)))]
    if "operacion" in df:
        df["operacion"] = df["operacion"].map(lambda s: norm(s).replace(" ", "-") if isinstance(s, str) else s)
    return df


NUM_BASE = ["superficie_total", "superficie_cubierta", "ambientes", "dormitorios", "banos", "cocheras", "expensas"]
NUM_DETAIL = ["antiguedad", "toilettes", "published_days"]


def build_features(df: pd.DataFrame) -> tuple[pd.DataFrame, list[str], list[str]]:
    """Variables numéricas y categóricas a partir de lo que trae el scraper."""
    X = pd.DataFrame(index=df.index)
    for c in NUM_BASE + NUM_DETAIL:
        if c in df:
            X[c] = pd.to_numeric(df[c], errors="coerce")
    sup = superficie(df)
    X["superficie"] = sup
    X["cub_ratio"] = (pd.to_numeric(df.get("superficie_cubierta"), errors="coerce") / pd.to_numeric(df.get("superficie_total"), errors="coerce")).clip(0, 1.5)
    X["expensas_m2"] = X.get("expensas") / sup
    X["fotos"] = df["photos"].map(lambda p: len(p) if isinstance(p, list) else np.nan) if "photos" in df else np.nan
    if "amenities_flat" in df:
        X["amenities_count"] = df["amenities_flat"].map(lambda a: len(a) if isinstance(a, list) else np.nan)
    X["destacado"] = df.get("highlight", pd.Series(index=df.index, dtype=object)).notna().astype(int)
    X["emprendimiento"] = (df.get("posting_type") == "DEVELOPMENT").astype(int)
    txt = (df.get("title", "").fillna("") + " " + df.get("description_short", "").fillna("")).map(norm)
    for kw in ["a estrenar", "reciclar", "apto credito", "balcon", "terraza", "pileta", "amenities", "luminoso", "frente", "contrafrente", "cochera", "patio"]:
        X["kw_" + kw.replace(" ", "_")] = txt.str.contains(kw, regex=False).astype(int)
    cats = ["barrio", "tipo_prop"]
    for c in ["disposicion", "orientacion", "luminosidad"]:
        if c in df:
            cats.append(c)
    for c in cats:
        X[c] = df[c].astype("category")
    nums = [c for c in X.columns if c not in cats]
    X = X.dropna(axis=1, how="all")
    nums = [c for c in nums if c in X]
    cats = [c for c in cats if c in X]
    return X, nums, cats


def superficie(df: pd.DataFrame) -> pd.Series:
    cub = pd.to_numeric(df.get("superficie_cubierta"), errors="coerce")
    tot = pd.to_numeric(df.get("superficie_total"), errors="coerce")
    return cub.where(cub > 0, tot)


def price_frame(df: pd.DataFrame, operacion="venta", currency="USD", fx=1450.0, tipo="todos",
                min_m2=15, max_m2=3000) -> pd.DataFrame:
    """Avisos con precio y superficie razonables, precio en una sola moneda (columna price_x)."""
    d = df[(df["operacion"] == operacion)].copy()
    if tipo and tipo != "todos":
        d = d[d["tipo_prop"] == tipo]
    d["price"] = pd.to_numeric(d["price"], errors="coerce")
    if currency == "convertir_a_USD":
        d["price_x"] = np.where(d["price_currency"] == "ARS", d["price"] / fx, d["price"])
        d = d[d["price_currency"].isin(["USD", "ARS"])]
    else:
        d = d[d["price_currency"] == currency]
        d["price_x"] = d["price"]
    d["sup"] = superficie(d)
    d = d[(d["price_x"] > 0) & d["sup"].between(min_m2, max_m2)]
    d["ppm2"] = d["price_x"] / d["sup"]
    # recorte de valores absurdos (errores de carga: pesos publicados como dólares, m² de más)
    lo, hi = d["ppm2"].quantile([0.005, 0.995]) if len(d) > 50 else (0, np.inf)
    return d[d["ppm2"].between(lo, hi)]


def rent_to_usd(d: pd.DataFrame, fx: float) -> pd.Series:
    p = pd.to_numeric(d["price"], errors="coerce")
    return np.where(d["price_currency"] == "ARS", p / fx, np.where(d["price_currency"] == "USD", p, np.nan))
