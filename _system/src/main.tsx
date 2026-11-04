import React from 'react';
import { createRoot } from 'react-dom/client';
import AcademicHub from './academic/AcademicHub';
import './styles.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><AcademicHub /></React.StrictMode>);
