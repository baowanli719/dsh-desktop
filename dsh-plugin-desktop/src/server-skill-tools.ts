/**
 * Cordis Host plugin bridging server-executed skills to model-facing tools.
 *
 * `run_data_query` and `run_mcp_skill` — the names server-delivered SKILL.md
 * instructions reference — forward to `POST /api/v1/skills/:name/execute`
 * through the Host-owned gsclaw-server client. Both are Host-plane tools by
 * construction: they register into the root `ctx.tools` layer and their
 * executors run in the Electron main process, where the access token lives.
 * They never enter a sandbox tool subprocess, and renderer or model only ever
 * see arguments and normalized results.
 *
 * Visibility follows the live server catalog: a tool registers only while the
 * server advertises the matching `skillExecution` type AND the effective
 * catalog holds at least one available skill of that runtime type. A
 * `definition_changed` failure invalidates the catalog and asks the model to
 * reconstruct the call against the fresh definition; nothing is blind-replayed.
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { GsServerRuntimeType } from './server/gs-contract.ts'
import type { GsRequest } from './server/gs-client.ts'
import {
  GsSkillExecutionClient,
  type GsSkillExecuteOutcome,
} from './server/gs-skill-execution.ts'
import type { GsServerSkillCatalog } from './server-skill-provider.ts'

/** Stable Cordis plugin name. */
export const name = 'server-skill-tools'

/** The tool registry, the gsclaw-server client, and the live server catalog. */
export const inject = ['tools', 'gsServer', 'gsServerSkillCatalog']

/** Model-facing tool names; server-delivered SKILL.md instructions cite these. */
export const RUN_DATA_QUERY_TOOL = 'run_data_query'
export const RUN_MCP_SKILL_TOOL = 'run_mcp_skill'

/** Optional seams for host adapters and tests; the patch row passes no config. */
export interface Config {
  /** Fetch implementation override. */
  readonly request?: GsRequest
  /** Client-side execute ceiling in milliseconds. */
  readonly timeoutMs?: number
}

/** Canonical result value both bridge tools return on success. */
interface ServerToolValue {
  readonly text: string
  readonly truncated: boolean
  readonly traceId: string
  readonly requestId: string
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true },
    truncated: { type: 'boolean', required: true },
    traceId: { type: 'string', required: true },
    requestId: { type: 'string', required: true },
  },
} as const

/** Project one outcome into the canonical value, or throw the model-facing error. */
function outcomeValue(
  outcome: GsSkillExecuteOutcome,
  catalog: GsServerSkillCatalog,
): ServerToolValue {
  if (outcome.status === 'ok') {
    return {
      text: outcome.text,
      truncated: outcome.truncated,
      traceId: outcome.traceId,
      requestId: outcome.requestId,
    }
  }
  const suffix = outcome.traceId === undefined ? '' : ` [traceId: ${outcome.traceId}]`
  if (outcome.code === 'definition_changed') {
    // The served definition moved: refresh the catalog and make the model
    // reconstruct the call against the new definition instead of replaying.
    catalog.invalidate()
    throw new Error(
      `the skill definition changed on the server${suffix}; call the skill tool again to reload the skill, then reconstruct this call against the new definition`,
    )
  }
  throw new Error(`gsclaw-server skill execution failed (${outcome.code}): ${outcome.message}${suffix}`)
}

/** Model-facing text of one successful outcome. */
function renderValue(_args: unknown, value: ServerToolValue) {
  return [{
    type: 'text' as const,
    text: value.truncated
      ? `${value.text}\n\n[The server truncated this result; narrow the parameters if more rows are needed.]`
      : value.text,
  }]
}

