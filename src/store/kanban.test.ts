import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.') && (error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url.endsWith('/src/store/kanban.ts')) {
      const source = typeof loaded.source === 'string' ? loaded.source : new TextDecoder().decode(loaded.source);
      return { ...loaded, source: source.replace("import { Task, Project, TaskStatus, TaskPriority } from '../types';", "import type { Task, Project, TaskStatus, TaskPriority } from '../types';") };
    }
    return loaded;
  },
});

const { clearQueue, listOps } = await import('./offlineQueue.ts');
const { getProjects, getTasks, isServerDown, pollDelayMs, updateProject } = await import('./kanban.ts');

const project = { id: 'p1', name: 'Before', path: 'p1', description: '', agentIds: [], createdAt: 'now' };

function withBrowserStubs(run: () => Promise<void>, projects: unknown[] = [], tasks: unknown[] = []) {
  const oldFetch = globalThis.fetch;
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const data = new Map<string, string>([
    ['kanban_projects', JSON.stringify(projects)],
    ['kanban_tasks', JSON.stringify(tasks)],
  ]);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
      removeItem: (key: string) => data.delete(key),
    },
  });
  return run().finally(() => {
    globalThis.fetch = oldFetch;
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
    clearQueue();
  });
}

test('API transport errors trigger backoff and cached reads', async () => withBrowserStubs(async () => {
  globalThis.fetch = async () => Response.json([project]);
  await getProjects();
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  assert.deepEqual(await getProjects(), [project]);
  assert.deepEqual(await getTasks(), []);
  assert.equal(pollDelayMs(100, 1000), 200);
  assert.equal(isServerDown(), true);
} , [project]));

test('HTTP errors do not trigger network backoff', async () => withBrowserStubs(async () => {
  globalThis.fetch = async () => Response.json([project]);
  await getProjects();
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'denied' }), { status: 403 });
  await getProjects();
  assert.equal(isServerDown(), false);
  assert.equal(pollDelayMs(100), 100);
}));

test('poll delay doubles and stops at its maximum', async () => withBrowserStubs(async () => {
  globalThis.fetch = async () => Response.json([project]);
  await getProjects();
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  await getProjects();
  await getProjects();
  await getProjects();
  assert.equal(pollDelayMs(100, 250), 250);
}));

test('updateProject patches and returns the cached row when offline', async () => withBrowserStubs(async () => {
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  const result = await updateProject('p1', { name: 'After' });
  assert.deepEqual(result, { ...project, name: 'After' });
}, [project]));

test('createTask queues a transport failure and marks the cached task pending', async () => withBrowserStubs(async () => {
  const { createTask } = await import('./kanban.ts');
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  await assert.rejects(createTask('p1', 'Queued', '', 'medium', undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'client-1'), /queued/i);
  assert.equal(listOps().length, 1);
  assert.equal(listOps()[0]?.kind, 'create');
}, [project]));
