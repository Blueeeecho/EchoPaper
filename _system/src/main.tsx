import React from 'react';
import { createRoot } from 'react-dom/client';
import AcademicHub from './academic/AcademicHub';
import './styles.css';
import './academic/workspace-theme.css';
import './academic/research-workflow.css';
import './academic/minimal-theme.css';
import './academic/writing-chrome.css';
import './academic/ui-readability.css';
// Design system last: it owns color, type, radius and elevation for the whole app.
import './design-system.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><AcademicHub /></React.StrictMode>);
