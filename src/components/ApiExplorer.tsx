import { useEffect, useState } from 'react';
import { FlaskConical, Play, Loader2, CheckCircle2, XCircle, Copy, ChevronDown } from 'lucide-react';

interface DocRoute {
  method: string;
  path: string;
  query?: string;
  body?: string;
  returns?: string;
}

interface ProbeResult {
  ok: boolean;
  status: number | null;
  ms: number;
  body: string;
}

const FALLBACK_ROUTES: DocRoute[] = [
  { method: 'GET', path: '/api/kanban/tasks', query: 'projectId?, status=backlog|running|done|blocked?', returns: 'Task[]' },
  { method: 'GET', path: '/api/kanban/tasks/:id', returns: 'Task (404 when missing)' },
  { method: 'POST', path: '/api/kanban/tasks', body: 'projectId*, title*, description?, status?, priority?, id?, agentId?, agentName?, sessionId?, modelId?, modelProviderID?, startupPhase?, startupError?', returns: 'Task' },
  { method: 'PATCH', path: '/api/kanban/tasks/:id', body: 'title?, description?, status?, priority?, agentId?, agentName?, sessionId?, modelId?, modelProviderID?, startupPhase?, startupError?', returns: 'Task' },
  { method: 'DELETE', path: '/api/kanban/tasks/:id', returns: '{ok:true,deleted}' },
  { method: 'GET', path: '/api/kanban/projects', returns: 'Project[]' },
  { method: 'POST', path: '/api/kanban/projects', body: 'name*, folder?|path?, gitUrl?, gitBranch?, noMkdir?, description?, id?, agentIds[]?', returns: 'Project' },
  { method: 'PATCH|PUT', path: '/api/kanban/projects/:id', body: 'name?, folder?|path?, gitUrl?, gitBranch?, description?, agentIds[]?', returns: 'Project' },
  { method: 'DELETE', path: '/api/kanban/projects/:id', returns: '{ok:true,deleted,tasksDeleted}' },
  { method: 'GET', path: '/api/kanban/projects/:id/git-check', returns: '{ok,current,pinned}' },
  { method: 'GET', path: '/api/kanban/roots', returns: '{root,folders}' },
  { method: 'GET', path: '/api/kanban/folders', returns: '{root,folders}' },
  { method: 'GET', path: '/api/kanban/folders/:name/git', returns: '{folder,isRepo,branch,dirty,remote,branches}' },
  { method: 'POST', path: '/api/kanban/clone', body: 'url*, folder*, branch?', returns: '{ok:true,folder,path}' },
  { method: 'GET', path: '/api/kanban/events', query: 'task?, limit=50', returns: 'Event[]' },
  { method: 'POST', path: '/api/kanban/delegate', body: 'projectId*, title*, description?, priority?, agentId?, agentName?, modelId?, modelProviderID?, timeoutSec?, pollMs?, wait?', returns: '{task, sessionId, waited} — sync: create + run + WAIT' },
  { method: 'GET', path: '/api/kanban/docs', returns: 'route catalogue' },
  { method: 'GET', path: '/api/kanban/openapi.json', returns: 'OpenAPI 3.0 spec' },
];

const METHOD_PILL: Record<string, string> = {
  GET: 'p-green',
  POST: 'p-blue',
  PATCH: 'p-amber',
  PUT: 'p-amber',
  DELETE: 'p-red',
};

function pillFor(method: string): string {
  const first = method.split('|')[0];
  return METHOD_PILL[first] ?? 'p-neutral';
}

function defaultQuery(path: string, query?: string): string {
  if (path === '/api/kanban/events') return 'limit=5';
  if (!query) return '';
  return '';
}

function defaultBody(path: string, method: string): string {
  const m = method.split('|')[0];
  if (m === 'POST' && path === '/api/kanban/tasks')
    return '{\n  "title": "Probe task (safe to delete)",\n  "description": "sent from the API explorer"\n}';
  if (m === 'POST' && path === '/api/kanban/clone')
    return '{\n  "url": "https://github.com/example/repo.git",\n  "folder": "probe-clone"\n}';
  if (m === 'POST') return '{\n  "name": "probe"\n}';
  if (m === 'PATCH' || m === 'PUT') return '{\n}';
  return '';
}

