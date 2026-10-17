import { useEffect, useState } from 'react'

export interface Server {
  id: string
  url: string
}

export interface Selection {
  serverId: string
  model: string
}

interface Stored {
  servers: Server[]
  selection: Selection | null
}

const KEY = 'playground:v1'
const EMPTY: Stored = { servers: [], selection: null }

function read(): Stored {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? { ...EMPTY, ...(JSON.parse(raw) as Partial<Stored>) } : EMPTY
  } catch {
    return EMPTY // corrupt or unavailable storage: start clean rather than crash
  }
}

/** Saved servers and the last selected model, persisted in localStorage. */
export function useStored() {
  const [stored, setStored] = useState<Stored>(read)
  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(stored))
  }, [stored])
  return [stored, setStored] as const
}
