# Rover anfibio — simulazione interattiva

Demo web (HTML/CSS/JS, WebGL2 con Three.js) di un rover anfibio da ispezione in un lago prealpino.
Fase attuale: **ambiente** (lago, fondale, condotta sommersa, ottica subacquea) con camera libera; il rover non è ancora presente.

## Avvio locale (Windows, PowerShell)

I moduli ES richiedono un server HTTP (l'apertura diretta di `index.html` da file non funziona).

```powershell
conda activate slackenv
cd C:\percorso\amphibious-robot
python -m http.server 8000
```

Aprire `http://localhost:8000` in Chrome o Edge aggiornati. Three.js è incluso in `vendor/`: non serve connessione internet.

## Comandi

| Tasto | Azione |
| --- | --- |
| Trascina (mouse) | orientamento |
| W A S D | movimento |
| E / Q | su / giù |
| Shift | veloce |
| Frecce | rotazione da tastiera |
| 1–5 | viste: riva, bassofondo, scarpata, condotta, panoramica |
| H | mostra/nasconde l'aiuto |

## Struttura

| File | Contenuto |
| --- | --- |
| `src/terrain.js` | campo di quota deterministico `heightAt(x, z)` (unica fonte per grafica e futura fisica), bacino, condotta |
| `src/optics.js` | modello ottico condiviso: attenuazione e diffusione in acqua, foschia, caustiche, superfici procedurali |
| `src/water.js` | superficie del lago (riflessione, rifrazione, finestra di Snell) e particelle in sospensione |
| `src/sky.js` | cielo fisico (Preetham), nuvole, mappa d'ambiente |
| `src/props.js` | rocce, conifere, piante acquatiche, tronchi sommersi, condotta con flange, selle e muro di testata |
| `src/pipeline.js` | passate di rendering: riflessione, scena HDR, composizione acqua, raggi di luce, bloom, tone mapping |
| `src/controls.js` | camera libera con inerzia |

## Parametri ottici dell'acqua (per metro)

Definiti in `src/optics.js`; coerenti con un lago moderatamente torbido verde-azzurro.

| Grandezza | R | G | B |
| --- | --- | --- | --- |
| Estinzione del fascio `c` | 0.50 | 0.17 | 0.24 |
| Attenuazione diffusa con la profondità `Kd` | 0.32 | 0.075 | 0.11 |

Il rosso si spegne nei primi metri; a 19 m (quota della condotta) arriva circa il 24 % del verde e il 12 % del blu della luce superficiale.

## Pubblicazione

Sito statico: GitHub Pages dalla radice del repository, nessun passo di build.
