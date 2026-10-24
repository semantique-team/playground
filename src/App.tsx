import { useEffect, useMemo, useState } from 'react'
import {
  decide,
  decideTyped,
  listExamples,
  listModels,
  normalizeUrl,
  type DecisionExample,
  type ModelCard,
} from './api'
import { DecisionForm, type FormValues } from './DecisionForm'
import { ModelSelect } from './ModelSelect'
import { Result, type RunState } from './Result'
import { ServerPanel } from './ServerPanel'
import { useStored, type Selection } from './storage'
import { useServers } from './useServers'

const EMPTY_FORM: FormValues = {
  kind: 'choice',
  state: '',
  question: '',
  candidates: ['', ''],
  criteria: { true: '', false: '' },
}

export default function App() {
  const [stored, setStored] = useStored()
  const { servers, selection: savedSelection } = stored
  const { states, refresh } = useServers(servers)

  // the saved selection if it still exists, otherwise the first available model
  const { current, card } = useMemo(() => {
    const cards = (serverId: string): ModelCard[] => {
      const state = states[serverId]
      return state?.status === 'online' ? state.models : []
    }
    const find = (s: Selection | null) =>
      s && cards(s.serverId).find((m) => m.name === s.model) ? s : null
    const fallback = servers
      .flatMap((s) => cards(s.id).map((m): Selection => ({ serverId: s.id, model: m.name })))
      .at(0)
    const picked = find(savedSelection) ?? fallback ?? null
    return {
      current: picked,
      card: picked ? cards(picked.serverId).find((m) => m.name === picked.model) ?? null : null,
    }
  }, [servers, states, savedSelection])

  const currentServer = servers.find((s) => s.id === current?.serverId) ?? null

  const [form, setForm] = useState<FormValues>(EMPTY_FORM)
  const [examples, setExamples] = useState<DecisionExample[]>([])
  const [expected, setExpected] = useState<string | null>(null)
  const [run, setRun] = useState<RunState>({ status: 'idle' })

  // each model ships its own real examples; reload when the selection changes
  const exampleKey = current ? `${currentServer?.url}|${current.model}` : null
  useEffect(() => {
    setExamples([])
    setExpected(null)
    setRun({ status: 'idle' })
    if (!currentServer || !current) return
    let stale = false
    listExamples(currentServer.url, current.model)
      .then((rows) => !stale && setExamples(rows))
      .catch(() => !stale && setExamples([]))
    return () => {
      stale = true
    }
    // keyed on the identity of the selected model, not on object references
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exampleKey])

  async function addServer(input: string): Promise<string | null> {
    const url = normalizeUrl(input)
    if (servers.some((s) => s.url === url)) return 'That server is already saved.'
    try {
      const models = await listModels(url) // only verified servers are saved
      if (models.length === 0) return 'The server is reachable but serves no models.'
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    setStored((prev) => ({ ...prev, servers: [...prev.servers, { id: crypto.randomUUID(), url }] }))
    return null
  }

  function removeServer(id: string) {
    setStored((prev) => ({
      servers: prev.servers.filter((s) => s.id !== id),
      selection: prev.selection?.serverId === id ? null : prev.selection,
    }))
  }

  function pickExample(example: DecisionExample) {
    setForm({
      kind: 'choice',
      state: example.state,
      question: example.question,
      candidates: example.candidates,
      criteria: { true: '', false: '' },
    })
    setExpected(example.correct)
    setRun({ status: 'idle' })
  }

  async function submit() {
    if (!currentServer || !current) return
    if (!form.state.trim() || !form.question.trim()) {
      setRun({ status: 'error', message: 'Fill in both the state and the question before running.' })
      return
    }
    if (form.kind === 'noul') {
      setRun({ status: 'running', n: 2 })
      try {
        const criteria: Record<string, string> = {}
        if (form.criteria.true.trim()) criteria.true = form.criteria.true.trim()
        if (form.criteria.false.trim()) criteria.false = form.criteria.false.trim()
        const response = await decideTyped(currentServer.url, {
          state: form.state,
          questions: {
            question: {
              type: 'noul',
              instructions: form.question,
              ...(Object.keys(criteria).length > 0 ? { criteria } : {}),
            },
          },
          model: current.model,
        })
        setRun({ status: 'done-typed', latencyMs: response.latency_ms, answer: response.answers.question })
        void refresh(currentServer)
      } catch (error) {
        setRun({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    const candidates = form.candidates.map((c) => c.trim()).filter(Boolean)
    if (candidates.length < 2) {
      setRun({
        status: 'error',
        message:
          form.kind === 'score'
            ? 'A score needs at least two non-empty levels.'
            : 'At least two non-empty candidates are required.',
      })
      return
    }
    if (form.kind === 'score' && candidates.length > 10) {
      setRun({ status: 'error', message: 'A score accepts at most 10 levels.' })
      return
    }
    if (form.kind === 'score') {
      setRun({ status: 'running', n: candidates.length })
      try {
        const response = await decideTyped(currentServer.url, {
          state: form.state,
          questions: {
            question: { type: 'score', instructions: form.question, criteria: candidates },
          },
          model: current.model,
        })
        setRun({ status: 'done-typed', latencyMs: response.latency_ms, answer: response.answers.question })
        void refresh(currentServer)
      } catch (error) {
        setRun({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    setRun({ status: 'running', n: candidates.length })
    try {
      const response = await decide(currentServer.url, {
        state: form.state,
        question: form.question,
        candidates,
        model: current.model,
      })
      // the label only applies while the inputs are still the loaded example
      const stillExample = expected !== null && candidates.includes(expected)
      setRun({ status: 'done', response, expected: stillExample ? expected : null })
      void refresh(currentServer) // the model is now resident: update its ready badge
    } catch (error) {
      setRun({ status: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  function onFormChange(next: FormValues) {
    setForm(next)
    setExpected(null)
  }

  return (
    <>
      <header className="site-header">
        <div className="page-shell site-header-inner" style={{ width: 'var(--shell)' }}>
          <a className="brand" href="/" aria-label="Semantique Playground home">
            <img src="/semantique.svg" alt="Semantique" />
            <span className="divider" aria-hidden="true" />
            <span className="product">Playground</span>
          </a>
          <nav aria-label="Model selection" className="model-nav">
            <ModelSelect
              options={servers.flatMap((server) => {
                const state = states[server.id]
                if (state?.status !== 'online') return []
                return state.models.map((m) => ({
                  value: `${server.id}::${m.name}`,
                  name: m.display_name || m.name,
                  url: server.url,
                  ready: m.loaded,
                }))
              })}
              value={current ? `${current.serverId}::${current.model}` : null}
              onChange={(value) => {
                const [serverId, model] = value.split('::')
                setStored((prev) => ({ ...prev, selection: { serverId, model } }))
              }}
            />
            {card && (
              <span className="header-meta">
                {card.scorer} · {card.calibratable ? 'calibrated' : 'uncalibrated'} · policy{' '}
                {card.escalation}
              </span>
            )}
          </nav>
        </div>
      </header>

      <main className="page-shell">
        <section className="hero">
          <p className="eyebrow">STRUCTURED DECISIONS, REAL PROBABILITIES</p>
          <h1>Semantique Playground</h1>
          <p>
            A state, a question, any number of candidates. Connect any model server, pick a
            model, and get the choice, calibrated probabilities and the execute/escalate verdict.
          </p>
        </section>

        <ServerPanel
          servers={servers}
          states={states}
          onAdd={addServer}
          onRemove={removeServer}
          onRetry={(server) => void refresh(server)}
        />

        {servers.length === 0 ? (
          <section className="panel onboarding" aria-label="Get started">
            <span className="eyebrow">GET STARTED</span>
            <p>Start a model server, then add its URL above:</p>
            <pre>python -m serve --runs runs/your-model</pre>
          </section>
        ) : (
          <section className="playground">
            <DecisionForm
              values={form}
              onChange={onFormChange}
              examples={examples}
              onPickExample={pickExample}
              busy={run.status === 'running'}
              disabled={!current}
              onSubmit={() => void submit()}
            />
            <section className="panel" aria-label="Result" aria-live="polite">
              <div className="panel-heading">
                <span className="eyebrow">OUTPUT</span>
                {card && <span className="model-label">{card.display_name}</span>}
              </div>
              <Result run={run} />
              <div className="result-footer">
                <span className="tiny-square" aria-hidden="true" /> Real model execution on the
                selected server, no simulated answers.
              </div>
            </section>
          </section>
        )}
      </main>
    </>
  )
}
