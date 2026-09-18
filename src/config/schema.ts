import { z } from 'zod';

export const RoleFileSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().min(1),
  system_prompt_ref: z.string().min(1),
  inputs: z.array(z.string()),
  outputs: z.array(z.string()).min(1),
  owns: z.array(z.string()),
  reads: z.array(z.string()),
  model: z.string().min(1),
  max_retries: z.number().int().nonnegative().default(2),
  max_wall_time_ms: z.number().int().positive(),
});
export type RoleFile = z.infer<typeof RoleFileSchema>;

export const WorkflowNodeFileSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  role: z.string().min(1),
  consumes: z.array(z.string()),
  produces: z.string().min(1),
  isolate: z.boolean(),
});

export const WorkflowEdgeFileSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  when: z.string().optional(),
});

export const WorkflowFileSchema = z.object({
  id: z.string().min(1),
  start: z.string().min(1),
  nodes: z.array(WorkflowNodeFileSchema).min(1),
  edges: z.array(WorkflowEdgeFileSchema),
});
export type WorkflowFile = z.infer<typeof WorkflowFileSchema>;