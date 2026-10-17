import { useMemo, useState, type FormEvent } from 'react'
import type { DecisionExample } from './api'

export interface FormValues {
  state: string
  question: string
  candidates: string[]
}

interface Props {
  values: FormValues
  onChange: (values: FormValues) => void
  examples: DecisionExample[]
  onPickExample: (example: DecisionExample) => void
  busy: boolean
  disabled: boolean
  onSubmit: () => void
}

const titleCase = (tag: string) => {
  const words = tag.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function DecisionForm({
  values,
  onChange,
  examples,
  onPickExample,
  busy,
  disabled,
  onSubmit,
}: Props) {
  // one chip per use case; each click moves to that use case's next example
  const useCases = useMemo(() => {
    const groups = new Map<string, DecisionExample[]>()
    for (const example of examples) {
      const tag = example.use_case ?? 'examples'
      groups.set(tag, [...(groups.get(tag) ?? []), example])
    }
    return [...groups]
  }, [examples])
  const [cursor, setCursor] = useState<Record<string, number>>({})
  const [activeTag, setActiveTag] = useState<string | null>(null)

  function pick(tag: string, group: DecisionExample[]) {
    const index = ((cursor[tag] ?? -1) + 1) % group.length
    setCursor({ ...cursor, [tag]: index })
    setActiveTag(tag)
    onPickExample(group[index])
  }

  function edit(next: Partial<FormValues>) {
    setActiveTag(null)
    onChange({ ...values, ...next })
  }

  function setCandidate(index: number, text: string) {
    edit({ candidates: values.candidates.map((c, i) => (i === index ? text : c)) })
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    onSubmit()
  }

  return (
    <form className="panel" onSubmit={submit} aria-label="Decision inputs">
      <div className="panel-heading">
        <span className="eyebrow">INPUT</span>
      </div>

      {useCases.length > 0 && (
        <div className="examples" role="group" aria-label="Try a use case">
          <span className="eyebrow">TRY A USE CASE</span>
          {useCases.map(([tag, group]) => (
            <button
              key={tag}
              type="button"
              className="chip"
              aria-pressed={activeTag === tag}
              onClick={() => pick(tag, group)}
              title={`${group.length} real example${group.length === 1 ? '' : 's'}`}
            >
              {titleCase(tag)}
            </button>
          ))}
        </div>
      )}

      <div className="field">
        <div className="label-row">
          <label htmlFor="state">State</label>
          <span className="micro">{values.state.length.toLocaleString('en-US')} / 8,000</span>
        </div>
        <textarea
          id="state"
          maxLength={8000}
          rows={4}
          value={values.state}
          onChange={(event) => edit({ state: event.target.value })}
          placeholder="The situation to read: a message, a record, a report…"
        />
      </div>

      <div className="field">
        <div className="label-row">
          <label htmlFor="question">Question</label>
        </div>
        <input
          type="text"
          id="question"
          maxLength={2000}
          value={values.question}
          onChange={(event) => edit({ question: event.target.value })}
          placeholder="The decision to make"
        />
      </div>

      <div className="field">
        <div className="label-row">
          <span className="eyebrow" style={{ margin: 0 }}>CANDIDATES</span>
          <span className="micro">{values.candidates.length} rows</span>
        </div>
        <div className="choice-grid">
          {values.candidates.map((candidate, index) => (
            <div className="choice-row" key={index}>
              <span className="index">{String(index + 1).padStart(2, '0')}</span>
              <input
                type="text"
                className="candidate"
                maxLength={120}
                value={candidate}
                onChange={(event) => setCandidate(index, event.target.value)}
                aria-label={`Candidate ${index + 1}`}
              />
              <button
                type="button"
                className="remove"
                disabled={values.candidates.length <= 2}
                onClick={() => edit({ candidates: values.candidates.filter((_, i) => i !== index) })}
                aria-label={`Remove candidate ${index + 1}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="text-button"
          onClick={() => edit({ candidates: [...values.candidates, ''] })}
        >
          + Add candidate
        </button>
      </div>

      <button className="run-button" type="submit" disabled={busy || disabled}>
        Run<span aria-hidden="true">↗</span>
      </button>
      {disabled && <p className="run-meta">Add a server and select a model to run.</p>}
    </form>
  )
}
