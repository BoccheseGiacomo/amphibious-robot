# Rover anfibio — simulazione interattiva

Demo web (HTML/CSS/JS, WebGL2 con Three.js) di un rover anfibio da ispezione in un lago prealpino.
Fase attuale: ambiente (lago, fondale, condotta sommersa, ottica subacquea) e **rover cingolato guidabile** dalla riva fino all'imbocco e dentro la condotta.

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
| W / S (o frecce) | avanti / indietro |
| A / D (o frecce) | sterzata (cingoli a velocità diverse; da fermo ruota sul posto) |
| L | luci accese / spente |
| V | vista esterna / telecamera di bordo |
| Trascina (mouse) | vista esterna: orbita · bordo: brandeggio della telecamera |
| Rotella | distanza della vista esterna |
| R | riporta il rover a riva |
| F | camera libera (W A S D, E / Q, Shift) |
| 1–5 | punti di vista fissi (camera libera) |
| H | mostra/nasconde l'aiuto |

## Rover

Rover generico da ~1 m, non una riproduzione di una macchina reale. Parametri in `src/rover.js`:

| Grandezza | Valore |
| --- | --- |
| Massa | 120 kg |
| Volume immerso | 0.08 m³ → peso apparente in acqua ≈ 40 kg |
| Carreggiata / lunghezza di contatto cingoli | 0.64 m / 0.80 m |
| Velocità massima cingoli | 1.4 m/s |
| Forza massima per cingolo | 350 N |
| Attrito cingolo–fondo | 0.6 |
| Resistenza idrodinamica (Cd·A frontale) | 0.32 m² |

Modello: dinamica nel piano con inerzia (più massa aggiunta in acqua), trazione limitata da attrito × carico normale (il galleggiamento riduce l'aderenza), componente del peso lungo la pendenza, resistenza quadratica dell'acqua proporzionale all'immersione, sterzata per differenza di velocità dei cingoli contro la resistenza laterale. L'assetto segue il terreno sotto le quattro estremità dei cingoli. Condotta (dall'esterno), muro di testata, tronchi e rocce alte più di ~25 cm bloccano il rover. La condotta (diametro interno 2.64 m) è percorribile: il rover entra dall'imbocco e viaggia sul fondo di sedimento; le pareti lo mantengono nel canale e lo riallineano all'asse. All'interno non arriva luce ambiente: servono i fari (L).

Indicatori: la profondità è riferita al centro del telaio (0.3 m sopra il fondo dei cingoli); velocità lungo l'asse del rover; rotta con 0° = −z (verso il lago); distanza dall'imbocco misurata dal centro del rover.

## Struttura

| File | Contenuto |
| --- | --- |
| `src/terrain.js` | campo di quota deterministico `heightAt(x, z)` (unica fonte per grafica e futura fisica), bacino, condotta |
| `src/optics.js` | modello ottico condiviso: attenuazione e diffusione in acqua, foschia, caustiche, superfici procedurali |
| `src/water.js` | superficie del lago (riflessione, rifrazione, finestra di Snell) e particelle in sospensione |
| `src/sky.js` | cielo fisico (Preetham), nuvole, mappa d'ambiente |
| `src/props.js` | rocce, conifere, piante acquatiche, tronchi sommersi, condotta con flange, selle e muro di testata |
| `src/pipeline.js` | passate di rendering: riflessione, scena HDR, composizione acqua, raggi di luce, bloom, tone mapping |
| `src/rover.js` | rover cingolato: geometria, parametri, dinamica, collisioni, luci |
| `src/controls.js` | input, camera libera e camera esterna |

## Parametri ottici dell'acqua (per metro)

Definiti in `src/optics.js`; coerenti con un lago moderatamente torbido verde-azzurro.

| Grandezza | R | G | B |
| --- | --- | --- | --- |
| Estinzione del fascio `c` | 0.40 | 0.10 | 0.13 |
| Attenuazione diffusa con la profondità `Kd` | 0.27 | 0.06 | 0.075 |

Il rosso si spegne nei primi metri; a 19 m (quota della condotta) arriva circa il 32 % del verde e il 24 % del blu della luce superficiale. In orizzontale il contrasto si riduce a 1/e ogni 10 m circa (verde).

## Pubblicazione

Sito statico, nessun passo di build: in GitHub → Settings → Pages scegliere "Deploy from a branch", branch desiderato, cartella `/ (root)`. Il file `.nojekyll` evita l'elaborazione Jekyll.
