import path from 'node:path';
import type { Diagnostic } from '../shared/types.ts';
import type { SourceFile } from './compile-utils.ts';

// This is intentionally a conservative source scanner, not a TeX interpreter.
// Offsets and newlines are retained so source diagnostics remain navigable.
function blank(text: string): string { return text.replace(/[^\n\r]/g, ' '); }
function escaped(text: string, index: number): boolean {
  let count = 0;
  while (index > 0 && text[--index] === '\\') count++;
  return count % 2 === 1;
}
interface Group { value: string; start: number; end: number }
function group(text: string, offset: number, open = '{', close = '}'): Group | undefined {
  while (/\s/.test(text[offset] || '') && offset < text.length) offset++;
  if (text[offset] !== open) return;
  const start = offset++;
  let depth = 1;
  for (; offset < text.length; offset++) {
    if (escaped(text, offset)) continue;
    if (text[offset] === open) depth++;
    else if (text[offset] === close && --depth === 0) return { value: text.slice(start + 1, offset), start, end: offset + 1 };
  }
}
export function scanTex(text: string, onDefinition?: (definition: string) => void): string {
  let result = text;
  const mask = (start: number, end: number) => { result = result.slice(0, start) + blank(result.slice(start, end)) + result.slice(end); };
  // Skip comments and literal environments before interpreting any commands.
  for (let i = 0; i < result.length; i++) {
    if (result[i] === '%' && !escaped(result, i)) {
      const end = result.indexOf('\n', i); mask(i, end < 0 ? result.length : end); continue;
    }
    if (result[i] !== '\\' || escaped(result, i)) continue;
    const verb = result.slice(i).match(/^\\(?:verb|lstinline)\*?(?![A-Za-z])/);
    if (verb) {
      let start = i + verb[0].length;
      const option = group(result, start, '[', ']'); if (option) start = option.end;
      const delimiter = result[start];
      if (delimiter && !/\s/.test(delimiter)) {
        const end = result.indexOf(delimiter, start + 1); const newline = result.indexOf('\n', start);
        mask(i, end >= 0 && (newline < 0 || end < newline) ? end + 1 : newline < 0 ? result.length : newline);
      }
      continue;
    }
    const env = result.slice(i).match(/^\\begin\s*\{(verbatim\*?|Verbatim|lstlisting|minted|comment)\}/);
    if (env) {
      const endText = `\\end{${env[1]}}`; const end = result.indexOf(endText, i + env[0].length);
      mask(i, end < 0 ? result.length : end + endText.length);
    }
  }
  // Entire multiline definitions are dormant until expanded. Never lint their
  // illustrative labels, inputs, or graphics as executed source.
  const definition = /\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|DeclareMathOperator|NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand|newenvironment|renewenvironment|NewDocumentEnvironment|RenewDocumentEnvironment|def|gdef|edef|xdef)\b\*?/g;
  let match: RegExpExecArray | null;
  while ((match = definition.exec(result))) {
    let cursor = match.index + match[0].length;
    const name = group(result, cursor);
    if (name) cursor = name.end;
    else { const token = result.slice(cursor).match(/^\s*\\(?:[A-Za-z@]+|.)/); if (!token) continue; cursor += token[0].length; }
    const primitive = /\\(?:def|gdef|edef|xdef)$/.test(match[0]);
    if (primitive) { const start = result.indexOf('{', cursor); if (start < 0) continue; cursor = start; }
    for (let count = 0; count < 2; count++) { const option = group(result, cursor, '[', ']'); if (option) cursor = option.end; }
    if (/Document(?:Command|Environment)/.test(match[0])) { const spec = group(result, cursor); if (spec) cursor = spec.end; }
    const body = group(result, cursor); if (!body) continue;
    cursor = body.end;
    if (/environment|Environment/.test(match[0])) { const endBody = group(result, cursor); if (endBody) cursor = endBody.end; }
    onDefinition?.(result.slice(match.index, cursor));
    mask(match.index, cursor); definition.lastIndex = cursor;
  }
  for (const declaration of result.matchAll(/\\newif\s*\\if[A-Za-z@]+/g)) mask(declaration.index!, declaration.index! + declaration[0].length);
  // Only literal true/false conditionals can be evaluated without executing
  // TeX. Unknown branches are left to the engine rather than linted as active.
  const conditional = /\\if(?:true|false|defined|csname|x|num|dim|odd|case|cat|hmode|vmode|mmode|inner|void|hbox|vbox|eof|pdf|xetex|luatex|draft|anonymous)\b/g;
  while ((match = conditional.exec(result))) {
    const tokens = /\\(?:if[A-Za-z@]*|else|fi)\b/g; tokens.lastIndex = conditional.lastIndex;
    let depth = 1; let token: RegExpExecArray | null; let end = result.length; let alternative: RegExpExecArray | undefined;
    while ((token = tokens.exec(result))) {
      if (token[0] === '\\else') { if (depth === 1) alternative = token; continue; }
      depth += token[0] === '\\fi' ? -1 : 1;
      if (!depth) { end = tokens.lastIndex; break; }
    }
    if (match[0] === '\\iftrue') {
      mask(match.index, conditional.lastIndex);
      if (alternative) mask(alternative.index, end);
      conditional.lastIndex = match.index + match[0].length;
    } else if (match[0] === '\\iffalse' && alternative) {
      mask(match.index, alternative.index + alternative[0].length);
      conditional.lastIndex = alternative.index + alternative[0].length;
    } else {
      if (match[0] !== '\\iffalse') onDefinition?.(result.slice(match.index, end));
      mask(match.index, end);
      conditional.lastIndex = end;
    }
  }
  const end = /\\(?:endinput\b|end\s*\{document\})/.exec(result);
  if (end) mask(end.index + end[0].length, result.length);
  return result;
}
interface SourceCommand { name: string; value: string; extra?: string; index: number; line: number }
function commands(text: string): SourceCommand[] {
  const result: SourceCommand[] = [];
  const re = /\\([A-Za-z@]+)\*?/g;
  let match: RegExpExecArray | null;
  let previous = 0; let line = 1;
  while ((match = re.exec(text))) {
    if (escaped(text, match.index)) continue;
    line += (text.slice(previous, match.index).match(/\n/g) || []).length; previous = match.index;
    let cursor = re.lastIndex;
    for (let count = 0; count < 2; count++) { const option = group(text, cursor, '[', ']'); if (option) cursor = option.end; }
    let argument = group(text, cursor);
    if (!argument && match[1] === 'input') {
      const token = text.slice(cursor).match(/^\s*([^\s{}%]+)/);
      if (token) argument = { value: token[1], start: cursor, end: cursor + token[0].length };
    }
    if (!argument) continue;
    const second = /^(?:import|subimport|inputfrom|subinputfrom|includefrom|subincludefrom)$/.test(match[1]) ? group(text, argument.end) : undefined;
    result.push({ name: match[1], value: argument.value.trim(), extra: second?.value.trim(), index: match.index, line });
  }
  return result;
}
const literal = (value: string) => Boolean(value) && !/[\\#{}$~\u0000]/.test(value) && !/^(?:https?:|ftp:|data:|\/)/i.test(value);
interface ActiveSource { file: SourceFile; text: string; commands: SourceCommand[]; importBase: string }
function activeSources(files: SourceFile[], main: string): ActiveSource[] {
  const byPath = new Map(files.map(file => [file.path, file]));
  const active: ActiveSource[] = []; const visited = new Set<string>();
  const includeOnly = commands(scanTex(byPath.get(main)?.bytes.toString('utf8') || '')).find(command => command.name === 'includeonly')?.value.split(',').map(value => value.trim().replace(/\.tex$/, ''));
  const resolve = (value: string, name: string, base: string): string | undefined => {
    const filename = path.posix.extname(value) ? value : `${value}.tex`;
    return [path.posix.join(base, filename), filename, path.posix.join(path.posix.dirname(name), filename)].find(item => byPath.has(item));
  };
  const visit = (name: string, importBase = '') => {
    if (visited.has(name)) return;
    const file = byPath.get(name); if (!file) return;
    visited.add(name);
    const text = scanTex(file.bytes.toString('utf8')); const items = commands(text);
    active.push({ file, text, commands: items, importBase });
    for (const command of items) {
      let value = command.value; let base = importBase;
      if (/^(?:import|subimport|inputfrom|subinputfrom|includefrom|subincludefrom)$/.test(command.name)) {
        if (!command.extra || !literal(value) || !literal(command.extra)) continue;
        base = command.name.startsWith('sub') ? path.posix.join(base, value) : value; value = command.extra;
      } else if (!/^(?:input|include|subfile)$/.test(command.name)) continue;
      if (!literal(value) || (command.name === 'include' && includeOnly && !includeOnly.includes(value.replace(/\.tex$/, '')))) continue;
      const dependency = resolve(value, name, base); if (dependency) visit(dependency, base);
    }
  };
  visit(main); return active;
}
export function activeTexFiles(files: SourceFile[], main: string): Set<string> { return new Set(activeSources(files, main).map(source => source.file.path)); }
export function placeholderDiagnostics(files: SourceFile[], main: string, prefix: string): Diagnostic[] {
  const active = activeTexFiles(files, main);
  const diagnostics: Diagnostic[] = [];
  for (const file of files) {
    if (!active.has(file.path)) continue;
    scanTex(file.bytes.toString('utf8')).split(/\r?\n/).forEach((line, i) => {
      if (/\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|def)\b/.test(line)) return;
      if (/\\(?:resultplaceholder|configplaceholder)\s*\{|\\missingresult\b|\b(?:TODO|TBD|FIXME)\b/.test(line)) {
        diagnostics.push({ severity: 'warning', category: 'placeholder', message: `待补充内容：${line.trim().slice(0, 180)}`, file: [prefix, file.path].filter(Boolean).join('/'), line: i + 1 });
      }
    });
  }
  return diagnostics;
}
export const DIAGNOSTICS_VERSION = 4;
interface SourceDiagnosticOptions { succeeded?: boolean; engine?: Diagnostic[] }
function referenceIdentity(message: string): string | undefined {
  const match = message.match(/(Reference|Citation|Label)\s+[`'“]([^'’”`]+)['’”`]/i);
  return match ? `${match[1].toLowerCase()}:${match[2]}` : undefined;
}
function externalLocation(message: string): boolean { return /^(?:\/|[A-Za-z]:[\\/]).*?:\d+ — /.test(message); }
export function dedupeDiagnostics(items: Diagnostic[]): Diagnostic[] {
  return [...new Map(items.map(item => [`${item.severity}:${item.category}:${item.file || ''}:${item.line || ''}:${item.page || ''}:${item.message}`, item])).values()];
}
export function sourceDiagnostics(files: SourceFile[], main: string, prefix: string, options: SourceDiagnosticOptions = {}): Diagnostic[] {
  const active = activeSources(files, main); const byPath = new Map(files.map(file => [file.path, file]));
  const diagnostics: Diagnostic[] = []; const labels = new Map<string, { source: ActiveSource; command: SourceCommand }[]>();
  const bibKeys = new Set<string>(); const bibliographyFiles = new Set<string>();
  const evidence = options.engine || [];
  const add = (source: ActiveSource, command: SourceCommand, category: Diagnostic['category'], message: string, severity: Diagnostic['severity'] = 'warning') => {
    diagnostics.push({ severity, category, message, file: [prefix, source.file.path].filter(Boolean).join('/'), line: command.line });
  };
  const paths = (source: ActiveSource, value: string) => [...new Set([path.posix.join(source.importBase, value), path.posix.normalize(value), path.posix.join(path.posix.dirname(source.file.path), value)])];
  const resolve = (source: ActiveSource, value: string, extensions: string[]) => paths(source, value).flatMap(name => path.posix.extname(name) ? [name] : extensions.map(extension => name + extension)).find(name => byPath.has(name));
  const graphicsDirectories: string[] = []; let dynamicGraphicsPath = false;
  let extensions = ['.pdf', '.png', '.jpg', '.jpeg', '.eps', '.ps', '.mps', '.tif', '.tiff', '.svg'];
  let uncertainLabels = false; let uncertainGraph = false; let externalReferences = false;
  for (const source of active) {
    // Macro-created labels and external documents are unknowable statically.
    const raw = source.file.bytes.toString('utf8');
    if (/\\(?:label|bibitem)\s*\{[^}]*[\\#]|\\csname/.test(source.text)) uncertainLabels = true;
    if (/\\externaldocument\b/.test(source.text)) externalReferences = true;
    for (const command of source.commands) {
      if (command.name === 'label' && literal(command.value)) {
        const entries = labels.get(command.value) || []; entries.push({ source, command }); labels.set(command.value, entries);
      }
      if (command.name === 'bibitem' && literal(command.value)) bibKeys.add(command.value);
      if (command.name === 'graphicspath') {
        for (const entry of command.value.matchAll(/\{([^{}]*)\}/g)) {
          if (literal(entry[1])) graphicsDirectories.push(...paths(source, entry[1])); else if (entry[1]) dynamicGraphicsPath = true;
        }
      }
      if (command.name === 'DeclareGraphicsExtensions') {
        const values = command.value.split(',').map(value => value.trim());
        if (values.length && values.every(value => /^\.[a-z0-9]+$/i.test(value))) extensions = values;
      }
      if (/^(?:bibliography|addbibresource|addglobalbib|addsectionbib)$/.test(command.name)) {
        for (const name of command.value.split(',').map(value => value.trim()).filter(literal)) {
          const found = resolve(source, name, ['.bib']); if (found) bibliographyFiles.add(found);
        }
      }
    }
    const graphDependency = /\\(?:input|include|subfile|import|subimport|inputfrom|subinputfrom|includefrom|subincludefrom)\b/;
    scanTex(raw, definition => {
      if (/\\(?:label|bibitem)\b/.test(definition)) uncertainLabels = true;
      if (graphDependency.test(definition)) uncertainGraph = true;
    });
    if (source.commands.some(command => graphDependency.test(`\\${command.name}`) && (!literal(command.value) || (command.extra !== undefined && !literal(command.extra))))) uncertainGraph = true;
  }
  for (const name of bibliographyFiles) {
    const bib = byPath.get(name)!.bytes.toString('utf8');
    for (const match of bib.matchAll(/@(?!comment\b|string\b|preamble\b)[a-z]+\s*[{(]\s*([^,\s]+)\s*,/gi)) bibKeys.add(match[1]);
  }
  for (const [key, definitions] of labels) {
    if (definitions.length < 2) continue;
    for (const entry of definitions) add(entry.source, entry.command, 'reference', `Label '${key}' multiply defined (${definitions.length} definitions).`);
  }
  const includeOnly = active.flatMap(source => source.commands).find(command => command.name === 'includeonly')?.value.split(',').map(value => value.trim().replace(/\.tex$/, ''));
  for (const source of active) for (const command of source.commands) {
    const citation = /^(?:cite|citep|citet|citealt|citealp|citeauthor|citeyear|citeyearpar|Cite|Citep|Citet|parencite|textcite|autocite|footcite|smartcite|supercite|nocite|bibentry)$/.test(command.name);
    const reference = /^(?:ref|eqref|pageref|autoref|Autoref|nameref|cref|Cref|vref|Vref|cpageref|Cpageref)$/.test(command.name);
    if (citation || reference) for (const key of command.value.split(',').map(value => value.trim())) {
      if (!literal(key) || key === '*') continue;
      const identity = `${citation ? 'citation' : 'reference'}:${key}`;
      const engineUndefined = evidence.some(item => item.category === 'reference' && !externalLocation(item.message) && referenceIdentity(item.message) === identity && /undefined/i.test(item.message));
      const missing = citation ? !bibKeys.has(key) && (bibliographyFiles.size > 0 || bibKeys.size > 0) : !labels.has(key) && !externalReferences && !uncertainLabels;
      if (engineUndefined || (missing && !uncertainGraph)) add(source, command, 'reference', `${citation ? 'Citation' : 'Reference'} '${key}' undefined.`);
    }
    let value = command.value; let kind = ''; let found: string | undefined; let required = true;
    if (/^(?:input|include|subfile)$/.test(command.name)) {
      if (command.name === 'include' && includeOnly && !includeOnly.includes(value.replace(/\.tex$/, ''))) continue;
      kind = 'input'; found = resolve(source, value, ['.tex', '']);
      required = true;
    } else if (/^(?:import|subimport|inputfrom|subinputfrom|includefrom|subincludefrom)$/.test(command.name) && command.extra && literal(value)) {
      kind = 'input'; value = path.posix.join(command.name.startsWith('sub') ? source.importBase : '', value, command.extra);
      found = resolve(source, value, ['.tex', '']);
    } else if (command.name === 'includegraphics') {
      kind = 'image'; found = resolve(source, value, extensions);
      if (!found) for (const directory of graphicsDirectories) { found = resolve(source, path.posix.join(directory, value), extensions); if (found) break; }
      if (dynamicGraphicsPath) required = false;
    } else if (/^(?:bibliography|addbibresource|addglobalbib|addsectionbib)$/.test(command.name)) {
      for (const name of value.split(',').map(value => value.trim()).filter(literal)) if (!resolve(source, name, ['.bib'])) {
        add(source, command, 'reference', `Bibliography file '${name}' was not found in the frozen source snapshot.`);
      }
      continue;
    }
    if (!kind || !literal(value) || found) continue;
    const engineMissing = evidence.some(item => /not found|not find|cannot find|can['’]t find|could not open|failed to open|does not exist|missing/i.test(item.message) && item.message.includes(value));
    if ((!required || (kind === 'input' && !value.includes('/') && !path.posix.extname(value) && options.succeeded === true)) && !engineMissing) continue;
    add(source, command, 'compile', `${kind === 'image' ? 'Image' : 'Input'} file '${value}' was not found in the frozen source snapshot.`, options.succeeded === false && engineMissing ? 'error' : 'warning');
  }
  return dedupeDiagnostics(diagnostics);
}
function dependencyKey(message: string): string | undefined { return message.match(/\bfile\s+[`'"“]([^'’”`"]+)['’”`"]/i)?.[1].replace(/\.tex$/i, ''); }
function mergeSourceDiagnostics(engine: Diagnostic[], source: Diagnostic[]): Diagnostic[] {
  // Keep engine wording; recover anchors when the trace lost file context.
  const merged = [...engine];
  for (const item of source) {
    const key = referenceIdentity(item.message); const dependency = dependencyKey(item.message);
    const candidates = merged.filter(candidate => {
      if (externalLocation(candidate.message) || candidate.category !== item.category || candidate.severity !== item.severity) return false;
      if (!((key && referenceIdentity(candidate.message) === key) || (dependency && dependencyKey(candidate.message) === dependency))) return false;
      if (candidate.file) return candidate.file === item.file && (!candidate.line || candidate.line === item.line);
      const reportedLine = candidate.message.match(/(?:on input line|at lines?)\s+(\d+)/i);
      const occurrences = source.filter(sourceItem => key ? referenceIdentity(sourceItem.message) === key : dependencyKey(sourceItem.message) === dependency);
      return reportedLine ? Number(reportedLine[1]) === item.line : occurrences.length === 1;
    });
    if (candidates.length) for (const existing of candidates) { existing.file = item.file; existing.line = item.line; }
    else merged.push(item);
  }
  return dedupeDiagnostics(merged);
}
export interface DiagnosticParseOptions { succeeded?: boolean; files?: SourceFile[]; finalLog?: string }
function latestTexPass(log: string): string {
  const starts = [...log.matchAll(/(?:^|\n)note: (?:Running|Rerunning) TeX\b/g)];
  return starts.length ? log.slice(starts[starts.length - 1].index!) : log;
}
export function parseDiagnostics(log: string, prefix: string, main: string, options: DiagnosticParseOptions = {}): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const knownFiles = options.files ? new Map(options.files.map(file => [file.path, file.bytes.toString('utf8').split(/\r?\n/).length])) : undefined;
  const stack: (string | undefined)[] = [];
  let fontTraces = 0;
  let lastError: Diagnostic | undefined;
  const fileCandidate = (value: string): boolean => /\.(?:tex|sty|cls|bbl|aux|def|cfg|fd|clo|out|ini|ltx|fontspec)$/i.test(value) || value.includes('/');
  const trace = (text: string): void => {
    for (let index = 0; index < text.length; index++) {
      if (text[index] === '(') {
        const token = text.slice(index + 1).match(/^(?:"([^"]+)"|([^\s()]+))/);
        const candidate = token?.[1] || token?.[2];
        stack.push(candidate && fileCandidate(candidate) ? candidate : undefined);
      } else if (text[index] === ')' && stack.length) stack.pop();
    }
  };
  const currentFile = (): string | undefined => [...stack].reverse().find(Boolean);
  const normalize = (value: string): string | undefined => {
    let cleaned = value.replace(/^\.\//, '').replace(/\\/g, '/');
    if (cleaned.includes('/source/')) {
      // An absolute engine path is navigable only when its snapshot-relative
      // suffix is actually present in this build's frozen manifest.
      const relative = cleaned.split('/source/').pop()!;
      if (!knownFiles || (!knownFiles.has(relative) && !knownFiles.has(`${relative}.tex`))) return undefined;
      cleaned = relative;
    } else if (path.posix.isAbsolute(cleaned) || /^[A-Za-z]:\//.test(cleaned)) return undefined;
    if (prefix && cleaned.startsWith(`${prefix}/`)) cleaned = cleaned.slice(prefix.length + 1);
    if (knownFiles) {
      if (knownFiles.has(cleaned)) return cleaned;
      if (!path.posix.extname(cleaned) && knownFiles.has(`${cleaned}.tex`)) return `${cleaned}.tex`;
      return undefined;
    }
    if (/\.(?:bbl|aux|log|out|sty|cls|def|fd|cfg|fontspec)$/i.test(cleaned)) return undefined;
    return path.posix.extname(cleaned) ? cleaned : `${cleaned}.tex`;
  };
  const add = (severity: Diagnostic['severity'], rawMessage: string, filename?: string, line?: number): Diagnostic | undefined => {
    let message = rawMessage.replace(/\s+/g, ' ').trim();
    if (!message) return;
    if (severity !== 'error' && /^(?:Requested font\b|->\s)/.test(message) && !/not found|failed|not loadable|missing/i.test(message)) { fontTraces++; return; }
    if (/^warnings were issued by (?:the TeX engine|BibTeX)/i.test(message)) return;
    const source = filename ? normalize(filename) : undefined;
    const page = message.match(/\bon page\s+(\d+)\b/i);
    const diagnostic: Diagnostic = { severity, category: /\bReference\b|\bCitation\b|undefined references|undefined citations|cross-references|multiply defined/i.test(message) ? 'reference' : 'compile', message };
    if (page && Number(page[1]) > 0) diagnostic.page = Number(page[1]);
    if (source) {
      diagnostic.file = [prefix, source].filter(Boolean).join('/');
      if (line && line > 0 && (!knownFiles || line <= knownFiles.get(source)!)) diagnostic.line = line;
    } else if (filename && line) diagnostic.message = `${filename}:${line} — ${message}`;
    diagnostics.push(diagnostic);
    return diagnostic;
  };
  const selected = options.succeeded === false ? log : options.finalLog?.trim() ? options.finalLog : latestTexPass(log);
  const lines = selected.split(/\r?\n/);
  const enginePrefix = (text: string) => /\b(warning|error):\s*/.exec(text);
  const packageWarning = (text: string) => /^(?:LaTeX(?: Font)?|Package .+?|Class .+?) Warning:/i.test(text.trim());
  const continuation = (start: number, initial: string): { text: string; end: number } => {
    let message = initial;
    let end = start;
    for (let next = start + 1; next < lines.length && next <= start + 12; next++) {
      const value = lines[next];
      if (!value.trim() || enginePrefix(value) || packageWarning(value) || /^\s*(?:!|l\.\d+|note:|\)\s|\)\s*$)/.test(value)) break;
      if (/^\s*\((?:[^\s()]+\.(?:tex|sty|cls|bbl)|tex\/)/.test(value) && !/^\([A-Za-z0-9_-]+\)\s/.test(value)) break;
      const tag = value.match(/^\([A-Za-z0-9_-]+\)\s+(.*)$/);
      message += tag ? ` ${tag[1]}` : value;
      end = next;
    }
    return { text: message, end };
  };
  const errorDetails = (start: number, initial: string): { text: string; end: number; line?: number } => {
    let text = initial; let end = start; let line: number | undefined;
    for (let next = start + 1; next < lines.length; next++) {
      const value = lines[next];
      if (!value.trim() || enginePrefix(value) || packageWarning(value) || /^\s*(?:!|note:|\)\s*$)/.test(value)) break;
      if (/^\s*\((?:[^\s()]+\.(?:tex|sty|cls|bbl)|tex\/)/.test(value)) break;
      const location = value.match(/^\s*l\.(\d+)\s/); if (location) line = Number(location[1]);
      text += ` ${value.trim()}`; end = next;
    }
    return { text, end, line };
  };
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    const marker = enginePrefix(raw);
    // Stderr can appear halfway through a stdout file trace. Only text after
    // the explicit engine marker is a diagnostic; preceding text updates context.
    const tracePart = marker ? raw.slice(0, marker.index) : raw;
    trace(tracePart);
    let text = marker ? raw.slice(marker.index + marker[0].length) : raw.trimStart();
    const severity: Diagnostic['severity'] | undefined = marker ? marker[1] === 'error' ? 'error' : 'warning' : undefined;
    let detail = text.match(/^([^()]+?):(\d+):\s*(.*)$/);
    if (detail && !marker && /\s/.test(detail[1])) detail = null;
    if (detail) {
      let message = detail[3];
      if (!message.trim() && index + 1 < lines.length && !enginePrefix(lines[index + 1]) && lines[index + 1].trim()) message = lines[++index].trim();
      const warning = severity === 'warning' || (!severity && /warning|overfull|underfull/i.test(message));
      const block = severity === 'error' || (!severity && !warning) ? errorDetails(index, message) : { text: message, end: index };
      index = block.end;
      const item = add(severity || (warning ? 'warning' : 'error'), block.text, detail[1].trim(), Number(detail[2]));
      if (item?.severity === 'error') lastError = item;
      continue;
    }
    if (/^!\s/.test(text) || severity === 'error') {
      const block = errorDetails(index, text.replace(/^!\s*/, ''));
      index = block.end;
      lastError = add('error', block.text, currentFile() || main, block.line);
      continue;
    }
    const errorLine = text.match(/^l\.(\d+)\s/);
    if (errorLine && lastError) {
      const value = Number(errorLine[1]);
      const source = lastError.file && normalize(lastError.file);
      if (source && (!knownFiles || value <= knownFiles.get(source)!)) lastError.line = value;
      continue;
    }
    if (packageWarning(text)) {
      const block = continuation(index, text);
      text = block.text;
      index = block.end;
      const line = text.match(/(?:on input line|at lines?)\s+(\d+)(?:--(\d+))?/i);
      add('warning', text, currentFile(), line ? Number(line[2] || line[1]) : undefined);
      continue;
    }
    if (/^(?:Overfull|Underfull) \\/.test(text) || severity === 'warning') {
      const line = text.match(/(?:on input line|at lines?)\s+(\d+)(?:--(\d+))?/i);
      add('warning', text, currentFile(), line ? Number(line[2] || line[1]) : undefined);
      continue;
    }
    if (/^Requested font\b/.test(text)) fontTraces++;
  }
  if (fontTraces) diagnostics.push({ severity: 'info', category: 'compile', message: `字体加载跟踪：${fontTraces} 条字体请求或映射记录，详见完整日志。` });
  // The engine termination line describes the preceding error, not another failure.
  const termination = (item: Diagnostic) => !item.line && /^(?:halted on potentially-recoverable error as specified|(?:the )?TeX engine (?:halted|failed)|emergency stop\.?|fatal error occurred[^]*)$/i.test(item.message);
  if (diagnostics.some(item => item.severity === 'error' && !termination(item))) {
    for (const item of diagnostics) if (item.severity === 'error' && termination(item)) {
      item.severity = 'info'; delete item.file;
    }
  }
  return options.files ? mergeSourceDiagnostics(diagnostics, sourceDiagnostics(options.files, main, prefix, { succeeded: options.succeeded, engine: diagnostics })) : dedupeDiagnostics(diagnostics);
}
