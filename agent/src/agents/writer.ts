'use agent';
import { defineTool, useModel, useTool, type AgentProps } from '@flue/runtime';
import { getConfig } from '../config.ts';
import { SPECS } from '../prompts/index.ts';
import { normalizeGenerated } from '../prompts/schemas.ts';
import { captures } from '../results.ts';

const spec = SPECS.generate;

export function Writer({ id }: AgentProps) {
  const cfg = getConfig();
  useModel(`anthropic/${spec.model(cfg)}`, { thinkingLevel: cfg.thinkingLevel });
  useTool(
    defineTool({
      name: spec.tool,
      description: spec.toolDescription,
      input: spec.schema,
      async run({ data }) {
        captures.set(id, normalizeGenerated(data as never));
        return { output: 'Saved.', terminate: true };
      },
    }),
  );
  return spec.prompt(cfg);
}
Writer.agentName = 'sharp-writer';
