export type ToolName = 'python' | 'browser' | 'api';

export interface AgentRunRequest {
  goal: string;
  tools: ToolName[];
  max_steps: number;
  parallelism: number;
  schedule: 'once' | 'continuous';
}

export interface StepPlan {
  step_id: string;
  step_order: number;
  tool: ToolName;
  payload: Record<string, unknown>;
}
