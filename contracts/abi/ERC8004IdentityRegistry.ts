/**
 * Minimal ERC-8004 Identity Registry ABI used by local scripts.
 */
export const ERC8004IdentityRegistry = [
  {
    type: 'function',
    name: 'register',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentURI', type: 'string', internalType: 'string' },
    ],
    outputs: [
      { name: 'agentId', type: 'uint256', internalType: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'setAgentURI',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256', internalType: 'uint256' },
      { name: 'newURI', type: 'string', internalType: 'string' },
    ],
    outputs: [],
  },
] as const
