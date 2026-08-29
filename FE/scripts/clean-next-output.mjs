import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Chỉ xóa output do Next.js sinh ra trước một phiên build/dev mới để không phục vụ bundle cũ.
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const nextOutputDirectory = path.resolve(scriptDirectory, '..', '.next');

await rm(nextOutputDirectory, { recursive: true, force: true });
