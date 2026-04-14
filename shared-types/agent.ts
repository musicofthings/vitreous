export type ScheduleMode = 'once' | 'continuous';

export interface AgentRunRequest {
  goal: string;
  tools: Array<'python' | 'browser' | 'api'>;
  max_steps: number;
  parallelism: number;
  schedule: ScheduleMode;
}

export interface AgentRunResponse {
  agent_id: string;
  status: 'queued';
}

export interface AgentQueuedMessage {
  type: 'agent_queued';
  agent_id: string;
  request: AgentRunRequest;
  created_at: string;
}

export interface StepTaskMessage {
  type: 'step_task';
  agent_id: string;
  step_id: string;
  tool: 'python' | 'browser' | 'api';
  payload: Record<string, unknown>;
  attempt: number;
}
