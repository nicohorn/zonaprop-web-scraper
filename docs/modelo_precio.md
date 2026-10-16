# Modelo A · Predicción del precio de departamentos en venta (CABA, USD)

MVP del modelo de precio del proyecto ZonaProp CABA. El código está en `ml/precio.py` (pipeline),
`ml/zpml.py` (carga y variables), `ml/run.py` (tarea `price` de la interfaz) y `ml/predict.py`
(formulario *Predecir precio*). El notebook `notebooks/01_price_prediction.ipynb` corre el mismo
pipeline paso a paso y quedó guardado con sus salidas.

Todas las cifras de este documento salen de la corrida `20261016-122915-price` (parámetros por
defecto, semilla 42), hecha sobre el scrape del 15–16/10/2026.

## 1. Datos

- Fuente: `data/listings.jsonl`, avisos del listado de ZonaProp (última versión de cada `id`),
  sólo CABA. El scrape terminó el 16/10/2026: 105.413 avisos (83.496 venta, 19.061 alquiler,
  2.856 temporal).
- No hay fichas de detalle (`details.jsonl`): no hay superficie cubierta, antigüedad,
  orientación ni descripción larga. La superficie usada es la **total**.
- Objetivo: `log(precio publicado en USD)`. Las métricas se calculan en USD.

## 2. Limpieza (filas en cada paso)

Las reglas son fijas (no se ajustan con los datos), así que aplicarlas antes de separar no filtra
información del test. Constantes en `ml/precio.py`.

| # | Paso | Filas | Quitadas |
|---|------|------:|---------:|
| 0 | Avisos de CABA (última versión de cada id) | 105.413 | – |
| 1 | Operación = venta | 83.496 | 21.917 |
| 2 | Tipo = departamento | 54.704 | 28.792 |
| 3 | Precio en USD | 54.607 | 97 |
| 4 | Con precio y superficie | 54.220 | 387 |
| 5 | Superficie 18–1000 m² y cubierta ≤ total | 54.097 | 123 |
| 6 | Ambientes 1–10, dormitorios ≤ ambientes, baños 1–6, ≥ 9 m² por ambiente | 53.979 | 118 |
| 7 | Precio USD 20.000–15.000.000 y USD/m² 500–15.000 (pesos cargados como dólares, precios parciales) | 53.889 | 90 |
| 8 | Sin pozo / en construcción / preventa / anticipo / emprendimiento (precio parcial) | 47.882 | 6.007 |
| 9 | Sin casi-duplicados | **41.121** | 6.761 |
| 10 | Train: recorte de USD/m² en percentiles 1–99, **calculado sólo con train** | 32.073 (train) | 656 |

- **Expensas** fuera de 200–30.000 ARS/m²/mes y **cocheras** > 6 pasan a faltante: no se
  descarta el aviso.
- **Casi-duplicados**: la misma unidad publicada por varias inmobiliarias o republicada con otro
  id. Huella = barrio + m² + ambientes + dormitorios + baños + precio redondeado a ~2 % (escala
  logarítmica). Queda el aviso publicado más recientemente.
- **Pozo**: detectado por texto (`pozo`, `preventa`, `en construcción`, `avance de obra`,
  `anticipo`, `entrega/posesión en…`) o por tipo emprendimiento. Se excluye por defecto
  (parámetro `excluir_pozo`).

## 3. Variables

| Grupo | Variables |
|---|---|
| Superficie | `superficie_total`, `superficie`, `log_superficie`, `m2_por_ambiente` |
| Ambientes | `ambientes`, `dormitorios`, `banos`, `cocheras` |
| Costos | `expensas` (ARS), `expensas_m2` |
| Atributos (texto sin montos) | `kw_a_estrenar`, `kw_balcon_terraza`, `kw_amenities`, `kw_apto_credito` |
| Categóricas | `barrio`, `tipo_prop` (niveles tomados sólo de train; lo que no se vio queda como faltante) |

**Excluidas a propósito**: días publicado, destacado/super destacado, cantidad de fotos y
tipo de publicación. Describen el aviso y no la propiedad, cambian con el tiempo, y el formulario
de predicción no los conoce (antes `predict.py` les ponía 0, fuera de la distribución de
entrenamiento).

