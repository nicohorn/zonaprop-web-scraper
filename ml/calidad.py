"""EDA de calidad de datos del scraper, pensado como control antes de entrenar el modelo A.

Seis chequeos; cada uno devuelve una sección con estado, hallazgos, KPIs, tablas y figuras:

  basicos()           0. controles básicos de la extracción: completitud, formato, unicidad, rangos, consistencia
                         y concordancia con la URL, sobre todos los avisos (independiente del modelo)
  embudo()            1. qué quita la limpieza de ml/precio.py y si lo hace parejo entre barrios
  duplicados()        2. la misma unidad publicada varias veces y la fuga train/test que produce
  faltantes()         3. qué falta y si falta al azar o según el precio (MNAR)
  representatividad() 4. avisos por barrio, estabilidad de la mediana y error del modelo A
  scraper()           5. deriva del parser en el tiempo, cobertura de las búsquedas y formatos

Lo usan ml/run.py (tarea "quality", página /calidad de la interfaz) y
notebooks/00_calidad_datos.ipynb. Las reglas de limpieza son las de ml/precio.py: el EDA audita
exactamente los datos con los que se entrena.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

import precio
import zpml

# Paleta (colores categóricos en orden fijo; ver la interfaz para los estados).
AZUL, NARANJA, AQUA, AMARILLO, MAGENTA, VERDE, VIOLETA, ROJO = (
    "#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948")
CATEG = [AZUL, NARANJA, AQUA, AMARILLO, MAGENTA, VERDE, VIOLETA, ROJO]
GRIS = "#9a9890"

DEFAULTS = {"operacion": "venta", "tipo": "departamento", "currency": "USD", "fx_mep": 1450, "excluir_pozo": True,
            "duplicados": "v2_direccion_texto", "min_barrio": 30, "umbral_deriva_pp": 15, "ventana": "auto",
            "trim_pct": 1.0, "test_size": 0.2, "seed": 42}


def _plt():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({"axes.spines.top": False, "axes.spines.right": False, "axes.grid": True, "grid.color": "#e6e5e0",
                         "grid.linewidth": .6, "axes.axisbelow": True, "axes.edgecolor": "#b5b3ab", "font.size": 9,
                         "axes.titlesize": 10.5, "axes.titleweight": "bold", "axes.titlelocation": "left"})
    return plt


def seccion(id_, titulo, pregunta, implicancia="") -> dict:
    return {"id": id_, "titulo": titulo, "pregunta": pregunta, "estado": "ok", "kpis": [], "hallazgos": [],
            "mitigacion": implicancia, "tablas": {}, "figuras": {}}


def kpi(s, label, valor, nota=""):
    s["kpis"].append({"label": label, "valor": valor, "nota": nota})


def peor(*estados) -> str:
    orden = ["sin_datos", "ok", "atencion", "critico"]
    return max(estados, key=orden.index)


def _pct(a, b) -> float:
    return float(a) / float(b) * 100 if b else float("nan")


def _f(v, dec=1) -> str:
    """Número con formato argentino (miles con punto, decimales con coma)."""
    if v is None or (isinstance(v, float) and not np.isfinite(v)):
        return "—"
    s = f"{v:,.{dec}f}" if dec else f"{round(v):,}"
    return s.replace(",", "§").replace(".", ",").replace("§", ".")


def params(p: dict | None) -> dict:
    return {**DEFAULTS, **(p or {})}


def limpiar(df, p, deduplicar=None, traza=None):
    p = params(p)
    if deduplicar is None:
        deduplicar = "huella" if p["duplicados"] == "v1_huella" else True
    return precio.limpiar(df, p["operacion"], p["currency"], p["tipo"], float(p["fx_mep"]), bool(p["excluir_pozo"]),
                          deduplicar=deduplicar, traza=traza)


# --- 0. Controles básicos del scraper -----------------------------------------------------------
# Sobre TODOS los avisos guardados (todas las operaciones y tipos, última versión de cada id), sin las reglas del modelo:
# ¿el scraper extrajo cada campo, con el formato y el rango esperables, sin repetir avisos y de forma coherente?
CAMPOS_BASICOS = ["id", "url", "operacion", "posting_type", "location", "price_currency", "price", "superficie_total",
                  "superficie_cubierta", "ambientes", "dormitorios", "banos", "cocheras", "expensas", "address", "title",
                  "description_short", "publisher", "date_posted", "photos", "search_slug", "page", "scraped_at"]
OBLIGATORIOS = {"id", "url", "operacion", "posting_type", "location", "search_slug", "page", "scraped_at", "title", "photos"}
# Rangos amplios de plausibilidad (incluyen terrenos, locales, edificios y alquileres): fuera de esto es error de carga o de parseo.
RANGOS = {"superficie_total": (10, 50_000), "superficie_cubierta": (10, 50_000), "ambientes": (1, 40), "dormitorios": (0, 30),
          "banos": (0, 30), "cocheras": (0, 100), "expensas": (1_000, 20_000_000), "page": (1, 500)}
# Precio por operación y moneda (los alquileres son mensuales; en dólares, desde unos USD 100).
RANGO_PRECIO = {("venta", "USD"): (5_000, 100_000_000), ("venta", "ARS"): (1_000_000, 200_000_000_000),
                ("alquiler", "USD"): (50, 1_000_000), ("alquiler", "ARS"): (10_000, 2_000_000_000),
                ("alquiler-temporal", "USD"): (20, 1_000_000), ("alquiler-temporal", "ARS"): (1_000, 2_000_000_000)}
_COD_OP = {"ve": "venta", "al": "alquiler", "te": "alquiler-temporal"}


def basicos(raw: pd.DataFrame, p: dict | None = None) -> dict:
    """raw: todas las líneas de listings.jsonl (se usa la última versión de cada id)."""
    p = params(p)
    s = seccion("basicos", "0 · Controles básicos del scraper",
                "¿El scraper guardó cada aviso una vez, con todos sus campos, en el formato y rango esperables y de forma coherente?",
                "Son controles sobre la extracción, independientes de cualquier modelo: completitud, formato, unicidad, rangos, "
                "consistencia entre campos y concordancia con la URL del aviso (una fuente independiente del texto parseado). "
                "Los campos que faltan por diseño del sitio (no por el parser) se marcan como estructurales.")
    v = raw.drop_duplicates("id", keep="last").reset_index(drop=True)
    n = len(v)
    num = {c: pd.to_numeric(v[c], errors="coerce") if c in v else pd.Series(np.nan, index=v.index) for c in
           ["price", "superficie_total", "superficie_cubierta", "ambientes", "dormitorios", "banos", "cocheras", "expensas", "page"]}
    txt = lambda c: v[c] if c in v else pd.Series(None, index=v.index, dtype=object)
    presente = lambda c: ~_vacio(txt(c)) if c in v else pd.Series(False, index=v.index)
    url = txt("url").fillna("").astype(str)
    op = txt("operacion").map(lambda x: zpml.norm(x).replace(" ", "-") if isinstance(x, str) else None)
    ts = pd.to_datetime(txt("scraped_at"), errors="coerce", utc=True, format="ISO8601")
    dp = pd.to_datetime(txt("date_posted"), errors="coerce", format="%Y-%m-%d")
    T = pd.Series(True, index=v.index)

    reglas = []
    con_falla = pd.Series(False, index=v.index)   # avisos que incumplen alguna regla de formato o rango

    def regla(dim, nombre, campo, falla, aplica=T, critica=False):
        a = aplica.fillna(False).astype(bool)
        f = (falla.fillna(False).astype(bool) & a)
        if dim in ("formato", "rango"):
            con_falla.loc[f] = True
        reglas.append({"dimensión": dim, "regla": nombre, "campo": campo, "aplica a": int(a.sum()), "fallan": int(f.sum()),
                       "% fallan": _pct(f.sum(), a.sum()) if a.sum() else 0.0, "crítica": "sí" if critica else "no",
                       "ejemplos (id)": ", ".join(v.loc[f, "id"].astype(str).head(3)) if "id" in v else ""})

    # Unicidad
    lin = raw.copy()
    huella = lin.drop(columns=[c for c in ("scraped_at", "page", "search_slug", "search_url", "changed_fields") if c in lin]).astype(str).agg("|".join, axis=1)
    rep = huella.duplicated()
    reglas.append({"dimensión": "unicidad", "regla": "líneas repetidas idénticas (mismo aviso sin cambios guardado dos veces)", "campo": "(todas)",
                   "aplica a": int(len(lin)), "fallan": int(rep.sum()), "% fallan": _pct(rep.sum(), len(lin)), "crítica": "sí",
                   "ejemplos (id)": ", ".join(lin.loc[rep, "id"].astype(str).head(3))})
    regla("unicidad", "la misma URL guardada con distinto id", "url", url.duplicated(keep=False) & (url != ""), critica=True)
    # Formato
    regla("formato", "id numérico", "id", ~txt("id").astype(str).str.fullmatch(r"\d{5,12}"), critica=True)
    regla("formato", "URL de zonaprop.com.ar que termina en el id del aviso", "url",
          ~pd.Series([u.startswith("https://www.zonaprop.com.ar/propiedades/") and u.endswith(f"-{i}.html") for u, i in zip(url, txt("id").astype(str))], index=v.index), critica=True)
    regla("formato", "fecha de scraping ISO 8601 válida", "scraped_at", ts.isna(), critica=True)
    regla("formato", "fecha de publicación AAAA-MM-DD válida", "date_posted", dp.isna(), aplica=presente("date_posted"))
    regla("formato", "operación conocida", "operacion", ~op.isin(["venta", "alquiler", "alquiler-temporal"]), critica=True)
    regla("formato", "moneda USD o ARS (o vacía si «consultar precio»)", "price_currency", ~txt("price_currency").isin(["USD", "ARS"]), aplica=presente("price_currency"), critica=True)
    regla("formato", "tipo de aviso PROPERTY o DEVELOPMENT", "posting_type", ~txt("posting_type").isin(["PROPERTY", "DEVELOPMENT"]))
    for c in ["ambientes", "dormitorios", "banos", "cocheras", "page"]:
        x = num[c]
        regla("formato", "número entero", c, x.notna() & (x != x.round()), aplica=x.notna())
    regla("formato", "precio y moneda vienen juntos (los dos o ninguno)", "price", num["price"].isna() != ~presente("price_currency"), critica=True)
    # Rangos
    for (o, cur), (lo, hi) in RANGO_PRECIO.items():
        regla("rango", f"{o} en {cur}: entre {_f(lo, 0)} y {_f(hi, 0)}", "price", ~num["price"].between(lo, hi),
              aplica=(op == o) & (txt("price_currency") == cur) & num["price"].notna())
    for c, (lo, hi) in RANGOS.items():
        regla("rango", f"entre {_f(lo, 0)} y {_f(hi, 0)}", c, ~num[c].between(lo, hi), aplica=num[c].notna())
    regla("rango", "fecha de publicación entre 2000 y el día del scraping", "date_posted",
          (dp < pd.Timestamp("2000-01-01")) | (dp > ts.dt.tz_localize(None).dt.normalize() + pd.Timedelta(days=1)), aplica=dp.notna() & ts.notna())
    # Consistencia entre campos
    regla("consistencia", "dormitorios ≤ ambientes", "dormitorios", num["dormitorios"] > num["ambientes"], aplica=num["dormitorios"].notna() & num["ambientes"].notna())
    regla("consistencia", "superficie cubierta ≤ total", "superficie_cubierta", num["superficie_cubierta"] > num["superficie_total"] * 1.05,
          aplica=num["superficie_cubierta"].notna() & num["superficie_total"].notna())
    slug = txt("search_slug").fillna("").astype(str)
    op_slug = np.where(slug.str.contains("alquiler-temporal"), "alquiler-temporal", np.where(slug.str.contains("alquiler"), "alquiler", np.where(slug.str.contains("venta"), "venta", None)))
    regla("consistencia", "la operación coincide con la de la búsqueda que lo trajo", "operacion", pd.Series(op_slug, index=v.index) != op, aplica=pd.Series(op_slug, index=v.index).notna(), critica=True)
    regla("consistencia", "ubicación en CABA (filtro soloCaba)", "location", ~txt("location").map(zpml.is_caba), critica=True)
    # Concordancia con la URL: el código del aviso y el slug son una fuente independiente de lo parseado de la tarjeta
    cod = url.str.extract(r"/clasificado/([a-z]{2})", expand=False)
    regla("concordancia URL", "operación = código de la URL (ve / al / te)", "operacion", cod.map(_COD_OP) != op, aplica=cod.isin(list(_COD_OP)))
    amb_url = pd.to_numeric(url.str.extract(r"[-/](\d{1,2})-amb(?:iente)?s?\b", expand=False), errors="coerce")
    con_amb = amb_url.notna() & num["ambientes"].notna()
    amb_exacta = float((amb_url == num["ambientes"])[con_amb].mean() * 100) if con_amb.any() else float("nan")
    # El título es texto libre («3 amb. con dependencia», «1 ½ ambientes»): ±1 es redacción, no parseo.
    regla("concordancia URL", "ambientes = «N-ambientes» del título en la URL (±1)", "ambientes", (amb_url - num["ambientes"]).abs() > 1, aplica=con_amb)
    m2_url = pd.to_numeric(url.str.extract(r"[-/](\d{2,4})-?m2\b", expand=False), errors="coerce")
    regla("concordancia URL", "m² = «N-m2» del título en la URL (total o cubierta)", "superficie_total",
          ~((m2_url == num["superficie_total"]) | (m2_url == num["superficie_cubierta"])), aplica=m2_url.notna() & num["superficie_total"].notna())
    t = pd.DataFrame(reglas)
    t = t[t["aplica a"] > 0]

    # Completitud por operación
    ops = [o for o in ["venta", "alquiler", "alquiler-temporal"] if (op == o).any()]
    comp = []
    for c in CAMPOS_BASICOS:
        pr = presente(c) if c not in num else num[c].notna()
        fila = {"campo": c, "obligatorio": "sí" if c in OBLIGATORIOS else "no", "% presente": pr.mean() * 100}
        for o in ops:
            fila[o] = pr[op == o].mean() * 100
        comp.append(fila)
    comp = pd.DataFrame(comp)
    nunca = comp[comp["% presente"] < 0.5]["campo"].tolist()
    por_op = [(c, o) for _, r in comp.iterrows() for o in ops if r[o] < 0.5 and r["% presente"] >= 0.5 for c in [r["campo"]]]
    def nota(r):
        if r["campo"] in nunca:
            return "nunca extraído: la tarjeta del listado no lo muestra (está en la ficha)" if r["campo"] == "superficie_cubierta" else "nunca extraído"
        falt = [o for c, o in por_op if c == r["campo"]]
        if falt:
            return "falta en " + ", ".join(falt) + " (el listado no lo publica para esa operación)"
        if r["obligatorio"] == "sí" and r["% presente"] < 99.5:
            return "obligatorio incompleto"
        return "opcional en el aviso" if r["% presente"] < 99.5 else "completo"
    comp["lectura"] = comp.apply(nota, axis=1)

    # Resumen numérico
    filas = []
    for c, x in num.items():
        y = x.dropna()
        if c == "price":
            for cur in ["USD", "ARS"]:
                yy = x[(txt("price_currency") == cur)].dropna()
                if len(yy):
                    filas.append({"campo": f"price ({cur})", "n": len(yy), "% presente": _pct(len(yy), n), "mín": yy.min(), "p1": yy.quantile(.01),
                                  "mediana": yy.median(), "p99": yy.quantile(.99), "máx": yy.max()})
            continue
        if len(y):
            filas.append({"campo": c, "n": len(y), "% presente": _pct(len(y), n), "mín": y.min(), "p1": y.quantile(.01), "mediana": y.median(),
                          "p99": y.quantile(.99), "máx": y.max()})
    resumen_num = pd.DataFrame(filas)

    # Estado y hallazgos
    crit = t[(t["crítica"] == "sí") & (t["% fallan"] > 1)]
    otras = t[t["% fallan"] > 2]
    oblig = comp[(comp["obligatorio"] == "sí") & (comp["% presente"] < 99)]
    s["estado"] = "critico" if len(crit) or len(oblig) else "atencion" if len(otras) or nunca else "ok"
    limpias = int((t["fallan"] == 0).sum())
    kpi(s, "Avisos (última versión de cada id)", _f(n, 0), ", ".join(f"{o} {_f((op == o).sum(), 0)}" for o in ops))
    kpi(s, "Reglas sin ninguna falla", f"{limpias} de {len(t)}")
    kpi(s, "Avisos con alguna falla de formato o rango", f"{_f(_pct(con_falla.sum(), n), 2)} %", f"{_f(con_falla.sum(), 0)} avisos")
    conc = t[t["dimensión"] == "concordancia URL"]
    if len(conc):
        kpi(s, "Concordancia con la URL", " · ".join(f"{_f(100 - r['% fallan'])} %" for _, r in conc.iterrows()), " · ".join(r["campo"] for _, r in conc.iterrows()))
    kpi(s, "Campos obligatorios completos", f"{int((comp[comp['obligatorio'] == 'sí']['% presente'] >= 99.5).sum())} de {int((comp['obligatorio'] == 'sí').sum())}")
    s["hallazgos"].append(f"{limpias} de {len(t)} reglas de formato, unicidad, rango y consistencia no tienen ninguna falla sobre {_f(n, 0)} avisos."
                          + (" Ninguna regla crítica supera el 1 % de fallas." if not len(crit) else
                             " Reglas críticas con más de 1 % de fallas: " + "; ".join(f"{r['regla']} ({_f(r['% fallan'], 2)} %)" for _, r in crit.iterrows()) + "."))
    malas = t[(t["fallan"] > 0)].sort_values("% fallan", ascending=False).head(4)
    if len(malas):
        s["hallazgos"].append("Las reglas con más fallas: " + "; ".join(f"{r['campo']}: {r['regla']} ({_f(r['fallan'], 0)} avisos, {_f(r['% fallan'], 2)} %)" for _, r in malas.iterrows()) + ".")
    va = t[t["regla"].str.startswith("venta en ARS")]
    if len(va) and va["% fallan"].iloc[0] > 50:
        s["hallazgos"].append(f"De {_f(va['aplica a'].iloc[0], 0)} ventas publicadas en pesos, el {_f(va['% fallan'].iloc[0])} % tiene un precio de dólares "
                              "(mediana del orden de 100.000): el anunciante eligió «$» por error. El parser lee bien lo publicado; es un error de origen.")
    for _, r in conc.iterrows():
        extra = (f" (coincidencia exacta {_f(amb_exacta)} %; las diferencias de un ambiente son del título libre, p. ej. «3 amb. con dependencia»)"
                 if r["campo"] == "ambientes" and np.isfinite(amb_exacta) else "")
        s["hallazgos"].append(f"Concordancia con la URL ({r['regla']}): {_f(100 - r['% fallan'])} % sobre {_f(r['aplica a'], 0)} avisos donde la URL trae el dato{extra}. "
                              "La URL es independiente del texto de la tarjeta, así que esto valida el parseo contra otra fuente.")
    if nunca:
        s["hallazgos"].append("Campos que el scraper nunca obtuvo del listado: " + ", ".join(nunca) + ". No es una falla del parser: la tarjeta no los muestra; "
                              "la fase de fichas (details.jsonl) los completaría.")
    for c, o in por_op:
        s["hallazgos"].append(f"«{c}» no viene en ningún aviso de {o}: el listado no lo publica para esa operación (estructural, no del parser).")
    if len(oblig):
        s["hallazgos"].append("Campos obligatorios incompletos: " + ", ".join(f"{r['campo']} ({_f(r['% presente'])} %)" for _, r in oblig.iterrows()) + ".")
    s["tablas"]["Reglas de calidad (formato, unicidad, rango, consistencia, concordancia con la URL)"] = t.round(3)
    s["tablas"]["Completitud por campo y operación (% de avisos con el dato)"] = comp.round(1)
    s["tablas"]["Resumen de los campos numéricos"] = resumen_num.round(1)

    plt = _plt()
    cols = ["% presente"] + ops
    fig, ax = plt.subplots(figsize=(7.5, 0.3 * len(comp) + 1.4))
    im = ax.imshow(comp[cols].values, aspect="auto", cmap="Blues", vmin=0, vmax=100)
    ax.set_xticks(range(len(cols)), ["todos"] + ops, fontsize=8); ax.set_yticks(range(len(comp)), [f"{c}{' *' if o == 'sí' else ''}" for c, o in zip(comp["campo"], comp["obligatorio"])], fontsize=7.8)
    for i in range(len(comp)):
        for j, c in enumerate(cols):
            val = comp[c].iloc[i]
            ax.text(j, i, _f(val, 0), ha="center", va="center", fontsize=7, color="white" if val > 60 else "#1c2330")
    ax.grid(False); ax.xaxis.tick_top()
    ax.set_title("Completitud: % de avisos con cada campo (* obligatorio)", pad=22)
    s["figuras"]["completitud"] = fig

    q = t[t["fallan"] > 0].sort_values("% fallan")
    colores = {"unicidad": VIOLETA, "formato": AZUL, "rango": NARANJA, "consistencia": AQUA, "concordancia URL": MAGENTA}
    fig, ax = plt.subplots(figsize=(9, 0.3 * max(1, len(q)) + 1.6))
    ax.barh([f"{c}: {r}"[:70] for c, r in zip(q["campo"], q["regla"])], q["% fallan"], color=[colores[d] for d in q["dimensión"]], height=.7)
    for y, (val, k) in enumerate(zip(q["% fallan"], q["fallan"])):
        ax.text(val, y, f" {_f(val, 2)} % ({_f(k, 0)})", va="center", fontsize=7)
    from matplotlib.patches import Patch
    ax.legend(handles=[Patch(color=c, label=d) for d, c in colores.items() if d in set(q["dimensión"])], frameon=False, fontsize=7.5, loc="lower right")
    ax.set_xlim(0, max(1, q["% fallan"].max() * 1.35)); ax.set_xlabel("% de los avisos a los que aplica la regla que la incumplen")
    ax.tick_params(axis="y", labelsize=7.2); ax.grid(axis="y", visible=False)
    ax.set_title(f"Reglas con alguna falla ({limpias} de {len(t)} reglas no tienen ninguna)")
    s["figuras"]["reglas"] = fig
    return s


# --- 1. Embudo de limpieza ---------------------------------------------------------------------
_MOTIVOS = [("Moneda", "moneda"), ("Con precio y superficie", "sin precio o m²"), ("Superficie", "superficie"),
            ("Ambientes", "ambientes"), ("Precio USD", "precio o USD/m²"), ("Sin pozo", "pozo"),
            ("duplicados", "duplicado"), ("Recorte", "recorte p1–p99")]


def _motivo(paso: str) -> str:
    for k, v in _MOTIVOS:
        if k.lower() in paso.lower():
            return v
    return paso


def embudo(df: pd.DataFrame, p: dict | None = None) -> tuple[dict, pd.DataFrame]:
    """Devuelve (sección, avisos limpios). El paso final reproduce el recorte de USD/m² que hace
    el modelo A (percentiles calculados sólo con train, sobre el mismo test agrupado)."""
    p = params(p)
    s = seccion("embudo", "1 · Embudo de limpieza", "¿Qué descarta la limpieza y lo hace parejo entre barrios?",
                "Las reglas son fijas (no se ajustan con los datos), así que pueden aplicarse antes de separar train y test. "
                "Si un barrio pierde mucho más que el resto, el modelo lo ve subrepresentado: revisarlo en la sección 4.")
    traza: dict = {}
    d, pasos = limpiar(df, p, traza=traza)
    d = d.copy()
    tr, te = precio.separar(d, "agrupado", float(p["test_size"]), int(p["seed"]))
    keep = precio.recorte_train(d["ppm2"].values[tr], float(p["trim_pct"]))
    recortadas = d.index[tr[~keep]]
    nombre_rec = f"Recorte de USD/m² en train (p{_f(p['trim_pct'], 0)}–p{_f(100 - p['trim_pct'], 0)}, calculado sólo con train)"
    traza.update(dict.fromkeys(recortadas, nombre_rec))
    pasos.append({"paso": nombre_rec, "filas": int(len(d) - len(recortadas)), "quitadas": int(len(recortadas))})
    t = pd.DataFrame(pasos)
    t.insert(0, "#", range(len(t)))
    t["% del inicial"] = (t["filas"] / t["filas"].iloc[0] * 100).round(1)

    # Base: avisos de la operación y el tipo pedidos (antes de esos filtros no hay "calidad" en juego).
    base_ix = df.index.difference([i for i, v in traza.items() if v.startswith(("Operación", "Tipo"))])
    base = df.loc[base_ix, ["barrio"]].copy()
    base["motivo"] = [_motivo(traza[i]) if i in traza else "conservado" for i in base.index]
    n0 = len(base)
    n_final = int(t["filas"].iloc[-1])
    kpi(s, "Avisos de CABA", _f(len(df), 0))
    kpi(s, f"Base ({p['operacion']}, {p['tipo']})", _f(n0, 0))
    kpi(s, "Quedan para entrenar/evaluar", _f(n_final, 0), f"{_f(_pct(n_final, n0))} % de la base")
    calidad = t.iloc[1:].loc[~t["paso"].iloc[1:].str.startswith(("Operación", "Tipo"))]
    top = calidad.sort_values("quitadas", ascending=False).iloc[0]
    s["hallazgos"].append(f"La limpieza conserva el {_f(_pct(n_final, n0))} % de la base. El paso que más quita es "
                          f"«{top['paso']}» ({_f(top['quitadas'], 0)} avisos, {_f(_pct(top['quitadas'], n0))} % de la base).")

    # Por barrio: % descartado y por qué motivo
    motivos = [m for _, m in _MOTIVOS if (base["motivo"] == m).any()]
    ct = pd.crosstab(base["barrio"].fillna("(sin barrio)"), base["motivo"])
    ct["n_base"] = ct.sum(axis=1)
    ct = ct[ct["n_base"] >= int(p["min_barrio"])]
    pb = pd.DataFrame({"barrio": ct.index, "n_base": ct["n_base"].values})
    for m in motivos:
        pb[m] = (ct.get(m, 0) / ct["n_base"] * 100).values
    pb["% descartado"] = pb[motivos].sum(axis=1)
    pb["conservados"] = ct.get("conservado", 0).values
    share_base = pb["n_base"] / pb["n_base"].sum()
    share_fin = pb["conservados"] / max(1, pb["conservados"].sum())
    pb["peso final / peso base"] = share_fin / share_base
    pb = pb.sort_values("% descartado", ascending=False)
    med = pb["% descartado"].median()
    if len(pb) >= 3:
        from scipy.stats import chi2_contingency
        tab = np.c_[pb["conservados"], pb["n_base"] - pb["conservados"]]
        chi2, pval, *_ = chi2_contingency(tab)
        v = np.sqrt(chi2 / tab.sum() / 1)
        kpi(s, "Cramér V (barrio × descarte)", _f(v, 3), "0 = descarte parejo; > 0,1 = desparejo")
        sesgados = pb[(pb["peso final / peso base"] < 0.8) | (pb["peso final / peso base"] > 1.25)]
        s["hallazgos"].append(f"Entre barrios con ≥ {p['min_barrio']} avisos el descarte va de {_f(pb['% descartado'].min())} % a "
                              f"{_f(pb['% descartado'].max())} % (mediana {_f(med)} %); χ² p = {pval:.1g}, V de Cramér = {_f(v, 3)}.")
        if len(sesgados):
            s["estado"] = "atencion"
            s["hallazgos"].append("Barrios cuyo peso cambia más de 20–25 % por la limpieza: " + ", ".join(
                f"{b} (×{_f(r, 2)})" for b, r in sesgados.set_index("barrio")["peso final / peso base"].sort_values().items()) + ".")
        else:
            s["hallazgos"].append("Ningún barrio cambia su peso en más de 20–25 % por la limpieza: el descarte no reordena el mapa.")
        por_barrio = pb.set_index("barrio")[motivos].idxmax(axis=1)
        principal = por_barrio.value_counts()
        s["hallazgos"].append("Motivo principal de descarte por barrio: " + ", ".join(f"{m} en {n}" for m, n in principal.items()) + ".")
        rec = [b for b, m in por_barrio.items() if m.startswith("recorte")]
        if rec:
            s["hallazgos"].append("El recorte de USD/m² usa percentiles de toda la ciudad, así que pega más en los barrios más baratos o más caros: "
                                  + ", ".join(rec) + ". Un recorte por barrio conservaría esos avisos sin dejar pasar errores de carga.")

    s["tablas"]["Pasos de limpieza (filas que quedan y quitadas)"] = t
    s["tablas"]["Descarte por barrio y motivo (% de la base del barrio)"] = pb[["barrio", "n_base", "% descartado", "peso final / peso base"] + motivos].round(2)

    plt = _plt()
    fig, ax = plt.subplots(figsize=(8, 0.42 * len(t) + 1))
    y = np.arange(len(t))[::-1]
    ax.barh(y, t["filas"], color=AZUL, height=.62)
    ax.barh(y, t["quitadas"], left=t["filas"], color=NARANJA, height=.62, alpha=.85)
    for yi, (f, q) in zip(y, zip(t["filas"], t["quitadas"])):
        ax.text(f + q, yi, f"  {_f(f, 0)}" + (f"  (−{_f(q, 0)})" if q else ""), va="center", fontsize=8)
    ax.set_yticks(y, [x if len(x) < 58 else x[:55] + "…" for x in t["paso"]], fontsize=8)
    ax.set_xlabel("avisos"); ax.grid(axis="y", visible=False)
    ax.set_xlim(0, t["filas"].iloc[0] * 1.28)
    from matplotlib.patches import Patch
    ax.legend(handles=[Patch(color=AZUL, label="quedan"), Patch(color=NARANJA, label="quitados en el paso")], frameon=False, fontsize=8, loc="lower right", bbox_to_anchor=(1, 1), ncol=2)
    ax.set_title("Embudo de limpieza")
    s["figuras"]["embudo"] = fig

    if len(pb):
        q = pb.sort_values("% descartado")
        fig, ax = plt.subplots(figsize=(8.5, 0.24 * len(q) + 1.4))
        left = np.zeros(len(q))
        for m, c in zip(motivos, CATEG):
            ax.barh(q["barrio"], q[m], left=left, color=c, label=m, height=.72, edgecolor="white", linewidth=.6)
            left += q[m].values
        ax.axvline(med, color="#555", lw=1, ls="--"); ax.text(med, len(q) - .3, f" mediana {_f(med)} %", fontsize=7.5, va="bottom")
        ax.set_xlabel("% de los avisos del barrio descartados"); ax.tick_params(axis="y", labelsize=7.5); ax.grid(axis="y", visible=False)
        ax.legend(ncol=4, fontsize=7.5, loc="lower center", bbox_to_anchor=(.5, 1.0), frameon=False)
        ax.set_title(f"Descarte por barrio y motivo (barrios con ≥ {p['min_barrio']} avisos)", pad=28)
        s["figuras"]["descarte_por_barrio"] = fig
    return s, d


# --- 2. Duplicados y fuga train/test --------------------------------------------------------------
def duplicados(df: pd.DataFrame, hist: pd.DataFrame | None, p: dict | None = None) -> dict:
    from sklearn.model_selection import train_test_split
    p = params(p)
    s = seccion("duplicados", "2 · Duplicados y fuga entre train y test",
                "¿Cuántas veces aparece la misma unidad y cuánto infla eso las métricas si no se controla?",
                "El modelo A quita los duplicados confirmados (misma huella y misma calle/altura o texto casi igual) y además separa "
                "train/test agrupando por la huella sin precio, así que ninguna unidad queda de los dos lados.")
    d0, _ = limpiar(df, p, deduplicar=False)
    d0 = d0.reset_index(drop=True)
    d0["dup_id"] = precio.dup_ids(d0).values
    tam = d0.groupby("dup_id")["id"].transform("size")
    tam_h = d0.groupby("huella")["id"].transform("size")
    n = len(d0)
    red_v2 = n - d0["dup_id"].nunique()
    red_v1 = n - d0["huella"].nunique()
    kpi(s, "Avisos con al menos un duplicado", f"{_f(_pct((tam > 1).sum(), n))} %", f"{_f((tam > 1).sum(), 0)} de {_f(n, 0)} limpios")
    kpi(s, "Avisos redundantes (regla v2)", _f(red_v2, 0), f"regla v1 (sólo huella) marcaría {_f(red_v1, 0)}")
    s["hallazgos"].append(f"Sobre {_f(n, 0)} avisos que pasan las reglas de consistencia, {_f(red_v2, 0)} ({_f(_pct(red_v2, n))} %) son copias de otra "
                          "publicación de la misma unidad."
                          + (f" La huella sola marcaría {_f(red_v1, 0)}: la diferencia son unidades distintas con igual barrio, m², ambientes y "
                             "precio, que la regla v2 separa por dirección o texto." if red_v1 > red_v2 else ""))
    multi = d0[tam > 1]
    pub = multi["publisher"].map(lambda x: zpml.norm(x) if isinstance(x, str) and x.strip() else np.nan) if "publisher" in multi else pd.Series(np.nan, index=multi.index)
    g = pd.DataFrame({"dup_id": multi["dup_id"], "pub": pub}).groupby("dup_id").agg(n=("pub", "size"), pubs=("pub", "nunique"))
    if len(g):
        varias = (g["pubs"] > 1).mean() * 100
        kpi(s, "Grupos con varias inmobiliarias", f"{_f(varias)} %", "misma unidad, distintos anunciantes")
        s["hallazgos"].append(f"En el {_f(varias)} % de los grupos de duplicados la unidad la publican inmobiliarias distintas; el resto es la misma "
                              "inmobiliaria republicando con otro id (típico para volver a aparecer arriba en el listado).")

    # Fuga: % de avisos de test con un gemelo en train, según cómo se separa
    filas = []
    tr, te = train_test_split(np.arange(n), test_size=float(p["test_size"]), random_state=int(p["seed"]))
    filas.append({"protocolo": "aleatorio, sin quitar duplicados (iteración 0)", "n_test": len(te),
                  "% test con duplicado en train": np.isin(d0["dup_id"].values[te], d0["dup_id"].values[tr]).mean() * 100,
                  "% test con misma unidad sin precio en train": np.isin(d0["grupo"].values[te], d0["grupo"].values[tr]).mean() * 100})
    d1 = d0.drop_duplicates("dup_id", keep="last").reset_index(drop=True)
    tr, te = train_test_split(np.arange(len(d1)), test_size=float(p["test_size"]), random_state=int(p["seed"]))
    filas.append({"protocolo": "aleatorio, con duplicados quitados", "n_test": len(te), "% test con duplicado en train": 0.0,
                  "% test con misma unidad sin precio en train": np.isin(d1["grupo"].values[te], d1["grupo"].values[tr]).mean() * 100})
    tr, te = precio.separar(d1, "agrupado", float(p["test_size"]), int(p["seed"]))
    filas.append({"protocolo": "agrupado por unidad (modelo A)", "n_test": len(te), "% test con duplicado en train": 0.0,
                  "% test con misma unidad sin precio en train": np.isin(d1["grupo"].values[te], d1["grupo"].values[tr]).mean() * 100})
    fuga = pd.DataFrame(filas)
    leak0 = fuga.iloc[0]["% test con duplicado en train"]
    kpi(s, "Fuga con split aleatorio", f"{_f(leak0)} %", "de test con su duplicado en train")
    kpi(s, "Fuga con split agrupado", f"{_f(fuga.iloc[2]['% test con misma unidad sin precio en train'])} %", "protocolo del modelo A")
    s["hallazgos"].append(f"Con el split aleatorio de la iteración 0, el {_f(leak0)} % del test tenía su duplicado en train: el modelo «recordaba» "
                          "el precio en vez de estimarlo. Con el split agrupado esa fuga es 0.")
    s["estado"] = "critico" if leak0 > 10 else "atencion" if leak0 > 3 else "ok"

    if hist is not None and len(hist):
        n_lin, n_ids = len(hist), hist["id"].nunique()
        kpi(s, "Líneas en listings.jsonl", _f(n_lin, 0), f"{_f(n_ids, 0)} ids únicos")
        if n_lin > n_ids:
            cambios = hist["changed_fields"].dropna().explode().value_counts() if "changed_fields" in hist else pd.Series(dtype=int)
            s["hallazgos"].append(f"{_f(n_lin - n_ids, 0)} líneas son versiones nuevas de un aviso ya visto (historial de cambios); el modelo usa la última."
                                  + (" Campos que más cambian: " + ", ".join(f"{k} ({v})" for k, v in cambios.head(4).items()) + "." if len(cambios) else ""))
    s["tablas"]["Fuga según el protocolo de separación"] = fuga.round(2)
    dist = tam[tam > 1].groupby(tam.clip(upper=6)).size()
    dist_t = pd.DataFrame({"tamaño del grupo": [str(int(k)) if k < 6 else "6+" for k in dist.index], "avisos": dist.values})
    s["tablas"]["Avisos según el tamaño de su grupo de duplicados"] = dist_t

    ej = multi.assign(tam=tam[tam > 1]).sort_values(["tam", "dup_id"], ascending=[False, True])
    ej = ej[ej["dup_id"].isin(ej["dup_id"].drop_duplicates().head(6))]
    cols = [c for c in ["dup_id", "id", "barrio", "sup", "ambientes", "price_x", "address", "publisher", "date_posted", "url"] if c in ej]
    s["tablas"]["Ejemplos: los grupos de duplicados más grandes"] = ej[cols].rename(columns={"dup_id": "grupo", "sup": "m²", "price_x": "precio"}).head(40)

    plt = _plt()
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(10, 3.6), gridspec_kw={"width_ratios": [1, 1.25]})
    a1.bar(dist_t["tamaño del grupo"], dist_t["avisos"], color=AZUL, width=.6)
    a1.set_xlabel("avisos que describen la misma unidad"); a1.set_ylabel("avisos"); a1.set_title("Tamaño de los grupos de duplicados")
    a1.grid(axis="x", visible=False)
    lab = ["aleatorio\ncon duplicados", "aleatorio\nsin duplicados", "agrupado\n(modelo A)"]
    x = np.arange(3)
    for k, (col, c, nm) in enumerate([("% test con duplicado en train", AZUL, "duplicado confirmado (regla v2)"),
                                      ("% test con misma unidad sin precio en train", NARANJA, "misma huella sin precio (conservador)")]):
        vals = fuga[col].values
        a2.bar(x + (k - .5) * .36, vals, width=.34, color=c, label=nm)
        for i, v in enumerate(vals):
            a2.text(x[i] + (k - .5) * .36, v, _f(v), ha="center", va="bottom", fontsize=7.5)
    a2.set_xticks(x, lab); a2.legend(frameon=False, fontsize=7.5, loc="upper center", bbox_to_anchor=(.5, -.22), ncol=2)
    a2.set_ylabel("% de test con su gemelo en train"); a2.set_title("Fuga train → test según el protocolo"); a2.grid(axis="x", visible=False)
    s["figuras"]["duplicados_fuga"] = fig
    return s


# --- 3. Faltantes: ¿al azar o según el precio? ---------------------------------------------------
CAMPOS_FALTANTES = {
    "superficie_cubierta": "num", "superficie_total": "num", "ambientes": "num", "dormitorios": "num", "banos": "num",
    "cocheras": "num", "expensas": "num", "antiguedad": "num", "address": "txt", "description_short": "txt",
    "publisher": "txt", "date_posted": "txt", "title": "txt",
}
USADOS_POR_MODELO = {"superficie_cubierta", "superficie_total", "ambientes", "dormitorios", "banos", "cocheras", "expensas", "antiguedad", "address"}


def _falta(col: pd.Series, kind: str) -> pd.Series:
    if kind == "num":
        return pd.to_numeric(col, errors="coerce").isna()
    return col.isna() | (col.astype(str).str.strip().isin(["", "None", "nan"]))


def faltantes(df: pd.DataFrame, d: pd.DataFrame, p: dict | None = None) -> dict:
    """df: avisos crudos (para ver el faltante original); d: avisos limpios (población de entrenamiento)."""
    from scipy.stats import mannwhitneyu
    p = params(p)
    s = seccion("faltantes", "3 · Faltantes: ¿al azar o según el precio?",
                "Si un dato falta más en avisos caros o baratos, el faltante en sí informa el precio (MNAR).",
                "LightGBM manda los faltantes a la rama que más reduce el error, y Ridge imputa la mediana con un indicador de faltante: "
                "los dos pueden aprovechar un faltante informativo. Lo que no se puede es imputar con un valor fijo sin indicador.")
    raw = df.loc[d.index]
    barrio_med = d.groupby("barrio")["ppm2"].transform("median")
    rel = (d["ppm2"] / barrio_med).values           # USD/m² relativo a la mediana del barrio: saca el efecto barrio
    ok = np.isfinite(rel)                           # sin barrio no hay referencia
    filas, ind = [], {}
    for c, kind in CAMPOS_FALTANTES.items():
        if c not in raw:
            continue
        miss = _falta(raw[c], kind).values
        ind[c] = miss
        r = {"campo": c, "usa el modelo": "sí" if c in USADOS_POR_MODELO else "no", "% faltante": miss.mean() * 100,
             "USD/m² rel. con dato": np.nan, "USD/m² rel. sin dato": np.nan, "diferencia %": np.nan, "p (Mann-Whitney)": np.nan, "lectura": "—"}
        if 0.005 <= miss.mean() <= 0.995 and (miss & ok).sum() >= 20 and (~miss & ok).sum() >= 20:
            con, sin = np.median(rel[~miss & ok]), np.median(rel[miss & ok])
            pv = mannwhitneyu(rel[miss & ok], rel[~miss & ok]).pvalue
            dif = (sin / con - 1) * 100
            r.update({"USD/m² rel. con dato": con, "USD/m² rel. sin dato": sin, "diferencia %": dif, "p (Mann-Whitney)": pv,
                      "lectura": "MNAR probable" if abs(dif) >= 5 and pv < 1e-3 else "relación débil" if abs(dif) >= 2 and pv < 1e-2 else "compatible con azar"})
        elif miss.mean() > 0.995:
            r["lectura"] = "casi siempre vacío"
        filas.append(r)
    t = pd.DataFrame(filas).sort_values("% faltante", ascending=False)
    if "expensas" in raw:
        raw_ok = ~_falta(raw["expensas"], "num")
        anuladas = int((raw_ok & d["expensas"].isna()).sum())
        if anuladas:
            s["hallazgos"].append(f"Además, {_f(anuladas, 0)} expensas informadas quedaron como faltantes por implausibles "
                                  f"(fuera de {precio.EXP_M2_MIN}–{_f(precio.EXP_M2_MAX, 0)} ARS/m²/mes).")
    mnar = t[t["lectura"] == "MNAR probable"]
    mnar_mod = mnar[mnar["usa el modelo"] == "sí"]
    kpi(s, "Campos analizados", str(len(t)))
    kpi(s, "Con faltante informativo (MNAR)", str(len(mnar)), ", ".join(mnar["campo"]) or "ninguno")
    if len(t):
        m = t.iloc[0]
        kpi(s, "Campo con más faltantes", m["campo"], f"{_f(m['% faltante'])} %")
    for _, r in mnar.iterrows():
        s["hallazgos"].append(f"«{r['campo']}» falta en el {_f(r['% faltante'])} % de los avisos, y donde falta el USD/m² (relativo al barrio) es "
                              f"{_f(abs(r['diferencia %']))} % {'más bajo' if r['diferencia %'] < 0 else 'más alto'} (p = {r['p (Mann-Whitney)']:.1g}).")
    if not len(mnar):
        s["hallazgos"].append("Ningún faltante se asocia con fuerza al precio: se pueden tratar como faltantes al azar.")
    if "cocheras" in ind and ind["cocheras"].mean() > .3:
        s["hallazgos"].append("Ojo: un faltante en «cocheras» suele significar «no tiene» (el aviso no lo menciona); imputar 0 sería razonable, imputar la mediana no.")
    s["estado"] = "atencion" if len(mnar_mod) else "ok"
    s["tablas"]["Faltantes y su relación con el precio (USD/m² relativo a la mediana del barrio)"] = t.round(4)

    plt = _plt()
    q = t.sort_values("% faltante")
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(10.5, 0.32 * len(q) + 1.4), sharey=True)
    a1.barh(q["campo"], q["% faltante"], color=[AZUL if u == "sí" else GRIS for u in q["usa el modelo"]], height=.62)
    for y, v in enumerate(q["% faltante"]):
        a1.text(v, y, f" {_f(v)}", va="center", fontsize=7.5)
    a1.set_xlabel("% de avisos sin el dato"); a1.set_title("Faltantes (azul = lo usa el modelo)"); a1.grid(axis="y", visible=False)
    a1.set_xlim(0, max(5, q["% faltante"].max() * 1.18))
    dif = q["diferencia %"].fillna(0)
    a2.barh(q["campo"], dif, color=[NARANJA if v > 0 else AZUL for v in dif], height=.62)
    a2.axvline(0, color="#555", lw=.8)
    for y, (v, l) in enumerate(zip(q["diferencia %"], q["lectura"])):
        if np.isfinite(v):
            a2.text(v, y, f" {_f(v)} %" if v >= 0 else f"{_f(v)} % ", va="center", ha="left" if v >= 0 else "right", fontsize=7.5,
                    fontweight="bold" if l == "MNAR probable" else "normal")
    a2.set_xlabel("USD/m² sin el dato vs. con el dato (%)"); a2.set_title("¿El faltante dice algo del precio?"); a2.grid(axis="y", visible=False)
    lim = max(5, np.nanmax(np.abs(dif)) * 1.35)
    a2.set_xlim(-lim, lim)
    s["figuras"]["faltantes"] = fig

    cols = [c for c, m in ind.items() if 0.01 <= m.mean() <= 0.99]
    if len(cols) >= 3:
        corr = pd.DataFrame({c: ind[c].astype(float) for c in cols}).corr()
        fig, ax = plt.subplots(figsize=(0.55 * len(cols) + 2.2, 0.5 * len(cols) + 1.4))
        im = ax.imshow(corr.values, cmap="RdBu_r", vmin=-1, vmax=1)
        ax.set_xticks(range(len(cols)), cols, rotation=45, ha="right", fontsize=7.5); ax.set_yticks(range(len(cols)), cols, fontsize=7.5)
        for i in range(len(cols)):
            for j in range(len(cols)):
                if i != j and abs(corr.values[i, j]) >= .2:
                    ax.text(j, i, _f(corr.values[i, j], 2), ha="center", va="center", fontsize=6.5)
        ax.grid(False); fig.colorbar(im, ax=ax, shrink=.75, label="correlación entre faltantes")
        ax.set_title("¿Qué datos faltan juntos?")
        s["figuras"]["faltantes_juntos"] = fig
    return s


# --- 4. Representatividad por barrio -------------------------------------------------------------
def representatividad(d: pd.DataFrame, p: dict | None = None) -> dict:
    p = params(p)
    mn = int(p["min_barrio"])
    s = seccion("representatividad", "4 · Representatividad por barrio",
                "¿Hay avisos suficientes en cada barrio para estimar su precio típico con confianza?",
                "El modelo usa el barrio como categoría y como codificación por objetivo (mediana del barrio fuera de fold). "
                "Con pocos avisos esa mediana es inestable; el modelo de respaldo es la mediana global.")
    rng = np.random.default_rng(int(p["seed"]))
    filas = []
    for b, g in d.groupby("barrio"):
        x = g["ppm2"].values
        reps = min(300, max(60, 30_000_000 // max(1, len(x) * 100)))
        meds = np.median(rng.choice(x, size=(reps, len(x)), replace=True), axis=1) if len(x) > 1 else np.array([x[0]])
        lo, hi = np.percentile(meds, [2.5, 97.5])
        filas.append({"barrio": b, "avisos": len(x), "mediana USD/m²": float(np.median(x)), "IC95 bajo": lo, "IC95 alto": hi,
                      "ancho IC95 %": (hi - lo) / np.median(x) * 100})
    t = pd.DataFrame(filas).sort_values("avisos", ascending=False)
    nb = len(t)
    chicos = t[t["avisos"] < mn]
    top5 = t["avisos"].head(5).sum() / t["avisos"].sum() * 100
    kpi(s, "Barrios con avisos", str(nb))
    kpi(s, f"Barrios con < {mn} avisos", str(len(chicos)), ", ".join(chicos["barrio"].head(6)) + ("…" if len(chicos) > 6 else ""))
    kpi(s, "Avisos en los 5 barrios más grandes", f"{_f(top5)} %", ", ".join(t["barrio"].head(5)))
    s["hallazgos"].append(f"El mercado está concentrado: los 5 barrios con más avisos suman el {_f(top5)} % y el más chico tiene "
                          f"{_f(t['avisos'].min(), 0)} avisos ({t['barrio'].iloc[-1]}).")
    ancho = t.set_index("barrio")["ancho IC95 %"]
    s["hallazgos"].append(f"La incertidumbre de la mediana de USD/m² (IC95 por bootstrap) va de ±{_f(ancho.min() / 2)} % en {ancho.idxmin()} "
                          f"a ±{_f(ancho.max() / 2)} % en {ancho.idxmax()}: crece como 1/√n.")
    estado = "critico" if len(chicos) > nb * .25 else "atencion" if len(chicos) else "ok"

    s["estado"] = estado
    s["tablas"]["Avisos y mediana de USD/m² por barrio (IC95 bootstrap)"] = t.round(2)

    plt = _plt()
    q = t.sort_values("avisos")
    fig, ax = plt.subplots(figsize=(8, 0.22 * len(q) + 1.2))
    ax.barh(q["barrio"], q["avisos"], color=[NARANJA if v < mn else AZUL for v in q["avisos"]], height=.72)
    ax.axvline(mn, color="#555", lw=1, ls="--"); ax.text(mn, -0.9, f" mínimo {mn}", fontsize=7.5)
    ax.set_xscale("log"); ax.set_xlabel("avisos limpios (escala log)"); ax.tick_params(axis="y", labelsize=7.2); ax.grid(axis="y", visible=False)
    ax.set_title(f"Avisos por barrio (naranja = menos de {mn})")
    s["figuras"]["avisos_por_barrio"] = fig

    fig, a = plt.subplots(figsize=(6, 3.9))
    a.scatter(t["avisos"], t["ancho IC95 %"] / 2, s=22, color=AZUL, edgecolor="white", linewidth=.6)
    xs = np.logspace(np.log10(max(2, t["avisos"].min())), np.log10(t["avisos"].max()), 50)
    k = np.median(t["ancho IC95 %"] / 2 * np.sqrt(t["avisos"]))
    a.plot(xs, k / np.sqrt(xs), color=GRIS, lw=1.2, ls="--", label="∝ 1/√n")
    a.set_xscale("log"); a.set_xlabel("avisos del barrio"); a.set_ylabel("± % de la mediana (IC95)"); a.legend(frameon=False, fontsize=8)
    a.set_title("Incertidumbre de la mediana de USD/m²")
    s["figuras"]["incertidumbre"] = fig
    return s


# --- 5. Robustez del scraper: deriva del parser y cobertura ------------------------------------
CAMPOS_PARSER = ["price", "price_currency", "superficie_total", "superficie_cubierta", "ambientes", "dormitorios", "banos",
                 "expensas", "location", "address", "description_short", "publisher", "date_posted", "title", "photos"]
NUCLEO = {"price", "price_currency", "superficie_total", "ambientes", "location"}


def _vacio(col: pd.Series) -> pd.Series:
    return col.map(lambda v: v is None or (isinstance(v, float) and np.isnan(v)) or (isinstance(v, (str, list)) and len(v) == 0))


def scraper(raw: pd.DataFrame, frontier: dict | None, failures: pd.DataFrame | None, settings: dict | None, p: dict | None = None) -> dict:
    """raw: todas las líneas de listings.jsonl (con historial y sin filtrar CABA)."""
    p = params(p)
    s = seccion("scraper", "5 · Robustez del scraper: deriva del parser y cobertura",
                "¿El parser extrajo lo mismo durante todo el scrape, y cuánto de lo que publica ZonaProp quedó guardado?",
                "Un cambio en el HTML de ZonaProp o una página degradada por Cloudflare no da error: deja campos vacíos. Si eso pasa en "
                "una franja del scrape, el modelo ve esos avisos como «sin dato» por un motivo técnico. Hay que re-scrapear esa franja.")
    r = raw.copy()
    r["t"] = pd.to_datetime(r["scraped_at"], errors="coerce", utc=True, format="ISO8601").dt.tz_convert("America/Argentina/Buenos_Aires")
    r = r[r["t"].notna()]
    if r.empty:
        s["estado"] = "sin_datos"; s["hallazgos"].append("No hay fechas de scraping (scraped_at) para analizar."); return s
    span = r["t"].max() - r["t"].min()
    freq = {"hora": "1h", "dia": "1D"}.get(p["ventana"]) or ("1h" if span <= pd.Timedelta(days=2) else "6h" if span <= pd.Timedelta(days=14) else "1D")
    r["franja"] = r["t"].dt.floor(freq)
    kpi(s, "Líneas leídas", _f(len(r), 0), f"{r['t'].min():%d/%m %H:%M} → {r['t'].max():%d/%m %H:%M}")

    campos = [c for c in CAMPOS_PARSER if c in r]
    vac = pd.DataFrame({c: _vacio(r[c]).astype(float) for c in campos}, index=r.index)
    # Lo esperable depende de qué se scrapeó en cada franja (un terreno no tiene ambientes, un alquiler casi nunca
    # tiene cochera): cada aviso aporta el % de vacíos de su operación × tipo en todo el scrape, y la deriva es
    # lo observado menos lo esperado para esa mezcla. Así una franja de terrenos no se confunde con un parser roto.
    col = lambda c: r[c] if c in r else pd.Series(None, index=r.index, dtype=object)
    estrato = col("operacion").astype(str) + "|" + pd.Series([zpml.tipo_from_row(u, t, tp) for u, t, tp in zip(col("url"), col("title"), col("tipo_propiedad"))], index=r.index)
    esp = vac.groupby(estrato).transform("mean")
    por, por_e = vac.groupby(r["franja"]), esp.groupby(r["franja"])
    n_fr = por.size()
    tasa = (por.mean() * 100)[n_fr >= 30]
    tasa_e = (por_e.mean() * 100)[n_fr >= 30]
    n_fr = n_fr[n_fr >= 30]
    anom = []
    if len(tasa) >= 3:
        for c in campos:
            dev = tasa[c] - tasa_e[c]
            for fr, v in dev[dev.abs() >= float(p["umbral_deriva_pp"])].items():
                anom.append({"_fr": fr, "franja": fr.strftime("%d/%m %H:%M"), "campo": c, "% vacío": tasa.loc[fr, c],
                             "% esperado por la mezcla de la franja": tasa_e.loc[fr, c], "desvío (pp)": v, "avisos en la franja": int(n_fr[fr]),
                             "campo central": "sí" if c in NUCLEO else "no"})
    anom = pd.DataFrame(anom)
    roto = [c for c in campos if len(tasa) >= 3 and tasa[c].iloc[-1] >= 95 and tasa[c].median() < 50]
    kpi(s, "Franjas analizadas", str(len(tasa)), f"ventana {freq.replace('1h', '1 hora').replace('6h', '6 horas').replace('1D', '1 día')}")
    kpi(s, "Franjas con deriva", str(anom["franja"].nunique() if len(anom) else 0), f"desvío ≥ {p['umbral_deriva_pp']} pp vs. lo esperado por operación y tipo")
    if roto:
        s["hallazgos"].append("En la última franja estos campos salen siempre vacíos y antes no: " + ", ".join(roto) + ". Probable cambio del HTML: revisar src/parse/listing.js.")
    if len(anom):
        nuc = anom[anom["campo central"] == "sí"]
        s["hallazgos"].append(f"{anom['franja'].nunique()} franjas tienen algún campo con un % de vacíos alejado ≥ {p['umbral_deriva_pp']} pp de lo esperable para lo que se scrapeó en ellas"
                              + (f"; {nuc['franja'].nunique()} afectan campos centrales para el modelo ({', '.join(sorted(nuc['campo'].unique()))})." if len(nuc) else
                                 "; ninguna afecta precio, moneda, superficie, ambientes ni ubicación."))
        s["tablas"]["Franjas con deriva del parser"] = anom.drop(columns="_fr").sort_values("desvío (pp)", key=abs, ascending=False).round(1).head(40)
    else:
        s["hallazgos"].append("El % de campos vacíos se mantiene estable durante todo el scrape: no hay señales de cambios de HTML ni de páginas degradadas.")
    estado = "critico" if roto or (len(anom) and (anom["campo central"] == "sí").any()) else "atencion" if len(anom) else "ok"

    # Cobertura de las búsquedas (frontier.json: total anunciado por ZonaProp en cada búsqueda)
    first = raw.drop_duplicates("id", keep="first")
    if frontier and "search_slug" in first:
        maxp = int((settings or {}).get("maxPagesPerSearch", 300))
        obt = first.groupby("search_slug").size()
        filas = []
        for slug, st in (frontier.get("nodes") or {}).items():
            if st.get("s") in ("split", "invalid") or st.get("total") is None:
                continue
            tot = int(st["total"])
            filas.append({"búsqueda": slug, "estado": "terminada" if st.get("s") == "done" else f"a medias (página {st.get('page', 0)})",
                          "anunciados": tot, "guardados": int(obt.get(slug, 0)), "cobertura %": _pct(obt.get(slug, 0), tot),
                          "supera el tope de páginas": "sí" if tot > maxp * 30 else "no"})
        cov = pd.DataFrame(filas)
        if len(cov):
            ctot = _pct(cov["guardados"].sum(), cov["anunciados"].sum())
            pend = cov[cov["estado"] != "terminada"]
            kpi(s, "Cobertura de búsquedas", f"{_f(ctot)} %", f"{_f(cov['guardados'].sum(), 0)} guardados de {_f(cov['anunciados'].sum(), 0)} anunciados")
            s["hallazgos"].append(f"Sobre {len(cov)} búsquedas finales, se guardó el {_f(ctot)} % de lo que anunciaba ZonaProp. La diferencia incluye avisos "
                                  "fuera de CABA o emprendimientos descartados a propósito y avisos ya guardados desde otra búsqueda.")
            if len(pend):
                s["hallazgos"].append(f"{len(pend)} búsquedas quedaron a medias ({_f(pend['anunciados'].sum(), 0)} avisos anunciados): retomar el scraper.")
                estado = peor(estado, "atencion")
            top = cov[cov["supera el tope de páginas"] == "sí"]
            if len(top):
                s["hallazgos"].append(f"{len(top)} búsquedas superan el tope de {maxp} páginas y no se pudieron partir más: cobertura parcial seguro.")
                estado = peor(estado, "atencion")
            if ctot < 80:
                estado = peor(estado, "atencion")
            s["tablas"]["Búsquedas con menor cobertura"] = cov[cov["anunciados"] >= 30].sort_values("cobertura %").round(1).head(25)
    else:
        s["hallazgos"].append("No hay frontier.json con totales por búsqueda: no se puede medir la cobertura del recorrido.")

    # Validez de formatos
    fmt = []
    vc = first["price_currency"].fillna("(vacío = consultar precio)").value_counts() if "price_currency" in first else pd.Series(dtype=int)
    for k, v in vc.items():
        fmt.append({"chequeo": "moneda del precio", "valor": k, "avisos": int(v), "%": _pct(v, len(first))})
    loc = first["location"] if "location" in first else pd.Series(None, index=first.index)
    fuera = int((~loc.map(zpml.is_caba)).sum())
    fmt.append({"chequeo": "ubicación fuera de CABA (no debería haber)", "valor": "", "avisos": fuera, "%": _pct(fuera, len(first))})
    caba = first[loc.map(zpml.is_caba)]
    bar = caba["location"].map(zpml.barrio_from_location)
    sinb = int(bar.isna().sum())
    fmt.append({"chequeo": "sin barrio (sólo «Capital Federal»)", "valor": "", "avisos": sinb, "%": _pct(sinb, len(caba))})
    nombres = {zpml.norm(n) for n in zpml.CABA}
    raros = bar.dropna()[~bar.dropna().map(zpml.norm).isin(nombres)].value_counts()
    if len(raros):
        fmt.append({"chequeo": "barrio no reconocido en la lista de CABA", "valor": ", ".join(raros.index[:5]), "avisos": int(raros.sum()), "%": _pct(raros.sum(), len(caba))})
    col = lambda c: caba[c] if c in caba else pd.Series(None, index=caba.index, dtype=object)
    tipos = pd.Series([zpml.tipo_from_row(u, t, tp) for u, t, tp in zip(col("url"), col("title"), col("tipo_propiedad"))])
    otros = int((tipos == "otro").sum())
    fmt.append({"chequeo": "tipo de propiedad no inferido («otro»)", "valor": "", "avisos": otros, "%": _pct(otros, len(caba))})
    fmtt = pd.DataFrame(fmt)
    s["tablas"]["Validez de formatos"] = fmtt.round(2)
    if fuera:
        estado = peor(estado, "atencion")
        s["hallazgos"].append(f"Hay {_f(fuera, 0)} avisos guardados fuera de CABA: el filtro de src/caba.js dejó pasar algo (el modelo igual los filtra).")
    if sinb:
        s["hallazgos"].append(f"{_f(sinb, 0)} avisos ({_f(_pct(sinb, len(caba)))} %) dicen sólo «Capital Federal» y quedan sin barrio: el modelo los trata como barrio faltante.")

    fallas = None
    if failures is not None and len(failures) and "at" in failures:
        f = failures.copy()
        f["t"] = pd.to_datetime(f["at"], errors="coerce", utc=True, format="ISO8601").dt.tz_convert("America/Argentina/Buenos_Aires")
        fallas = f[f["t"].notna()].assign(franja=lambda x: x["t"].dt.floor(freq)).groupby("franja").size()
        kpi(s, "Cargas fallidas", _f(len(f), 0), "failures.jsonl")

    plt = _plt()
    if len(tasa):
        show = [c for c in campos if tasa[c].max() > 0.5] or campos
        fig, ax = plt.subplots(figsize=(min(13, max(8, 3 + 0.32 * len(tasa))), 0.36 * len(show) + 1.6))
        im = ax.imshow(tasa[show].T.values, aspect="auto", cmap="Blues", vmin=0, vmax=100)
        lab = [x.strftime("%d/%m %Hh") for x in tasa.index]
        step = max(1, len(lab) // 16)
        ax.set_xticks(range(0, len(lab), step), lab[::step], rotation=45, ha="right", fontsize=7)
        ax.set_yticks(range(len(show)), show, fontsize=7.5); ax.grid(False)
        if len(anom):
            pos = {fr: i for i, fr in enumerate(tasa.index)}
            for _, a in anom[anom["campo"].isin(show)].iterrows():
                ax.add_patch(plt.Rectangle((pos[a["_fr"]] - .5, show.index(a["campo"]) - .5), 1, 1, fill=False, ec=NARANJA, lw=1.6))
        fig.colorbar(im, ax=ax, shrink=.8, label="% de avisos con el campo vacío")
        ax.set_title("Campos vacíos por franja de scraping (recuadro = deriva)")
        s["figuras"]["deriva_parser"] = fig

    cnt = r.groupby("franja").size()
    nf = 2 if fallas is not None and len(fallas) else 1
    fig, axs = plt.subplots(nf, 1, figsize=(10, 2.3 * nf + .6), sharex=True)
    axs = np.atleast_1d(axs)
    w = pd.Timedelta(freq) * .8
    axs[0].bar(cnt.index, cnt.values, width=w, color=AZUL); axs[0].set_ylabel("avisos leídos"); axs[0].set_title("Ritmo del scraping (los huecos son pausas, cortes o Cloudflare)")
    if nf == 2:
        axs[1].bar(fallas.index, fallas.values, width=w, color=ROJO); axs[1].set_ylabel("cargas fallidas")
    for a in axs:
        a.grid(axis="x", visible=False)
    fig.autofmt_xdate()
    s["figuras"]["ritmo_scraping"] = fig

    if "page" in first:
        pg = first.assign(page=pd.to_numeric(first["page"], errors="coerce")).dropna(subset=["page"])
        pg = pg[pg["page"] <= pg["page"].quantile(.98)]
        if len(pg) and pg["page"].nunique() > 3:
            bins = pd.cut(pg["page"], bins=min(20, pg["page"].nunique()))
            serie = {"precio vacío (consultar)": _vacio(pg["price"]) if "price" in pg else None,
                     "expensas vacías": _vacio(pg["expensas"]) if "expensas" in pg else None,
                     "aviso destacado": pg["highlight"].notna() & (pg["highlight"].astype(str).str.len() > 0) if "highlight" in pg else None}
            fig, ax = plt.subplots(figsize=(8, 3.4))
            for (nm, v), c in zip([(k, v) for k, v in serie.items() if v is not None], [AZUL, NARANJA, AQUA]):
                m = v.groupby(bins, observed=True).mean() * 100
                ax.plot([iv.mid for iv in m.index], m.values, color=c, lw=2, marker="o", ms=4, label=nm)
            ax.set_xlabel("página del listado"); ax.set_ylabel("% de avisos"); ax.legend(frameon=False, fontsize=8)
            ax.set_title("¿Cambia lo que se extrae según la página? (destacados arriba)")
            s["figuras"]["por_pagina"] = fig
    s["estado"] = estado
    return s


# --- Reporte completo ------------------------------------------------------------------------------
def cargar(data_dir: Path | None = None) -> dict:
    """Todo lo que necesitan los chequeos: avisos (como el modelo), historial crudo, frontier, fallas y settings."""
    data_dir = data_dir or zpml.DATA
    df = zpml.load()
    raw = pd.DataFrame(zpml.read_jsonl(data_dir / "listings.jsonl"))
    rd = lambda n: json.loads((data_dir / n).read_text(encoding="utf-8")) if (data_dir / n).exists() else None
    fl = zpml.read_jsonl(data_dir / "failures.jsonl")
    return {"df": df, "raw": raw, "frontier": rd("frontier.json"), "settings": rd("settings.json"),
            "failures": pd.DataFrame(fl) if fl else None}


def resumen(secciones: list[dict]) -> pd.DataFrame:
    txt = {"ok": "OK", "atencion": "Atención", "critico": "Crítico", "sin_datos": "Sin datos"}
    return pd.DataFrame([{"chequeo": s["titulo"], "estado": txt[s["estado"]], "hallazgo principal": (s["hallazgos"] or [""])[0]} for s in secciones])


def reporte(p: dict | None = None, progreso=lambda pct, msg: None, datos: dict | None = None) -> list[dict]:
    p = params(p)
    progreso(3, "Cargando avisos, frontier y fallas")
    x = datos or cargar()
    progreso(8, "0 · Controles básicos del scraper")
    s0 = basicos(x["raw"], p)
    progreso(15, "1 · Embudo de limpieza")
    s1, d = embudo(x["df"], p)
    progreso(30, "2 · Duplicados y fuga train/test")
    s2 = duplicados(x["df"], x["raw"], p)
    progreso(55, "3 · Faltantes")
    s3 = faltantes(x["df"], d, p)
    progreso(68, "4 · Representatividad por barrio")
    s4 = representatividad(d, p)
    progreso(80, "5 · Deriva del parser y cobertura")
    s5 = scraper(x["raw"], x["frontier"], x["failures"], x["settings"], p)
    return [s0, s1, s2, s3, s4, s5]
