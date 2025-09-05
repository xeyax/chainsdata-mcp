# ChainsData MCP Server Implementation Blueprint

## Phase 1: Initial Planning & Architecture

### Step 1: Project Structure Design
- Define minimal file structure
- Identify core dependencies
- Plan data flow from request to response

### Step 2: Break Down Core Functionality
- Token list file reading
- Symbol matching logic
- Chain name to ID mapping
- Response formatting

### Step 3: Iterative Chunk Definition
First iteration - Major components:
1. Project setup
2. Core server implementation
3. Token data handling
4. Transport layer

Second iteration - Smaller chunks:
1. Initialize TypeScript project
2. Create MCP server skeleton
3. Implement file reading logic
4. Add token search functionality
5. Setup stdio transport
6. Add HTTP transport

Third iteration - Right-sized steps:
1. Initialize npm project with TypeScript
2. Setup MCP SDK and basic server structure
3. Create token list file reader
4. Implement symbol matching with case-insensitive search
5. Add chain mapping functionality
6. Wire up the getTokensBySymbols tool
7. Implement stdio transport handler
8. Add HTTP transport with Express
9. Create sample token lists
10. Final wiring and cleanup

## Phase 2: Implementation Prompts

### Prompt 1: Project Initialization

```text
Create a new TypeScript project for an MCP (Model Context Protocol) server called "chainsdata-mcp". 

Set up the following:
1. Initialize npm project with package.json
2. Install dependencies: @modelcontextprotocol/sdk, typescript, @types/node
3. Create tsconfig.json for Node.js targeting ES2020
4. Create the basic directory structure with src/ and token-lists/ folders
5. Add npm scripts for: build (tsc), start (node dist/index.js), and dev (for development)

The package.json should include:
- name: "chainsdata-mcp"
- version: "1.0.0"
- main: "dist/index.js"
- type: "module" for ESM support

Make the tsconfig.json minimal but functional for a Node.js MCP server.
```

### Prompt 2: MCP Server Skeleton

```text
Building on the previous project setup, create the basic MCP server skeleton in src/index.ts:

1. Import Server from @modelcontextprotocol/sdk/server/index.js
2. Import StdioServerTransport from @modelcontextprotocol/sdk/server/stdio.js
3. Create a new Server instance with:
   - name: "chainsdata-mcp"
   - version: "1.0.0"
4. Set up the basic server structure with empty tool handlers
5. Create a main function that initializes stdio transport and connects it to the server
6. Add basic error handling for the transport
7. Call the main function at the bottom of the file

The server should be ready to run but won't have any tools yet. Focus on getting the MCP protocol connection working.
```

### Prompt 3: Token List File Reader

```text
Add token list file reading functionality to the existing MCP server:

1. Create a simple interface for TokenList and Token types based on this structure:
   - Token: { chainId, address, name, symbol, decimals, logoURI }
   - TokenList: { name, tokens: Token[] }

2. Add a function readTokenList that:
   - Takes parameters: listName (string) and chainId (number)
   - Constructs filename as: `${listName}.${chainId}.json`
   - Reads the file from token-lists/ directory using fs.readFileSync
   - Parses and returns the JSON as TokenList type
   - No error handling needed - assume files exist

3. Import fs and path modules for file operations

Keep it simple - synchronous file reading is fine for this use case.
```

### Prompt 4: Token Search Implementation

```text
Add token searching functionality to the MCP server:

1. Create a chain name to ID mapping object:
   - Ethereum -> 1
   - Arbitrum -> 42161

2. Create a function findTokensBySymbols that:
   - Takes: symbols array, chain name (optional, default "Ethereum"), list name (optional, default "Coingecko")
   - Maps chain name to chain ID using the mapping
   - Calls readTokenList with the list name and chain ID
   - Filters tokens where symbol (case-insensitive) matches any in the input array
   - Returns an object with:
     * tokens: array of found tokens
     * notFound: comma-separated string of symbols not found (only if some weren't found)

3. Make symbol matching case-insensitive using toLowerCase()

This function will be the core logic for the MCP tool.
```

### Prompt 5: Wire Up MCP Tool

