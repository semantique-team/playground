import { useState, type FormEvent } from 'react'
import type { Server } from './storage'
import type { ServerState } from './useServers'

interface Props {
  servers: Server[]
  states: Record<string, ServerState>
  /** Resolves to an error message, or null once the server was verified and saved. */
  onAdd: (url: string) => Promise<string | null>
  onRemove: (id: string) => void
  onRetry: (server: Server) => void
}

export function ServerPanel({ servers, states, onAdd, onRemove, onRetry }: Props) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!url.trim()) return
    setBusy(true)
    const failure = await onAdd(url)
    setBusy(false)
    setError(failure)
    if (!failure) setUrl('')
  }

  return (
    <section className="panel servers" aria-label="Model servers">
      <div className="panel-heading">
        <span className="eyebrow">SERVERS</span>
        <span className="micro">saved in this browser</span>
      </div>

      <ul className="server-list">
        {servers.map((server) => {
          const state = states[server.id] ?? { status: 'loading' as const }
          return (
            <li key={server.id} className="server-row">
              <span className={`dot ${state.status}`} aria-hidden="true" />
              <span className="server-url">{server.url}</span>
              <span className="micro">
                {state.status === 'online'
                  ? `${state.models.length} model${state.models.length === 1 ? '' : 's'}`
                  : state.status === 'loading'
                    ? 'connecting…'
                    : 'offline'}
              </span>
              {state.status === 'offline' && (
                <button type="button" className="text-button" onClick={() => onRetry(server)}>
                  Retry
                </button>
              )}
              <button
                type="button"
                className="remove"
                onClick={() => onRemove(server.id)}
                aria-label={`Remove ${server.url}`}
              >
                ×
              </button>
              {state.status === 'offline' && <p className="server-error">{state.error}</p>}
            </li>
          )
        })}
      </ul>

      <form className="server-add" onSubmit={submit}>
        <input
          type="text"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="http://localhost:8000"
          aria-label="Server URL"
          spellCheck={false}
        />
        <button type="submit" className="chip" disabled={busy || !url.trim()}>
          {busy ? 'Checking…' : 'Add server'}
        </button>
      </form>
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
