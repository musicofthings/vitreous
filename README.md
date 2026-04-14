# Agent Infrastructure as a Service (MVP)

Production-ready MVP for distributed autonomous-agent execution using Cloudflare edge primitives + Node orchestrator + Python execution nodes.

## Architecture

- **Edge Layer**: Cloudflare Worker API ingress (`POST /agents/run`).
- **Queue/Event Layer**: Cloudflare Queue (`agent-jobs`) for enqueueing new agent jobs.
- **Stateful Coordination**: Durable Object per `agent_id` stores active state and intermediate outputs.
- **Orchestrator**: TypeScript service handles planning, dispatch, retries, dead-letter handling, and timeline.
- **Execution Nodes**: FastAPI Python worker polls tasks and executes tool calls (`python`, `browser`, `api`).
- **Persistence**: PostgreSQL stores durable execution history and status.
- **Observability**: `execution_events` timeline + structured logs.

---

## Repo structure

- `edge-worker/` Cloudflare Worker + Durable Object.
- `orchestrator/` Node.js orchestrator with Postgres persistence.
- `node-worker/` Python execution worker (local/Colab compatible).
- `shared-types/` shared TypeScript interfaces.

---

## 1) Deploy Edge Worker (Cloudflare)

### Prerequisites

- Cloudflare account
- `wrangler` authenticated (`wrangler login`)

### Configure queue and worker

1. Create queue:

```bash
wrangler queues create agent-jobs
```

2. Edit `edge-worker/wrangler.toml` and set `AUTH_TOKEN`.
3. Deploy:

```bash
cd edge-worker
npm install
npm run deploy
```

### Required bindings

- Queue producer: `AGENT_QUEUE`
- Durable Object namespace: `AGENT_STATE`

---

## 2) Run Orchestrator locally

### Environment

Create `orchestrator/.env`:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/agent_iaas
REDIS_URL=redis://localhost:6379
PORT=8080
LOG_LEVEL=info
```

> Redis is optional for this MVP; Postgres is required.

### Setup and start

```bash
cd orchestrator
npm install
psql "$DATABASE_URL" -f sql/schema.sql
npm run dev
```

### Main orchestrator endpoints

- `POST /queue/agent` – ingest edge-queued agent message.
- `POST /nodes/register` – execution node registration.
- `POST /tasks/poll` – node pulls next runnable step.
- `POST /tasks/:stepId/result` – node posts tool result.
- `GET /agents/:agentId` – full state + steps + timeline.

---

## 3) Run Node Worker locally

Create `node-worker/.env`:

```bash
ORCHESTRATOR_URL=http://localhost:8080
NODE_ID=node-local-1
NODE_URL=http://localhost:8090
POLL_INTERVAL_SECONDS=2
ALLOWED_TOOLS=python,browser,api
ALLOW_NETWORK=false
# OPENAI_API_KEY=...
```

Start:

```bash
cd node-worker
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8090
```

---

## 4) Run Node Worker on Google Colab

In Colab cell:

```bash
!git clone <your-repo-url>
%cd vitreous/node-worker
!bash scripts/run_colab.sh
```

Set env vars before running:

```python
import os
os.environ["ORCHESTRATOR_URL"] = "https://your-orchestrator-host"
os.environ["NODE_ID"] = "colab-node-1"
os.environ["NODE_PORT"] = "8090"
os.environ["NODE_URL"] = "https://<ngrok-id>.ngrok-free.app"
os.environ["ALLOW_NETWORK"] = "true"
```

Then call register endpoint automatically via worker startup.

---

## 5) End-to-end flow

1. User sends `POST /agents/run` to Worker.
2. Worker validates/authenticates request.
3. Worker initializes Durable Object state.
4. Worker pushes `agent_queued` message into Cloudflare Queue.
5. Queue consumer forwards message to orchestrator `POST /queue/agent`.
6. Orchestrator builds 3–5 step plan and stores state in Postgres.
7. Node workers poll orchestrator and execute tool steps.
8. Results are posted back to orchestrator; retries/dead-letter handled.
9. Agent final status and timeline available via `GET /agents/:agentId`.

---

## 6) Sample API payloads

### A) Public API request (Edge Worker)

```bash
curl -X POST "https://<worker-url>/agents/run" \
  -H "Authorization: Bearer replace-me" \
  -H "Content-Type: application/json" \
  -d '{
    "goal": "Research competitor pricing and summarize key deltas",
    "tools": ["browser", "api", "python"],
    "max_steps": 5,
    "parallelism": 2,
    "schedule": "once"
  }'
```

Response:

```json
{
  "agent_id": "b9f2f5f8-4f96-4d0d-a7ce-3c1f5f8d2f67",
  "status": "queued"
}
```

### B) Queue consumer payload to orchestrator (`POST /queue/agent`)

```json
{
  "type": "agent_queued",
  "agent_id": "b9f2f5f8-4f96-4d0d-a7ce-3c1f5f8d2f67",
  "created_at": "2026-04-14T10:00:00.000Z",
  "request": {
    "goal": "Research competitor pricing and summarize key deltas",
    "tools": ["browser", "api", "python"],
    "max_steps": 5,
    "parallelism": 2,
    "schedule": "once"
  }
}
```

---

## 7) Reliability and security implemented

- Per-step retries with exponential backoff (`max_attempts=3`).
- Dead-letter state (`steps.status = dead_letter`) when retries exhausted.
- Idempotent inserts via `ON CONFLICT DO NOTHING`.
- Step timeout boundary via node HTTP timeouts.
- Python sandbox with restricted builtins.
- Browser tool network access gated with `ALLOW_NETWORK` flag.

---

## 8) Env variable matrix

### Edge

- `AUTH_TOKEN`
- `AGENT_QUEUE` (binding)
- `AGENT_STATE` (Durable Object binding)

### Orchestrator

- `DATABASE_URL`
- `REDIS_URL` (optional)
- `PORT`
- `LOG_LEVEL`

### Node worker

- `ORCHESTRATOR_URL`
- `NODE_ID`
- `NODE_URL`
- `POLL_INTERVAL_SECONDS`
- `ALLOWED_TOOLS`
- `ALLOW_NETWORK`
- `OPENAI_API_KEY` (optional)
