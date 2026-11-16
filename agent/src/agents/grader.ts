'use agent';
import { defineTool, useModel, useTool, type AgentProps } from '@flue/runtime';
import { getConfig } from '../config.ts';
import { SPECS } from '../prompts/index.ts';
import { captures } from '../results.ts';

const spec = SPECS.grade;

export function Grader({ id }: AgentProps) {
  const cfg = getConfig();
  useModel(`anthropic/${spec.model(cfg)}`, { thinkingLevel: cfg.thinkingLevel });
  useTool(
    defineTool({
      name: spec.tool,
      description: spec.toolDescription,
      input: spec.schema,
      async run({ data }) {
        captures.set(id, data);
        return { output: 'Saved.', terminate: true };
      },
    }),
  );
  return spec.prompt(cfg);
}
Grader.agentName = 'sharp-grader';
