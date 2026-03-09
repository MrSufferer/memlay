# MemoryVault Agent Protocol — Investor Demo

A minimal React/TypeScript frontend that visualizes verifiable MemoryVault commits and custom HTTP alpha for CLMM rebalancing, aligned with the MemoryVault Agent Protocol.

## Quick Start

```bash
cd por/memoryvault-frontend-demo
npm install
npm run dev
```

The demo runs entirely in the browser using local fixtures—no backend required.

## Demo Script for Live Pitches

**Time: 5-7 minutes** | **Audience: Investors evaluating the MemoryVault Agent Protocol**

### Step 1: Set the Stage (30 seconds)

**What to say:**
> "This demo shows two critical guarantees of the MemoryVault Agent Protocol: **verifiable memory before action** and **pluggable private alpha**. We're using a single CLMM rebalancing scenario as a concrete example, but the same pattern applies to any DeFi strategy."

**What to show:**
- Point to the header: "Verifiable memory before action"
- Explain that this prevents agents from going rogue because every decision is committed to an immutable audit log before funds move

### Step 2: Walk Through the CLMM Scenario (2 minutes)

**What to say:**
> "Let's watch the agent evaluate a CLMM opportunity. Notice the four-step process—this is the memory-before-action guarantee in action."

**Actions:**
1. Click "Next step" to move from **"Opportunity detected"** → **"Risk analysis running"**
   - Explain: "The agent is scoring this opportunity using public on-chain data plus any private alpha feeds you've configured."
2. Click "Next step" to move to **"Reasoning committed to MemoryVault"**
   - **Emphasize**: "🔒 This is the critical step. The agent commits its reasoning and decision to MemoryVault, creating a verifiable, tamper-evident record. This happens **before** any execution."
3. Click "Next step" to move to **"CLMM rebalance executed"**
   - Explain: "Only after the reasoning is locked in MemoryVault does the agent execute. You can always audit what the agent decided and why."

**Key message:** The "after" position only appears after reasoning is committed. This enforces memory-before-action—no execution without a verifiable audit trail.

### Step 3: Show the Reasoning Panel (1 minute)

**What to say:**
> "This is how the Risk Analysis Skill evaluates opportunities. Notice it uses both public data and your private HTTP alpha feeds."

**What to point out:**
- **Public inputs**: On-chain data from Uniswap V3 subgraph (TVL, fee APR, pool metrics)
- **Private HTTP alpha**: Your custom endpoints (if configured)
- The scores (risk level, opportunity score, trust score) are influenced by both

**Key message:** You can make the agent smarter by plugging in your own data sources.

### Step 4: Review the MemoryVault Timeline (1 minute)

**What to say:**
> "This is the verifiable audit trail. Notice the chronological order—the decision and reasoning are committed **before** execution."

**What to point out:**
- The three events: `scan-result` → `rebalancing-decision` → `rebalancing-executed`
- The "🔒 committed before action" badge on the decision entry
- The timestamps showing the sequence
- If private alpha sources are configured, they're mentioned in the decision entry

**Key message:** This tamper-evident log is anchored on-chain, so you can always verify what the agent decided and when.

### Step 5: Configure Private Alpha (1-2 minutes)

**What to say:**
> "Let's add a custom HTTP alpha source. This is how you plug your own data into the agent's decision-making."

**Actions:**
1. In the "Your Private HTTP Alpha Sources" panel, fill in:
   - **Name**: "My Research Feed" (optional)
   - **HTTP URL**: `https://api.example.com/clmm-signals`
   - **API key label**: `MY_RESEARCH_API_KEY`
2. Click "Add alpha source"
3. Point out that it now appears in:
   - The Reasoning Panel under "Private HTTP alpha"
   - The Memory Timeline in the decision entry

**What to say:**
> "In the real protocol, these endpoints are called via `ConfidentialHTTPClient` with API keys stored securely in your trader template. The agent treats them as confidential inputs when scoring opportunities."

**Key message:** You can make the agent smarter with your own proprietary data sources.

### Closing (30 seconds)

**What to say:**
> "This demo shows the two core guarantees: **verifiable memory before action** prevents rogue behavior, and **pluggable private alpha** makes the agent smarter with your data. The same pattern applies to any DeFi strategy—not just CLMM rebalancing."

**Questions to anticipate:**
- "How is this different from other AI agents?" → **Answer**: The memory-before-action guarantee is enforced at the protocol level, not just a best practice.
- "Can I audit historical decisions?" → **Answer**: Yes, the audit-reader workflow lets you verify the complete decision log for any agent.
- "What if the agent makes a bad decision?" → **Answer**: You can see exactly what it decided and why, because the reasoning is committed before execution.

## Technical Details

### Architecture

- **Frontend-only**: Runs entirely in the browser using local fixtures
- **Protocol-aligned**: View models match the MemoryVault Agent Protocol semantics
- **Future-ready**: Optional real-data hooks for connecting to agent/audit endpoints

### Data Sources

By default, the demo uses fixtures defined in `src/fixtures/clmmOpportunity.ts`. To enable real data:

1. Set environment variables:
   ```bash
   VITE_USE_REAL_DATA=true
   VITE_AGENT_SERVICE_URL=https://your-agent-service.com/opportunities
   VITE_AUDIT_READER_URL=https://your-audit-reader.com
   VITE_API_KEY=your-api-key  # Optional
   ```

2. Or enable at runtime:
   ```typescript
   import { setRealDataMode } from './config'
   setRealDataMode(true, {
     agentServiceUrl: 'https://...',
     auditReaderUrl: 'https://...',
   })
   ```

See `src/data/realDataAdapter.ts` for the data layer implementation.

### Project Structure

```
src/
  components/          # React components (CLMMScenarioPanel, ReasoningPanel, etc.)
  fixtures/            # Mock data fixtures
  types/               # TypeScript view models (aligned with protocol)
  data/                # Real data adapter (optional)
  config.ts            # Configuration and feature flags
  demoState.tsx        # React context for demo state
```

## Development

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## Related Documentation

- **Requirements**: `docs/ai/requirements/feature-memoryvault-frontend-demo.md`
- **Design**: `docs/ai/design/feature-memoryvault-frontend-demo.md`
- **Planning**: `docs/ai/planning/feature-memoryvault-frontend-demo.md`
- **Protocol**: `docs/ai/requirements/feature-memoryvault-agent-protocol.md`