function EndpointCard({ route, projectId }: { route: DocRoute; projectId: string | null }) {
  const methods = route.method.split('|');
  const [method, setMethod] = useState(methods[0]);
  const [open, setOpen] = useState(false);
  const [pathInput, setPathInput] = useState(route.path);
  const [queryInput, setQueryInput] = useState(() => defaultQuery(route.path, route.query));
  const [bodyInput, setBodyInput] = useState(() => defaultBody(route.path, methods[0]));
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [copied, setCopied] = useState(false);

  // Pre-fill the active project id into task-list probes.
  useEffect(() => {
    if (route.path === '/api/kanban/tasks' && projectId && !queryInput) {
      setQueryInput(`projectId=${projectId}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const send = async () => {
    setSending(true);
    setResult(null);
    const url = queryInput.trim()
      ? `${pathInput.trim()}?${queryInput.trim()}`
      : pathInput.trim();
    const t0 = performance.now();
    try {
      const init: RequestInit = { method };
      if (method !== 'GET' && method !== 'DELETE' && bodyInput.trim()) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = bodyInput;
      }
      const res = await fetch(url, init);
      const text = await res.text();
      setResult({ ok: res.ok, status: res.status, ms: Math.round(performance.now() - t0), body: text });
    } catch (e) {
      setResult({ ok: false, status: null, ms: Math.round(performance.now() - t0), body: `fetch failed: ${String((e as Error)?.message ?? e)}` });
    } finally {
      setSending(false);
    }
  };

  const copyCurl = async () => {
    const url = queryInput.trim() ? `${pathInput.trim()}?${queryInput.trim()}` : pathInput.trim();
    let cmd = `curl -X ${method} "http://localhost:3001${url}"`;
    if (method !== 'GET' && method !== 'DELETE' && bodyInput.trim()) {
      cmd += ` -H "Content-Type: application/json" -d '${bodyInput.replace(/\n/g, ' ')}'`;
    }
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

  const pretty = (() => {
    if (!result) return '';
    try {
      return JSON.stringify(JSON.parse(result.body), null, 2);
    } catch {
      return result.body;
    }
  })();

  return (
    <div className="panel p-3">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 text-left">
        {methods.length > 1 ? (
          <select
            value={method}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setMethod(e.target.value)}
            className="pill mono"
            style={{ background: 'var(--surface-2)' }}
          >
            {methods.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        ) : (
          <span className={`pill ${pillFor(method)}`}>{method}</span>
        )}
        <code className="mono text-[13px] t-strong flex-1 truncate">{route.path}</code>
        <span className="muted text-[11px] mono hidden md:inline truncate max-w-[220px]">→ {route.returns}</span>
        <ChevronDown className="w-4 h-4 muted shrink-0" style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .12s' }} />
      </button>

      {route.query && !open && (
        <p className="muted text-[11px] mono mt-1 ml-1">?{route.query}</p>
      )}

      {open && (
        <div className="mt-3 space-y-2 animate-fadeIn">
          {route.body && (
            <p className="muted text-[11px] mono">body: {route.body}</p>
          )}
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              spellCheck={false}
              className="input mono text-[13px] flex-1"
              aria-label="Request path"
            />
            <input
              value={queryInput}
              onChange={(e) => setQueryInput(e.target.value)}
              spellCheck={false}
              placeholder="query e.g. limit=5"
              className="input mono text-[13px] flex-1"
              aria-label="Query string"
            />
          </div>
          {(method === 'POST' || method === 'PATCH' || method === 'PUT') && (
            <textarea
              value={bodyInput}
              onChange={(e) => setBodyInput(e.target.value)}
              spellCheck={false}
              rows={4}
              className="input mono text-[13px]"
              aria-label="JSON body"
            />
          )}
          <div className="flex items-center gap-2">
            <button onClick={send} disabled={sending} className="btn btn-primary flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium disabled:opacity-50">
              {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              Send
            </button>
            <button onClick={copyCurl} className="btn flex items-center gap-1.5 px-3 py-1.5 text-[13px]" title="Copy as curl">
              <Copy className="w-3.5 h-3.5" />
              {copied ? 'Copied' : 'curl'}
            </button>
            {result && (
              <span className={`pill ${result.ok ? 'p-green' : 'p-red'}`}>
                {result.ok ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                {result.status ?? 'ERR'} · {result.ms}ms · {(result.body.length / 1024).toFixed(1)}kb
              </span>
            )}
          </div>
          {result && (
            <pre className="mono text-[12px] t-soft p-3 overflow-auto max-h-80" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6 }}>
              {pretty.slice(0, 20000)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export default function ApiExplorer({ projectId }: { projectId: string | null }) {
  const [routes, setRoutes] = useState<DocRoute[]>(FALLBACK_ROUTES);
  const [live, setLive] = useState(false);

  // Authoritative list from the server; falls back to the static copy.
  // /api/kanban/docs serves the try-it-out HTML page — ?format=json gives the catalogue.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/kanban/docs?format=json')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.routes?.length) {
          setRoutes(d.routes as DocRoute[]);
          setLive(true);
        }
      })
      .catch(() => { /* offline — keep fallback */ });
    return () => { cancelled = true; };
  }, []);

  const groups: { title: string; match: (r: DocRoute) => boolean }[] = [
    { title: 'Tasks', match: (r) => r.path.startsWith('/api/kanban/tasks') },
    { title: 'Projects', match: (r) => r.path.startsWith('/api/kanban/projects') },
    { title: 'Folders / Clone', match: (r) => r.path.includes('/folders') || r.path.includes('/roots') || r.path.includes('/clone') },
    { title: 'Delegate (sync)', match: (r) => r.path.includes('/delegate') },
  { title: 'Events & Docs', match: (r) => r.path.includes('/events') || r.path.includes('/docs') || r.path.includes('/openapi') },
  ];

  return (
    <div className="max-w-4xl mx-auto space-y-5 pb-10">
      <div className="flex items-center gap-2 flex-wrap">
        <FlaskConical className="w-4 h-4 muted" />
        <h2 className="text-[16px] font-semibold t-strong">API Explorer</h2>
        <span className={`pill ${live ? 'p-green' : 'p-amber'}`}>
          <span className="dot" style={{ background: live ? 'var(--emerald)' : 'var(--amber)' }} />
          {live ? 'LIVE · /api/kanban/docs?format=json' : 'OFFLINE · static copy'}
        </span>
        <span className="muted text-[12px]">
          No auth on <code className="mono">/api/kanban/*</code>. Other <code className="mono">/api/*</code> paths proxy to OpenCode :4096 (Basic auth).
        </span>
      </div>

      {groups.map((g) => {
        const items = routes.filter(g.match);
        if (items.length === 0) return null;
        return (
          <section key={g.title} className="space-y-2">
            <h3 className="text-[13px] font-semibold t-soft mono uppercase" style={{ letterSpacing: '.06em' }}>{g.title}</h3>
            {items.map((r) => (
              <EndpointCard key={`${r.method} ${r.path}`} route={r} projectId={projectId} />
            ))}
          </section>
        );
      })}
    </div>
  );
}
