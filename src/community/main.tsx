import React from 'react'
import { createRoot } from 'react-dom/client'
import CommunityApp from './CommunityApp'
import '../styles.css'
import '../new-round.css'
import './community.css'
document.documentElement.dataset.theme=localStorage.getItem('ideabox.theme')||'starry'
createRoot(document.getElementById('root')!).render(<React.StrictMode><CommunityApp/></React.StrictMode>)
