"""Carga y preparación de datos de ZonaProp para los modelos (CABA).

Lo usan ml/run.py (la sección Modelos de la interfaz) y notebooks/01_price_prediction.ipynb.
Lee data/listings.jsonl (o data/listings.jsonl.gz si no está; última versión de cada id) y, si existe, data/details.jsonl.
ZP_DATA_DIR cambia la carpeta (lo usan los tests).
"""
from __future__ import annotations

import gzip
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
        # En un clon nuevo sólo está la versión comprimida (data/listings.jsonl.gz).
        gz = path.with_name(path.name + ".gz")
        if not gz.exists():
            return rows
        opener = lambda: gzip.open(gz, "rt", encoding="utf-8")
    else:
        opener = lambda: open(path, encoding="utf-8")
    with opener() as f:
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
        raise SystemExit(f"No hay avisos en {DATA / 'listings.jsonl'} (ni .gz): corré el scraper primero.")
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
NUM_DETAIL = ["antiguedad", "toilettes"]
# Fuera a propósito: published_days, destacado (highlight), cantidad de fotos y posting_type. Describen
# la publicación y no la propiedad, cambian con el tiempo y el formulario de predicción no los conoce.

# Montos en el texto ("USD 120.000", "$ 350.000", "u$s 95 mil", "120k"): se borran antes de cualquier
# variable de texto para que el modelo no lea el precio desde la descripción.
_AMOUNT = re.compile(
    r"(?:u\$s|us\$|usd|u\$d|dolares|dólares|\$|ars|pesos)\s*[\d.,]+(?:\s*(?:mil|k|millones?|m\b))?"
    r"|[\d.,]+\s*(?:mil|k|millones?)?\s*(?:u\$s|us\$|usd|dolares|dólares|pesos)"
    r"|\b\d{1,3}(?:[.,]\d{3})+\b|\b\d{5,}\b", re.I)


def strip_amounts(s) -> str:
    return _AMOUNT.sub(" ", str(s or ""))


def _text_col(df: pd.DataFrame, col: str) -> pd.Series:
    if col in df:
        return df[col].fillna("").astype(str)
    return pd.Series("", index=df.index, dtype=object)


def listing_text(df: pd.DataFrame) -> pd.Series:
    """Título + descripción corta (+ etiquetas), normalizado y sin montos."""
    pills = df["pills"].map(lambda p: " ".join(p) if isinstance(p, list) else "") if "pills" in df else pd.Series("", index=df.index)
    return (_text_col(df, "title") + " " + _text_col(df, "description_short") + " " + pills).map(strip_amounts).map(norm)


# Atributos que también pide el formulario de predicción (casillas), así train y predicción ven lo mismo.
FLAGS = {
    "a_estrenar": r"a estrenar|\bestrenar\b",
    "balcon_terraza": r"balcon|terraza",
    "amenities": r"amenities|pileta|piscina|\bsum\b|gimnasio|parrilla|quincho|laundry",
    "apto_credito": r"apto credito",
}

# v2: más atributos del texto existente (nunca montos). Se activan con build_features(..., version=2).
FLAGS_V2 = {
    "reciclado": r"reciclad|refaccionad|a nuevo",
    "a_reciclar": r"a reciclar|para reciclar|a refaccionar|para refaccionar",
    "luminoso": r"luminos",
    "frente": r"al frente|a la calle",
    "contrafrente": r"contrafrente",
    "cochera_txt": r"cochera|garage|garaje",
    "dependencia": r"dependencia",
    "suite": r"suite",
    "vista": r"vista abierta|vista panoramica|vista al rio|vista despejada|vistas",
    "semipiso": r"semipiso|semi piso|piso exclusivo|piso unico",
    "duplex": r"duplex|triplex",
    "penthouse": r"penthouse|pent house",
    "torre": r"\btorre\b",
    "patio": r"\bpatio\b",
    "baulera": r"baulera",
    "apto_profesional": r"apto profesional",
    "seguridad": r"seguridad|vigilancia",
    "categoria": r"categoria|premium|lujo|exclusiv|jerarquic",
    "planta_baja": r"planta baja|\bpb\b",
    "frances": r"estilo frances|frances",
    "impecable": r"impecable|excelente estado|muy buen estado",
}
_PISO = re.compile(r"\bpiso (\d{1,2})\b|\b(\d{1,2}) ?(?:°|º|o|to|vo|mo|ro|do|er|no)? piso\b")
_ANT = re.compile(r"(\d{1,3}) anos de antiguedad|antiguedad:? ?(\d{1,3})")


def _first_num(rx, t, lo, hi):
    m = rx.search(t)
    if not m:
        return np.nan
    v = float(next(g for g in m.groups() if g))
    return v if lo <= v <= hi else np.nan


