import type { AgentQueuedMessage, AgentRunRequest, AgentRunResponse } from '../../shared-types/agent';

export interface Env {
  AGENT_QUEUE: Queue;
  AGENT_STATE: DurableObjectNamespace;
  AUTH_TOKEN: string;
  ORCHESTRATOR_INGEST_URL?: string;
  ORCHESTRATOR_INGEST_TOKEN?: string;
}

const MAX_TOOLS = new Set(['python', 'browser', 'api']);

function validateRunRequest(input: unknown): AgentRunRequest {
  if (!input || typeof input !== 'object') throw new Error('invalid body');
  const data = input as Record<string, unknown>;

  const goal = String(data.goal ?? '').trim();
  const tools = Array.isArray(data.tools) ? data.tools : [];
  const maxSteps = Number(data.max_steps);
  const parallelism = Number(data.parallelism);
  const schedule = data.schedule;

  if (!goal) throw new Error('goal is required');
  if (!Array.isArray(tools) || tools.length === 0 || tools.some((t) => typeof t !== 'string' || !MAX_TOOLS.has(t))) {
    throw new Error('tools must include python/browser/api');
  }
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 50) throw new Error('max_steps must be 1..50');
  if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > 20) throw new Error('parallelism must be 1..20');
  if (schedule !== 'once' && schedule !== 'continuous') throw new Error('schedule must be once|continuous');

  return {
    goal,
    tools: tools as AgentRunRequest['tools'],
    max_steps: maxSteps,
    parallelism,
    schedule,
  };
}

function unauthorized() {
  return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
}

export class AgentStateDO extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/init') {
      const payload = await request.json<Record<string, unknown>>();
      await this.ctx.storage.put('state', {
        agent_id: payload.agent_id,
        status: 'queued',
        created_at: new Date().toISOString(),
        steps: [],
        outputs: {},
      });
      return Response.json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/step') {
      const step = await request.json<Record<string, unknown>>();
      const state = (await this.ctx.storage.get<Record<string, unknown>>('state')) ?? { steps: [], outputs: {} };
      const steps = Array.isArray(state.steps) ? state.steps : [];
      const outputs = (state.outputs as Record<string, unknown>) ?? {};
      steps.push(step);
      if (typeof step.step_id === 'string') outputs[step.step_id] = step.output;
      const nextState = { ...state, steps, outputs, updated_at: new Date().toISOString() };
      await this.ctx.storage.put('state', nextState);
      return Response.json({ ok: true });
    }

    if (request.method === 'GET' && url.pathname === '/state') {
      const state = await this.ctx.storage.get('state');
      return Response.json(state ?? {});
    }

    return new Response('not found', { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/agents/run') {
      if (request.headers.get('authorization') !== `Bearer ${env.AUTH_TOKEN}`) return unauthorized();

      try {
        const runRequest = validateRunRequest(await request.json());
        const agentId = crypto.randomUUID();
        const id = env.AGENT_STATE.idFromName(agentId);
        const stateStub = env.AGENT_STATE.get(id);

        await stateStub.fetch('https://do/init', {
          method: 'POST',
          body: JSON.stringify({ agent_id: agentId }),
        });

        const message: AgentQueuedMessage = {
          type: 'agent_queued',
          agent_id: agentId,
          request: runRequest,
          created_at: new Date().toISOString(),
        };

        await env.AGENT_QUEUE.send(message);

        const response: AgentRunResponse = { agent_id: agentId, status: 'queued' };
        return Response.json(response, { status: 202 });
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 400 });
      }
    }

    if (request.method === 'GET' && url.pathname.startsWith('/agents/')) {
      const agentId = url.pathname.split('/')[2];
      if (!agentId) return new Response('bad request', { status: 400 });
      const id = env.AGENT_STATE.idFromName(agentId);
      const stateStub = env.AGENT_STATE.get(id);
      return stateStub.fetch('https://do/state');
    }

    return new Response('not found', { status: 404 });
  },

  async queue(batch: MessageBatch<AgentQueuedMessage>, env: Env): Promise<void> {
    if (!env.ORCHESTRATOR_INGEST_URL) {
      for (const msg of batch.messages) msg.retry();
      return;
    }

    await Promise.all(batch.messages.map(async (msg) => {
      try {
        const response = await fetch(`${env.ORCHESTRATOR_INGEST_URL}/queue/agent`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(env.ORCHESTRATOR_INGEST_TOKEN ? { authorization: `Bearer ${env.ORCHESTRATOR_INGEST_TOKEN}` } : {}),
          },
          body: JSON.stringify(msg.body),
        });
        if (!response.ok) throw new Error(`ingest failed: ${response.status}`);
        msg.ack();
      } catch {
        msg.retry();
      }
    }));
  },
};
