## Final Specification for ChainsData MCP Server

### Overview
MCP server that provides token data from locally stored token lists for dapp development with Claude Code.

### Core Functionality
- **Single Tool**: `getTokensBySymbols`
  - Input: Array of token symbols, optional chain name, optional list name
  - Output: Array of token data + not-found message if applicable
  - Defaults: Ethereum chain, Coingecko list

### File Structure
```
chainsdata-mcp/
├── token-lists/
│   ├── Coingecko.1.json      # Ethereum
│   ├── Coingecko.42161.json  # Arbitrum
│   └── [Other lists as needed]
├── src/
│   └── index.ts
├── package.json
└── tsconfig.json
```

### Token List Format
```json
{
  "name": "CoinGecko on Ethereum",
  "tokens": [
    {
      "chainId": 1,
      "address": "0xdac17f958d2ee523a2206206994597c13d831ec7",
      "name": "Tether",
      "symbol": "USDT",
      "decimals": 6,
      "logoURI": "https://..."
    }
  ]
}
```

### Tool Interface
```typescript
// Input
{
  symbols: ["USDC", "USDT", "DAI"],
  chain?: "Ethereum" | "Arbitrum",  // default: "Ethereum"
  list?: string                      // default: "Coingecko"
}

// Output
{
  tokens: [...token data as stored in JSON...],
  notFound?: "DAI"  // if any tokens weren't found
}
```

### Transport Modes
- **stdio**: Default when run as `node dist/index.js`
- **HTTP**: When run with `node dist/index.js --http` (port 3000, or PORT env var)

### Implementation Details
- Case-insensitive token symbol matching
- Chain name to ID mapping: {"Ethereum": 1, "Arbitrum": 42161}
- No caching - reads file on each request
- No error handling - assumes valid inputs
- No startup validation

### Usage Example
```
Claude Code prompt: "Write a dropdown where a user will be able to change the deposit token: USDC, USDT or DAI on Ethereum network. Use ChainsData MCP for token data"

MCP will be called with:
- symbols: ["USDC", "USDT", "DAI"]
- chain: "Ethereum" (from context or default)
- list: "Coingecko" (default)
```

### Dependencies
- @modelcontextprotocol/sdk
- express (for HTTP transport)
- TypeScript + standard type definitions

This specification is ready to hand off to a developer for implementation. The server is intentionally minimal, focusing solely on the core use case of fetching token data during dapp development.
