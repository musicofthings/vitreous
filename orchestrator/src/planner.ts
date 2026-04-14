import { randomUUID } from 'node:crypto';
import type { AgentRunRequest, StepPlan, ToolName } from './types.js';

export function buildPlan(agentId: string, req: AgentRunRequest): StepPlan[] {
  const upper = Math.min(Math.max(req.max_steps, 3), 5);
  const steps: StepPlan[] = [];
  const toolCycle: ToolName[] = req.tools;

  for (let i = 0; i < upper; i += 1) {
    const tool = toolCycle[i % toolCycle.length];
    steps.push({
      step_id: randomUUID(),
      step_order: i + 1,
      tool,
      payload: {
        goal: req.goal,
        instruction: `Execute stage ${i + 1} for agent ${agentId}`,
        context: { stage: i + 1 },
      },
    });
  }

  return steps;
}
