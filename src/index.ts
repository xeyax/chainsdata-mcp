import { config } from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import fs from "fs";
import path from "path";
import express from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";

// Load environment variables from .env file
config();

// Environment variables validation
const GRAPH_API_KEY = process.env.GRAPH_API_KEY;
if (!GRAPH_API_KEY) {
  console.warn(
    "Warning: GRAPH_API_KEY not set. Using public endpoint (may have rate limits)",
  );
}

//token interface
interface Token {
  chainId: number;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  logoURI: string;
}

interface TokenList {
  name: string;
  tokens: Token[];
}

// Uniswap V3 Pool interfaces
interface UniswapV3Token {
  id: string; // Token address
  symbol: string; // Token symbol (e.g., "WETH")
  name: string; // Token name (e.g., "Wrapped Ether")
  decimals: string; // Token decimals as string (from subgraph)
}

interface UniswapV3Pool {
  id: string; // Pool address
  feeTier: string; // Fee tier (500, 3000, 10000)
  token0: UniswapV3Token; // First token in pair
  token1: UniswapV3Token; // Second token in pair
  totalValueLockedUSD: string; // TVL in USD
  volumeUSD: string; // 24h volume in USD
  txCount: string; // Total transaction count
}

interface UniswapV3PoolsResponse {
  pools: UniswapV3Pool[];
}

interface SubgraphResponse {
  data: UniswapV3PoolsResponse;
  errors?: Array<{ message: string }>;
}

// Chainlink feed interfaces
interface ChainlinkFeed {
  name: string; // e.g., "BRL/USD", "ETH/USD"
  proxyAddress: string;
  feedCategory: string; // e.g., "low", "medium", "high"
}

interface ChainData {
  baseUrl: string; // e.g., "https://mainnet.infura.io/v3"
  feeds: ChainlinkFeed[];
}

interface FeedsData {
  [chainName: string]: ChainData;
}