/**
 * Register the bridge tools and keep their visibility in sync with the
 * effective server catalog published by server-skill-provider.
 * @param ctx - Host context; tools register globally and run on the Host plane.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const client = new GsSkillExecutionClient({
    endpoint: () => ctx.gsServer.endpoints.resolve(),
    session: ctx.gsServer.auth,
    ...(config.request === undefined ? {} : { request: config.request }),
  })
  const catalog = ctx.gsServerSkillCatalog

  const executeRemote = async (
    runtimeType: GsServerRuntimeType,
    skillName: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    sessionId: string | undefined,
  ): Promise<ServerToolValue> => {
    // The skill must belong to the current effective catalog of this runtime
    // type; the server re-checks authorization independently on every call.
    const entry = catalog.resolveRemote(skillName, runtimeType)
    if (entry === undefined) {
      throw new Error(
        `skill "${skillName}" is not an available ${runtimeType} skill in the current catalog; reload the available skills catalog and use a listed skill`,
      )
    }
    const outcome = await client.execute(skillName, {
      requestId: randomUUID(),
      ...(sessionId === undefined ? {} : { sessionId }),
      definitionRevision: entry.definitionRevision,
      arguments: args,
    }, { signal, ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }) })
    return outcomeValue(outcome, catalog)
  }

  const dataQueryTool = defineTool({
    name: RUN_DATA_QUERY_TOOL,
    description: 'Run one declared query template of a server-delivered data-query skill and return the rows as text. Load the skill with the skill tool first; use only template names and parameters its definition declares.',
    parameters: {
      skill: { type: 'string', required: true, description: 'Exact skill name from the available skills catalog.' },
      query: { type: 'string', required: true, description: 'Query template name declared by the skill definition.' },
      params: { type: 'object', additionalProperties: true, description: 'Template parameter values keyed by declared parameter name.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderValue },
    async execute(args, exec) {
      return executeRemote(
        'data-query',
        args.skill,
        { query: args.query, params: args.params ?? {} },
        exec.signal,
        exec.agent?.session.header.id,
      )
    },
    presentCall(args) {
      return { card: 'generic', title: `Run data query ${args.query}`, kind: 'read', rawInput: args.params }
    },
  })

  const mcpSkillTool = defineTool({
    name: RUN_MCP_SKILL_TOOL,
    description: 'Call one allowlisted tool of a server-delivered MCP skill and return its result as text. Load the skill with the skill tool first; use only tool names and argument shapes its definition declares.',
    parameters: {
      skill: { type: 'string', required: true, description: 'Exact skill name from the available skills catalog.' },
      tool: { type: 'string', required: true, description: 'MCP tool name declared by the skill definition.' },
      arguments: { type: 'object', additionalProperties: true, description: 'Tool arguments matching the declared input schema.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderValue },
    async execute(args, exec) {
      return executeRemote(
        'server-mcp',
        args.skill,
        { tool: args.tool, arguments: args.arguments ?? {} },
        exec.signal,
        exec.agent?.session.header.id,
      )
    },
    presentCall(args) {
      return { card: 'generic', title: `Run MCP tool ${args.tool}`, kind: 'read', rawInput: args.arguments }
    },
  })

  const definitions: ReadonlyMap<GsServerRuntimeType, ToolDefinition> = new Map([
    ['data-query', dataQueryTool],
    ['server-mcp', mcpSkillTool],
  ])
  const registrations = new Map<GsServerRuntimeType, () => void>()

  const reconcile = (): void => {
    const snapshot = catalog.snapshot()
    for (const [runtimeType, definition] of definitions) {
      const exposed = snapshot.supported
        && snapshot.types.includes(runtimeType)
        && snapshot.remotes.some(entry => entry.runtimeType === runtimeType)
      const dispose = registrations.get(runtimeType)
      if (exposed && dispose === undefined) {
        try {
          registrations.set(runtimeType, ctx.tools.register(definition))
        } catch (cause) {
          // A same-name tool from another layer must not crash the Host; the
          // bridge stays hidden and the next catalog change retries.
          ctx.logger.warn(
            `dsh-plugin-desktop: server skill tool ${definition.name} could not register: ${cause instanceof Error ? cause.message : String(cause)}`,
          )
        }
      } else if (!exposed && dispose !== undefined) {
        registrations.delete(runtimeType)
        dispose()
      }
    }
  }
  const unsubscribe = catalog.subscribe(reconcile)
  reconcile()
  ctx.effect(() => () => {
    unsubscribe()
    for (const dispose of registrations.values()) dispose()
    registrations.clear()
  }, 'dsh-plugin-desktop: server skill tool registrations')
}
