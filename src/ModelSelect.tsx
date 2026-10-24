import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'

export interface ModelOption {
  /** Selection key passed to onChange: `${serverId}::${modelName}`. */
  value: string
  /** Human model name. */
  name: string
  /** Base URL of the server that serves the model. */
  url: string
  /** True once the model is resident on its server. */
  ready: boolean
}

interface Props {
  options: ModelOption[]
  /** Selected option value, or null when there is no model to pick. */
  value: string | null
  onChange: (value: string) => void
}

function ModelLine({ option }: { option: ModelOption }) {
  return (
    <span className="model-line">
      <span className="model-line-name">
        {option.name}
        {option.ready && <span className="micro">ready</span>}
      </span>
      <span className="model-line-url">{option.url}</span>
    </span>
  )
}

export function ModelSelect({ options, value, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const listId = useId()

  const selected = options.find((option) => option.value === value) ?? null

  // close on an outside press; presses on the trigger are left to its onClick
  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  function pick(index: number) {
    const option = options[index]
    if (!option) return
    onChange(option.value)
    setOpen(false)
  }

  // focus stays on the trigger; it moves through the list via aria-activedescendant
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const last = options.length - 1
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        setActive(Math.max(0, options.findIndex((option) => option.value === value)))
        setOpen(true)
      }
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((index) => (index >= last ? 0 : index + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((index) => (index <= 0 ? last : index - 1))
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      pick(active)
    }
  }

  return (
    <div className="model-picker" ref={root} onKeyDown={onKeyDown}>
      <button
        type="button"
        role="combobox"
        className="model-select"
        aria-label="Model"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        disabled={!selected}
        onClick={() => {
          setActive(Math.max(0, options.findIndex((option) => option.value === value)))
          setOpen((wasOpen) => !wasOpen)
        }}
      >
        {selected ? <ModelLine option={selected} /> : 'No model available'}
        <svg className="caret" aria-hidden="true" viewBox="0 0 16 16" fill="none">
          <path
            d="m4 6 4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <ul
          className="model-menu"
          role="listbox"
          id={listId}
          aria-label="Model"
          onMouseDown={(event) => event.preventDefault()}
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={option.value === value}
              className={`model-option${index === active ? ' is-active' : ''}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(index)}
            >
              <ModelLine option={option} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
