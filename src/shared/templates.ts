export interface SummaryTemplate {
  id: string
  label: string
  /** One line explaining when to pick it. */
  hint: string
  /** Section headings, in the order the summary should follow. */
  outline: Array<{ heading: string; guidance: string }>
}

/**
 * A verbale, an interview and a training session do not want the same
 * sections. The outline is what actually shapes the model's answer, so each
 * kind of meeting gets its own.
 */
export const TEMPLATES: SummaryTemplate[] = [
  {
    id: 'riunione',
    label: 'Riunione',
    hint: 'Verbale generico, adatto alla maggior parte delle call di lavoro.',
    outline: [
      { heading: 'Sintesi', guidance: 'Da tre a cinque frasi su di cosa si è parlato e come è finita.' },
      { heading: 'Punti chiave', guidance: 'I temi affrontati, con il dettaglio che conta.' },
      { heading: 'Decisioni', guidance: 'Cosa è stato deciso o concordato.' },
      { heading: 'Azioni da fare', guidance: 'Elenco con responsabile e scadenza quando emergono.' },
      { heading: 'Domande aperte', guidance: 'Questioni rimaste in sospeso.' },
      { heading: 'Dettagli rilevanti', guidance: 'Numeri, nomi, strumenti, riferimenti citati.' }
    ]
  },
  {
    id: 'formazione',
    label: 'Formazione o demo',
    hint: 'Qualcuno spiega uno strumento o una procedura: privilegia i passaggi operativi.',
    outline: [
      { heading: 'Sintesi', guidance: 'Cosa è stato insegnato o mostrato, in poche frasi.' },
      { heading: 'Argomenti trattati', guidance: 'Gli argomenti in ordine, con le nozioni che servono.' },
      {
        heading: 'Procedure passo per passo',
        guidance:
          "Le sequenze operative mostrate, nell'ordine esatto in cui vanno eseguite."
      },
      { heading: 'Da ricordare', guidance: 'Avvertenze, scorciatoie, errori da evitare citati durante la spiegazione.' },
      { heading: 'Domande rimaste aperte', guidance: 'Dubbi sollevati e non risolti.' },
      { heading: 'Azioni da fare', guidance: 'Cosa provare o configurare dopo, con il responsabile.' }
    ]
  },
  {
    id: 'colloquio',
    label: 'Colloquio',
    hint: 'Selezione di un candidato: esperienza, motivazione, condizioni.',
    outline: [
      { heading: 'Sintesi', guidance: 'Impressione complessiva e come si è concluso il colloquio.' },
      { heading: 'Percorso ed esperienza', guidance: 'Cosa ha fatto finora il candidato, nelle sue parole.' },
      { heading: 'Competenze emerse', guidance: 'Capacità dimostrate o dichiarate, con gli esempi portati.' },
      { heading: 'Motivazione e aspettative', guidance: 'Perché è interessato e cosa cerca.' },
      { heading: 'Condizioni discusse', guidance: 'Inquadramento, compenso, disponibilità, sede.' },
      { heading: 'Punti di attenzione', guidance: 'Perplessità o aspetti da verificare, senza inventarne.' },
      { heading: 'Prossimi passi', guidance: 'Cosa è stato concordato, con scadenza e responsabile.' }
    ]
  },
  {
    id: 'uno-a-uno',
    label: 'Uno a uno',
    hint: 'Allineamento con una persona del team.',
    outline: [
      { heading: 'Sintesi', guidance: 'Il senso generale della conversazione.' },
      { heading: 'Come sta andando', guidance: 'Stato del lavoro e del morale, per come è emerso.' },
      { heading: 'Ostacoli', guidance: 'Cosa sta rallentando o bloccando.' },
      { heading: 'Feedback scambiato', guidance: 'Riscontri dati e ricevuti.' },
      { heading: 'Impegni presi', guidance: 'Chi fa cosa, entro quando.' },
      { heading: 'Da riprendere la prossima volta', guidance: 'Temi rimandati.' }
    ]
  },
  {
    id: 'commerciale',
    label: 'Call commerciale',
    hint: 'Conversazione con un cliente o un prospect.',
    outline: [
      { heading: 'Sintesi', guidance: 'Chi è il cliente, cosa cerca, a che punto siamo.' },
      { heading: 'Esigenze emerse', guidance: 'I problemi che il cliente vuole risolvere, nelle sue parole.' },
      { heading: 'Obiezioni e dubbi', guidance: 'Resistenze sollevate e come sono state affrontate.' },
      { heading: 'Soluzione proposta', guidance: 'Cosa è stato presentato e come è stato accolto.' },
      { heading: 'Condizioni discusse', guidance: 'Prezzi, tempi, vincoli contrattuali citati.' },
      { heading: 'Prossimi passi', guidance: 'Impegni presi dalle due parti, con scadenza.' }
    ]
  }
]

export const DEFAULT_TEMPLATE = 'riunione'

export function templateById(id: string): SummaryTemplate {
  return TEMPLATES.find((template) => template.id === id) ?? TEMPLATES[0]
}

/** The outline as the model receives it. */
export function renderOutline(template: SummaryTemplate): string {
  return template.outline
    .map((section) => `## ${section.heading}\n${section.guidance}`)
    .join('\n\n')
}