Los **montos se borran del texto** (`USD 120.000`, `u$s 95 mil`, `$350.000`, cifras de 5 o más
dígitos) antes de buscar palabras clave o armar TF-IDF, así el modelo no lee el precio de la
descripción. Las cuatro palabras clave se piden en el formulario como casillas, así entrenamiento
y predicción ven lo mismo. TF-IDF + SVD (`use_text`) queda sólo como experimento y no se guarda
para predecir.

## 4. Separación y validación

- **Test fijo del 20 % agrupado** (`GroupShuffleSplit`, semilla 42) por *grupo* = barrio + m² +
  ambientes + dormitorios + baños (la huella sin precio). Una misma unidad, aunque cambie de
  precio o de id, nunca queda en train y en test: 0 grupos compartidos. Train 32.729
  (32.073 después del recorte) y test 8.392.
  El grupo es conservador: puede juntar unidades distintas de igual tamaño en el mismo barrio.
- Opciones `temporal` (test = los publicados más recientemente, sin grupos compartidos) y
  `aleatorio` (sólo para comparar).
- **CV de 5 folds agrupados** (`GroupKFold`) sobre train. El recorte de percentiles se recalcula
  con el train de cada fold. Con la CV se eligen el `alpha` de Ridge (0,3 / 3 / 30 → 3) y la
  grilla de LightGBM (12 combinaciones: `num_leaves` 31/63/127 × `min_child_samples` 10/30 ×
  `reg_lambda` 0/5, `learning_rate` 0,03, early stopping de 100 rondas sobre el fold). Ganó
  `num_leaves=63, min_child_samples=10, reg_lambda=0`. El modelo final se entrena con todo train,
  con 1,1 × la media de árboles óptimos (644), y se evalúa **una sola vez** en test.
  El early stopping usa el mismo fold que se puntúa, así que el CV de LightGBM es apenas
  optimista. El test no tiene ese problema.

## 5. Resultados

Métricas: MAE en USD, mediana del error porcentual absoluto (APE), % de avisos con error < 10 %,
R² en log y en USD.

### CV (5 folds agrupados en train, media ± desvío)

| Modelo | MAE (USD) | Mediana APE % | Dentro de 10 % | R² log |
|---|---:|---:|---:|---:|
| Mediana global | 151.047 ± 4.617 | 46,10 ± 1,28 | 10,74 ± 0,29 | −0,03 ± 0,02 |
| Mediana USD/m² del barrio × m² | 73.210 ± 2.073 | 19,22 ± 0,34 | 27,16 ± 0,59 | 0,83 ± 0,01 |
| Ridge (alpha 3) | 59.561 ± 1.324 | 14,70 ± 0,16 | 35,69 ± 0,42 | 0,89 ± 0,00 |
| **LightGBM** | 53.372 ± 1.891 | **13,62 ± 0,17** | 38,24 ± 0,47 | 0,91 ± 0,00 |

### Test (8.392 avisos, evaluación única)

| Modelo | MAE (USD) | Mediana APE % | Dentro de 10 % | R² log | R² |
|---|---:|---:|---:|---:|---:|
| Mediana global | 156.994 | 48,63 | 9,99 | −0,02 | −0,08 |
| Mediana USD/m² del barrio × m² | 73.851 | 19,34 | 27,68 | 0,845 | 0,662 |
| Ridge | 61.338 | 15,05 | 35,22 | 0,898 | 0,745 |
| **LightGBM** | **53.292** | **13,73** | **38,08** | **0,915** | **0,810** |

El test cae dentro de la banda de la CV, así que no hay señales de sobreajuste al elegir
hiperparámetros.

### Comparación con el 12,1 % anterior

El 12,1 % original se medía con un split aleatorio sin quitar casi-duplicados (además de usar
publicación, destacado y fotos, y de recortar con todos los datos). Con los mismos
hiperparámetros y ese protocolo, el modelo nuevo da **12,91 %** (MAE 47.854, dentro de 10 %:
40,9 %). Ahí el 72,8 % de los avisos de test tenía otro aviso del mismo grupo en train. El paso a
**13,73 %** no es un empeoramiento del modelo: es el costo de medir sin que la misma propiedad
esté de los dos lados. Es la cifra que hay que reportar.

### Intervalo de predicción

Los cuantiles 10/90 y 25/75 del residuo (en log) salen de las predicciones **fuera de fold** de la
CV, no del test. En test, el rango de 80 % contiene al **79,9 %** de los precios y el de 50 % al
**49,8 %**: el intervalo está bien calibrado. Es un ancho global, igual para todos los avisos.

