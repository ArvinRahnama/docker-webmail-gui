import { VERSION } from '@dwg/shared';

// Trivial startup stub for milestone M1. Real bootstrapping — config
// loading, logging with redaction, SQLite + migrations, the Fastify
// instance itself — lands at M2 (IMPLEMENTATION_PLAN.md §3). This file
// exists only so the workspace has a real entry point to typecheck,
// build and run.
console.log(`@dwg/server starting (shared v${VERSION})`);
