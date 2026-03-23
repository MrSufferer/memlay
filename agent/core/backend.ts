import type {
    MemoryEntryData,
    ToolRequest,
    ToolResponse,
} from '../../cre-memoryvault/protocol/tool-interface'

export interface AgentToolRuntime {
    scan(toolId: string): Promise<ToolResponse | null>
    monitor(toolId: string): Promise<ToolResponse | null>
}

export interface AgentMemoryRuntime {
    commitEntry(args: {
        agentId: string
        entryKey: string
        entryData: MemoryEntryData
    }): Promise<void>
}

export interface AgentExecutionRuntime {
    enterPosition(args: {
        toolId: string
        request: ToolRequest
    }): Promise<void>
    exitPosition(args: {
        toolId: string
        request: ToolRequest
    }): Promise<void>
}

export interface AgentBackend {
    target: string
    label: string
    tools: AgentToolRuntime
    memory: AgentMemoryRuntime
    execution: AgentExecutionRuntime
}