## 6. Análisis de errores (test)

Sesgo = mediana de (real / predicho − 1). Si es positivo, el mercado publica más caro de lo que
predice el modelo.

| Superficie | n | Mediana APE % | Dentro de 10 % | Sesgo % |
|---|---:|---:|---:|---:|
| < 35 m² | 1.091 | 11,6 | 43,4 | −0,7 |
| 35–50 | 1.836 | 12,5 | 41,9 | −1,0 |
| 50–70 | 1.704 | 13,2 | 38,3 | −1,0 |
| 70–100 | 1.634 | 13,2 | 39,8 | −0,1 |
| 100–150 | 1.149 | 15,9 | 32,1 | +0,5 |
| 150+ | 978 | 18,0 | 28,7 | +0,9 |

| Precio publicado | n | Mediana APE % | Dentro de 10 % | Sesgo % |
|---|---:|---:|---:|---:|
| < 80k | 1.485 | 13,9 | 37,0 | −10,6 |
| 80–120k | 1.771 | 12,0 | 42,2 | −2,4 |
| 120–180k | 1.767 | 12,1 | 43,7 | −0,3 |
| 180–300k | 1.700 | 14,1 | 37,6 | +3,8 |
| 300–600k | 1.064 | 15,7 | 32,1 | +7,9 |
| 600k+ | 605 | 20,9 | 24,1 | +17,3 |

- Hay **regresión a la media**: los avisos baratos se sobreestiman y los de lujo se subestiman.
  Faltan variables que distingan calidad (piso, vista, estado, amenities detallados).
- Por barrio (≥ 30 avisos en test): el error más bajo está en La Paternal (7,8 %), Villa
  Pueyrredón (8,4 %) y Villa del Parque (8,8 %). El más alto, en Villa Lugano (25,2 %, sesgo
  −18 %), Mataderos (23,3 %), Constitución (20,8 %), Microcentro (18,7 %) y La Boca (18,4 %),
  barrios heterogéneos o con pocos datos. Puerto Madero tiene sesgo de +10,5 %. La tabla
  completa queda en `error_por_barrio.csv` de la corrida y en el notebook.
- Importancia (ganancia): la superficie explica la mayor parte (`superficie_total` 65 %), luego
  `barrio` (11 %), expensas, amenities y baños.

## 7. Limitaciones

- **Precios publicados, no de cierre.** En CABA la escritura suele cerrar por debajo del precio
  publicado. El modelo estima el precio *de publicación*.
- **Una sola foto del mercado** (scrape del 15–16/10/2026). Sin historia de precios no se puede
  medir la deriva; el modelo hay que reentrenarlo con cada scrape. `date_posted` es la fecha de
  publicación, no del precio.
- **Dólar MEP**: el modelo usa sólo avisos publicados en USD (97 avisos en pesos se descartan),
  así que no depende del tipo de cambio. Las expensas están en ARS nominales y pierden valor con
  la inflación.
- Sin ubicación fina (calle, lat/lon), piso, antigüedad ni superficie cubierta: con fichas de
  detalle el modelo mejoraría.
- Las reglas de pozo y de duplicados son heurísticas: pueden quedar duplicados con m² distintos y
  precios parciales sin las palabras clave.
- La mediana de error del 13,7 % sirve para un precio de referencia, no para una tasación.

## 8. Cómo reproducir

```powershell
python -m venv ml\.venv
ml\.venv\Scripts\python.exe -m pip install -r ml\requirements.txt   # versiones fijas
npm start   # http://localhost:3210/modelos -> "A · Predicción de precio" -> Entrenar (defaults)
# o sin interfaz:
mkdir data\ml\runs\manual-price; ml\.venv\Scripts\python.exe ml\run.py price --run-dir data\ml\runs\manual-price
# notebook con salidas:
ml\.venv\Scripts\jupyter nbconvert --to notebook --execute --inplace notebooks\01_price_prediction.ipynb
```

Cada corrida deja en `data/ml/runs/<id>/`: `result.json`, `model.joblib`/`model.json`,
`limpieza_pasos.csv`, `cv_grilla_lightgbm.csv`, `predicciones_test.csv`, `error_por_*.csv`,
`importancia.csv` y los gráficos. La corrida tarda unos 6 minutos en una PC de escritorio.
