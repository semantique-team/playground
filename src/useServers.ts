import { useCallback, useEffect, useState } from 'react'
import { listModels, type ModelCard } from './api'
import type { Server } from './storage'

export type ServerState =
  | { status: 'loading' }
  | { status: 'online'; models: ModelCard[] }
  | { status: 'offline'; error: string }

/** Live model lists for every saved server; one failing server never hides the others. */
export function useServers(servers: Server[]) {
  const [states, setStates] = useState<Record<string, ServerState>>({})

  const refresh = useCallback(async (server: Server) => {
    setStates((prev) => ({ ...prev, [server.id]: prev[server.id] ?? { status: 'loading' } }))
    try {
      const models = await listModels(server.url)
      setStates((prev) => ({ ...prev, [server.id]: { status: 'online', models } }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setStates((prev) => ({ ...prev, [server.id]: { status: 'offline', error: message } }))
    }
  }, [])

  useEffect(() => {
    for (const server of servers) {
      if (!states[server.id]) void refresh(server)
    }
  }, [servers, states, refresh])

  return { states, refresh }
}
