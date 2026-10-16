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

---

# Iteración 2 (16/10/2026): duplicados validados, rasgos de texto y variantes

Sin scraping nuevo: mismos 105.413 avisos. La iteración 1 (13,7 %, corrida `20261016-122915-price`) se conserva tal cual en la interfaz y en `data/ml/runs/`; la variante `v1` y la regla `v1_huella` siguen seleccionables.

## 9. Validación de la regla de casi-duplicados

Script: `ml/validar_duplicados.py` (salida en `data/ml/validacion_duplicados/`: `resumen.json`, `muestra_pares.csv`, `revision_manual.csv`).

- Regla v1: misma *huella* (barrio + m² + ambientes + dormitorios + baños + precio redondeado). Sobre 47.882 avisos limpios hay 4.732 huellas repetidas que abarcan 11.493 avisos (11.192 pares); v1 quitaba **6.761**.
- Señales en esos pares: misma calle + cuadra 33,3 %; título+descripción casi iguales (coseno de n-gramas ≥ 0,6) 5,6 %; misma inmobiliaria (`publisher`) sólo 5,1 % (la mayoría de los pares son de anunciantes distintos, por eso no se usa como condición).
- Revisión manual de 40 pares al azar (semilla 0): 15 parecen el mismo departamento (misma dirección/edificio, mismo precio), 24 son unidades distintas que sólo coinciden en barrio, tamaño y precio, 1 dudoso. **Precisión estimada de v1 ≈ 38 %** (15/39).
- Regla v2 (por defecto): misma huella **y** (misma calle+cuadra **o** texto casi igual). En la misma muestra marcó 13 pares y los 13 eran duplicados reales (precisión 13/13); se le escaparon 2 de 15 (calle escrita "Franklin D. Roosevelt" vs "Roosevelt"; altura "0").
- **Antes / después: v1 quita 6.761 → v2 quita 2.253** (quedan 45.629 avisos en vez de 41.121). El test agrupado sigue usando la huella sin precio como grupo, así que sigue siendo estricto (0 grupos en train y test).

La muestra es chica (40 pares): las precisiones son orientativas, no un intervalo.

## 10. Variantes y ablación (CV 5 folds agrupados, sólo train)

Rasgos nuevos del texto (`zpml.build_features(version=2)`, nunca montos): reciclado, a reciclar, luminoso, frente, contrafrente, cochera, dependencia, suite, vista, semipiso, dúplex, penthouse, torre, patio, baulera, apto profesional, seguridad, categoría/lujo, planta baja, estilo francés, impecable, `piso_txt` (número de piso) y `antiguedad_txt` (años). Además `calle` (primera palabra de la dirección, categorías con ≥ 15 avisos en train).

Corrida `20261016-140544-price_ablation` (archivo `ablacion_cv.csv`). MAPE = mediana del error porcentual; sesgo negativo = el modelo sobreestima.

| variante | target | pesos | objetivo | segm. | MAPE CV | ±std | dentro 10 % | < 80k | > 600k | ≥ 150 m² | barrios débiles | sesgo < 80k | sesgo > 600k |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| v1 (iter. 1) | log precio | — | L2 | no | 13,19 | 0,14 | 39,5 | 13,03 | 22,36 | 19,72 | 18,30 | −9,8 | +20,8 |
| v2_texto | log precio | — | L2 | no | 12,11 | 0,21 | 42,2 | 11,96 | 20,45 | 18,17 | 16,71 | −8,7 | +16,6 |
| v2_texto_calle | log precio | — | L2 | no | 11,42 | 0,18 | 44,7 | 11,80 | 18,26 | 16,46 | 15,63 | −8,2 | +13,6 |
| v2_ppm2 | log USD/m² | — | L2 | no | 11,13 | 0,08 | 45,5 | 11,47 | 17,74 | 16,11 | 15,65 | −8,1 | +13,4 |
| v2_pesos | log precio | balanceado | L2 | no | 11,43 | 0,16 | 44,6 | 11,42 | 18,09 | 16,21 | 15,19 | −7,7 | +13,9 |
| v2_huber | log precio | — | Huber | no | 11,21 | 0,17 | 45,5 | 11,57 | 18,19 | 16,09 | 15,86 | −8,2 | +14,3 |
| v2_l1 | log precio | — | L1 | no | 11,31 | 0,19 | 45,2 | 11,30 | 18,86 | 16,39 | 16,45 | −8,1 | +15,3 |
| v2_segmentos | log precio | — | L2 | < / ≥ 100 m² | 11,40 | 0,10 | 44,8 | 11,88 | 19,01 | 16,77 | 16,08 | −8,3 | +14,6 |
| **v3_ppm2_huber** | log USD/m² | — | Huber | no | **11,07** | 0,09 | 46,1 | 11,41 | 17,44 | 15,88 | 15,35 | −7,8 | +12,7 |
| v3_ppm2_pesos | log USD/m² | balanceado | L2 | no | 11,25 | 0,07 | 45,5 | 11,20 | 17,39 | 16,17 | 15,63 | −7,6 | +13,0 |
| v3_ppm2_huber_pesos | log USD/m² | balanceado | Huber | no | 11,04 | 0,10 | 46,1 | 11,10 | 17,26 | 15,96 | 15,55 | −7,4 | +12,3 |

