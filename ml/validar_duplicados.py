"""Validación de la regla de casi-duplicados (modelo A).

Toma los pares que la regla v1 (sólo huella) consideraba duplicados, muestrea pares al azar
y guarda una planilla para revisión manual, más estadísticas de qué señales comparten
(calle+cuadra, texto casi igual, inmobiliaria). Uso: python ml/validar_duplicados.py [n_muestra]
Salida: data/ml/validacion_duplicados/{muestra_pares.csv,resumen.json}
"""
from __future__ import annotations
import json, os, sys
from pathlib import Path
import numpy as np, pandas as pd
sys.path.insert(0, str(Path(__file__).parent))
import zpml, precio
from sklearn.feature_extraction.text import TfidfVectorizer

def main(n=60, seed=0):
    df = zpml.load()
    d, _ = precio.limpiar(df, deduplicar=False)
    multi = d[d.duplicated("huella", keep=False)].copy()
    txt = (zpml._text_col(multi, "title") + " " + zpml._text_col(multi, "description_short")).map(zpml.norm).map(zpml.strip_amounts).str[:300]
    T = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), min_df=2).fit_transform(txt)
    pos = {ix: i for i, ix in enumerate(multi.index)}
    key = multi["address"].map(precio.clave_direccion) if "address" in multi else pd.Series(None, index=multi.index)
    ag_col = next((c for c in ["publisher", "inmobiliaria", "publisher_name", "agency", "anunciante"] if c in multi), None)
    pares = []
    for h, g in multi.groupby("huella"):
        ix = list(g.index)
        for a in range(len(ix)):
            for b in range(a + 1, len(ix)):
                i, j = ix[a], ix[b]
                pares.append((h, i, j))
    rng = np.random.default_rng(seed)
    filas = []
    for h, i, j in pares:
        s = float((T[pos[i]] @ T[pos[j]].T).toarray()[0, 0])
        ka, kb = key[i], key[j]
        filas.append({"huella": h, "id_a": d.at[i, "id"], "id_b": d.at[j, "id"], "sim_texto": round(s, 3),
                      "misma_direccion": bool(ka is not None and ka == kb), "dir_a": d.at[i, "address"] if "address" in d else None,
                      "dir_b": d.at[j, "address"] if "address" in d else None,
                      "misma_inmobiliaria": (str(d.at[i, ag_col]) == str(d.at[j, ag_col])) if ag_col else None,
                      "titulo_a": str(d.at[i, "title"])[:90] if "title" in d else None, "titulo_b": str(d.at[j, "title"])[:90] if "title" in d else None,
                      "precio_a": d.at[i, "price_x"], "precio_b": d.at[j, "price_x"], "url_a": d.at[i, "url"], "url_b": d.at[j, "url"]})
    P = pd.DataFrame(filas)
    P["dup_v2"] = P["misma_direccion"] | (P["sim_texto"] >= 0.6)
    out = Path(os.environ.get("ZP_DATA_DIR", Path(__file__).parents[1] / "data")) / "ml" / "validacion_duplicados"
    out.mkdir(parents=True, exist_ok=True)
    m = P.sample(min(n, len(P)), random_state=seed)
    m.to_csv(out / "muestra_pares.csv", index=False, encoding="utf-8")
    res = {"avisos_limpios_antes_dedup": int(len(d)), "avisos_en_huellas_repetidas": int(len(multi)), "huellas_repetidas": int(multi["huella"].nunique()),
           "pares": int(len(P)), "pares_misma_direccion_%": float(P["misma_direccion"].mean() * 100),
           "pares_texto_sim_ge_0.6_%": float((P["sim_texto"] >= 0.6).mean() * 100), "pares_dup_v2_%": float(P["dup_v2"].mean() * 100),
           "columna_inmobiliaria": ag_col, "pares_misma_inmobiliaria_%": float(P["misma_inmobiliaria"].mean() * 100) if ag_col else None,
           "quitados_v1": int(len(d) - d["huella"].nunique()), "quitados_v2": int(len(d) - precio.dup_ids(d).nunique())}
    (out / "resumen.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(res, ensure_ascii=False, indent=1))

if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 60)