function readTokenList(listName: string, chainId: number): TokenList {
  const filename = `${listName}.${chainId}.json`;
  const filePath = path.join(process.cwd(), "token-lists", filename);

  try {
    const fileContent = fs.readFileSync(filePath, "utf8");
    return JSON.parse(fileContent) as TokenList;
  } catch (error) {
    throw new Error(
      `Failed to read token list ${filename}: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

function readFeedsData(): FeedsData {
  const filePath = path.join(process.cwd(), "feeds.json");

  try {
    const fileContent = fs.readFileSync(filePath, "utf8");
    return JSON.parse(fileContent) as FeedsData;
  } catch (error) {
    throw new Error(
      `Failed to read feeds.json: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

const chainMapping: Record<string, number> = {
  Ethereum: 1,
  "BNB Smart Chain": 56,
  Gnosis: 100,
  Polygon: 137,
  Arbitrum: 42161,
  Base: 8453,
};

// The Graph subgraph IDs for Uniswap V3 on different chains
const uniswapV3SubgraphMapping: Record<string, string> = {
  Ethereum: "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV",
  Polygon: "3hCPRGf4z88VC5rsBKU5AA9FBBq5nF3jbKJG7VZCbhjm",
  Base: "HMuAwufqZ1YCRmzL2SfHTVkzZovC9VL2UAKhjvRqKiR1",
  Arbitrum: "3V7ZY6muhxaQL5qvntX1CFXJ32W7BxXZTGTwmpH5J4t3",
};

// Supported chains for Uniswap V3 (subset of main chainMapping)
const supportedUniswapChains = Object.keys(uniswapV3SubgraphMapping);

function findTokensBySymbols(
  symbols: string[],
  chain: string = "Ethereum",
  list: string = "Coingecko",
): { tokens: Token[]; notFound?: string } {
  if (!symbols || symbols.length === 0) {
    throw new Error("Symbols array cannot be empty");
  }

  const chainId = chainMapping[chain];
  if (!chainId) {
    throw new Error(
      `Unsupported chain: ${chain}. Supported chains: ${Object.keys(chainMapping).join(", ")}`,
    );
  }

  const tokenList = readTokenList(list, chainId);

  const foundTokens: Token[] = [];
  const notFoundSymbols: string[] = [];

  for (const symbol of symbols) {
    if (typeof symbol !== "string" || symbol.trim() === "") {
      notFoundSymbols.push(String(symbol));
      continue;
    }

    const token = tokenList.tokens.find(
      (t) => t.symbol.toLowerCase() === symbol.toLowerCase(),
    );
    if (token) {
      foundTokens.push(token);
    } else {
      notFoundSymbols.push(symbol);
    }
  }

  const result: { tokens: Token[]; notFound?: string } = {
    tokens: foundTokens,
  };

  if (notFoundSymbols.length > 0) {
    result.notFound = notFoundSymbols.join(", ");
  }

  return result;
}

// GraphQL query for Uniswap V3 pools
const UNISWAP_V3_POOLS_QUERY = `
  query GetPools($token0Symbol: String, $token1Symbol: String, $token0Name: String, $token1Name: String) {
    pools(
      first: 100,
      orderBy: totalValueLockedUSD,
      orderDirection: desc,
      where: {
        or: [
          {
            and: [
              {
                or: [
                  { token0_: { symbol_contains_nocase: $token0Symbol } },
                  { token0_: { name_contains_nocase: $token0Name } }
                ]
              },
              {
                or: [
                  { token1_: { symbol_contains_nocase: $token1Symbol } },
                  { token1_: { name_contains_nocase: $token1Name } }
                ]
              }
            ]
          },
          {
            and: [
              {
                or: [
                  { token0_: { symbol_contains_nocase: $token1Symbol } },
                  { token0_: { name_contains_nocase: $token1Name } }
                ]
              },
              {
                or: [
                  { token1_: { symbol_contains_nocase: $token0Symbol } },
                  { token1_: { name_contains_nocase: $token0Name } }
                ]
              }
            ]
          }
        ]
      }
    ) {
      id
      feeTier
      totalValueLockedUSD
      volumeUSD
      txCount
      token0 {
        id
        symbol
        name
        decimals
      }
      token1 {
        id
        symbol
        name
        decimals
      }
    }
  }
`;

async function queryUniswapV3Subgraph(
  query: string,
  variables: Record<string, any>,
  chainSubgraphId: string,
  retries = 3,
): Promise<SubgraphResponse> {
  const baseUrl = GRAPH_API_KEY
    ? `https://gateway.thegraph.com/api/${GRAPH_API_KEY}/subgraphs/id/${chainSubgraphId}`
    : `https://api.thegraph.com/subgraphs/id/${chainSubgraphId}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data: SubgraphResponse = await response.json();

      if (data.errors && data.errors.length > 0) {
        throw new Error(
          `GraphQL errors: ${data.errors.map((e) => e.message).join(", ")}`,
        );
      }

      return data;
    } catch (error) {
      console.error(`Attempt ${attempt} failed:`, error);

      if (attempt === retries) {
        throw new Error(
          `Failed to query subgraph after ${retries} attempts: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }

      // Exponential backoff: wait 1s, 2s, 4s between retries
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)),
      );
    }
  }

  throw new Error("Unexpected error in queryUniswapV3Subgraph");
}

