/**
 * MemoryRegistry ABI — TypeScript const export for viem
 *
 * Generated from contracts/src/MemoryRegistry.sol
 * Used by: audit-reader, integrity-checker, and agent service CRE workflows
 */
export const MemoryRegistry = [
    {
        "inputs": [
            {
                "internalType": "address",
                "name": "forwarderAddress",
                "type": "address"
            }
        ],
        "stateMutability": "nonpayable",
        "type": "constructor"
    },
    {
        "inputs": [
            {
                "internalType": "address",
                "name": "received",
                "type": "address"
            },
            {
                "internalType": "address",
                "name": "expected",
                "type": "address"
            }
        ],
        "name": "InvalidAuthor",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "InvalidForwarderAddress",
        "type": "error"
    },
    {
        "inputs": [
            {
                "internalType": "address",
                "name": "sender",
                "type": "address"
            },
            {
                "internalType": "address",
                "name": "expected",
                "type": "address"
            }
        ],
        "name": "InvalidSender",
        "type": "error"
    },
    {
        "inputs": [
            {
                "internalType": "bytes32",
                "name": "received",
                "type": "bytes32"
            },
            {
                "internalType": "bytes32",
                "name": "expected",
                "type": "bytes32"
            }
        ],
        "name": "InvalidWorkflowId",
        "type": "error"
    },
    {
        "inputs": [
            {
                "internalType": "bytes10",
                "name": "received",
                "type": "bytes10"
            },
            {
                "internalType": "bytes10",
                "name": "expected",
                "type": "bytes10"
            }
        ],
        "name": "InvalidWorkflowName",
        "type": "error"
    },
    {
        "inputs": [
            {
                "internalType": "address",
                "name": "owner",
                "type": "address"
            }
        ],
        "name": "OwnableInvalidOwner",
        "type": "error"
    },
    {
        "inputs": [
            {
                "internalType": "address",
                "name": "account",
                "type": "address"
            }
        ],
        "name": "OwnableUnauthorizedAccount",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "WorkflowNameRequiresAuthorValidation",
        "type": "error"
    },
    {
        "anonymous": false,
        "inputs": [
            {
                "indexed": true,
                "internalType": "address",
                "name": "previousAuthor",
                "type": "address"
            },
            {
                "indexed": true,
                "internalType": "address",
                "name": "newAuthor",
                "type": "address"
            }
        ],
        "name": "ExpectedAuthorUpdated",
        "type": "event"
    },
    {
        "anonymous": false,
        "inputs": [
            {
                "indexed": true,
                "internalType": "bytes32",
                "name": "previousId",
                "type": "bytes32"
            },
            {
                "indexed": true,
                "internalType": "bytes32",
                "name": "newId",
                "type": "bytes32"
            }
        ],
        "name": "ExpectedWorkflowIdUpdated",
        "type": "event"
    },
    {
        "anonymous": false,
        "inputs": [
            {
                "indexed": true,
                "internalType": "bytes10",
                "name": "previousName",
                "type": "bytes10"
            },
            {
                "indexed": true,
                "internalType": "bytes10",
                "name": "newName",
                "type": "bytes10"
            }
        ],
        "name": "ExpectedWorkflowNameUpdated",
        "type": "event"
    },
    {
        "anonymous": false,
        "inputs": [
            {
                "indexed": true,
                "internalType": "address",
                "name": "previousForwarder",
                "type": "address"
            },
            {
                "indexed": true,
                "internalType": "address",
                "name": "newForwarder",
                "type": "address"
            }
        ],
        "name": "ForwarderAddressUpdated",
        "type": "event"
    },
    {
        "anonymous": false,
        "inputs": [
            {
                "indexed": true,
                "internalType": "string",
                "name": "agentId",
                "type": "string"
            },
            {
                "indexed": false,
                "internalType": "bytes32",
                "name": "entryHash",
                "type": "bytes32"
            },
            {
                "indexed": false,
                "internalType": "string",
                "name": "entryKey",
                "type": "string"
            },
            {
                "indexed": false,
                "internalType": "uint256",
                "name": "timestamp",
                "type": "uint256"
            }
        ],
        "name": "MemoryCommitted",
        "type": "event"
    },
    {
        "anonymous": false,
        "inputs": [
            {
                "indexed": true,
                "internalType": "address",
                "name": "previousOwner",
                "type": "address"
            },
            {
                "indexed": true,
                "internalType": "address",
                "name": "newOwner",
                "type": "address"
            }
        ],
        "name": "OwnershipTransferred",
        "type": "event"
    },
    {
        "anonymous": false,
        "inputs": [
            {
                "indexed": false,
                "internalType": "string",
                "name": "message",
                "type": "string"
            }
        ],
        "name": "SecurityWarning",
        "type": "event"
    },
    {
        "inputs": [
            {
                "internalType": "string",
                "name": "agentId",
                "type": "string"
            },
            {
                "internalType": "uint256",
                "name": "",
                "type": "uint256"
            }
        ],
        "name": "agentHashes",
        "outputs": [
            {
                "internalType": "bytes32",
                "name": "",
                "type": "bytes32"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "bytes32",
                "name": "",
                "type": "bytes32"
            }
        ],
        "name": "commitments",
        "outputs": [
            {
                "internalType": "string",
                "name": "agentId",
                "type": "string"
            },
            {
                "internalType": "string",
                "name": "entryKey",
                "type": "string"
            },
            {
                "internalType": "bytes32",
                "name": "entryHash",
                "type": "bytes32"
            },
            {
                "internalType": "uint256",
                "name": "committedAt",
                "type": "uint256"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "string",
                "name": "agentId",
                "type": "string"
            },
            {
                "internalType": "uint256",
                "name": "index",
                "type": "uint256"
            }
        ],
        "name": "getAgentHash",
        "outputs": [
            {
                "internalType": "bytes32",
                "name": "",
                "type": "bytes32"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "string",
                "name": "agentId",
                "type": "string"
            }
        ],
        "name": "getAgentHashCount",
        "outputs": [
            {
                "internalType": "uint256",
                "name": "",
                "type": "uint256"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "bytes32",
                "name": "hash",
                "type": "bytes32"
            }
        ],
        "name": "getCommitment",
        "outputs": [
            {
                "components": [
                    {
                        "internalType": "string",
                        "name": "agentId",
                        "type": "string"
                    },
                    {
                        "internalType": "string",
                        "name": "entryKey",
                        "type": "string"
                    },
                    {
                        "internalType": "bytes32",
                        "name": "entryHash",
                        "type": "bytes32"
                    },
                    {
                        "internalType": "uint256",
                        "name": "committedAt",
                        "type": "uint256"
                    }
                ],
                "internalType": "struct MemoryRegistry.Commitment",
                "name": "",
                "type": "tuple"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "getExpectedAuthor",
        "outputs": [
            {
                "internalType": "address",
                "name": "",
                "type": "address"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "getExpectedWorkflowId",
        "outputs": [
            {
                "internalType": "bytes32",
                "name": "",
                "type": "bytes32"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "getExpectedWorkflowName",
        "outputs": [
            {
                "internalType": "bytes10",
                "name": "",
                "type": "bytes10"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "getForwarderAddress",
        "outputs": [
            {
                "internalType": "address",
                "name": "",
                "type": "address"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "bytes calldata",
                "name": "metadata",
                "type": "bytes"
            },
            {
                "internalType": "bytes calldata",
                "name": "report",
                "type": "bytes"
            }
        ],
        "name": "onReport",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "owner",
        "outputs": [
            {
                "internalType": "address",
                "name": "",
                "type": "address"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "renounceOwnership",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "address",
                "name": "_author",
                "type": "address"
            }
        ],
        "name": "setExpectedAuthor",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "bytes32",
                "name": "_id",
                "type": "bytes32"
            }
        ],
        "name": "setExpectedWorkflowId",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "string",
                "name": "_name",
                "type": "string"
            }
        ],
        "name": "setExpectedWorkflowName",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "address",
                "name": "_forwarder",
                "type": "address"
            }
        ],
        "name": "setForwarderAddress",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "bytes4",
                "name": "interfaceId",
                "type": "bytes4"
            }
        ],
        "name": "supportsInterface",
        "outputs": [
            {
                "internalType": "bool",
                "name": "",
                "type": "bool"
            }
        ],
        "stateMutability": "pure",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "address",
                "name": "newOwner",
                "type": "address"
            }
        ],
        "name": "transferOwnership",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    }
] as const
