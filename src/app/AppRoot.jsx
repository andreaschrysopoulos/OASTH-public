import { Suspense, lazy } from 'react'

const App = lazy(() => import('./App.jsx'))

export default function AppRoot() {
  return (
    <Suspense fallback={null}>
      <App />
    </Suspense>
  )
}