async function findUniswapV3Pools(
  token0: string,
  token1: string,
  chain: string = "Ethereum",
): Promise<{
  pools: UniswapV3Pool[];
  metadata: { chain: string; totalResults: number };
}> {
  // Input validation
  if (!token0 || !token1) {
    throw new Error("Both token0 and token1 parameters are required");
  }

  if (typeof token0 !== "string" || typeof token1 !== "string") {
    throw new Error("Token parameters must be strings");
  }

  // Normalize inputs
  const normalizedToken0 = token0.trim();
  const normalizedToken1 = token1.trim();

  if (normalizedToken0 === "" || normalizedToken1 === "") {
    throw new Error("Token parameters cannot be empty");
  }

  // Check if chain is supported for Uniswap V3
  if (!supportedUniswapChains.includes(chain)) {
    throw new Error(
      `Uniswap V3 not supported on ${chain}. Supported chains: ${supportedUniswapChains.join(", ")}`,
    );
  }

  const subgraphId = uniswapV3SubgraphMapping[chain];

  try {
    // Query the subgraph
    const response = await queryUniswapV3Subgraph(
      UNISWAP_V3_POOLS_QUERY,
      {
        token0Symbol: normalizedToken0,
        token1Symbol: normalizedToken1,
        token0Name: normalizedToken0,
        token1Name: normalizedToken1,
      },
      subgraphId,
    );

    const pools = response.data.pools || [];

    // Filter pools to ensure we have meaningful TVL (> $1000)
    const filteredPools = pools.filter((pool) => {
      const tvl = parseFloat(pool.totalValueLockedUSD);
      return tvl > 1000; // Only return pools with > $1000 TVL
    });

    return {
      pools: filteredPools,
      metadata: {
        chain,
        totalResults: filteredPools.length,
      },
    };
  } catch (error) {
    throw new Error(
      `Failed to fetch Uniswap V3 pools: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

function getSupportedChains(): { supportedChains: string[] } {
  const feedsData = readFeedsData();
  return {
    supportedChains: Object.keys(feedsData),
  };
}

function getFeedAddresses(
  pairs: string[],
  chain?: string,
): {
  feeds: Array<{
    name: string;
    proxyAddress: string;
    feedCategory: string;
    chain: string;
  }>;
  notFound?: string;
} {
  if (!pairs || pairs.length === 0) {
    throw new Error("Pairs array cannot be empty");
  }

  const feedsData = readFeedsData();
  const foundFeeds: Array<{
    name: string;
    proxyAddress: string;
    feedCategory: string;
    chain: string;
  }> = [];
  const notFoundPairs: string[] = [];

  if (chain) {
    // Search in specific chain (convert to lowercase for consistent lookup)
    const normalizedChain = chain.toLowerCase();
    if (!feedsData[normalizedChain]) {
      throw new Error(
        `Unsupported chain: ${chain}. Supported chains: ${Object.keys(feedsData).join(", ")}`,
      );
    }

    const chainData = feedsData[normalizedChain];
    for (const pair of pairs) {
      if (typeof pair !== "string" || pair.trim() === "") {
        notFoundPairs.push(String(pair));
        continue;
      }

      const feed = chainData.feeds.find(
        (f) => f.name.toLowerCase() === pair.toLowerCase(),
      );
      if (feed) {
        foundFeeds.push({
          ...feed,
          chain: normalizedChain,
        });
      } else {
        notFoundPairs.push(pair);
      }
    }
  } else {
    // Search across all chains
    for (const pair of pairs) {
      if (typeof pair !== "string" || pair.trim() === "") {
        notFoundPairs.push(String(pair));
        continue;
      }

      let found = false;
      for (const [chainName, chainData] of Object.entries(feedsData)) {
        const feed = chainData.feeds.find(
          (f) => f.name.toLowerCase() === pair.toLowerCase(),
        );
        if (feed) {
          foundFeeds.push({
            ...feed,
            chain: chainName,
          });
          found = true;
          break; // Only return first match per pair
        }
      }

      if (!found) {
        notFoundPairs.push(pair);
      }
    }
  }

  const result: {
    feeds: Array<{
      name: string;
      proxyAddress: string;
      feedCategory: string;
      chain: string;
    }>;
    notFound?: string;
  } = {
    feeds: foundFeeds,
  };

  if (notFoundPairs.length > 0) {
    result.notFound = notFoundPairs.join(", ");
  }

  return result;
}

function getSupportedFeedsByChain(chain: string): {
  chain: string;
  supportedFeeds: string[];
} {
  if (!chain || typeof chain !== "string" || chain.trim() === "") {
    throw new Error("Chain parameter is required and cannot be empty");
  }

  const feedsData = readFeedsData();
  
  // Convert chain to lowercase for consistent lookup
  const normalizedChain = chain.toLowerCase();
  if (!feedsData[normalizedChain]) {
    throw new Error(
      `Unsupported chain: ${chain}. Supported chains: ${Object.keys(feedsData).join(", ")}`,
    );
  }

  const chainData = feedsData[normalizedChain];
  const supportedFeeds = chainData.feeds.map((feed) => feed.name);

  return {
    chain: normalizedChain,
    supportedFeeds,
  };
}

function createServer(): McpServer {
  const server = new McpServer({
    name: "chainsdata-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "getTokensBySymbols",
    {
      title: "Get Tokens by Symbols",
      description: "Get token information by symbols from token lists",
      inputSchema: {
        symbols: z
          .array(z.string())
          .describe("Array of token symbols to search for"),
        chain: z
          .string()
          .optional()
          .describe("Chain name (optional, default: 'Ethereum')"),
        list: z
          .string()
          .optional()
          .describe("Token list name (optional, default: 'Coingecko')"),
      },
    },
    async ({ symbols, chain, list }) => {
      try {
        const result = findTokensBySymbols(symbols, chain, list);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error occurred";
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: errorMessage }, null, 2),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "getUniswapV3Pools",
    {
      title: "Get Uniswap V3 Pools",
      description:
        "Find Uniswap V3 liquidity pools by token pairs using The Graph Protocol",
      inputSchema: {
        token0: z
          .string()
          .describe("First token symbol or name (e.g., 'WETH', 'tBTC')"),
        token1: z
          .string()
          .describe("Second token symbol or name (e.g., 'USDC', 'DAI')"),
        chain: z
          .string()
          .optional()
          .default("Ethereum")
          .describe(
            `Chain name (optional, default: 'Ethereum'). Supported: ${supportedUniswapChains.join(", ")}`,
          ),
      },
    },
    async ({ token0, token1, chain }) => {
      try {
        const result = await findUniswapV3Pools(token0, token1, chain);

        // Format the response with additional metadata
        const formattedResult = {
          ...result,
          searchCriteria: {
            token0,
            token1,
            chain,
          },
          timestamp: new Date().toISOString(),
          apiInfo: {
            source: "The Graph Protocol",
            subgraph: "Uniswap V3",
            endpoint: GRAPH_API_KEY ? "Authenticated Gateway" : "Public API",
          },
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(formattedResult, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error occurred";
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error: errorMessage,
                  searchCriteria: { token0, token1, chain },
                  timestamp: new Date().toISOString(),
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "getSupportedChains",
    {
      title: "Get Supported Chains",
      description: "Get list of supported chains for Chainlink feeds",
      inputSchema: {},
    },
    async () => {
      try {
        const result = getSupportedChains();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error occurred";
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: errorMessage }, null, 2),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "getFeedAddresses",
    {
      title: "Get Feed Addresses",
      description: "Get Chainlink feed addresses by token pairs",
      inputSchema: {
        pairs: z
          .array(z.string())
          .describe('Array of token pairs to search for (e.g., ["BRL/USD", "ETH/USD"])'),
        chain: z
          .string()
          .optional()
          .describe("Chain name (optional, searches all chains if not specified)"),
      },
    },
    async ({ pairs, chain }) => {
      try {
        const result = getFeedAddresses(pairs, chain);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error occurred";
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: errorMessage }, null, 2),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "getSupportedFeedsByChain",
    {
      title: "Get Supported Feeds by Chain",
      description: "Get list of all supported feed pairs for a specific chain",
      inputSchema: {
        chain: z
          .string()
          .describe("Chain name (required)"),
      },
    },
    async ({ chain }) => {
      try {
        const result = getSupportedFeedsByChain(chain);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error occurred";
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: errorMessage }, null, 2),
            },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}

async function main() {
  try {
    const useStdio = process.argv.includes("--stdio");
    const useHttp = !useStdio;

    if (useHttp) {
      const app = express();
      const port = Number(process.env.PORT) || 3000;

      app.use(express.json());

      // CORS headers for remote access
      app.use((req, res, next) => {
        res.header("Access-Control-Allow-Origin", "*");
        res.header(
          "Access-Control-Allow-Methods",
          "GET, POST, DELETE, OPTIONS",
        );
        res.header(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization, MCP-Session-Id",
        );
        res.header("Access-Control-Expose-Headers", "MCP-Session-Id");

        if (req.method === "OPTIONS") {
          res.sendStatus(200);
          return;
        }
        next();
      });

      // Session management with cleanup
      const transports: { [sessionId: string]: StreamableHTTPServerTransport } =
        {};
      const sessionTimers: { [sessionId: string]: NodeJS.Timeout } = {};
      const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

      const cleanupSession = (sessionId: string) => {
        if (transports[sessionId]) {
          transports[sessionId].close?.();
          delete transports[sessionId];
        }
        if (sessionTimers[sessionId]) {
          clearTimeout(sessionTimers[sessionId]);
          delete sessionTimers[sessionId];
        }
      };

      const resetSessionTimer = (sessionId: string) => {
        if (sessionTimers[sessionId]) {
          clearTimeout(sessionTimers[sessionId]);
        }
        sessionTimers[sessionId] = setTimeout(() => {
          console.error(`Session ${sessionId} expired due to inactivity`);
          cleanupSession(sessionId);
        }, SESSION_TIMEOUT);
      };

      // Handle POST requests for client-to-server communication
      app.post("/mcp", async (req, res) => {
        try {
          const sessionId = req.headers["mcp-session-id"] as string | undefined;
          let transport: StreamableHTTPServerTransport;

          if (sessionId && transports[sessionId]) {
            // Reuse existing transport and reset its timer
            transport = transports[sessionId];
            resetSessionTimer(sessionId);
          } else if (!sessionId || !transports[sessionId]) {
            // New initialization request
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (sessionId) => {
                transports[sessionId] = transport;
                resetSessionTimer(sessionId);
                console.error(`New MCP session initialized: ${sessionId}`);
              },
            });

            // Clean up transport when closed
            transport.onclose = () => {
              if (transport.sessionId) {
                console.error(`MCP session closed: ${transport.sessionId}`);
                cleanupSession(transport.sessionId);
              }
            };

            const server = createServer();
            await server.connect(transport);
          } else {
            res.status(400).json({
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message:
                  "Bad Request: No valid session ID provided or not an initialize request",
              },
              id: null,
            });
            return;
          }

          await transport.handleRequest(req, res, req.body);
        } catch (error) {
          console.error("Error handling MCP request:", error);
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal error",
              data: error instanceof Error ? error.message : "Unknown error",
            },
            id: null,
          });
        }
      });

      // Reusable handler for GET and DELETE requests
      const handleSessionRequest = async (
        req: express.Request,
        res: express.Response,
      ) => {
        try {
          const sessionId = req.headers["mcp-session-id"] as string | undefined;
          if (!sessionId || !transports[sessionId]) {
            res.status(400).json({
              error: "Invalid or missing session ID",
              sessionId: sessionId || "missing",
            });
            return;
          }

          const transport = transports[sessionId];
          resetSessionTimer(sessionId);
          await transport.handleRequest(req, res);
        } catch (error) {
          console.error("Error handling session request:", error);
          res.status(500).json({
            error: "Internal server error",
            details: error instanceof Error ? error.message : "Unknown error",
          });
        }
      };

      // Handle GET requests for server-to-client notifications via SSE
      app.get("/mcp", handleSessionRequest);

      // Handle DELETE requests for session termination
      app.delete("/mcp", handleSessionRequest);

      // Health check endpoint
      app.get("/health", (req, res) => {
        const activeSessions = Object.keys(transports).length;
        res.json({
          status: "healthy",
          timestamp: new Date().toISOString(),
          activeSessions,
          supportedChains: Object.keys(chainMapping),
          uniswapV3Chains: supportedUniswapChains,
          tools: ["getTokensBySymbols", "getUniswapV3Pools", "getSupportedChains", "getFeedAddresses", "getSupportedFeedsByChain"],
          version: "1.0.0",
          graphApiKeyConfigured: !!GRAPH_API_KEY,
        });
      });

      // Default route for API information
      app.get("/", (req, res) => {
        res.json({
          name: "ChainsData MCP Server",
          description:
            "Model Context Protocol server for blockchain token data",
          version: "1.0.0",
          endpoints: {
            mcp: "/mcp",
            health: "/health",
          },
          supportedChains: Object.keys(chainMapping),
        });
      });

      // Global error handler
      app.use(
        (
          error: Error,
          req: express.Request,
          res: express.Response,
          next: express.NextFunction,
        ) => {
          console.error("Unhandled Express error:", error);
          res.status(500).json({
            error: "Internal server error",
            message: error.message,
          });
        },
      );

      const server = app.listen(port, "0.0.0.0", () => {
        console.error(`ChainsData MCP server running on HTTP port ${port}`);
        console.error(`Health check: http://localhost:${port}/health`);
        console.error(`MCP endpoint: http://localhost:${port}/mcp`);
      });

      // Graceful shutdown
      const shutdown = () => {
        console.error("Received shutdown signal, cleaning up...");

        // Clean up all sessions
        Object.keys(transports).forEach((sessionId) => {
          cleanupSession(sessionId);
        });

        server.close(() => {
          console.error("HTTP server closed");
          process.exit(0);
        });
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    } else {
      // Stdio mode
      const server = createServer();
      const transport = new StdioServerTransport();

      process.on("SIGINT", async () => {
        await transport.close();
        process.exit(0);
      });

      process.on("SIGTERM", async () => {
        await transport.close();
        process.exit(0);
      });

      await server.connect(transport);
      console.error("ChainsData MCP server running on stdio");
    }
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

main();