# v3: más atributos (nunca montos). build_features(..., version=3)
FLAGS_V3 = {
    "piso_alto": r"piso alto|ultimo piso|pisos altos|alto con vista",
    "piso_bajo": r"piso bajo|primer piso|1er piso",
    "sin_expensas": r"sin expensas|bajas expensas|expensas bajas",
    "a_estrenar_v3": r"a estrenar|estrenar|nuevo a estrenar",
    "terraza_propia": r"terraza propia|terraza exclusiva|azotea propia",
    "parrilla_propia": r"parrilla propia",
    "pileta": r"pileta|piscina",
    "gimnasio": r"gimnasio|\bgym\b",
    "sum": r"\bsum\b|salon de usos",
    "toilette": r"toilette",
    "lavadero": r"lavadero",
    "cocina_separada": r"cocina separada|cocina independiente",
    "doble_circulacion": r"doble circulacion",
    "esquina": r"\besquina\b",
    "dueno_directo": r"dueno directo|duenio directo",
    "oportunidad": r"oportunidad|urgente|liquido|retasado",
    "escritura": r"escritura inmediata|escriturable",
    "edificio_antiguo": r"edificio antiguo|antiguo|estilo|techos altos",
    "humedad": r"humedad|a refaccionar|necesita arreglos",
    "amoblado": r"amoblado|amueblado",
}


POZO = re.compile(r"\bpozo\b|pre ?-?venta|en construccion|avances? de obra|anticipo|entrega (?:en|estimada|prevista)|posesion (?:en|estimada|prevista)")


def es_pozo(df: pd.DataFrame) -> pd.Series:
    """Avisos de pozo / en construcción: el precio suele ser parcial (anticipo, cuotas)."""
    t = (_text_col(df, "title") + " " + _text_col(df, "description_short")).map(norm)
    dev = (df["posting_type"] == "DEVELOPMENT") if "posting_type" in df else False
    return t.str.contains(POZO) | dev | (df.get("tipo_prop", pd.Series("", index=df.index)) == "emprendimiento")


def build_features(df: pd.DataFrame, version: int = 1) -> tuple[pd.DataFrame, list[str], list[str]]:
    """Variables numéricas y categóricas a partir de lo que trae el scraper (sin rasgos de la publicación)."""
    X = pd.DataFrame(index=df.index)
    for c in NUM_BASE + NUM_DETAIL:
        if c in df:
            X[c] = pd.to_numeric(df[c], errors="coerce")
    sup = superficie(df)
    X["superficie"] = sup
    X["log_superficie"] = np.log(sup.where(sup > 0))
    X["cub_ratio"] = (num_col(df, "superficie_cubierta") / num_col(df, "superficie_total")).clip(0, 1.5)
    if "expensas" in X:
        X["expensas_m2"] = X["expensas"] / sup
    if "ambientes" in X:
        X["m2_por_ambiente"] = sup / X["ambientes"].where(X["ambientes"] > 0)
    if "amenities_flat" in df:
        X["amenities_count"] = df["amenities_flat"].map(lambda a: len(a) if isinstance(a, list) else np.nan)
    txt = listing_text(df)
    for k, rx in FLAGS.items():
        X["kw_" + k] = txt.str.contains(rx).astype(int)
    if version >= 2:
        for k, rx in FLAGS_V2.items():
            X["kw_" + k] = txt.str.contains(rx).astype(int)
        X["piso_txt"] = txt.map(lambda t: _first_num(_PISO, t, 0, 60))
        X.loc[txt.str.contains(FLAGS_V2["planta_baja"]) & X["piso_txt"].isna(), "piso_txt"] = 0
        X["antiguedad_txt"] = txt.map(lambda t: _first_num(_ANT, t, 0, 150))
        X.loc[txt.str.contains(FLAGS["a_estrenar"]) & X["antiguedad_txt"].isna(), "antiguedad_txt"] = 0
    if version >= 3:
        for k, rx in FLAGS_V3.items():
            X["kw_" + k] = txt.str.contains(rx).astype(int)
        X["largo_texto"] = txt.str.len()
    cats = ["barrio", "tipo_prop"]
    for c in ["disposicion", "orientacion", "luminosidad"]:
        if c in df:
            cats.append(c)
    for c in cats:
        X[c] = df[c].astype("category") if c in df else pd.Series(np.nan, index=df.index, dtype="category")
    nums = [c for c in X.columns if c not in cats]
    X = X.dropna(axis=1, how="all")
    nums = [c for c in nums if c in X]
    cats = [c for c in cats if c in X]
    return X, nums, cats


def num_col(df: pd.DataFrame, col: str) -> pd.Series:
    """Columna numérica; NaN si no existe (df.get devolvería None o un escalar)."""
    if col in df:
        return pd.to_numeric(df[col], errors="coerce").astype(float)
    return pd.Series(np.nan, index=df.index, dtype=float)


def superficie(df: pd.DataFrame) -> pd.Series:
    cub = num_col(df, "superficie_cubierta")
    tot = num_col(df, "superficie_total")
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
