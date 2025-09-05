# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Build
```bash
npm run build
```
Compiles TypeScript source to JavaScript in the `dist/` directory.

### Development
```bash
npm run dev
```
Builds and runs the server in stdio mode for development.

### Run
```bash
npm start                 # stdio mode (default)
npm start -- --http       # HTTP mode on port 3000
```

## Architecture

This is a **Model Context Protocol (MCP) server** that provides blockchain token data to Claude Code for dapp development. The server exposes one primary tool: `getTokensBySymbols`.

### Core Components

- **src/index.ts**: Main server implementation containing:
  - MCP server initialization and tool registration
  - Token list file reading logic (`readTokenList`)
  - Token search functionality (`findTokensBySymbols`) 
  - Transport handling (stdio and HTTP modes)

- **token-lists/**: JSON files containing token data organized by chain:
  - `Coingecko.1.json`: Ethereum tokens (chainId: 1)
  - `Coingecko.42161.json`: Arbitrum tokens (chainId: 42161)

### Key Data Flow
1. MCP tool receives array of token symbols + optional chain/list parameters
2. Chain name maps to chainId (Ethereum → 1, Arbitrum → 42161)
3. Reads corresponding JSON file from `token-lists/`
4. Performs case-insensitive symbol matching
5. Returns matched tokens + list of not-found symbols

### Chain & List Mapping
- Default chain: "Ethereum" (chainId: 1)
- Default list: "Coingecko"
- Supported chains: Ethereum, Arbitrum
- File naming: `{listName}.{chainId}.json`

### Token Data Structure
Each token contains: chainId, address, name, symbol, decimals, logoURI

### Transport Modes
- **stdio** (default): Communicates via standard input/output streams
- **HTTP**: REST-like interface on port 3000 with `/rpc` endpoint

The server is designed for integration with Claude Code's MCP system to provide real-time token data during smart contract and dapp development.