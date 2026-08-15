import { VERSION } from '@dwg/shared';

// Trivial startup stub for milestone M1. The real broker — operation
// enum, Zod-validated per-operation schemas, container allowlist, the
// dockerode client — lands at M4 (IMPLEMENTATION_PLAN.md §3). Kept
// deliberately minimal even as a placeholder: this process is a privilege
// boundary, and every line added to it is a security-relevant change
// (ARCHITECTURE.md §11, SECURITY.md §4.1).
console.log(`@dwg/broker starting (shared v${VERSION})`);
