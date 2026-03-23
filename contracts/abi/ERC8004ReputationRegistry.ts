/**
 * Minimal ERC-8004 Reputation Registry ABI used by local scripts.
 */
export const ERC8004ReputationRegistry = [
  {
    type: 'function',
    name: 'giveFeedback',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256', internalType: 'uint256' },
      { name: 'value', type: 'int128', internalType: 'int128' },
      { name: 'valueDecimals', type: 'uint8', internalType: 'uint8' },
      { name: 'tag1', type: 'string', internalType: 'string' },
      { name: 'tag2', type: 'string', internalType: 'string' },
      { name: 'endpoint', type: 'string', internalType: 'string' },
      { name: 'feedbackURI', type: 'string', internalType: 'string' },
      { name: 'feedbackHash', type: 'bytes32', internalType: 'bytes32' },
    ],
    outputs: [],
  },
] as const