```text
Integrate the token search functionality as an MCP tool in the server:

1. Register a tool called "getTokensBySymbols" with the server using server.setRequestHandler
2. Define the tool's JSON schema with:
   - Input properties: symbols (array of strings, required), chain (string, optional), list (string, optional)
   - Description explaining what the tool does
3. In the tool handler:
   - Extract symbols, chain, and list from the request arguments
   - Call findTokensBySymbols with these parameters
   - Return the result directly (tokens array and optional notFound string)

4. Update the server initialization to include this tool registration

The tool should now be callable through the MCP protocol. Make sure the handler is set up before starting the transport.
```

### Prompt 6: Stdio Transport Setup

```text
Ensure the stdio transport is properly configured for the MCP server:

1. The main function should already have StdioServerTransport setup from earlier
2. Add proper process signal handlers for cleanup:
   - Listen for SIGINT and SIGTERM
   - Close the transport gracefully on these signals
3. Add console.error for any transport errors (stderr so it doesn't interfere with stdio protocol)
4. Ensure the server runs when executing: node dist/index.js

The stdio transport should be the default mode of operation. This allows the server to communicate through standard input/output streams.
```

### Prompt 7: HTTP Transport Addition

```text
Add HTTP transport support to the existing MCP server:

1. Install express and @types/express as dependencies
2. Import express and create HTTP transport handling:
   - Check for --http flag in process.argv
   - If present, use express instead of stdio
3. Set up express server:
   - Port from PORT env variable or default to 3000
   - POST endpoint at /rpc for MCP messages
   - Parse JSON body and forward to MCP server
   - Return MCP server response as JSON
4. Keep the existing stdio as default (no --http flag)
5. Add proper logging for HTTP mode (which port it's running on)

The server should now support both modes:
- node dist/index.js (stdio mode)
- node dist/index.js --http (HTTP mode on port 3000)
```

### Prompt 8: Create Sample Token Lists

```text
Create comprehensive token lists for the MCP server:

1. Create token-lists/Coingecko.1.json (Ethereum) with these tokens:
   - USDC (address: 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48, decimals: 6)
   - USDT (address: 0xdac17f958d2ee523a2206206994597c13d831ec7, decimals: 6)
   - DAI (address: 0x6b175474e89094c44da98b954eedeac495271d0f, decimals: 18)
   - WETH (address: 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2, decimals: 18)
   - Add logoURI for each token (can use placeholder URLs)

2. Create token-lists/Coingecko.42161.json (Arbitrum) with:
   - USDC (address: 0xff970a61a04b1ca14834a43f5de4533ebddb5cc8, decimals: 6)
   - USDT (address: 0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9, decimals: 6)
   - DAI (address: 0xda10009cbd5d07dd0cecc66161fc93d7c9000da1, decimals: 18)
   - Include proper decimals and logoURI fields

3. Ensure JSON files are properly formatted with the correct structure:
   - name field describing the list (e.g., "CoinGecko on Ethereum")
   - tokens array with all required fields

These files will serve as the data source for the server.
```

### Prompt 9: Final Wiring and Documentation

```text
Complete the MCP server implementation with final touches:

1. Add a README.md with:
   - Brief description of the server's purpose
   - Installation instructions
   - Usage examples for both stdio and HTTP modes
   - Example of how to call the getTokensBySymbols tool
   - Token list format documentation
   - Example usage with Claude Code

2. Add error boundaries where absolutely necessary:
   - Wrap the main function in try-catch
   - Log errors to stderr to not interfere with stdio

3. Clean up any unused imports or code
4. Ensure all TypeScript types are properly defined
5. Add a .gitignore file for node_modules and dist/
6. Verify the build process works: npm run build && npm start

7. Make sure the tool properly handles:
   - Default values (Ethereum chain, Coingecko list)
   - Case-insensitive symbol matching
   - Not found tokens reporting

The server should now be complete and ready for use with Claude Code or other MCP clients.
```

## Implementation Notes

Each prompt builds on the previous one, creating a complete, working MCP server. The prompts are designed to:

1. Start with basic setup and structure
2. Build core functionality incrementally
3. Add transport layers
4. Include sample data
5. Finish with documentation and cleanup

The key principles followed:
- No orphaned code - each piece connects to the previous
- Incremental complexity - starting simple, adding features gradually
- Best practices - TypeScript, proper structure
- Small enough steps to implement safely
- Large enough steps to show meaningful progress