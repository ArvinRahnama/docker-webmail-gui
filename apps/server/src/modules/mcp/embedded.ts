/**
 * Starts the MCP integration inside this process unless `MCP_ENABLED=false`
 * (docs/mcp-integration.md). There is no separate MCP
 * container: the MCP component's public listener (OAuth + MCP, its own
 * port) runs here, and the panel reaches its control API in-process.
 *
 * The MCP component keeps its own SQLite database (under `DATA_DIR/mcp` by
 * default), its own logger with its own redaction list, and its own
 * vault key file; it never touches the panel's database or the broker.
 */
import { join } from 'node:path';
import type { Logger } from 'pino';
import { loadMcpConfig, startEmbeddedMcp, type EmbeddedMcp } from '@dwg/mcp';
import type { AppConfig } from '../../platform/config.js';
import {
  EmbeddedMcpControlClient,
  type McpControlClient,
} from '../../drivers/mcp-control/index.js';

export interface McpIntegration {
  readonly mcp: EmbeddedMcp;
  readonly client: McpControlClient;
}

/**
 * Returns `null` when the integration is off. Throws `McpConfigError` (from
 * `@dwg/mcp`) when it is on but misconfigured — the caller refuses to start
 * rather than run without it.
 */
export async function startMcpIntegration(
  config: AppConfig,
  logger: Logger,
  env: NodeJS.ProcessEnv = process.env,
): Promise<McpIntegration | null> {
  if (!config.mcp.enabled) {
    logger.info('MCP integration: off (MCP_ENABLED=false)');
    return null;
  }
  const mcpConfig = loadMcpConfig(env, {
    defaultDataDir: join(config.dataDir, 'mcp'),
    // On by default means it must start on an install that never mounted
    // a vault key (plain compose.yaml, a self-updated container).
    generateMissingVaultKey: true,
  });
  const mcp = await startEmbeddedMcp({ config: mcpConfig });
  logger.info(
    { listener: mcpConfig.publicListener, mailBackend: mcpConfig.mailBackend },
    'MCP integration: enabled',
  );
  return { mcp, client: new EmbeddedMcpControlClient(mcp.control) };
}
