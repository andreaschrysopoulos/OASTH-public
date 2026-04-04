import React from 'react'
import ReactDOM from 'react-dom/client'
import 'mapbox-gl/dist/mapbox-gl.css'
import AppRoot from './app/AppRoot.jsx'
import './styles/index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppRoot />
  </React.StrictMode>,
)
