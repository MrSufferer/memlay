// Quick probe of the ICHIX vault contract on Hedera mainnet
const RPC = 'https://mainnet.hashio.io/api'
const VAULT = '0x26C770f89d320Da2c2341cbf410F132f44eF70CD'

const calls = [
  ['name()',                       '0x06fdde03'],
  ['symbol()',                     '0x95d89b41'],
  ['decimals()',                   '0x313ce567'],
  ['totalSupply()',                '0x18160ddd'],
  ['supportsInterface(bytes4)',   '0x01ffc9a7', '0x80ac58cd'], // ERC165
  ['supportsInterface(bytes4)',     '0x01ffc9a7', '0x80ac58cd'],
  ['ownerOf(uint256)',              '0x6352211e', '0x0000000000000000000000000000000000000000000000000000000000000001'],
  ['tokenURI(uint256)',             '0xc87b56dd', '0x0000000000000000000000000000000000000000000000000000000000000001'],
  // ERC4626
  ['asset()',                       '0x35a84d87'],
  ['totalAssets()',               '0x02571792'],
  ['convertToAssets(uint256)',      '0x397316a9', '0x0000000000000000000000000000000000000000000000000000000000000001'],
  // try a raw deposit signature
  ['deposit()',                   '0xd0e30db0'],
  ['withdraw(uint256)',            '0x2e1a7d4d', '0x0000000000000000000000000000000000000000000000000000000000000001'],
  // try what the original eth_getCode showed worked
]

async function ethCall(sel, ...args) {
  const data = args.length ? sel + args.join('') : sel
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: VAULT, data }, 'latest'] })
  }).then(r => r.json())
  return r
}

async function main() {
  console.log('Vault: ' + VAULT)
  console.log('')
  for (const c of calls) {
    const [sig, sel, ...args] = c
    const r = await ethCall(sel, ...args)
    if (r.error) {
      console.log('❌ ' + sig.padEnd(35) + '  RPC ERR: ' + r.error.message)
    } else if (!r.result || r.result === '0x') {
      console.log('❌ ' + sig.padEnd(35) + '  -> REVERTED')
    } else {
      const val = parseInt(r.result, 16)
      console.log('✅ ' + sig.padEnd(35) + '  -> ' + (isNaN(val) ? r.result.slice(0, 40) + '...' : val))
    }
  }
}

main()
