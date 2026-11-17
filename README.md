# NoteBro

App desktop per macOS, Windows e Linux che ascolta **il tuo microfono e l'audio di sistema**
durante una call o un colloquio, e al termine produce un **riassunto strutturato**
che puoi nominare e archiviare in cartelle.

Tutto gira in locale: nessun audio e nessun testo lascia il computer.

- **Trascrizione** — [whisper.cpp](https://github.com/ggml-org/whisper.cpp), accelerato su GPU
- **Riassunto** — [Ollama](https://ollama.com) con il modello che preferisci
- **Audio di sistema** — ScreenCaptureKit su macOS, loopback di Chromium su Windows,
  monitor di PulseAudio/PipeWire (`parec`) su Linux.
  Nessun driver virtuale tipo BlackHole.
- **Riconoscimento degli interlocutori** — [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx),
  per distinguere più persone collegate (sperimentale, spento di default)

Le due sorgenti vengono registrate su **canali separati**, trascritte separatamente e
riunite in un dialogo con i turni attribuiti a chi ha parlato. Il riassunto sa quindi
distinguere quello che hai detto tu da quello che ha detto il tuo interlocutore.

Durante la registrazione puoi prendere **appunti in presa diretta**: il riassunto parte
da lì e li completa con la trascrizione, seguendo un **template** scelto per il tipo di
conversazione (riunione, formazione, colloquio, uno a uno, call commerciale).

Insieme al riassunto viene conservata la **registrazione riascoltabile**: ogni battuta
della trascrizione è cliccabile e porta il player esattamente a quel punto, e il turno
in riproduzione resta evidenziato.

Se alla call partecipano più persone, la **diarizzazione** può separarne le voci: a
ciascuna dai un nome, che compare poi nella trascrizione e nel riassunto.

---

## Requisiti

| Cosa | Perché | Come |
| --- | --- | --- |
| Node.js 22+ | toolchain di build | `brew install node@22` |
| Ollama | genera il riassunto | `brew install ollama` → [ollama.com](https://ollama.com) su Windows |
| Un modello Ollama | il cervello del riassunto | `ollama pull qwen2.5:7b` |
| whisper.cpp | trascrive l'audio | `brew install whisper-cpp` (macOS) / vedi sotto (Windows) |
| Un modello whisper | pesi per la trascrizione | si scarica dall'app, in Impostazioni |

Su **Windows** whisper.cpp non ha un gestore di pacchetti: scarica una release
precompilata da [ggml-org/whisper.cpp/releases](https://github.com/ggml-org/whisper.cpp/releases),
estraila, e in *Impostazioni → Percorso personalizzato* indica il percorso di
`whisper-cli.exe`.

Su **Linux** servono `whisper-cli` nel `PATH` (su Arch: `whisper.cpp` da AUR, oppure
`whisper.cpp-cuda` / `whisper.cpp-vulkan`), Ollama e `parec`, che arriva con `libpulse`
(Arch) o `pulseaudio-utils` (Debian/Ubuntu) e funziona anche su PipeWire tramite
`pipewire-pulse`. L'audio di sistema si registra dal *monitor* dell'uscita: di default
quella predefinita, oppure quella scelta in *Uscita da registrare* nella schermata di
registrazione. Nessun permesso da concedere.

## Avvio in sviluppo

```bash
npm install
npm run native:mac   # compila l'helper audio (solo macOS)
npm run dev
```

## Creare l'app installabile

```bash
npm run dist:mac     # -> dist/NoteBro-1.0.0-arm64.dmg
npm run dist:win     # -> dist/NoteBro Setup 1.0.0.exe  (da eseguire su Windows)
npm run dist:linux   # -> dist/NoteBro-1.0.0.AppImage
```

`dist:mac` crea al primo utilizzo un certificato di firma locale (vedi
**Firma su macOS**); senza, ripiega su una firma ad-hoc e lo segnala.

L'installer Windows non si può produrre in modo affidabile da macOS. Il repository
include `.github/workflows/build-windows.yml`: lanciandolo da GitHub (*Actions →
Build Windows installer → Run workflow*, oppure con un tag `v*`) ottieni l'`.exe`
come artefatto.

## Permessi su macOS

Al primo avvio macOS chiede due autorizzazioni, entrambe come popup automatico:

1. **Microfono** — per la tua voce.
2. **Registrazione schermo e audio di sistema** — per la voce dell'interlocutore.

La seconda sorprende, ma è corretta: macOS classifica la cattura dell'audio di
sistema sotto ScreenCaptureKit. NoteBro **non salva nulla dello schermo**, chiede a
ScreenCaptureKit la superficie video minima consentita (2×2 pixel) e scarta ogni
fotogramma; tiene solo l'audio.

Questo permesso richiede il **riavvio dell'app** dopo la concessione. In
*Impostazioni* ci sono i pulsanti che aprono direttamente il pannello giusto e un
**Testa audio di sistema** per verificare che funzioni.

In sviluppo l'app da autorizzare si chiama `Electron`; dopo la build è `NoteBro`.

## Firma su macOS

`npm run cert:mac` crea un certificato auto-firmato `NoteBro Local Signing` nel
portachiavi "login", e la build lo usa per firmare l'app. Non serve a dimostrare
niente a nessuno: serve a dare all'app un'**identità stabile**.

Senza, macOS lega il permesso di registrazione schermo all'impronta esatta di una
singola build:

```
designated => cdhash H"afa4da0b…"           # ad-hoc: cambia a ogni ricompilazione
designated => identifier "it.beatdata.notebro" and certificate leaf = H"70800b72…"
```

Con la firma ad-hoc, ogni ricompilazione fa sembrare NoteBro un'app diversa e
l'autorizzazione concessa smette silenziosamente di valere — l'interruttore resta
acceso nelle impostazioni ma non si applica più. Col certificato il requisito è
ancorato al certificato e sopravvive ad aggiornamenti e ricompilazioni.

La prima firma richiede una volta sola la password del Mac, per autorizzare
`codesign` a usare la chiave:

```bash
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -l "NoteBro Local Signing" ~/Library/Keychains/login.keychain-db
```

Il certificato è locale e si può eliminare da Accesso Portachiavi in qualunque
momento (poi ricompila).

> **Cuffie o altoparlanti?** Con le cuffie le due voci restano perfettamente
> separate. Con gli altoparlanti il microfono può captare anche l'interlocutore e
> qualche frase risulta doppia: la cancellazione dell'eco riduce il problema ma non
> lo elimina sempre.

## Appunti in presa diretta

Durante la registrazione c'è un blocco note: scrivi liberamente mentre si parla, anche
solo due parole o un nome. Il riassunto non li ignora e non si limita a ricopiarli —
parte da lì, espande ogni punto accennato con quello che è stato effettivamente detto,
e corregge ciò che la conversazione smentisce. Gli appunti valgono come fonte quanto la
trascrizione: un impegno che hai scritto tu ma che nessuno ha pronunciato finisce
comunque nel verbale.

Restano anche salvati in chiaro accanto al riassunto, per rileggere cosa avevi
annotato.

## Trascrizione in diretta (sperimentale, opzionale)

Spenta di default: la trascrizione avviene a fine call. Da *Impostazioni → Trascrizione in
diretta* si può attivare la visualizzazione delle battute mentre si parla, con qualche
secondo di ritardo.

- NoteBro avvia `whisper-server` (parte della stessa build di `whisper-cli`) a inizio
  registrazione e lo chiude alla fine; il modello resta caricato per tutta la call.
- Ogni canale viene tagliato sulle pause (al massimo ogni 10 s) e inviato al server un
  pezzo alla volta; i pezzi silenziosi non vengono inviati.
- **Può pesare sulle prestazioni durante la riunione**: whisper gira insieme all'app della
  videochiamata. Senza GPU conviene un modello piccolo, scelto a parte in *Modello per la
  diretta*. Se il computer non sta al passo, la schermata lo segnala.
- *Riusa la diretta a fine call* salta la trascrizione finale e va subito al riassunto: più
  veloce, ma meno precisa. Se la diretta si è interrotta o è vuota, la call viene
  ritrascritta per intero.

## Template per tipo di conversazione

Un colloquio, una formazione e una call commerciale non vogliono le stesse sezioni. Il
template si sceglie prima di registrare e decide la struttura del verbale:

| Template | Sezioni caratteristiche |
| --- | --- |
| Riunione | Decisioni, Azioni da fare, Domande aperte |
| Formazione o demo | Procedure passo per passo, Da ricordare |
| Colloquio | Percorso ed esperienza, Motivazione, Condizioni discusse |
| Uno a uno | Ostacoli, Feedback scambiato, Impegni presi |
| Call commerciale | Esigenze emerse, Obiezioni, Condizioni discusse |

Si aggiungono in `src/shared/templates.ts`: un id, un'etichetta e l'elenco delle
sezioni con una riga di istruzioni ciascuna.

## Chi sei, e chi sono gli altri

In *Impostazioni → Chi sei* puoi indicare il tuo nome. Serve a due cose: il riassunto
capisce che quando il tuo interlocutore ti chiama per nome sta parlando con te, e
intesta a te le azioni da fare invece di scrivere "responsabile: me" — inutile in un
documento da condividere. Il campo *Termini ricorrenti* elenca nomi di colleghi,
clienti o sigle: la trascrizione tende a rendere i nomi propri con la parola comune più
vicina, ed elencarli qui la indirizza.

In *Impostazioni → Riconoscimento degli interlocutori* si scaricano i due modelli
(74 MB) che separano le voci sul canale remoto. La tua voce arriva già dal microfono ed
è sempre distinta: la diarizzazione serve solo per le persone collegate.

Come funziona: un modello segmenta i turni, un secondo confronta il timbro delle voci e
le raggruppa. Il raggruppamento sa dire "questi turni sono della stessa persona", mai
chi sia: i nomi li dai tu, e ogni voce è mostrata con la prima frase che ha detto,
cliccabile per riascoltarla.

Il numero di partecipanti va **dichiarato** prima di registrare. Il rilevamento
automatico è stato tolto: su audio di call reale inventava interlocutori — su una
conversazione con una sola persona ne ha contate 38. Con il numero dichiarato il
raggruppamento è stabile; con "1 persona" la diarizzazione non gira affatto. La
funzione resta sperimentale: è verificata su voci sintetiche e su call a un solo
interlocutore, non ancora su riunioni reali a più voci.

Costa qualche secondo di elaborazione per minuto registrato, e gira in un processo
separato: l'inferenza è sincrona e bloccherebbe la finestra per minuti su una call
lunga.

## Come funziona

```
microfono ──► getUserMedia ──► AudioWorklet ─┐
                                              ├─► PCM 16 kHz mono ─► me.wav   ─► whisper ─┐
audio di sistema                              │                                            ├─► dialogo ─► Ollama ─► riassunto
  macOS:   helper ScreenCaptureKit ───────────┤                                            │
  Windows: getDisplayMedia (loopback) ────────┤
  Linux:   parec sul monitor dell'uscita ─────┘   ...                     ─► them.wav ─► whisper ─┘
```

Dettagli che contano:

- **Un solo formato.** L'`AudioWorklet` e l'helper nativo producono entrambi PCM
  16 bit mono a 16 kHz, che è esattamente ciò che whisper.cpp vuole in ingresso:
  niente ffmpeg, niente transcodifica.
- **Allineamento dei canali.** Ogni canale viene riempito in testa con il silenzio
  pari al suo ritardo di avvio, così entrambi condividono lo stesso `t = 0`.
- **Riposizionamento dei turni.** whisper.cpp riporta i confini dei segmenti, non
  l'inizio del parlato: su un canale rimasto zitto mentre parlava l'altro, un
  segmento comincia dove finiva il precedente. Ordinando su quegli offset il dialogo
  risulta invertito. NoteBro aggancia ogni segmento al **profilo di energia** (un
  valore RMS ogni 100 ms) registrato insieme all'audio, prendendo la sequenza di
  parlato più lunga del segmento. Lo stesso profilo scarta le frasi che whisper
  inventa sul silenzio.
- **Riassunti lunghi.** Se la trascrizione non entra nella finestra di contesto del
  modello, viene divisa sui confini dei turni, riassunta a blocchi e infine
  sintetizzata (map-reduce).
- **Riascolto.** I due canali vengono sommati in un unico file, servito al player da
  uno schema dedicato (`notebro-audio://`) che gestisce le richieste di intervallo:
  saltare al minuto 42 non scarica i 41 precedenti.
- **Spazio.** Il PCM a 16 kHz che serve a whisper costa 1,8 MB al minuto: un paio
  d'ore di call a settimana fanno circa 12 GB l'anno. Archiviata la nota, la
  registrazione viene ricodificata in Opus a 24 kbps dentro un contenitore WebM —
  misurato, un nono dello spazio senza perdita udibile sul parlato — e il WAV viene
  eliminato. In *Impostazioni → Spazio su disco* si vede l'occupazione e si
  comprimono le registrazioni più vecchie.

## Dove finiscono i dati

Tutto sotto `~/Library/Application Support/NoteBro` (su Windows
`%APPDATA%\NoteBro`, su Linux `~/.config/NoteBro`):

```
library.json          indice di cartelle e riassunti
settings.json         preferenze
models/               modelli whisper scaricati
notes/<titolo>/       summary.md, transcript.json, audio.webm (mix riascoltabile)
sessions/<id>/        audio temporaneo, cancellato al salvataggio
logs/notebro.log      diagnostica di cattura, permessi e trascrizione
```

I riassunti sono normali file Markdown: puoi leggerli e modificarli anche fuori
dall'app. *Mostra nel Finder* (*Mostra nella cartella* su Windows e Linux) apre la
cartella della nota.

Da *Impostazioni → Dove salvare le note* si sceglie una cartella diversa per le note
(per esempio una sincronizzata) e come chiamare la cartella di ogni nota: con il titolo
così com'è (`Riunione con Marco budget 2027`) o in snake_case
(`riunione_con_marco_budget_2027`). Le impostazioni valgono per le nuove note; *Sposta
e rinomina le note esistenti* le applica a quelle già salvate. Rinominando una nota, la
sua cartella segue il titolo. L'indice (`library.json`), le impostazioni e i modelli
restano nella cartella dell'app.

## Test

```bash
npm test               # scrittura WAV, riposizionamento dei turni, fusione (nessun prerequisito)
npm run test:integration   # + whisper.cpp e Ollama reali, su parlato sintetico italiano
```

Il test di integrazione genera un finto colloquio con la sintesi vocale di macOS su
due canali allineati, lo fa passare per l'intera pipeline e verifica che i turni
finiscano nell'ordine giusto e che il riassunto contenga i fatti citati. Si salta da
solo se manca un prerequisito.

## Struttura

```
native/macos/SystemAudioCapture.swift   helper ScreenCaptureKit -> PCM su stdout
src/main/wav.ts                         scrittura WAV + profilo di energia
src/main/transcript.ts                  parsing whisper, riposizionamento, dialogo
src/main/recorder.ts                    sessione di registrazione, allineamento canali
src/main/whisper.ts                     rilevamento binario, modelli, esecuzione
src/main/ollama.ts                      stato, download modelli, riassunto, titolo
src/main/pipeline.ts                    orchestrazione con avanzamento
src/main/mixdown.ts                     somma dei canali in un file riascoltabile
src/main/audio-protocol.ts              notebro-audio:// con supporto Range
src/main/range.ts                       parsing delle richieste di intervallo
src/main/diarization.ts                 modelli e orchestrazione del riconoscimento
src/main/workers/diarize.ts             inferenza in un utilityProcess separato
src/shared/speakers.ts                  come viene etichettato ogni turno
src/renderer/src/audio/capture.ts       microfono + loopback -> PCM via AudioWorklet
```

## Problemi frequenti

**"Nessun parlato riconosciuto"** — durante la registrazione le barre di livello
devono muoversi. Se quella dell'interlocutore resta ferma, manca il permesso di
registrazione schermo (macOS) o la sorgente audio non sta suonando.

**Il riassunto è in inglese** — seleziona la lingua della call prima di avviare,
invece di lasciare il rilevamento automatico.

**Trascrizione imprecisa** — passa da `small` a `medium` o `large-v3-turbo` in
Impostazioni. Su Apple Silicon `large-v3-turbo` resta più veloce del tempo reale.

**Le voci vengono confuse o moltiplicate** — controlla di aver dichiarato il numero
esatto di partecipanti. Voci dello stesso registro, audio molto compresso e
sovrapposizioni sono i casi in cui il raggruppamento sbaglia più spesso; nel dubbio,
lascia la diarizzazione spenta.

**Ollama non risponde** — in Impostazioni c'è il pulsante *Avvia Ollama*, che lancia
`ollama serve`.

**L'audio di sistema resta muto** — il log in `logs/notebro.log` riporta la risposta
esatta di macOS. Se dice che il permesso è negato mentre nelle impostazioni risulta
concesso, l'autorizzazione appartiene a un'altra copia dell'app: rimuovi tutte le voci
NoteBro dall'elenco e aggiungi `/Applications/NoteBro.app`. Firmando col certificato il
problema non si ripresenta.

**Autodiagnosi** — `touch "$HOME/Library/Application Support/NoteBro/selftest"` e riavvia
l'app: esegue da sola una prova di cattura e scrive l'esito nel log.
