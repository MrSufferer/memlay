export interface WorkflowIdMap {
    scanner?: string
    monitor?: string
    memoryWriter?: string
    auditReader?: string
}

export function loadWorkflowIdsFromEnv(): WorkflowIdMap {
    return {
        scanner: process.env.CRE_WORKFLOW_ID_SCANNER,
        monitor: process.env.CRE_WORKFLOW_ID_MONITOR,
        memoryWriter: process.env.CRE_WORKFLOW_ID_MEMORY_WRITER,
        auditReader: process.env.CRE_WORKFLOW_ID_AUDIT_READER,
    }
}

export function normalizeWorkflowId(workflowId: string): string {
    return workflowId.startsWith('0x') ? workflowId.slice(2) : workflowId
}
