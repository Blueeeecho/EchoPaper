import React from 'react';
import { createRoot } from 'react-dom/client';
import AcademicHub from './academic/AcademicHub';
import './styles/tokens.css';
import './styles/base.css';
import './styles.css';
import './academic/research-workflow.css';
import './design-system.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><AcademicHub /></React.StrictMode>);
