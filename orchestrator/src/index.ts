import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pino from 'pino';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { query } from './db.js';
import { buildPlan } from './planner.js';
import { nextBackoffMs } from './retry.js';
import type { AgentRunRequest } from './types.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

function checkIngestAuth(req: express.Request): boolean {
  const token = process.env.INGEST_TOKEN;
  if (!token) return true;
  return req.headers.authorization === `Bearer ${token}`;
}


const agentQueuedSchema = z.object({
  type: z.literal('agent_queued'),
  agent_id: z.string().uuid(),
  request: z.object({
    goal: z.string().min(1),
    tools: z.array(z.enum(['python', 'browser', 'api'])).min(1),
    max_steps: z.number().int().min(1).max(50),
    parallelism: z.number().int().min(1).max(20),
    schedule: z.enum(['once', 'continuous']),
  }),
});

app.get('/health', async (_req, res) => {
  await query('SELECT 1');
  res.json({ ok: true });
});

app.post('/queue/agent', async (req, res) => {
  if (!checkIngestAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  const parsed = agentQueuedSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const msg = parsed.data;
  const run = msg.request as AgentRunRequest;

  await query(
    `INSERT INTO agents (agent_id, goal, status, tools, max_steps, parallelism, schedule)
     VALUES ($1,$2,'planning',$3::jsonb,$4,$5,$6)
     ON CONFLICT (agent_id) DO NOTHING`,
    [msg.agent_id, run.goal, JSON.stringify(run.tools), run.max_steps, run.parallelism, run.schedule],
  );

  const steps = buildPlan(msg.agent_id, run);
  for (const step of steps) {
    await query(
      `INSERT INTO steps (step_id, agent_id, step_order, tool, payload, status, next_run_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,'queued',NOW())
       ON CONFLICT (step_id) DO NOTHING`,
      [step.step_id, msg.agent_id, step.step_order, step.tool, JSON.stringify(step.payload)],
    );
  }

  await query(`UPDATE agents SET status='running', updated_at=NOW() WHERE agent_id=$1`, [msg.agent_id]);
  await addEvent(msg.agent_id, null, 'info', 'agent_planned', { steps: steps.length });

  log.info({ agent_id: msg.agent_id, steps: steps.length }, 'agent planned');
  return res.status(202).json({ accepted: true, steps: steps.length });
});

app.post('/nodes/register', async (req, res) => {
  const body = z
    .object({
      node_id: z.string().min(2),
      callback_url: z.string().url(),
      capabilities: z.array(z.enum(['python', 'browser', 'api'])).default(['python']),
    })
    .parse(req.body);

  await query(
    `INSERT INTO node_registrations (node_id, callback_url, capabilities, last_seen)
     VALUES ($1,$2,$3::jsonb,NOW())
     ON CONFLICT (node_id)
     DO UPDATE SET callback_url=EXCLUDED.callback_url, capabilities=EXCLUDED.capabilities, last_seen=NOW()`,
    [body.node_id, body.callback_url, JSON.stringify(body.capabilities)],
  );

  res.json({ ok: true });
});

app.post('/tasks/poll', async (req, res) => {
  const body = z.object({ node_id: z.string() }).parse(req.body);

  const node = await query<{ capabilities: string[] }>('SELECT capabilities FROM node_registrations WHERE node_id=$1', [body.node_id]);
  if (!node.rowCount) return res.status(404).json({ error: 'node not registered' });

  const capabilities = node.rows[0].capabilities;
  const step = await query<{
    step_id: string;
    agent_id: string;
    tool: string;
    payload: Record<string, unknown>;
    attempt: number;
  }>(
    `UPDATE steps s
      SET status='running', started_at=NOW(), attempt=attempt + 1
     WHERE s.step_id = (
      SELECT step_id FROM steps
      WHERE status='queued' AND next_run_at <= NOW() AND tool = ANY($1::text[])
      ORDER BY step_order ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
     )
     RETURNING step_id, agent_id, tool, payload, attempt`,
    [capabilities],
  );

  await query(`UPDATE node_registrations SET last_seen=NOW() WHERE node_id=$1`, [body.node_id]);

  if (!step.rowCount) return res.json({ task: null });
  return res.json({ task: step.rows[0] });
});

app.post('/tasks/:stepId/result', async (req, res) => {
  const stepId = req.params.stepId;
  const body = z
    .object({
      status: z.enum(['success', 'failed']),
      output: z.record(z.any()).optional(),
      error: z.string().optional(),
    })
    .parse(req.body);

  const stepResult = await query<{ agent_id: string; attempt: number; max_attempts: number }>(
    `SELECT agent_id, attempt, max_attempts FROM steps WHERE step_id=$1`,
    [stepId],
  );
  if (!stepResult.rowCount) return res.status(404).json({ error: 'step not found' });

  const step = stepResult.rows[0];

  if (body.status === 'success') {
    await query(
      `UPDATE steps SET status='success', output=$2::jsonb, finished_at=NOW(), last_error=NULL WHERE step_id=$1`,
      [stepId, JSON.stringify(body.output ?? {})],
    );
    await addEvent(step.agent_id, stepId, 'info', 'step_succeeded', body.output ?? {});
  } else {
    if (step.attempt < step.max_attempts) {
      const delayMs = nextBackoffMs(step.attempt);
      await query(
        `UPDATE steps
         SET status='queued', last_error=$2, next_run_at=NOW() + ($3 || ' milliseconds')::interval
         WHERE step_id=$1`,
        [stepId, body.error ?? 'unknown failure', String(delayMs)],
      );
      await addEvent(step.agent_id, stepId, 'warn', 'step_retry_scheduled', { delay_ms: delayMs, error: body.error });
    } else {
      await query(
        `UPDATE steps SET status='dead_letter', last_error=$2, finished_at=NOW() WHERE step_id=$1`,
        [stepId, body.error ?? 'unknown failure'],
      );
      await addEvent(step.agent_id, stepId, 'error', 'step_dead_letter', { error: body.error });
    }
  }

  await closeAgentIfDone(step.agent_id);
  return res.json({ ok: true });
});

app.get('/agents/:agentId', async (req, res) => {
  const agentId = req.params.agentId;
  const agent = await query('SELECT * FROM agents WHERE agent_id=$1', [agentId]);
  const steps = await query('SELECT * FROM steps WHERE agent_id=$1 ORDER BY step_order ASC', [agentId]);
  const events = await query('SELECT * FROM execution_events WHERE agent_id=$1 ORDER BY id ASC LIMIT 200', [agentId]);
  res.json({ agent: agent.rows[0] ?? null, steps: steps.rows, events: events.rows });
});

async function closeAgentIfDone(agentId: string) {
  const pending = await query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM steps
     WHERE agent_id=$1 AND status IN ('queued','running')`,
    [agentId],
  );
  if (Number(pending.rows[0].count) > 0) return;

  const dead = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM steps WHERE agent_id=$1 AND status='dead_letter'`,
    [agentId],
  );
  const finalStatus = Number(dead.rows[0].count) > 0 ? 'failed' : 'completed';
  await query(`UPDATE agents SET status=$2, updated_at=NOW() WHERE agent_id=$1`, [agentId, finalStatus]);
  await addEvent(agentId, null, 'info', 'agent_finished', { status: finalStatus });
}

async function addEvent(agentId: string, stepId: string | null, level: string, eventType: string, payload: Record<string, unknown>) {
  await query(
    `INSERT INTO execution_events (agent_id, step_id, level, event_type, payload)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [agentId, stepId, level, eventType, JSON.stringify(payload)],
  );
}

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => log.info({ port, node: randomUUID().slice(0, 8) }, 'orchestrator started'));
