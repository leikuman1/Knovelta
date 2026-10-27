import { z } from 'zod';

export const idSchema = z.string().uuid();
export const proposalSchema = z.object({
  action: z.enum(['CREATE', 'UPDATE', 'FLAG_CONFLICT']),
  targetNoteId: idSchema.nullable(),
  baseVersion: z.number().int().positive().nullable(),
  proposedTitle: z.string().trim().min(1).max(200),
  proposedContent: z.string().min(1).max(100_000),
  sourceIds: z.array(idSchema).min(1).max(100),
  reason: z.string().trim().min(1).max(4000),
}).strict().superRefine((v, ctx) => {
  if (v.action === 'CREATE' ? v.targetNoteId !== null || v.baseVersion !== null : v.targetNoteId === null || v.baseVersion === null) {
    ctx.addIssue({ code: 'custom', message: '动作、目标和基础版本不匹配' });
  }
});
export const chatSchema = z.object({ message: z.string().trim().min(1).max(20_000), requestId: idSchema }).strict();
export const approveSchema = z.object({ expectedVersion: z.number().int().nonnegative() }).strict();
export const restoreSchema = z.object({ version: z.number().int().positive(), expectedVersion: z.number().int().positive() }).strict();
export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export function requireId(id: string) {
  if (!idSchema.safeParse(id).success) throw new AppError('INVALID_ID', '无效的对象 ID');
  return id;
}
