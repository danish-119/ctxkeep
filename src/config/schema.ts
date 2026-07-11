import { z } from 'zod';

/**
 * .ctxkeep/config.yaml — Milestone 2 subset only (build spec §4 Milestone 2).
 * Matches the shape of architecture-plan.md §24, but deliberately omits
 * fields nothing reads yet (token_budgets, review_policy, triggers, other
 * adapters). Add a field here only once something in the CLI actually
 * consumes it — an unread config field is a lie about what the tool does.
 */
export const ConfigSchema = z.object({
  adapters: z.object({
    claude: z.object({
      enabled: z.boolean().default(true),
    }),
  }),
  modules: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
    }),
  ),
  ignore: z.array(z.string()).default([]),
});

export type Config = z.infer<typeof ConfigSchema>;
