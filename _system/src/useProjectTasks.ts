import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentCreateInput, AgentRun, AgentRunDetail, RunEvent } from '../shared/agent-types';
import { api, json } from './api';

export function mergeTaskRuns(previous: AgentRun[], incoming: AgentRun[]): AgentRun[] {
  const runs = new Map(previous.map(run => [run.id, run]));
  for (const run of incoming) {
    const before = runs.get(run.id);
    if (!before || run.version >= before.version) runs.set(run.id, run);
  }
  return [...runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function mergeTaskEvents(previous: RunEvent[], incoming: RunEvent[]): RunEvent[] {
  return [...new Map([...previous, ...incoming].map(event => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq);
}
export function mergeTaskDetail(previous: AgentRunDetail, incoming: AgentRunDetail): AgentRunDetail {
  if (previous.run.id !== incoming.run.id) return incoming;
  const tools = new Map(previous.tools.map(tool => [tool.id, tool]));
  for (const tool of incoming.tools) {
    const before = tools.get(tool.id);
    if (before && before.status !== 'running' && tool.status === 'running') continue;
    if (before?.finishedAt && tool.finishedAt && before.finishedAt > tool.finishedAt) continue;
    tools.set(tool.id, tool);
  }
  return { run: previous.run.version > incoming.run.version ? previous.run : incoming.run, events: mergeTaskEvents(previous.events, incoming.events), tools: [...tools.values()] };
}
export interface ProjectTasks {
  runs: AgentRun[]; detail?: AgentRunDetail; details: Record<string, AgentRunDetail>; selectedId: string; loading: boolean;
  connected: boolean; error: string; busy: string;
  select: (id: string) => void; refresh: () => Promise<void>; clearError: () => void;
  create: (input: AgentCreateInput) => Promise<AgentRun>;
  load: (id: string) => Promise<void>;
  action: (action: 'cancel' | 'resume' | 'decisions' | 'undo', body?: unknown, runId?: string) => Promise<void>;
}
const unpackRun = (value: AgentRun | { run: AgentRun }): AgentRun => 'run' in value ? value.run : value;

/** The service owns execution. Closing or losing this subscription never cancels a run. */
export function useProjectTasks(projectId: string): ProjectTasks {
  const [runs, setRuns] = useState<AgentRun[]>([]), [details, setDetails] = useState<Record<string, AgentRunDetail>>({});
  const [selectedId, setSelectedId] = useState(''), [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState('');
  const current = useRef({ projectId, selectedId }); current.current = { projectId, selectedId };
  const pendingDetails = useRef(new Map<string, Promise<void>>());
  const base = '/api/projects/' + encodeURIComponent(projectId) + '/agent-runs';
  const selectionKey = 'echopaper:agent-selection:' + projectId;
  const select = useCallback((id: string) => { setSelectedId(id); setError(''); try { localStorage.setItem(selectionKey, id); } catch {} }, [selectionKey]);
  const receive = useCallback((run: AgentRun) => {
    if (current.current.projectId !== projectId) return;
    setRuns(previous => mergeTaskRuns(previous, [run]));
  }, [projectId]);
  const refresh = useCallback(async () => {
    if (!projectId) return;
    const result = await api<{ runs: AgentRun[] }>(base);
    if (current.current.projectId !== projectId) return;
    setRuns(previous => mergeTaskRuns(previous, result.runs));
    setSelectedId(previous => result.runs.some(run => run.id === previous) ? previous : result.runs[0]?.id || '');
  }, [projectId, base]);
  const refreshDetail = useCallback(async (id: string) => {
    if (!id || !projectId) return;
    const key = projectId + ':' + id, pending = pendingDetails.current.get(key);
    if (pending) return pending;
    const work = (async () => {
      const value = await api<AgentRunDetail>(base + '/' + encodeURIComponent(id));
      if (current.current.projectId !== projectId) return;
      receive(value.run);
      setDetails(previous => ({ ...previous, [id]: previous[id] ? mergeTaskDetail(previous[id], value) : value }));
    })();
    pendingDetails.current.set(key, work);
    try { await work; } finally { if (pendingDetails.current.get(key) === work) pendingDetails.current.delete(key); }
  }, [projectId, base, receive]);
  useEffect(() => {
    setRuns([]); setDetails({}); setError(''); setBusy(''); setConnected(false);
    let restored = ''; try { restored = localStorage.getItem(selectionKey) || ''; } catch {}
    setSelectedId(restored); setLoading(!!projectId);
    let active = true;
    void refresh().catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    if (!projectId) return () => { active = false; };
    const events = new EventSource('/api/events');
    events.onopen = () => { if (active) { setConnected(true); void refresh().catch(() => {}); } };
    events.onerror = () => { if (active) setConnected(false); };
    events.onmessage = event => { try { const value = JSON.parse(event.data); if (value.type === 'agent.updated' && value.projectId === projectId) { void refresh().catch(() => {}); if (value.runId) void refreshDetail(value.runId).catch(() => {}); } } catch {} };
    return () => { active = false; events.close(); };
  }, [projectId, selectionKey, refresh, refreshDetail]);
  useEffect(() => {
    if (!selectedId || !projectId) return;
    let active = true, timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => refreshDetail(selectedId).catch(e => { if (active) setError(e.message); });
    void load();
    const events = new EventSource(base + '/' + encodeURIComponent(selectedId) + '/events');
    events.onopen = () => { if (active) { setConnected(true); setError(''); void load(); } };
    events.onerror = () => { if (active) setConnected(false); };
    events.onmessage = message => {
      try {
        const event = JSON.parse(message.data) as RunEvent;
        if (event.runId !== selectedId || !Number.isFinite(event.seq)) return;
        setDetails(previous => previous[selectedId] ? { ...previous, [selectedId]: { ...previous[selectedId], events: mergeTaskEvents(previous[selectedId].events, [event]) } } : previous);
        if (!timer) timer = setTimeout(() => { timer = undefined; if (active) void load(); }, 150);
      } catch { /* A malformed live event must not erase the authoritative snapshot. */ }
    };
    return () => { active = false; events.close(); clearTimeout(timer); };
  }, [projectId, selectedId, base, refreshDetail]);
  const create = useCallback(async (input: AgentCreateInput) => {
    setBusy('create'); setError('');
    try { const run = unpackRun(await api<AgentRun | { run: AgentRun }>(base, json('POST', input))); if (current.current.projectId === projectId) { receive(run); select(run.id); } return run; }
    catch (e: any) { if (current.current.projectId === projectId) setError(e.message); throw e; }
    finally { if (current.current.projectId === projectId) setBusy(''); }
  }, [base, projectId, receive, select]);
  const action = useCallback(async (name: 'cancel' | 'resume' | 'decisions' | 'undo', body: unknown = {}, runId?: string) => {
    const id = runId || current.current.selectedId; if (!id) return;
    setBusy(name); setError('');
    try { await api(base + '/' + encodeURIComponent(id) + '/' + name, json('POST', body)); await refreshDetail(id); }
    catch (e: any) { if (current.current.projectId === projectId) setError(e.message); }
    finally { if (current.current.projectId === projectId) setBusy(''); }
  }, [base, projectId, refreshDetail]);
  return { runs, detail: details[selectedId], details, selectedId, loading, connected, error, busy, select, refresh, load: refreshDetail, create, action, clearError: () => setError('') };
}
