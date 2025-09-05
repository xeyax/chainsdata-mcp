# ChainsData MCP Server

A Model Context Protocol (MCP) server that provides token data from locally stored token lists for dapp development with Claude Code.

## Features

- **Token Lookup**: Find token information by symbol across different chains
- **Multiple Chains**: Support for Ethereum (chainId: 1) and Arbitrum (chainId: 42161)
- **Flexible Transport**: Supports both stdio and HTTP transport modes
- **Case-Insensitive**: Token symbol matching is case-insensitive

## Installation

```bash
npm install
npm run build
```

## Usage

### Stdio Mode (Default)
```bash
npm start
```

### HTTP Mode
```bash
npm start -- --http
```
Server will run on port 3000 (or the PORT environment variable).

### Development
```bash
npm run dev
```

## Adding to Claude Code

To use this MCP server with Claude Code, add it to your MCP configuration:

1. Open Claude Code settings
2. Navigate to MCP Servers
3. Add a new server with the following configuration:

```json
{
  "chainsdata": {
    "command": "node",
    "args": ["/path/to/your/chainsdata-mcp/dist/index.js"],
    "cwd": "/path/to/your/chainsdata-mcp"
  }
}
```

Replace `/path/to/your/chainsdata-mcp` with the actual path to this project directory.

Alternatively, you can add it directly to your `claude_code_mcp_config.json` file:

```json
{
  "mcpServers": {
    "chainsdata": {
      "command": "node",
      "args": ["/path/to/your/chainsdata-mcp/dist/index.js"],
      "cwd": "/path/to/your/chainsdata-mcp"
    }
  }
}
```

After configuration, restart Claude Code to load the MCP server.

## MCP Tool: getTokensBySymbols

Get token information by providing an array of token symbols.

**Parameters:**
- `symbols` (required): Array of token symbols to search for
- `chain` (optional): Chain name - "Ethereum" or "Arbitrum" (default: "Ethereum")  
- `list` (optional): Token list name (default: "Coingecko")

**Example:**
```json
{
  "symbols": ["USDC", "USDT", "DAI"],
  "chain": "Ethereum",
  "list": "Coingecko"
}
```

**Response:**
```json
{
  "tokens": [
    {
      "chainId": 1,
      "address": "0xa0b86a33e6417c5334a8b4cf0bc0fa5ea4deb866",
      "name": "USD Coin",
      "symbol": "USDC",
      "decimals": 6,
      "logoURI": "https://..."
    }
  ],
  "notFound": "DAI"
}
```

## Token Lists

Token data is stored in the `token-lists/` directory:
- `Coingecko.1.json` - Ethereum tokens
- `Coingecko.42161.json` - Arbitrum tokens

## Project Structure

```
chainsdata-mcp/
├── token-lists/
│   ├── Coingecko.1.json
│   └── Coingecko.42161.json
├── src/
│   └── index.ts
├── dist/
├── package.json
├── tsconfig.json
└── README.md
```

## License

ISC