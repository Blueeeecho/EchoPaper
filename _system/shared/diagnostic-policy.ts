import type {Diagnostic} from './types';

/** Submission severity is separate from whether the TeX engine could emit a PDF. */
export function submissionSeverity(diagnostic:Diagnostic):Diagnostic['severity']{
 if(diagnostic.severity==='error')return 'error';
 if(diagnostic.category==='placeholder')return 'error';
 if(diagnostic.category==='reference'&&diagnostic.severity!=='info')return 'error';
 if(diagnostic.category==='compile'&&diagnostic.severity==='warning'&&/not found|can(?:not|'t) find|does not exist|missing (?:file|character)|undefined control sequence|invalid|failed to (?:load|include)|font.*not (?:available|loadable)/i.test(diagnostic.message))return 'error';
 return diagnostic.severity;
}
