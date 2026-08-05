import { useEffect, useState } from 'react'

type Props = {
  title: string
  detail: string
  delayMs?: number
}

export default function LoadingOverlay({ title, detail, delayMs = 120 }: Props) {
  const [visible, setVisible] = useState(delayMs === 0)

  useEffect(() => {
    if (delayMs === 0) {
      setVisible(true)
      return
    }
    const timer = window.setTimeout(() => setVisible(true), delayMs)
    return () => window.clearTimeout(timer)
  }, [delayMs])

  if (!visible) return null

  return <div className="loading-overlay" role="status" aria-live="polite" aria-label={title} data-testid="loading-overlay">
    <div className="loading-card">
      <div className="loading-card-brand">
        <span>NYC</span>
        <img src="/pigeon.png" alt="" />
      </div>
      <div className="loading-curbs" aria-hidden="true">
        <i className="cannot-park" />
        <i className="paid" />
        <i className="free" />
      </div>
      <strong>{title}</strong>
      <p>{detail}</p>
      <div className="loading-progress" aria-hidden="true"><span /></div>
      <small>Validating the complete parking interval</small>
    </div>
  </div>
}
