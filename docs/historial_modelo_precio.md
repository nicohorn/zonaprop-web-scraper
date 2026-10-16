# Historial del modelo A (precio de departamentos en venta, CABA, USD)

Orden cronológico. Todas las corridas siguen en `data/ml/runs/` y en /modelos («Comparar corridas y variantes»); ninguna variante se borró: todas se pueden volver a entrenar eligiéndolas en la tarea A. Detalle de cada iteración en `docs/modelo_precio.md`. Métrica principal: mediana del error porcentual absoluto (MAPE mediana).

| # | fecha | commit(s) | corrida | cambio principal | evaluación | test MAPE | CV MAPE | dentro 10 % | cobertura 80 % |
|---|---|---|---|---|---|---:|---:|---:|---:|
| 0 | 15/10 | `f39f02e` | `20261016-144037-price` (aleatorio), `20261016-144101-price` (temporal) | LightGBM sobre log precio, sin quitar duplicados | split aleatorio / temporal (optimista: duplicados en train y test) | 12,13 / 12,44 | — | 42,5 / 41,5 | — |
| 1 | 16/10 | `e10deb7` | `20261016-122915-price` | limpieza con conteos, casi-duplicados v1 (huella), test agrupado, CV 5 folds, baselines, intervalo | test agrupado (8.392) | 13,73 | 13,62 ± 0,17 | 38,1 | 79,9 |
| 2 | 16/10 | `5c4fd47`, `4591caf`, `61c7e8e` | ablación `20261016-140544-price_ablation`; final `20261016-143053-price` | duplicados v2 validados, texto v2, calle, target log USD/m², Huber (`v3_ppm2_huber`) | test agrupado (9.300) | 10,81 (v1 en el mismo test: 13,33) | 10,97 ± 0,09 | 46,6 | 80,5 |
| 3 | 16/10 | `c9b2f86` … `5f03c3f` | ablaciones `20261016-164504-…`, `20261016-171122-…`; final `20261016-171812-price` | calle normalizada, target encoding OOF, TF-IDF+SVD, texto v3 (`v4_todo_sin_iso`) | mismo test (9.300) | 9,88 | 10,02 ± 0,17 | 50,7 | 80,4 |

Notas: el 12,1 % de la iteración 0 no es comparable (el test compartía departamentos con train). Desde la iteración 2 el test es el mismo, así que 13,33 → 10,81 → 9,88 son comparables entre sí.

Otras corridas del proyecto que se conservan: `b-dq-20261016` (modelo B con filtro de calidad de datos) y `c-mep-20261016` (modelo C con dólar MEP automático), más las corridas de prueba de B–F del 16/10.
