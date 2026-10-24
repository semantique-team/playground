/** The only place that talks to an ANT server. Every call takes the server's base URL. */

export interface ModelCard {
  name: string
  display_name: string
  description: string | null
  n_examples: number
  backbone_model: string
  scorer: string
  scoring_dim: number
  calibratable: boolean
  escalation: string
  loaded: boolean
}

export interface DecisionExample {
  state: string
  question: string
  candidates: string[]
  correct: string
  use_case?: string
}

export interface DecisionResult {
  choice: string
  action: 'execute' | 'escalate'
  probabilities: Record<string, number>
  confidence: number
  margin: number | null
  entropy: number | null
  normalized_entropy: number | null
  n_candidates: number
}

export interface DecisionResponse {
  result: DecisionResult
  model: string
  latency_ms: number
}

export interface DecisionBody {
  state: string
  question: string
  candidates: string[]
  model: string
}

/** System One style question kinds, answered by POST /api/typed. */
export type QuestionKind = 'choice' | 'noul' | 'score'

export interface TypedQuestion {
  type: QuestionKind
  instructions: string
  criteria?: Record<string, string> | string[]
}

export interface TypedAnswer {
  type: QuestionKind
  choice?: string
  noul?: number
  score?: number
  legend?: Record<string, string>
  probabilities: Record<string, number>
  confidence: number
  action: 'execute' | 'escalate'
}

export interface TypedResponse {
  answers: Record<string, TypedAnswer>
  model: string
  latency_ms: number
}

export interface TypedBody {
  state: string
  questions: Record<string, TypedQuestion>
  model: string
}

/** Accepts `localhost:8000`, `http://host:8000/` or `.../api`; returns the bare origin URL. */
export function normalizeUrl(input: string): string {
  let url = input.trim()
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`
  return url.replace(/\/+$/, '').replace(/\/api$/, '')
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch {
    throw new Error('Cannot reach the server. Is it running, and does the URL match?')
  }
  if (!response.ok) {
    const detail = await response
      .json()
      .then((body: { detail?: unknown }) => String(body.detail))
      .catch(() => response.statusText)
    throw new Error(`${response.status}: ${detail}`)
  }
  return response.json() as Promise<T>
}

export async function listModels(base: string): Promise<ModelCard[]> {
  return (await request<{ models: ModelCard[] }>(`${base}/api/models`)).models
}

export async function listExamples(base: string, model: string): Promise<DecisionExample[]> {
  const url = `${base}/api/examples?model=${encodeURIComponent(model)}`
  return (await request<{ examples: DecisionExample[] }>(url)).examples
}

export function decide(base: string, body: DecisionBody): Promise<DecisionResponse> {
  return request<DecisionResponse>(`${base}/api/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function decideTyped(base: string, body: TypedBody): Promise<TypedResponse> {
  return request<TypedResponse>(`${base}/api/typed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
