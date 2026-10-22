import type { Doc } from '@/doc';

/** The doc's name as a file name (characters file systems reject replaced). */
export const safeName = (doc: Doc) => doc.name.trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').slice(0, 80) || 'Untitled';
