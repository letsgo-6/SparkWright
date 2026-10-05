// SPDX-License-Identifier: MPL-2.0
import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './community/ClientEntry'
import './styles.css'
import './new-round.css'
import './ui-refinements.css'
import './community/community.css'

document.documentElement.dataset.theme=localStorage.getItem('ideabox.theme')||'starry'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
)
