import { useState } from 'react'
import {
  BASE_RATES,
  CONFIDENCE,
  OUTCOMES,
  points,
  quickPick,
  type Confidence,
  type Outcome,
  type Probs,
} from '../../src/scoring/scoring'
import type { Match, PickBody } from './api'
import { kickoffLabel, rebalance, shortName } from './pick'

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  lean: 'Lean',
  likely: 'Likely',
  confident: 'Confident',
  lock: 'Lock',
}

function outcomeName(o: Outcome, m: Match): string {
  return o === 'H' ? `${shortName(m.home)} win` : o === 'A' ? `${shortName(m.away)} win` : 'Draw'
}

interface Props {
  match: Match
  onSave: (body: PickBody) => Promise<void>
  onClose: () => void
}

export function PickSheet({ match, onSave, onClose }: Props) {
  const [mode, setMode] = useState<'quick' | 'exact'>(match.pick ? 'exact' : 'quick')
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [confidence, setConfidence] = useState<Confidence | null>(null)
  const [exact, setExact] = useState<Probs>(match.pick ?? { H: 34, D: 33, A: 33 })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const preview: Probs | null =
    mode === 'exact'
      ? exact
      : outcome && confidence
        ? quickPick(outcome, confidence, BASE_RATES[match.league])
        : null

  async function save() {
    if (!preview) return
    setSaving(true)
    setError(null)
    try {
      await onSave(mode === 'quick' && outcome && confidence ? { outcome, confidence } : { pick: exact })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSaving(false)
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sheet-head">
          <div>
            <h2 id="sheet-title">
              {shortName(match.home)} <span className="vs">v</span> {shortName(match.away)}
            </h2>
            <p className="muted">{kickoffLabel(match.kickoffAt, match.time !== null)}</p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="segmented" role="tablist" aria-label="Pick style">
          <button role="tab" aria-selected={mode === 'quick'} onClick={() => setMode('quick')}>
            Quick
          </button>
          <button role="tab" aria-selected={mode === 'exact'} onClick={() => setMode('exact')}>
            Exact %
          </button>
        </div>

        {mode === 'quick' ? (
          <>
            <p className="step">1. Who wins?</p>
            <div className="choice-row">
              {OUTCOMES.map((o) => (
                <button key={o} className="choice" aria-pressed={outcome === o} onClick={() => setOutcome(o)}>
                  {outcomeName(o, match)}
                </button>
              ))}
            </div>
            <p className="step">2. How sure?</p>
            <div className="choice-row four">
              {(Object.keys(CONFIDENCE) as Confidence[]).map((c) => (
                <button key={c} className="choice" aria-pressed={confidence === c} onClick={() => setConfidence(c)}>
                  <span>{CONFIDENCE_LABEL[c]}</span>
                  <small>{CONFIDENCE[c]}%</small>
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="sliders">
            {OUTCOMES.map((o) => (
              <label key={o} className="slider">
                <span className="slider-label">
                  {outcomeName(o, match)} <b>{exact[o]}%</b>
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={exact[o]}
                  aria-label={`${outcomeName(o, match)} percent`}
                  onChange={(e) => setExact((p) => rebalance(p, o, Number(e.target.value)))}
                />
              </label>
            ))}
          </div>
        )}

        {preview && (
          <div className="preview" aria-live="polite">
            <div className="bar" aria-hidden="true">
              {OUTCOMES.map((o) => (
                <span key={o} className={`bar-${o}`} style={{ flexGrow: preview[o] }} />
              ))}
            </div>
            <table className="if-table">
              <thead>
                <tr>
                  <th />
                  <th>Your %</th>
                  <th>Points if it happens</th>
                </tr>
              </thead>
              <tbody>
                {OUTCOMES.map((o) => (
                  <tr key={o}>
                    <td>{outcomeName(o, match)}</td>
                    <td>{preview[o]}%</td>
                    <td>{points(preview, o)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <button className="primary" disabled={!preview || saving} onClick={save}>
          {saving ? 'Saving…' : match.pick ? 'Update pick' : 'Save pick'}
        </button>
        <p className="fine">You can change it until kickoff.</p>
      </div>
    </div>
  )
}