(Todas las variantes v2/v3 usan rasgos de texto v2 y `calle`, salvo `v2_texto`. Barrios débiles = Villa Lugano, Mataderos, Constitución.)

Lecturas: lo que más ayuda son los rasgos de texto (−1,1 pp) y la calle (−0,7 pp); modelar log USD/m² y la pérdida Huber suman ~0,3 pp más. Pesos por rango de precio y modelos separados por tamaño casi no cambian el total. `v3_ppm2_huber_pesos` quedó 0,03 pp por debajo de `v3_ppm2_huber`, menos que un desvío entre folds; se eligió `v3_ppm2_huber` como default por ser más simple (sin pesos). Ambas quedan seleccionables.

## 11. Resultado final (test agrupado, evaluación única) — corrida `20261016-143053-price`

Regla de duplicados v2 → train 35.602 / test 9.300 (otro test que el de la iteración 1: no son cifras directamente comparables con el 13,7 %). Para comparar en igualdad de condiciones se reentrena v1 en el **mismo** train/test.

| modelo | MAPE test | dentro 10 % | R² log | MAE USD |
|---|---:|---:|---:|---:|
| Mediana global | 47,50 | 10,6 | −0,02 | 148.644 |
| Mediana USD/m² barrio × m² | 18,51 | 28,9 | 0,847 | 69.359 |
| Ridge | 14,39 | 36,8 | 0,900 | 57.595 |
| LightGBM v1 (referencia, mismo test) | 13,33 | 39,1 | 0,916 | 50.508 |
| **LightGBM v3_ppm2_huber** | **10,81** | **46,6** | **0,939** | **42.081** |

CV en train de la variante final: 10,97 ± 0,09 % (coincide con el test). Hiperparámetros por CV: num_leaves 127, min_child_samples 30, learning_rate 0,03, 1.712 árboles. Intervalo 80 % cubre 80,5 % del test; el 50 %, 50,4 %. Con el protocolo viejo (split aleatorio con duplicados) la misma variante da 10,28 %.

Por segmento (test, MAPE / sesgo):

| segmento | n | v1 ref | v3_ppm2_huber | sesgo v1 → v3 |
|---|---:|---:|---:|---:|
| todos | 9.300 | 13,33 | 10,81 | −0,5 → −0,1 |
| < USD 80k | 1.628 | 13,55 | 11,70 | −10,3 → −8,0 |
| > USD 600k | 617 | 21,17 | 16,32 | +18,7 → +11,6 |
| ≥ 150 m² | 1.011 | 18,14 | 14,51 | +1,0 → +1,8 |
| barrios débiles | 307 | 21,10 | 17,18 | −9,2 → −5,4 |

Peores barrios en test: Villa Lugano 21,0 %, Constitución 18,3 %, La Boca 16,5 %, Liniers 15,8 %. Variables más importantes (gain): barrio 29 %, calle 15 %, amenities 10 %, expensas/m² 8 %.

## 12. Limitaciones que siguen

- Sigue la regresión a la media: los baratos se sobreestiman ~8 % y los > USD 600k se subestiman ~12 %.
- Villa Lugano y Constitución siguen > 18 % de error: pocos avisos y mucha heterogeneidad.
- Los rasgos de texto dependen de cómo escribe cada inmobiliaria (`piso_txt`/`antiguedad_txt` faltan en la mayoría de los avisos).
- La regla v2 de duplicados se validó con 40 pares; normalizar nombres de calle (alias tipo "Franklin D. Roosevelt") recuperaría algunos duplicados que hoy se escapan.

Reproducir: `python ml/run.py price_ablation --run-dir …` (o tarea "A2 · Ablación" en /modelos), luego la tarea A con `variante=v3_ppm2_huber`; `python ml/validar_duplicados.py 60` para la validación.
