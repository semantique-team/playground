import type { DecisionResponse } from './api'

export type RunState =
  | { status: 'idle' }
  | { status: 'running'; n: number }
  | { status: 'error'; message: string }
  | { status: 'done'; response: DecisionResponse; expected: string | null }

const fixed = (value: number | null) => (value == null ? '—' : value.toFixed(3))

export function Result({ run }: { run: RunState }) {
  if (run.status === 'idle') {
    return (
      <div className="result-empty">
        <span className="empty-mark" aria-hidden="true">
          [ · ]
        </span>
        <h2>The decision appears here.</h2>
        <p>Pick a use case, or write your own state, question and candidates.</p>
      </div>
    )
  }
  if (run.status === 'running') return <p className="run-meta">scoring {run.n} candidates…</p>
  if (run.status === 'error') {
    return (
      <div className="error-box" role="alert">
        {run.message}
      </div>
    )
  }

  const { result, latency_ms } = run.response
  const entries = Object.entries(result.probabilities)
  const max = Math.max(...entries.map(([, p]) => p))
  return (
    <>
      <div className="bars">
        {entries.map(([label, p]) => (
          <div key={label} className={`bar-row${p === max ? ' winner' : ''}`}>
            <div>
              <div className="bar-label">
                <span>{label}</span>
                <span className="bar-value">{(p * 100).toFixed(1)}%</span>
              </div>
              <div className="bar-track">
                <div className="bar-fill" style={{ width: `${p * 100}%` }} />
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="verdict">
        <span className="word">{result.choice}</span>
        <span className={`action-badge ${result.action}`}>{result.action.toUpperCase()}</span>
      </div>
      {run.expected !== null && (
        <p className={`expected ${run.expected === result.choice ? 'match' : 'miss'}`}>
          {run.expected === result.choice
            ? 'Matches the labelled answer'
            : `Labelled answer: ${run.expected}`}
        </p>
      )}
      <div className="confidence-grid">
        <div><div className="k">confidence</div><div className="v">{fixed(result.confidence)}</div></div>
        <div><div className="k">margin</div><div className="v">{fixed(result.margin)}</div></div>
        <div><div className="k">entropy</div><div className="v">{fixed(result.entropy)}</div></div>
        <div><div className="k">norm. entropy</div><div className="v">{fixed(result.normalized_entropy)}</div></div>
      </div>
      <p className="latency">
        {latency_ms.toFixed(1)} ms · {result.n_candidates} candidates scored
      </p>
    </>
  )
}
