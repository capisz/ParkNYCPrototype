import { lazy, Suspense, useEffect, useState } from 'react'
import './App.css'
import LoadingOverlay from './components/LoadingOverlay'
import ParkingPlanner from './components/ParkingPlanner'
import type { ParkingPlan } from './types'

const loadParkingMapScreen = () => import('./components/ParkingMapScreen')
const ParkingMapScreen = lazy(loadParkingMapScreen)

type Stage = 'planner' | 'map'

export default function App() {
  const [stage, setStage] = useState<Stage>('planner')
  const [plan, setPlan] = useState<ParkingPlan | null>(null)
  const [isOnline, setIsOnline] = useState(navigator.onLine)

  useEffect(() => {
    const online = () => setIsOnline(true)
    const offline = () => setIsOnline(false)
    window.addEventListener('online', online)
    window.addEventListener('offline', offline)
    return () => {
      window.removeEventListener('online', online)
      window.removeEventListener('offline', offline)
    }
  }, [])

  if (stage === 'planner' || !plan) return <ParkingPlanner
    initialPlan={plan}
    isOnline={isOnline}
    onMapIntent={() => { void loadParkingMapScreen() }}
    onPlan={nextPlan => {
      setPlan(nextPlan)
      setStage('map')
    }}
  />

  return <Suspense fallback={<main className="map-loading" aria-busy="true">
    <LoadingOverlay
      title="Opening your parking map"
      detail="Preparing the map and the parking evidence for your selected destination."
      delayMs={0}
    />
  </main>}>
    <ParkingMapScreen plan={plan} onChangePlan={() => setStage('planner')} />
  </Suspense>
}
