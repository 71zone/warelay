import { z } from 'zod';

const rawBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('markdown'), text: z.string() }),
  z.object({ type: z.literal('draft'), title: z.string().optional(), text: z.string() }),
  z.object({ type: z.literal('code'), language: z.string().nullable(), code: z.string() }),
  z.object({ type: z.literal('table'), header: z.array(z.string()), rows: z.array(z.array(z.string())) }),
  z.object({ type: z.literal('asset'), id: z.number() }),
]);

/**
 * What an extraction script returns: display-ordered blocks where images and files are still unfetched `asset` placeholders, and `shots`, the
 * tables and cards on the page (stamped `data-wab-shot`) that the adapter may screenshot, each pointing at its `table` block by index.
 */
export const extraction = z.object({
  url: z.string(),
  text: z.string(),
  blocks: z.array(rawBlock),
  assets: z.array(z.object({ id: z.number(), kind: z.enum(['image', 'file']), name: z.string() })),
  shots: z.array(z.object({ id: z.number(), kind: z.enum(['table', 'card']), block: z.number() })).default([]),
});
export type Extraction = z.infer<typeof extraction>;
